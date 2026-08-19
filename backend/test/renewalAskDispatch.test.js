const test = require('node:test');
const assert = require('node:assert/strict');
const { nextAskDue, shouldEscalate, renewalAskChannel, MAX_ASKS } = require('../src/utils/renewalAsk');

// The scheduling rules that decide whether a real tenant gets a message today. Dates are
// fixed literals because every function takes `today` explicitly and never reads a clock.

test('the first ask is due when there is no history', () => {
  assert.deepEqual(nextAskDue([], { today: '2026-08-19' }), { due: true, ask_number: 1 });
});

test('a tenant is never messaged twice in one day, whatever the gap is set to', () => {
  const sentToday = [{ ask_number: 1, sent_at: '2026-08-19' }];
  for (const gapDays of [0, null, undefined, -5, '']) {
    const d = nextAskDue(sentToday, { today: '2026-08-19', gapDays });
    assert.equal(d.due, false, `gap ${JSON.stringify(gapDays)} must not allow a same-day second ask`);
    assert.equal(d.reason, 'too_soon');
  }
});

test('the configured gap is honoured, and the ask number advances', () => {
  const one = [{ ask_number: 1, sent_at: '2026-08-16' }];
  assert.equal(nextAskDue(one, { today: '2026-08-18', gapDays: 3 }).due, false);   // 2 days
  assert.deepEqual(nextAskDue(one, { today: '2026-08-19', gapDays: 3 }), { due: true, ask_number: 2 });
  const two = [...one, { ask_number: 2, sent_at: '2026-08-19' }];
  assert.deepEqual(nextAskDue(two, { today: '2026-08-22', gapDays: 3 }), { due: true, ask_number: 3 });
});

test('the sequence stops at three asks and hands over to staff', () => {
  const three = [
    { ask_number: 1, sent_at: '2026-08-10' },
    { ask_number: 2, sent_at: '2026-08-13' },
    { ask_number: 3, sent_at: '2026-08-16' },
  ];
  assert.equal(MAX_ASKS, 3);
  assert.equal(nextAskDue(three, { today: '2026-08-19', gapDays: 3 }).due, false, 'a fourth message must never be sent');
  assert.equal(nextAskDue(three, { today: '2026-08-19', gapDays: 3 }).reason, 'max_asks_reached');
  assert.equal(shouldEscalate(three, { today: '2026-08-19', gapDays: 3 }), true);
});

test('escalation happens once, not on every run', () => {
  const three = [
    { ask_number: 1, sent_at: '2026-08-10' },
    { ask_number: 2, sent_at: '2026-08-13' },
    { ask_number: 3, sent_at: '2026-08-16', escalated_at: '2026-08-19 10:00:00' },
  ];
  assert.equal(shouldEscalate(three, { today: '2026-08-20', gapDays: 3 }), false);
});

test('a reply ends the sequence and prevents escalation', () => {
  const withReply = [
    { ask_number: 1, sent_at: '2026-08-10', reply_intent: 1 },
    { ask_number: 2, sent_at: '2026-08-13' },
    { ask_number: 3, sent_at: '2026-08-16' },
  ];
  assert.equal(nextAskDue(withReply, { today: '2026-08-25', gapDays: 3, hasReply: true }).reason, 'already_replied');
  assert.equal(shouldEscalate(withReply, { today: '2026-08-25', gapDays: 3, hasReply: true }), false,
    'a tenant who answered must not then be escalated as unresponsive');
});

test('escalation waits for the last ask to have had its window', () => {
  const three = [
    { ask_number: 1, sent_at: '2026-08-13' },
    { ask_number: 2, sent_at: '2026-08-16' },
    { ask_number: 3, sent_at: '2026-08-19' },
  ];
  // Sent today: still their turn to reply.
  assert.equal(shouldEscalate(three, { today: '2026-08-19', gapDays: 3 }), false);
  assert.equal(shouldEscalate(three, { today: '2026-08-22', gapDays: 3 }), true);
});

test('channel is WhatsApp with a phone, email without, null when unreachable', () => {
  assert.equal(renewalAskChannel({ tenant_phone: '+85291234567', tenant_email: 'a@b.c' }), 'whatsapp');
  assert.equal(renewalAskChannel({ tenant_phone: null, tenant_email: 'a@b.c' }), 'email');
  assert.equal(renewalAskChannel({ tenant_phone: '   ', tenant_email: 'a@b.c' }), 'email');
  assert.equal(renewalAskChannel({ tenant_phone: '', tenant_email: '' }), null);
  assert.equal(renewalAskChannel({}), null);
});

test('the dispatcher does not route email through the helper that also sends WhatsApp', () => {
  // sendTemplateEmail fires a best-effort WhatsApp for the matching template type, and a
  // Renewal-Tenant WhatsApp template exists — so using it here would double-contact the
  // tenant. This asserts the dependency stays absent rather than trusting a comment.
  const raw = require('node:fs').readFileSync(require.resolve('../src/services/renewalAskDispatch'), 'utf8');
  // Strip comments: the module explains WHY it avoids those helpers, and the explanation
  // must not be mistaken for a call to them.
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.ok(!/sendTemplateEmail\s*\(/.test(src), 'renewal asks must not call sendTemplateEmail');
  assert.ok(!/sendTemplateWhatsApp\s*\(/.test(src), 'renewal asks must not call sendTemplateWhatsApp');
  assert.ok(/sendMail\s*\(|sendMailWithAccount\s*\(/.test(src), 'the email path should use the low-level mailer');
});

test('the legacy renewal email stands down when the ask flow is enabled', () => {
  // Both would ask the same tenant the same question. The gate lives in the scheduler so
  // the switchover is one flag, and reversible.
  const src = require('node:fs').readFileSync(require.resolve('../src/services/scheduler'), 'utf8');
  const fn = src.slice(src.indexOf('async function sendRenewalEmailsForOrg'));
  const body = fn.slice(0, fn.indexOf('\nasync function'));
  assert.ok(/renewal_ask_enabled/.test(body), 'the legacy email job must check the renewal-ask flag');
  assert.ok(/return;/.test(body.slice(0, body.indexOf('Find leases'))), 'and return before sending');
});

test('a failed send does not strand the tenant — the slot is an attempt, not a delivery', () => {
  // The row is written before the send, so a failure leaves a PENDING row occupying that
  // ask number. If scheduling counted only delivered asks, nothing could ever be inserted
  // for that slot again and the tenant would go permanently silent — asked zero times,
  // never escalated. Counting attempts is what prevents that.
  const failedFirstAsk = [{ ask_number: 1, attempted_on: '2026-08-16', sent_at: null }];
  assert.deepEqual(nextAskDue(failedFirstAsk, { today: '2026-08-19', gapDays: 3 }),
    { due: true, ask_number: 2 });

  const threeAttemptsNoneDelivered = [
    { ask_number: 1, attempted_on: '2026-08-10', sent_at: null },
    { ask_number: 2, attempted_on: '2026-08-13', sent_at: null },
    { ask_number: 3, attempted_on: '2026-08-16', sent_at: null },
  ];
  assert.equal(shouldEscalate(threeAttemptsNoneDelivered, { today: '2026-08-19', gapDays: 3 }), true,
    'a tenant we could never reach must still reach a human');
});

test('the channel is fixed for the whole cycle', () => {
  // Recomputing per ask would move a tenant from WhatsApp to email mid-sequence because
  // staff edited a phone number. The dispatcher reuses the first non-empty channel.
  const raw = require('node:fs').readFileSync(require.resolve('../src/services/renewalAskDispatch'), 'utf8');
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.ok(/priorChannel/.test(src), 'the dispatcher must reuse the cycle\'s existing channel');
  assert.ok(/history\.map\(h => h\.channel\)\.find\(Boolean\)/.test(src));
});

test('only live, started leases are messaged', () => {
  const raw = require('node:fs').readFileSync(require.resolve('../src/services/renewalAskDispatch'), 'utf8');
  for (const guard of ['l.status = 1', "l.lease_state = 'active'", 'l.start_date <= ?']) {
    assert.ok(raw.includes(guard), `candidate query must require ${guard}`);
  }
});

test('a send is NEVER retried — the slot resolves instead', () => {
  // A gateway call that throws is indistinguishable from one that was delivered and lost
  // its acknowledgement, so retrying can put the same message in front of a real tenant
  // twice. The slot is closed out as an attempt instead, which advances the sequence
  // without re-sending. This asserts the retry path stays absent.
  const raw = require('node:fs').readFileSync(require.resolve('../src/services/renewalAskDispatch'), 'utf8');
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.ok(!/MAX_SEND_ATTEMPTS/.test(src), 'no retry budget should exist');
  assert.ok(!/attempts\s*\+\s*1/.test(src), 'a stuck row must not be re-sent');
  assert.ok(/state = 'FAILED', resolved_on/.test(src), 'a stuck row is resolved, not retried');
  // And the resolve must be race-gated, so two runs cannot both count it.
  assert.ok(/affectedRows > 0/.test(src), 'the resolve should be conditional');
});

test('both the scheduled and the on-demand path require a live lease', () => {
  const dispatch = require('node:fs').readFileSync(require.resolve('../src/services/renewalAskDispatch'), 'utf8');
  const pub = require('node:fs').readFileSync(require.resolve('../src/routes/public'), 'utf8');
  const lease = pub.slice(pub.indexOf('async function currentLeaseForUnit'));
  const body = lease.slice(0, lease.indexOf('\n}'));
  for (const guard of ['l.status = 1', "l.lease_state = 'active'", 'l.start_date <=']) {
    assert.ok(dispatch.includes(guard), `scheduled path must require ${guard}`);
    assert.ok(body.includes(guard), `on-demand path must require ${guard}`);
  }
});

test('staff and partner reply paths share one implementation', () => {
  // Two entry points recording the same fact must apply the same staleness checks and the
  // same suppression. A rule enforced on one path only is not a rule, so both routes
  // delegate rather than each carrying its own copy of the logic.
  const pub = require('node:fs').readFileSync(require.resolve('../src/routes/public'), 'utf8');
  const adv = require('node:fs').readFileSync(require.resolve('../src/routes/advertising'), 'utf8');
  assert.ok(/recordRenewalReply\(/.test(pub), 'the partner route must delegate');
  assert.ok(/recordRenewalReply\(/.test(adv), 'the staff route must delegate');
  // Neither may re-implement the decision itself.
  assert.ok(!/applyRenewalReply\(/.test(pub), 'the partner route must not re-apply the decision');
  assert.ok(!/applyRenewalReply\(/.test(adv), 'the staff route must not re-apply the decision');

  const svc = require('../src/services/renewalReply');
  assert.equal(typeof svc.recordRenewalReply, 'function');
  // 'staying' stays accepted so an in-flight partner caller is not broken by the rename.
  assert.equal(svc.INTENTS.extend, 1);
  assert.equal(svc.INTENTS.staying, 1);
  assert.equal(svc.INTENTS.leaving, 2);
  assert.equal(svc.INTENTS.unsure, 3);
});

test('an ask with no operator wording is never invented and never stalls silently', () => {
  // The operator writes ask 3 themselves. Falling back to ask 1's words would send a
  // message they never approved; doing nothing would leave the sequence stuck. It
  // escalates instead.
  const raw = require('node:fs').readFileSync(require.resolve('../src/services/renewalAskDispatch'), 'utf8');
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.ok(!/settings\.renewal_ask_phrase\s*;/.test(src.replace(/PHRASE_COLUMN\[[^\]]+\]/g, 'X')),
    'no silent fallback to another ask\'s wording');
  assert.ok(/no_wording/.test(src), 'a missing phrase is counted and surfaced');
  assert.ok(/wording is not written/.test(raw), 'and staff are told which ask needs writing');
});

test('the default notice period matches the operator policy of 45 days', () => {
  const { renewalDecisionDueOn, DEFAULT_NOTICE_DAYS } = require('../src/utils/renewalAsk');
  assert.equal(DEFAULT_NOTICE_DAYS, 45);
  // A lease with nothing recorded is treated as 45 days, not 30.
  assert.equal(renewalDecisionDueOn('2026-09-25', null), '2026-08-11');
});

test('the partner polling path hands an ask out once and never re-offers it', () => {
  // The first version re-offered a claim after ten minutes so a crashed poller could not
  // strand an ask. That trade was wrong: if the partner sent the message and only the
  // acknowledgement was lost, re-offering messages the tenant twice. Unconfirmed claims
  // are resolved by the scheduler instead.
  const pub = require('node:fs').readFileSync(require.resolve('../src/routes/public'), 'utf8');
  const claim = pub.slice(pub.indexOf("SET claimed_at = ?, claim_token = ?"));
  const stmt = claim.slice(0, claim.indexOf('`'));
  assert.ok(/claimed_at IS NULL/.test(stmt), 'only unclaimed asks may be handed out');
  assert.ok(!/DATE_SUB/.test(stmt), 'a claim must not expire back into the queue');
  assert.ok(!/RENEWAL_CLAIM_MINUTES/.test(pub.replace(/\/\/.*$/gm, '')), 'the expiry window should be gone');
});
