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

test('a definite reply ends the sequence and prevents escalation', () => {
  const withReply = [
    { ask_number: 1, sent_at: '2026-08-10', reply_intent: 1 },
    { ask_number: 2, sent_at: '2026-08-13' },
    { ask_number: 3, sent_at: '2026-08-16' },
  ];
  assert.equal(nextAskDue(withReply, { today: '2026-08-25', gapDays: 3, hasDefiniteReply: true }).reason, 'already_replied');
  assert.equal(shouldEscalate(withReply, { today: '2026-08-25', gapDays: 3, hasDefiniteReply: true }), false,
    'a tenant who answered must not then be escalated as unresponsive');
});

test('an UNSURE reply does not end the sequence — we keep monitoring', () => {
  // The relay cannot tell a tenant's answer from an unrelated message and deliberately
  // does not try, so an ask landing mid-conversation gets "ok thanks" filed against it and
  // classified `unsure`. If that closed the sequence, the tenant would be recorded as
  // answered, never asked again, and never escalated — silent on all three counts.
  const vague = [{ ask_number: 1, sent_at: '2026-08-10', reply_intent: 3 }];
  const due = nextAskDue(vague, { today: '2026-08-19', gapDays: 3, hasDefiniteReply: false });
  assert.equal(due.due, true, 'ask 2 must still go out after a vague answer');
  assert.equal(due.ask_number, 2);

  // …and three vague answers still reach a human rather than stopping quietly.
  const threeVague = [
    { ask_number: 1, sent_at: '2026-08-10', reply_intent: 3 },
    { ask_number: 2, sent_at: '2026-08-13', reply_intent: 3 },
    { ask_number: 3, sent_at: '2026-08-16', reply_intent: 3 },
  ];
  assert.equal(shouldEscalate(threeVague, { today: '2026-08-20', gapDays: 3, hasDefiniteReply: false }), true);
});

test('the dispatcher classifies its own history, and unsure leases stay in the pool', () => {
  const { isDefiniteReply } = require('../src/utils/renewalAsk');
  assert.equal(isDefiniteReply(null), false);
  assert.equal(isDefiniteReply(3), false);
  assert.equal(isDefiniteReply('3'), false, 'mysql2 may hand back a string');
  assert.equal(isDefiniteReply(1), true);
  assert.equal(isDefiniteReply(2), true);
  assert.equal(isDefiniteReply(9), true, 'an unknown code must stop us messaging, not start us');

  // The SQL gate has to agree with the code gate, or the lease is filtered out before
  // eligibility is ever consulted and the remaining asks silently never happen.
  const src = require('node:fs').readFileSync(require.resolve('../src/services/renewalAskDispatch'), 'utf8');
  const stripped = src.replace(/--.*$/gm, '');
  assert.ok(/renewal_reply IS NULL OR l\.renewal_reply = 3/.test(stripped),
    'the candidate query must keep unsure leases in the pool');
  assert.ok(!/hasReply\b/.test(src), 'the ambiguous flag name should be gone');
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

test('the partner cannot consume an ask, and has nothing to send', () => {
  // Tenafy is the only sender (operator decision, 2026-08-19). Two behaviours follow, and
  // both are load-bearing:
  //
  //   1. Reading /pending must not claim. It used to, which meant a partner merely LOOKING
  //      at the list spent the ask — and since they were not the sender, the tenant was
  //      never asked while the slot was counted as used.
  //   2. The rendered message must not leave the building. If it is in the payload, a
  //      future engineer on either side can wire up a second sender by accident, and the
  //      failure mode is a tenant asked the same question twice.
  const pub = require('node:fs').readFileSync(require.resolve('../src/routes/public'), 'utf8');
  const code = pub.replace(/\/\/.*$/gm, '');

  assert.ok(!/SET claimed_at\s*=/.test(code), 'reading the pending list must not claim anything');
  assert.ok(!/claim_token\s*=\s*\?/.test(code), 'the claim token must no longer be written');

  // The /pending SELECT names its columns explicitly; `message` must not be among them.
  const sel = code.slice(code.indexOf('SELECT r.id, r.state'));
  assert.ok(sel.startsWith('SELECT r.id, r.state'), 'pending select not found — update this test');
  const stmt = sel.slice(0, sel.indexOf('`'));
  assert.ok(!/r\.message/.test(stmt), 'the rendered ask must not be handed to the partner');

  // …nor smuggled out through the shared row shaper.
  const shaper = code.slice(code.indexOf('function renewalAskRow'));
  assert.ok(!/message:/.test(shaper.slice(0, shaper.indexOf('\n}'))),
    'renewalAskRow must not expose the message');

  // And the demand trigger sends, rather than handing the text back to be sent.
  assert.ok(/deliverRenewalAsk\(/.test(code), 'the demand-triggered ask must dispatch here');
});

// ── One open question per conversation ───────────────────────────────────────
//
// A tenant renting two units can hit both notice periods in the same week. Asked about both
// at once, their "yes we'd like to stay" arrives on one WhatsApp thread referring to neither
// message, and writing it to the wrong lease is a renewal decision invented out of nothing.

const { conflictingOpenAsk, conversationKey } = require('../src/utils/renewalAsk');

test('conversationKey treats the same number written four ways as one conversation', () => {
  const forms = ['9123 4567', '+852 9123 4567', '85291234567', '(852)9123-4567'];
  const keys = new Set(forms.map(conversationKey));
  assert.equal(keys.size, 1, `expected one key, got ${[...keys].join(', ')}`);
  assert.equal(conversationKey(''), null);
  assert.equal(conversationKey(null), null);
  // Short/partial numbers are not padded into a false match.
  assert.equal(conversationKey('1234'), '1234');
});

test('a second lease waits while the same tenant has an open ask', () => {
  const open = [{ id: 'a1', lease_id: '10', tenant_id: '77', tenant_phone: '+852 9123 4567' }];

  // Same tenant, different lease → blocked.
  const blocked = conflictingOpenAsk(open, { lease_id: '11', tenant_id: '77', tenant_phone: '91234567' });
  assert.equal(blocked && blocked.id, 'a1');

  // Same PHONE but a different tenant row — the couple case, and the one a tenant_id-only
  // check would miss.
  const samePhone = conflictingOpenAsk(open, { lease_id: '12', tenant_id: '88', tenant_phone: '9123 4567' });
  assert.equal(samePhone && samePhone.id, 'a1');

  // The same PERSON on two numbers is two threads, and deliberately not a conflict. The check
  // and the lock must agree on identity or both sides proceed — so identity is the thread, and
  // a reply on either number is unambiguous even though one human owns both.
  assert.equal(conflictingOpenAsk(open, { lease_id: '13', tenant_id: '77', tenant_phone: '98765432' }), null);

  // Same email, no phone on either side.
  const byEmail = conflictingOpenAsk(
    [{ id: 'a2', lease_id: '10', tenant_id: '77', tenant_email: 'Sam@Example.com' }],
    { lease_id: '11', tenant_id: '88', tenant_email: ' sam@example.com ' });
  assert.equal(byEmail && byEmail.id, 'a2');

  // A different tenant entirely → not blocked.
  assert.equal(conflictingOpenAsk(open, { lease_id: '11', tenant_id: '99', tenant_phone: '98765432' }), null);

  // THE SAME lease is never a conflict: asks 2 and 3 are the same question repeated, and
  // blocking on them would stop every sequence after its first message.
  assert.equal(conflictingOpenAsk(open, { lease_id: '10', tenant_id: '77', tenant_phone: '91234567' }), null);

  // Nothing outstanding, or nothing to compare.
  assert.equal(conflictingOpenAsk([], { lease_id: '11', tenant_id: '77' }), null);
  assert.equal(conflictingOpenAsk(open, null), null);
});

test('an escalated cycle stops blocking the tenant\'s other lease', () => {
  // Three asks went unanswered and a person took over. Those rows stay SENT-and-unanswered
  // for good, so treating them as outstanding would block this tenant's second lease
  // FOREVER — one silent tenant costing us a question we then never ask about a different
  // unit. The partner's correlation list still carries them, because a late reply must
  // still be attributable to something.
  const escalated = [{
    id: 'a1', lease_id: '10', tenant_id: '77', tenant_phone: '91234567',
    escalated_at: '2026-08-25 10:00:00',
  }];
  assert.equal(conflictingOpenAsk(escalated, { lease_id: '11', tenant_id: '77', tenant_phone: '91234567' }), null);

  // …but an unescalated one still blocks.
  const live = [{ ...escalated[0], escalated_at: null }];
  assert.ok(conflictingOpenAsk(live, { lease_id: '11', tenant_id: '77', tenant_phone: '91234567' }));

  // The list the check reads must actually carry the column, or the filter is dead code.
  const disp = require('node:fs').readFileSync(require.resolve('../src/services/renewalAskDispatch'), 'utf8');
  const sel = disp.slice(disp.indexOf('async function openAsks'));
  assert.ok(/r\.escalated_at/.test(sel.slice(0, sel.indexOf('`,'))),
    'openAsks must select escalated_at');
});

test('both creation paths enforce the rule, and the loop re-reads it', () => {
  // Enforced in only one place, it is not enforced: the demand trigger and the nightly job
  // both open asks. And the nightly job must re-read inside the loop — a tenant with two
  // leases is two candidates in the SAME run, so a list loaded once would let both through.
  const disp = require('node:fs').readFileSync(require.resolve('../src/services/renewalAskDispatch'), 'utf8');
  const pub = require('node:fs').readFileSync(require.resolve('../src/routes/public'), 'utf8');
  assert.ok(/conflictingOpenAsk\(/.test(disp), 'the nightly job must check');
  assert.ok(/conflictingOpenAsk\(/.test(pub), 'the demand trigger must check');
  const loop = disp.slice(disp.indexOf('for (const lease of candidates)'));
  assert.ok(/conflictingOpenAsk\(await openAsks\(/.test(loop),
    'the open-ask list must be re-read inside the loop, not hoisted out of it');
});

test('the ask id rides with the message, but only once the partner accepts it', () => {
  // Attribution: a tenant's "yes" on WhatsApp does not say which message it answers, so the
  // id travels out with the ask. Off by default — an unrecognised key at a live gateway would
  // risk viewing-relay traffic, which goes through the same call.
  const { sendOriginEnabled } = require('../src/services/whatsappService');
  const prior = process.env.WHATSAPP_SEND_ORIGIN;
  try {
    delete process.env.WHATSAPP_SEND_ORIGIN;
    assert.equal(sendOriginEnabled(), false, 'must default to the payload we know works');
    process.env.WHATSAPP_SEND_ORIGIN = '0';
    assert.equal(sendOriginEnabled(), false);
    process.env.WHATSAPP_SEND_ORIGIN = '1';
    assert.equal(sendOriginEnabled(), true);
  } finally {
    if (prior === undefined) delete process.env.WHATSAPP_SEND_ORIGIN;
    else process.env.WHATSAPP_SEND_ORIGIN = prior;
  }

  const wa = require('node:fs').readFileSync(require.resolve('../src/services/whatsappService'), 'utf8');
  assert.ok(/body\.origin = \{ type: String\(origin\.type\), id: String\(origin\.id\) \}/.test(wa),
    'the origin must be the agreed generic shape');
  const disp = require('node:fs').readFileSync(require.resolve('../src/services/renewalAskDispatch'), 'utf8');
  assert.ok(/type: 'renewal_ask', id: askId/.test(disp), 'the renewal ask must tag itself');
});

test('the open-ask list is correlation, not a work queue', () => {
  // One definition of "outstanding", shared by the partner list and the serialisation rule.
  // Two would drift, and the partner would be told an ask was answerable that we had already
  // stopped counting.
  const disp = require('node:fs').readFileSync(require.resolve('../src/services/renewalAskDispatch'), 'utf8');
  const q = disp.slice(disp.indexOf('async function openAsks'));
  const sql = q.slice(0, q.indexOf('`,'));
  assert.ok(!/r\.message/.test(sql), 'the rendered ask must not reappear here');
  assert.ok(/reply_intent IS NOT NULL AND d\.reply_intent <> 3/.test(sql),
    'a cycle closes on a DEFINITE reply only — an unsure must stay findable so it can be superseded');
  assert.ok(/n\.ask_number > r\.ask_number/.test(sql),
    'one row per cycle: an earlier ask is not what a reply answers');
  assert.ok(!/UPDATE |INSERT /.test(sql), 'reading it must change nothing');
});

test('the open-ask endpoint delegates rather than writing its own query', () => {
  // It exists because a SENT ask appears on no other list, so the partner had no way to learn
  // an id and their relay would have run silently finding nothing. It must not become the
  // send queue we just removed: no message text, and no writes.
  const pub = require('node:fs').readFileSync(require.resolve('../src/routes/public'), 'utf8');
  const code = pub.replace(/\/\/.*$/gm, '');
  const at = code.indexOf("router.get('/renewal-asks/open'");
  assert.ok(at > 0, 'the endpoint must exist');
  const body = code.slice(at, code.indexOf('} catch', at));
  assert.ok(/openRenewalAsks\(req\.pool/.test(body), 'it must use the shared definition');
  assert.ok(!/SELECT /.test(body), 'a second query here would drift from the rule it reports on');
});

test('creation is serialised by a real lock, not by comparing ids', () => {
  // The first attempt inserted and then broke ties on the Snowflake id, assuming the older ask
  // wins. That is unsound: the LOWER id may commit SECOND. The higher-id racer re-reads, sees
  // nothing older, sends; the lower-id racer re-reads, sees only something newer, and sends
  // too. Both tenants messaged. Id order is not commit order, so the check and the insert have
  // to happen inside a lock.
  const { withConversationLock } = require('../src/services/renewalAskDispatch');
  const ra = require('../src/utils/renewalAsk');
  assert.equal(typeof withConversationLock, 'function');
  assert.equal(ra.losesRaceTo, undefined, 'the unsound tie-break must be gone, not just unused');

  for (const f of ['../src/routes/public', '../src/services/renewalAskDispatch']) {
    const src = require('node:fs').readFileSync(require.resolve(f), 'utf8');
    // The CALL site, not the definition — searching for the bare name finds the function
    // declaration in the dispatcher and the assertions below would inspect the wrong code.
    const at = src.indexOf('await withConversationLock(');
    assert.ok(at > 0, `${f} must take the lock`);
    // The conflict check AND the insert must both sit inside the callback.
    const section = src.slice(at, at + 2600);
    const checkAt = section.indexOf('conflictingOpenAsk(');
    const insertAt = section.indexOf('INSERT INTO renewal_ask');
    assert.ok(checkAt > 0 && insertAt > 0, `${f}: both must be inside the locked section`);
    assert.ok(checkAt < insertAt, `${f}: the check must precede the insert`);
    // …and they must use the locked CONNECTION, not the pool: a lock on one connection does
    // nothing for work done on another.
    assert.ok(/conflictingOpenAsk\(\s*\n?\s*await open\w*\(conn/.test(section)
      || /openAsks\(conn/.test(section) || /openRenewalAsks\(conn/.test(section),
      `${f}: the check must run on the locked connection`);
    assert.ok(/conn\.execute\(\s*\n?\s*`INSERT INTO renewal_ask/.test(section),
      `${f}: the insert must run on the locked connection`);
  }
});

test('failing to take the lock defers the ask rather than sending', () => {
  // The safe direction. Skipping a tenant this hour costs a few hours; asking them twice about
  // their own home cannot be undone.
  const src = require('node:fs').readFileSync(require.resolve('../src/services/renewalAskDispatch'), 'utf8');
  const fn = src.slice(src.indexOf('async function withConversationLock'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.ok(/GET_LOCK\(\?, \?\)/.test(body), 'the lock must be named and time-bounded');
  assert.ok(/Number\(got\.got\) !== 1/.test(body), 'a failed acquisition must be detected');
  assert.ok(/finally \{[\s\S]*RELEASE_LOCK/.test(body), 'the lock must be released even on throw');
  assert.ok(/finally \{[\s\S]*conn\.release\(\)/.test(body), 'the connection must go back to the pool');

  const pub = require('node:fs').readFileSync(require.resolve('../src/routes/public'), 'utf8');
  assert.ok(/if \(!claim\.locked\)[\s\S]{0,220}conversation_busy/.test(pub),
    'the route must defer when the lock is unavailable');
  assert.ok(/if \(!claim\.locked \|\| claim\.value\?\.deferred\)/.test(src),
    'the nightly job must defer too');
});

test('the correlation list excludes undelivered asks; the serialisation rule includes them', () => {
  // A reply cannot be about a message that never arrived, so the partner must not be offered
  // one — a stray "ok thanks" would otherwise be filed against an ask the tenant never saw.
  // The serialisation rule needs the opposite: an ask mid-send still owns the conversation.
  const disp = require('node:fs').readFileSync(require.resolve('../src/services/renewalAskDispatch'), 'utf8');
  const fn = disp.slice(disp.indexOf('async function openAsks'));
  const sql = fn.slice(0, fn.indexOf('`,'));
  assert.ok(/deliveredOnly \? 'sent_at IS NOT NULL'/.test(fn.slice(0, fn.indexOf('pool.execute'))),
    'the delivered predicate must be selectable');
  // Interpolated in BOTH places: a failed ask 2 must not hide a delivered ask 1 by being newer.
  assert.equal((sql.match(/\$\{delivered\}/g) || []).length, 2,
    'the predicate must narrow the newest-ask subquery too, or a cycle disappears from the list');

  const pub = require('node:fs').readFileSync(require.resolve('../src/routes/public'), 'utf8');
  const at = pub.indexOf("router.get('/renewal-asks/open'");
  assert.ok(/deliveredOnly: true/.test(pub.slice(at, at + 1200)), 'the partner list must be delivered-only');
  // …and the conflict checks must NOT be, or an in-flight ask stops blocking.
  for (const call of pub.match(/openRenewalAsks\(req\.pool, orgId[^)]*\)/g) || []) {
    assert.ok(!/deliveredOnly/.test(call), `the serialisation check must include in-flight asks: ${call}`);
  }
});

test('both racers derive the same lock name from the same conversation', () => {
  // If the two sides name the lock differently they take different locks and both proceed,
  // which is precisely the failure the lock exists to prevent. So the key must be derived the
  // same way from either lease, whatever shape the phone number is stored in.
  const { conversationLockKey } = require('../src/utils/renewalAsk');
  const a = conversationLockKey({ lease_id: '10', tenant_phone: '+852 9123 4567' });
  const b = conversationLockKey({ lease_id: '11', tenant_phone: '91234567' });
  assert.equal(a, b, 'the same number written two ways must lock the same conversation');

  // An email-only tenant has an inbox, which is equally one conversation.
  const e1 = conversationLockKey({ lease_id: '10', tenant_email: 'Sam@Example.com' });
  const e2 = conversationLockKey({ lease_id: '11', tenant_email: ' sam@example.com ' });
  assert.equal(e1, e2);
  assert.notEqual(e1, conversationLockKey({ lease_id: '12', tenant_email: 'other@example.com' }));

  // Phone wins over email, so a tenant reachable both ways still has ONE key.
  assert.equal(conversationLockKey({ lease_id: '10', tenant_phone: '91234567', tenant_email: 'sam@example.com' }), a);

  // Unreachable: a stable name that serialises nothing, rather than a null lock that would
  // silently skip the critical section.
  assert.equal(conversationLockKey({ lease_id: '13' }), 'l13');
  assert.equal(conversationLockKey(null), null);

  // Comfortably inside MySQL's 64-character lock-name cap once prefixed with the org id.
  for (const k of [a, e1, 'l13']) assert.ok(String(k).length <= 24, `key too long: ${k}`);
});

test('the conflict check and the lock cannot disagree about identity', () => {
  // If they could, both sides would take their own lock, both would see a clear conversation,
  // and both would send. An earlier version matched tenant id OR phone OR email while the lock
  // named only the first — so two tenant records sharing an email but holding different phones
  // raced. Both now derive from the one function.
  const src = require('node:fs').readFileSync(require.resolve('../src/utils/renewalAsk'), 'utf8');
  const fn = src.slice(src.indexOf('function conflictingOpenAsk'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.ok(/conversationLockKey\(ask\) === key/.test(body),
    'the conflict check must compare the same key the lock is named for');
  assert.ok(!/tenant_id/.test(body), 'no second identity may creep back in');
  assert.ok(!/tenant_email/.test(body) && !/tenant_phone/.test(body),
    'contact fields belong in conversationLockKey, not here');
});
