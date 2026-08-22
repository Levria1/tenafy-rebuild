const test = require('node:test');
const assert = require('node:assert/strict');

const {
  REPLY_EXTEND, REPLY_LEAVING, REPLY_UNSURE, renewalAskStatus,
} = require('../src/utils/renewalAsk');
const { buildRenewalDigest } = require('../src/services/scheduler');

test('renewalAskStatus marks definite extend plus applied as paperwork due', () => {
  assert.equal(renewalAskStatus({
    reply_intent: REPLY_EXTEND, reply_applied: 1, escalated: 0, asks_delivered: 1, slots_used: 1,
  }), 'extend_pending_paperwork');
});

test('renewalAskStatus marks definite extend plus not applied as stale lease check', () => {
  assert.equal(renewalAskStatus({
    reply_intent: REPLY_EXTEND, reply_applied: 0, escalated: 0, asks_delivered: 1, slots_used: 1,
  }), 'replied_but_stale_check_lease');
});

test('renewalAskStatus marks definite leaving plus applied as review needed', () => {
  assert.equal(renewalAskStatus({
    reply_intent: REPLY_LEAVING, reply_applied: 1, escalated: 0, asks_delivered: 1, slots_used: 1,
  }), 'replied_needs_review');
});

test('renewalAskStatus does not treat unsure as an answer while asks are delivered', () => {
  assert.equal(renewalAskStatus({
    reply_intent: REPLY_UNSURE, reply_applied: 1, escalated: 0, asks_delivered: 1, slots_used: 1,
  }), 'awaiting_reply');
});

test('renewalAskStatus escalates unsure replies after the ask sequence', () => {
  assert.equal(renewalAskStatus({
    reply_intent: REPLY_UNSURE, reply_applied: 1, escalated: 1, asks_delivered: 3, slots_used: 3,
  }), 'no_answer_call_them');
});

test('renewalAskStatus escalates no reply after the ask sequence', () => {
  assert.equal(renewalAskStatus({
    reply_intent: null, reply_applied: null, escalated: 1, asks_delivered: 3, slots_used: 3,
  }), 'no_answer_call_them');
});

test('renewalAskStatus marks no delivered asks with used slots as unreachable', () => {
  assert.equal(renewalAskStatus({
    reply_intent: null, reply_applied: null, escalated: 0, asks_delivered: 0, slots_used: 2,
  }), 'could_not_reach_them');
});

test('renewalAskStatus leaves no reply with delivered asks awaiting reply', () => {
  assert.equal(renewalAskStatus({
    reply_intent: null, reply_applied: null, escalated: 0, asks_delivered: 1, slots_used: 1,
  }), 'awaiting_reply');
});

test('renewalAskStatus tolerates string inputs from mysql2', () => {
  assert.equal(renewalAskStatus({
    reply_intent: '1', reply_applied: '1', escalated: '0', asks_delivered: '1', slots_used: '1',
  }), 'extend_pending_paperwork');
  assert.equal(renewalAskStatus({
    reply_intent: null, reply_applied: null, escalated: '1', asks_delivered: '3', slots_used: '3',
  }), 'no_answer_call_them');
});

test('buildRenewalDigest skips when only awaiting replies exist', () => {
  const digest = buildRenewalDigest([
    { reply_intent: null, escalated: 0, asks_delivered: 1, slots_used: 1 },
  ]);
  assert.equal(digest.shouldSend, false);
  assert.equal(digest.awaitingCount, 1);
});

test('buildRenewalDigest sends when section 1 has content', () => {
  const digest = buildRenewalDigest([
    {
      reply_intent: REPLY_EXTEND,
      reply_applied: 1,
      escalated: 0,
      asks_delivered: 1,
      slots_used: 1,
      property_name: 'Hollywood Road',
      unit_name: '1B',
      tenant_name: 'Ada Tenant',
      lease_end: '2026-09-30',
    },
  ]);
  assert.equal(digest.shouldSend, true);
  assert.equal(digest.subject, 'Renewals: 1 confirmation awaiting paperwork');
  assert.match(digest.html, /Hollywood Road 1B/);
});

test('buildRenewalDigest subject reflects the first non-empty section', () => {
  const digest = buildRenewalDigest([
    {
      reply_intent: REPLY_LEAVING,
      reply_applied: 1,
      escalated: 0,
      asks_delivered: 1,
      slots_used: 1,
    },
  ]);
  assert.equal(digest.shouldSend, true);
  assert.equal(digest.subject, 'Renewals: 1 tenant is leaving');
});

// ---------------------------------------------------------------------------
// Review additions.
// ---------------------------------------------------------------------------

test('the subject pluralises — it is the only line read before deciding to open', () => {
  const confirmed = (n) => buildRenewalDigest(
    Array.from({ length: n }, (_, i) => ({
      reply_intent: 1, reply_applied: '1',
      property_name: 'Poplar', unit_name: `${i}A`, tenant_name: 'T', lease_end: '2026-09-30',
    }))
  ).subject;
  assert.equal(confirmed(1), 'Renewals: 1 confirmation awaiting paperwork');
  assert.equal(confirmed(3), 'Renewals: 3 confirmations awaiting paperwork');

  const leaving = (n) => buildRenewalDigest(
    Array.from({ length: n }, (_, i) => ({
      reply_intent: 2, reply_applied: '1',
      property_name: 'Poplar', unit_name: `${i}B`, tenant_name: 'T', lease_end: '2026-09-30',
    }))
  ).subject;
  assert.equal(leaving(1), 'Renewals: 1 tenant is leaving');
  assert.equal(leaving(2), 'Renewals: 2 tenants are leaving');
});

test('tenant-supplied text cannot inject markup into the email', () => {
  // Property, unit and tenant names are operator-entered and the stale reason is
  // internal, but reply text and names both reach this HTML. Escaping is the only
  // thing between a name containing a tag and a broken (or hostile) email body.
  const digest = buildRenewalDigest([{
    reply_intent: 1, reply_applied: '1',
    property_name: '<script>alert(1)</script>',
    unit_name: '5A',
    tenant_name: 'Bobby <b>Tables</b> & Co',
    lease_end: '2026-09-30',
  }]);
  assert.ok(!digest.html.includes('<script>'), 'raw script tag reached the body');
  assert.ok(digest.html.includes('&lt;script&gt;'));
  assert.ok(digest.html.includes('&amp;'), 'ampersand must be escaped, not left bare');
});

test('a row awaiting reply is counted, never listed', () => {
  // Listing them would make the email mostly noise: they are not actionable, and
  // the whole point of the digest is that every line is a job.
  const digest = buildRenewalDigest([
    { reply_intent: 1, reply_applied: '1', property_name: 'P', unit_name: '1A', tenant_name: 'A', lease_end: '2026-09-30' },
    { reply_intent: null, escalated: '0', asks_delivered: '1', slots_used: '1', property_name: 'P', unit_name: '2A', tenant_name: 'B' },
    { reply_intent: 3, escalated: '0', asks_delivered: '1', slots_used: '1', property_name: 'P', unit_name: '3A', tenant_name: 'C' },
  ]);
  assert.equal(digest.awaitingCount, 2, 'unsure is not an answer and counts as awaiting');
  assert.equal(digest.actionCount, 1);
  assert.ok(digest.html.includes('2 more awaiting a reply'));
  assert.ok(!digest.html.includes('2A'), 'awaiting rows must not be listed');
  assert.ok(!digest.html.includes('3A'));
});

test('tripwire: delivery is counted from sent_at, not from current state', () => {
  // A renewal_ask moves SENT -> REPLIED when the tenant answers. Counting
  // state='SENT' therefore reported every answered ask as never delivered, and a
  // tenant whose only reply was vague ("I'll check when I'm back") was classified
  // could_not_reach_them — the exact opposite of what happened. Found on live data:
  // Hollywood 1B, a tenant who had written back twice.
  //
  // A tripwire because the expression lives in SQL. It pins both call sites, which
  // must agree or the weekly email and the Vacancy page will label the same lease
  // differently.
  const fs = require('node:fs');
  const path = require('node:path');
  for (const rel of ['../src/routes/advertising.js', '../src/services/scheduler.js']) {
    const src = fs.readFileSync(path.join(__dirname, rel), 'utf8');
    const line = src.split('\n').find(l => l.includes('AS asks_delivered'));
    assert.ok(line, `asks_delivered not found in ${rel}`);
    assert.match(line, /sent_at IS NOT NULL/, `${rel} counts state instead of delivery`);
    assert.ok(!/state\s*=\s*'SENT'/.test(line), `${rel} still counts state='SENT'`);
  }
});

test('a delivered ask that has been answered is not "could not reach them"', () => {
  // The behavioural half of the tripwire above: given a correctly-counted row, a
  // vague reply reads as still awaiting an answer, never as unreachable.
  assert.equal(
    require('../src/utils/renewalAsk').renewalAskStatus({
      reply_intent: 3, reply_applied: '1', escalated: '0', asks_delivered: '1', slots_used: '1',
    }),
    'awaiting_reply'
  );
  // And the genuine unreachable case still works: rows exist, none was delivered.
  assert.equal(
    require('../src/utils/renewalAsk').renewalAskStatus({
      reply_intent: null, escalated: '0', asks_delivered: '0', slots_used: '2',
    }),
    'could_not_reach_them'
  );
});
