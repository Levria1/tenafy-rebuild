const test = require('node:test');
const assert = require('node:assert/strict');

const { sendWithRetry, isTransient } = require('../src/utils/mailRetry');

// A fake transport that fails the first `failures` attempts with `err`, then
// succeeds. Records how many times it was actually called.
function transportFailing(failures, err) {
  const calls = { count: 0 };
  return {
    calls,
    sendMail: async () => {
      calls.count++;
      if (calls.count <= failures) throw err;
      return { messageId: 'ok', accepted: ['a@b.com'], rejected: [] };
    },
  };
}

const timeout = () => Object.assign(new Error('Connection timeout'), { code: 'ETIMEDOUT' });
const rejected = () => Object.assign(new Error('Mail command failed: 553 5.7.1'), { responseCode: 553 });

// `wait` is injected everywhere so the suite never actually sleeps.
const opts = { wait: async () => {} };

test('a transient timeout recovers on the second attempt', () => {
  // The production case: 63 of 77 logged failures were "Connection timeout".
  const t = transportFailing(1, timeout());

  return sendWithRetry(t, { to: 'a@b.com' }, opts).then((info) => {
    assert.equal(info.messageId, 'ok');
    assert.equal(t.calls.count, 2);
  });
});

test('a 5xx rejection is NOT retried', async () => {
  // 553 is the server refusing this sender. Retrying cannot change the answer and
  // hammering the relay on a permanent reject is how a domain gets throttled.
  const t = transportFailing(99, rejected());

  await assert.rejects(() => sendWithRetry(t, { to: 'a@b.com' }, opts), /553/);
  assert.equal(t.calls.count, 1, 'a permanent rejection must be attempted exactly once');
});

test('exhausts three attempts then rethrows the last error', async () => {
  const t = transportFailing(99, timeout());

  const err = await sendWithRetry(t, { to: 'a@b.com' }, opts).catch(e => e);

  assert.equal(t.calls.count, 3);
  assert.equal(err.attempts, 3);
  assert.match(err.message, /Connection timeout/);
});

test('attempts is set to 1 on a permanent failure so email_log can tell them apart', async () => {
  const t = transportFailing(99, rejected());

  const err = await sendWithRetry(t, { to: 'a@b.com' }, opts).catch(e => e);

  assert.equal(err.attempts, 1);
});

test('a successful first attempt does not retry or delay', async () => {
  const t = transportFailing(0, timeout());
  let waited = false;

  await sendWithRetry(t, { to: 'a@b.com' }, { wait: async () => { waited = true; } });

  assert.equal(t.calls.count, 1);
  assert.equal(waited, false);
});

test('backs off between attempts rather than hammering immediately', async () => {
  // These sends run inside cron loops over every lease, so the delays must stay
  // bounded and must actually be applied in order.
  const t = transportFailing(2, timeout());
  const delays = [];

  await sendWithRetry(t, { to: 'a@b.com' }, { wait: async (ms) => { delays.push(ms); } });

  assert.deepEqual(delays, [1000, 3000]);
});

test('isTransient classifies the error families we actually see', () => {
  assert.equal(isTransient(timeout()), true);
  assert.equal(isTransient(rejected()), false);
  assert.equal(isTransient({ responseCode: 550, message: 'no such user' }), false);
  assert.equal(isTransient({ responseCode: 421, message: 'service unavailable' }), true);
  assert.equal(isTransient({ code: 'EAUTH', message: 'bad credentials' }), false);
  assert.equal(isTransient({ code: 'ECONNRESET', message: 'reset' }), true);
});

test('an unlabelled socket error is treated as transient', () => {
  // Bounded attempts make guessing wrong cheap; dropping a real invoice email
  // because the error had no code is not.
  assert.equal(isTransient(new Error('socket hang up')), true);
});
