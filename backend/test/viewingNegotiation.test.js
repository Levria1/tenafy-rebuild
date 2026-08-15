const test = require('node:test');
const assert = require('node:assert');
const {
  DEFAULT_SETTING, STATE_AUTO_CONFIRMED, STATE_TENANT_REVERSED, STATE_RESCHEDULE_AFTER_COMMIT,
  TERMINAL_STATES, CLOSED_STATES,
  DRAFT_FRESH_MINUTES,
  combineDateTime, minutesOf, withinWindow, withinQuietHours, viewingWindow, nextStep, buildRouting,
  resolvePolicy, optOutDeadline, autoConfirmDecision, nudgeDecision, reversalClassification,
  sendModeFor, idempotencyKeyFor, reminderTarget, activeNegotiationPayload, draftQueryOptions,
} = require('../src/services/viewingNegotiationLogic');
const viewingService = require('../src/services/viewingNegotiation');

// A fixed far-future weekday base so "in the past" never trips these tests.
// 2099-01-06 is a Tuesday; 2099-01-04 is a Sunday.
const S = DEFAULT_SETTING;

test('combineDateTime: accepts date+time, datetime, when; rejects junk', () => {
  assert.equal(combineDateTime({ date: '2099-01-06', time: '17:00' }), '2099-01-06T17:00:00');
  assert.equal(combineDateTime({ datetime: '2099-01-06T09:30' }), '2099-01-06T09:30:00');
  assert.equal(combineDateTime({ when: '2099-01-06 9:05' }), '2099-01-06T09:05:00'); // pads hour, space sep
  assert.equal(combineDateTime({}), null);
  assert.equal(combineDateTime(null), null);
  assert.equal(combineDateTime({ date: 'tomorrow' }), null);
});

test('minutesOf: HH:mm → minutes', () => {
  assert.equal(minutesOf('11:00:00'), 660);
  assert.equal(minutesOf('19:00'), 1140);
  assert.equal(minutesOf(''), 0);
});

test('withinWindow: enforces days + open/close + not-in-past', () => {
  assert.equal(withinWindow('2099-01-06T17:00:00', S), null);              // Tue 5pm OK
  assert.equal(withinWindow('2099-01-06T09:00:00', S), 'Before opening time');
  assert.equal(withinWindow('2099-01-06T18:45:00', S), 'After closing time'); // 18:45+30 > 19:00
  assert.equal(withinWindow('2099-01-04T12:00:00', S), 'Outside viewing days'); // Sunday
  assert.equal(withinWindow('2000-01-04T12:00:00', S), 'In the past');
  assert.equal(withinWindow('not-a-date', S), 'Invalid date/time');
});

test('withinWindow: custom viewing_days honoured (Sunday-only org)', () => {
  const sunOnly = { ...S, viewing_days: '0' };
  assert.equal(withinWindow('2099-01-04T12:00:00', sunOnly), null);       // Sunday allowed
  assert.equal(withinWindow('2099-01-06T12:00:00', sunOnly), 'Outside viewing days'); // Tuesday not
});

test('draftQueryOptions: defaults with an empty query', () => {
  assert.deepEqual(draftQueryOptions({}), { limit: 50, maxAgeMinutes: DRAFT_FRESH_MINUTES, party: null });
});

test('draftQueryOptions: limit clamps and non-numeric falls back', () => {
  assert.equal(draftQueryOptions({ limit: '0' }).limit, 1);
  assert.equal(draftQueryOptions({ limit: '9999' }).limit, 200);
  assert.equal(draftQueryOptions({ limit: 'many' }).limit, 50);
});

test('draftQueryOptions: max_age_hours clamps and non-numeric falls back', () => {
  assert.equal(draftQueryOptions({ max_age_hours: '0' }).maxAgeMinutes, DRAFT_FRESH_MINUTES);
  assert.equal(draftQueryOptions({ max_age_hours: '99999' }).maxAgeMinutes, DRAFT_FRESH_MINUTES);
  assert.equal(draftQueryOptions({ max_age_hours: 'many' }).maxAgeMinutes, DRAFT_FRESH_MINUTES);
  // A caller may still narrow the window; only widening is refused.
  assert.equal(draftQueryOptions({ max_age_hours: '0.25' }).maxAgeMinutes, 15);
});

test('draftQueryOptions: party only accepts TaneChat-sendable parties', () => {
  assert.equal(draftQueryOptions({ party: 'prospect' }).party, 'prospect');
  assert.equal(draftQueryOptions({ party: 'tenant' }).party, 'tenant');
  assert.equal(draftQueryOptions({ party: '' }).party, null);
  // `staff` is rejected deliberately: staff alerts are internal and must never
  // be handed to TaneChat to send into a customer thread.
  assert.equal(draftQueryOptions({ party: 'staff' }).party, null);
});

// ── nextStep transitions ─────────────────────────────────────────────────────
const NS = (state, party, intent, roundCount = 0, maxRounds = 3) =>
  nextStep({ state, party, intent, roundCount, maxRounds });

test('nextStep: prospect proposes a day → staff_check', () => {
  assert.deepEqual(
    NS('ASK_PROSPECT_DAY', 'prospect', { when: '2099-01-06T17:00:00' }),
    { type: 'staff_check', when: '2099-01-06T17:00:00', proposedBy: 'prospect', confirmOnFree: false, roundDelta: 0 }
  );
});

test('nextStep: unparseable prospect day → reprompt', () => {
  assert.deepEqual(NS('ASK_PROSPECT_DAY', 'prospect', { when: null }), { type: 'reprompt_day' });
});

test('nextStep: tenant accepts → confirm', () => {
  assert.deepEqual(NS('AWAIT_TENANT', 'tenant', { accepted: true }), { type: 'confirm' });
});

test('nextStep: tenant counters → relay to prospect (round++)', () => {
  assert.deepEqual(
    NS('AWAIT_TENANT', 'tenant', { accepted: false, when: '2099-01-07T15:00:00' }),
    { type: 'relay_to_prospect', when: '2099-01-07T15:00:00', proposedBy: 'tenant', roundDelta: 1 }
  );
});

test('nextStep: tenant declines with no time → ask for alternative', () => {
  assert.deepEqual(NS('AWAIT_TENANT', 'tenant', { accepted: false }), { type: 'ask_tenant_alt' });
});

test('nextStep: tenant gives alternative in ASK_TENANT_ALT → relay', () => {
  assert.deepEqual(
    NS('ASK_TENANT_ALT', 'tenant', { when: '2099-01-07T15:00:00' }),
    { type: 'relay_to_prospect', when: '2099-01-07T15:00:00', proposedBy: 'tenant', roundDelta: 1 }
  );
});

test('nextStep: prospect accepts relayed time → staff_check with confirmOnFree', () => {
  assert.deepEqual(
    NS('RELAY_TO_PROSPECT', 'prospect', { accepted: true, currentWhen: '2099-01-07T15:00:00' }, 1),
    { type: 'staff_check', when: '2099-01-07T15:00:00', proposedBy: 'tenant', confirmOnFree: true, roundDelta: 0 }
  );
});

test('nextStep: prospect counters the relay → staff_check (round++)', () => {
  assert.deepEqual(
    NS('RELAY_TO_PROSPECT', 'prospect', { accepted: false, when: '2099-01-08T16:00:00' }, 1),
    { type: 'staff_check', when: '2099-01-08T16:00:00', proposedBy: 'prospect', confirmOnFree: false, roundDelta: 1 }
  );
});

test('nextStep: escalates once roundCount reaches maxRounds', () => {
  // tenant side
  assert.deepEqual(
    NS('AWAIT_TENANT', 'tenant', { accepted: false, when: '2099-01-07T15:00:00' }, 3, 3),
    { type: 'escalate', reason: 'max_rounds' }
  );
  // prospect side
  assert.deepEqual(
    NS('RELAY_TO_PROSPECT', 'prospect', { accepted: false, when: '2099-01-08T16:00:00' }, 3, 3),
    { type: 'escalate', reason: 'max_rounds' }
  );
});

test('nextStep: cancel from either side → cancel', () => {
  assert.deepEqual(NS('AWAIT_TENANT', 'tenant', { cancel: true }), { type: 'cancel' });
  assert.deepEqual(NS('ASK_PROSPECT_DAY', 'prospect', { cancel: true }), { type: 'cancel' });
});

test('nextStep: replies in the wrong state are ignored, not acted on', () => {
  assert.deepEqual(NS('AWAIT_TENANT', 'prospect', { when: '2099-01-06T17:00:00' }), { type: 'ignore' });
  assert.deepEqual(NS('ASK_PROSPECT_DAY', 'tenant', { accepted: true }), { type: 'ignore' });
  assert.deepEqual(NS('CONFIRMED', 'tenant', { accepted: true }), { type: 'ignore' });
});

test('nextStep: prospect declines relay without a counter → reprompt for a day', () => {
  assert.deepEqual(NS('RELAY_TO_PROSPECT', 'prospect', { accepted: false }), { type: 'reprompt_day' });
});

// ── read-back reconfirmation ──────────────────────────────────────────────────
test('read-back ON: prospect propose → read_back (not straight to staff_check)', () => {
  assert.deepEqual(
    nextStep({ state: 'ASK_PROSPECT_DAY', party: 'prospect', intent: { when: '2099-01-06T17:00:00' }, roundCount: 0, maxRounds: 3, readBack: true }),
    { type: 'read_back', when: '2099-01-06T17:00:00', proposedBy: 'prospect', roundDelta: 0 }
  );
});

test('read-back OFF: prospect propose → staff_check (unchanged)', () => {
  assert.deepEqual(
    nextStep({ state: 'ASK_PROSPECT_DAY', party: 'prospect', intent: { when: '2099-01-06T17:00:00' }, roundCount: 0, maxRounds: 3, readBack: false }),
    { type: 'staff_check', when: '2099-01-06T17:00:00', proposedBy: 'prospect', confirmOnFree: false, roundDelta: 0 }
  );
});

test('read-back ON: tenant counter → read_back (roundDelta 1)', () => {
  assert.deepEqual(
    nextStep({ state: 'AWAIT_TENANT', party: 'tenant', intent: { accepted: false, when: '2099-01-07T15:00:00' }, roundCount: 0, maxRounds: 3, readBack: true }),
    { type: 'read_back', when: '2099-01-07T15:00:00', proposedBy: 'tenant', roundDelta: 1 }
  );
});

test('CONFIRM_TIME + yes (prospect) → confirmed_proceed with the pending time', () => {
  assert.deepEqual(
    nextStep({ state: 'CONFIRM_TIME', party: 'prospect', intent: { accepted: true, pendingWhen: '2099-01-06T17:00:00' }, roundCount: 0, maxRounds: 3, proposedBy: 'prospect' }),
    { type: 'confirmed_proceed', proposedBy: 'prospect', when: '2099-01-06T17:00:00' }
  );
});

test('CONFIRM_TIME + yes (tenant) → confirmed_proceed (tenant)', () => {
  assert.deepEqual(
    nextStep({ state: 'CONFIRM_TIME', party: 'tenant', intent: { accepted: true, pendingWhen: '2099-01-07T15:00:00' }, roundCount: 0, maxRounds: 3, proposedBy: 'tenant' }),
    { type: 'confirmed_proceed', proposedBy: 'tenant', when: '2099-01-07T15:00:00' }
  );
});

test('CONFIRM_TIME + corrected time → re-read_back (no round bump)', () => {
  assert.deepEqual(
    nextStep({ state: 'CONFIRM_TIME', party: 'prospect', intent: { when: '2099-01-08T16:00:00' }, roundCount: 1, maxRounds: 3, proposedBy: 'prospect' }),
    { type: 'read_back', when: '2099-01-08T16:00:00', proposedBy: 'prospect', roundDelta: 0 }
  );
});

test('CONFIRM_TIME + no → ask again (reprompt for prospect, alt for tenant)', () => {
  assert.deepEqual(nextStep({ state: 'CONFIRM_TIME', party: 'prospect', intent: { accepted: false }, roundCount: 0, maxRounds: 3, proposedBy: 'prospect' }), { type: 'reprompt_day' });
  assert.deepEqual(nextStep({ state: 'CONFIRM_TIME', party: 'tenant', intent: { accepted: false }, roundCount: 0, maxRounds: 3, proposedBy: 'tenant' }), { type: 'ask_tenant_alt' });
});

test('CONFIRM_TIME: reply from the WRONG party is ignored', () => {
  assert.deepEqual(
    nextStep({ state: 'CONFIRM_TIME', party: 'tenant', intent: { accepted: true, pendingWhen: 'x' }, roundCount: 0, maxRounds: 3, proposedBy: 'prospect' }),
    { type: 'ignore' }
  );
});

// ── unit resolution phase (RESOLVE_UNIT / CONFIRM_UNIT) ───────────────────────
const NR = (state, intent, proposedBy = null) =>
  nextStep({ state, party: 'prospect', intent, roundCount: 0, maxRounds: 3, proposedBy });

test('CONFIRM_UNIT: YES → unit_confirmed', () => {
  assert.deepEqual(NR('CONFIRM_UNIT', { accepted: true }), { type: 'unit_confirmed' });
});
test('CONFIRM_UNIT: a corrected name → resolve_unit', () => {
  assert.deepEqual(NR('CONFIRM_UNIT', { unit_text: 'jervois 4b' }), { type: 'resolve_unit', text: 'jervois 4b' });
});
test('CONFIRM_UNIT: NO → reask_unit', () => {
  assert.deepEqual(NR('CONFIRM_UNIT', { accepted: false }), { type: 'reask_unit' });
});
test('CONFIRM_UNIT: a bare number (no list here) → reask_unit, not unit_picked', () => {
  assert.deepEqual(NR('CONFIRM_UNIT', { index: 2 }), { type: 'reask_unit' });
  assert.deepEqual(NR('CONFIRM_UNIT', {}), { type: 'reask_unit' });
});
test('RESOLVE_UNIT: numbered pick → unit_picked', () => {
  assert.deepEqual(NR('RESOLVE_UNIT', { index: 2 }), { type: 'unit_picked', index: 2, choice: undefined });
});
test('RESOLVE_UNIT: a fresh name → resolve_unit', () => {
  assert.deepEqual(NR('RESOLVE_UNIT', { unit_text: 'mongkok 6a' }), { type: 'resolve_unit', text: 'mongkok 6a' });
});
test('RESOLVE_UNIT: cancel → cancel; empty → ignore', () => {
  assert.deepEqual(NR('RESOLVE_UNIT', { cancel: true }), { type: 'cancel' });
  assert.deepEqual(NR('RESOLVE_UNIT', {}), { type: 'ignore' });
});
test('resolution states ignore the tenant party', () => {
  assert.deepEqual(nextStep({ state: 'CONFIRM_UNIT', party: 'tenant', intent: { accepted: true }, roundCount: 0, maxRounds: 3 }), { type: 'ignore' });
});

// ── viewingWindow (per-status lead gate) ──────────────────────────────────────
// today 2099-01-06: +45 days = 2099-02-20, +46 = 2099-02-21, +60 = 2099-03-07, +61 = 2099-03-08.
const VW = (endDate, contractType) => viewingWindow({
  endDate, contractType, leadDaysNr: 60, leadDaysOther: 45, today: '2099-01-06',
});

test('viewingWindow: NR (3) uses the 60-day window', () => {
  assert.deepEqual(VW('2099-03-07', 3), { inWindow: true, leadDays: 60, reason: 'ok' });        // exactly +60
  assert.deepEqual(VW('2099-03-08', 3), { inWindow: false, leadDays: 60, reason: 'beyond_window' }); // +61
  assert.equal(VW('2099-02-21', 3).inWindow, true); // +46: inside 60 for NR
});

test('viewingWindow: MTM/MR/UC/unset use the 45-day window', () => {
  for (const ct of [2, 1, 4, 0, null]) {
    assert.deepEqual(VW('2099-02-20', ct), { inWindow: true, leadDays: 45, reason: 'ok' });        // exactly +45
    assert.deepEqual(VW('2099-02-21', ct), { inWindow: false, leadDays: 45, reason: 'beyond_window' }); // +46
  }
});

test('viewingWindow: no end date → out of window (staff decides)', () => {
  assert.deepEqual(VW(null, 3), { inWindow: false, leadDays: 60, reason: 'no_end_date' });
  assert.deepEqual(VW('', 2), { inWindow: false, leadDays: 45, reason: 'no_end_date' });
});

test('viewingWindow: a lease already ended (holdover) is in-window', () => {
  assert.equal(VW('2098-12-01', 2).inWindow, true); // negative daysToEnd
});

test('viewingWindow: well inside the window → in', () => {
  assert.equal(VW('2099-01-20', 0).inWindow, true);
});

// ── buildRouting (TaneChat pre-seed block) ────────────────────────────────────
test('buildRouting: awaiting prospect → awaiting_phone is the prospect phone', () => {
  const r = buildRouting({ prospect_phone: '+85261234567', awaiting: 'prospect' }, '+85269998888');
  assert.deepEqual(r.parties, { prospect: { phone: '+85261234567' }, tenant: { phone: '+85269998888' } });
  assert.equal(r.awaiting_phone, '+85261234567');
});

test('buildRouting: awaiting tenant → awaiting_phone is the tenant phone', () => {
  const r = buildRouting({ prospect_phone: '+85261234567', awaiting: 'tenant' }, '+85269998888');
  assert.equal(r.awaiting_phone, '+85269998888');
});

test('buildRouting: vacant unit (no tenant phone) → tenant phone null, no crash', () => {
  const r = buildRouting({ prospect_phone: '+85261234567', awaiting: 'staff' }, null);
  assert.equal(r.parties.tenant.phone, null);
  assert.equal(r.awaiting_phone, null); // awaiting=staff → nobody to route to
});

// ── stale reaper pure decisions ──────────────────────────────────────────────
// 4h is the live cadence (VIEWING_REMINDER_HOURS): a viewing request unanswered
// longer than that is already costing the booking.
const reminderCfg = { reminderHours: 4, staleHours: 24 };
const RT = (row) => reminderTarget(row, reminderCfg);

test('reminderTarget: nudges prospect or tenant only in the reminder window', () => {
  assert.equal(RT({ awaiting: 'prospect', reminder_sent_at: null, hoursIdle: 5 }), 'prospect');
  assert.equal(RT({ awaiting: 'tenant', reminder_sent_at: null, hoursIdle: 5 }), 'tenant');
  // The boundary is inclusive: the cron runs hourly, so a row that has just crossed
  // 4h must be picked up by that same sweep or it waits another hour.
  assert.equal(RT({ awaiting: 'prospect', reminder_sent_at: null, hoursIdle: 4 }), 'prospect');
  // Still inside the window right up to the escalation cutoff.
  assert.equal(RT({ awaiting: 'prospect', reminder_sent_at: null, hoursIdle: 23 }), 'prospect');
});

test('reminderTarget: does not nudge staff-owned, early, stale, already-reminded, or unawaited rows', () => {
  assert.equal(RT({ awaiting: 'staff', reminder_sent_at: null, hoursIdle: 5 }), null);
  assert.equal(RT({ awaiting: 'prospect', reminder_sent_at: null, hoursIdle: 3 }), null);
  assert.equal(RT({ awaiting: 'prospect', reminder_sent_at: null, hoursIdle: 25 }), null);
  assert.equal(RT({ awaiting: 'prospect', reminder_sent_at: new Date(), hoursIdle: 5 }), null);
  assert.equal(RT({ awaiting: 'tenant', reminder_sent_at: new Date(), hoursIdle: 20 }), null);
  assert.equal(RT({ awaiting: null, reminder_sent_at: null, hoursIdle: 5 }), null);
});

test('reminderTarget: a reminder window at or past the stale cutoff can never fire', () => {
  // Misconfiguration guard: if VIEWING_REMINDER_HOURS >= VIEWING_STALE_HOURS the
  // window is empty and the nudge silently never sends. viewingNegotiation.js warns
  // at boot; this pins the behaviour so the warning cannot be removed as harmless.
  const bad = { reminderHours: 24, staleHours: 24 };
  for (const idle of [23, 24, 25, 100]) {
    assert.equal(reminderTarget({ awaiting: 'prospect', reminder_sent_at: null, hoursIdle: idle }, bad), null);
  }
});

test('activeNegotiationPayload: NEEDS_STAFF is visible but not routable or active by itself', () => {
  const escalatedOnly = activeNegotiationPayload([
    { id: '1', state: 'NEEDS_STAFF', awaiting: 'staff', prospect_digits: '61234567', tenant_digits: '' },
  ], '61234567');
  assert.equal(escalatedOnly.active, false);
  assert.deepEqual(escalatedOnly.negotiations, [
    { negotiation_id: '1', party: 'prospect', state: 'NEEDS_STAFF',
      needs_staff_reason: null, awaiting: 'staff', routable: false },
  ]);

  const mixed = activeNegotiationPayload([
    { id: '1', state: 'NEEDS_STAFF', awaiting: 'staff', prospect_digits: '61234567', tenant_digits: '' },
    { id: '2', state: 'ASK_PROSPECT_DAY', awaiting: 'prospect', prospect_digits: '61234567', tenant_digits: '' },
  ], '61234567');
  assert.equal(mixed.active, true);
  assert.deepEqual(mixed.negotiations.map(n => [n.negotiation_id, n.routable]), [['2', true], ['1', false]]);
});

// ── viewing relay v2 policy/timer pure helpers ──────────────────────────────
test('resolvePolicy: caller wins over stored wins over setting wins over hardcoded 4', () => {
  assert.deepEqual(resolvePolicy({
    callerPolicy: { opt_out_window_hours: 6, require_explicit_confirmation: true },
    storedPolicy: { opt_out_window_hours: 12, require_explicit_confirmation: false },
    setting: { tenant_opt_out_hours: 24 },
  }), { opt_out_window_hours: 6, require_explicit_confirmation: true, source: 'caller' });
  assert.deepEqual(resolvePolicy({
    callerPolicy: { opt_out_window_hours: 0, require_explicit_confirmation: true },
    storedPolicy: { opt_out_window_hours: 12, require_explicit_confirmation: true },
    setting: { tenant_opt_out_hours: 24 },
  }), { opt_out_window_hours: 12, require_explicit_confirmation: true, source: 'stored' });
  assert.deepEqual(resolvePolicy({
    callerPolicy: { opt_out_window_hours: 999 },
    storedPolicy: { opt_out_window_hours: NaN },
    setting: { tenant_opt_out_hours: 8 },
  }), { opt_out_window_hours: 8, require_explicit_confirmation: false, source: 'setting' });
  assert.deepEqual(resolvePolicy({
    callerPolicy: { opt_out_window_hours: null },
    storedPolicy: { opt_out_window_hours: 999 },
    setting: { tenant_opt_out_hours: 0 },
  }), { opt_out_window_hours: 4, require_explicit_confirmation: false, source: 'setting' });
});

test('resolvePolicy: out-of-range values fall through to the next source', () => {
  for (const bad of [0, 999, NaN, null]) {
    // The invalid HOURS fall through to `stored`, but the caller's explicit
    // require_explicit_confirmation still stands — the two fields resolve
    // independently, so a bad optional value cannot discard a safety flag.
    assert.deepEqual(resolvePolicy({
      callerPolicy: { opt_out_window_hours: bad, require_explicit_confirmation: true },
      storedPolicy: { opt_out_window_hours: 10, require_explicit_confirmation: false },
      setting: { tenant_opt_out_hours: 6 },
    }), { opt_out_window_hours: 10, require_explicit_confirmation: true, source: 'stored' });
  }
});

test('resolvePolicy: short notice forces explicit confirmation', () => {
  assert.deepEqual(resolvePolicy({
    callerPolicy: { opt_out_window_hours: 4, require_explicit_confirmation: false },
    viewingStartAt: '2099-01-06T13:00:00',
    noticeSentAt: '2099-01-06T10:00:00',
  }), { opt_out_window_hours: 4, require_explicit_confirmation: true, source: 'short_notice' });
  assert.deepEqual(resolvePolicy({
    callerPolicy: { opt_out_window_hours: 4, require_explicit_confirmation: false },
    viewingStartAt: '2099-01-06T15:00:00',
    noticeSentAt: '2099-01-06T10:00:00',
  }), { opt_out_window_hours: 4, require_explicit_confirmation: false, source: 'caller' });
  assert.deepEqual(resolvePolicy({
    callerPolicy: { opt_out_window_hours: 4, require_explicit_confirmation: false },
    viewingStartAt: '2099-01-06T09:00:00',
    noticeSentAt: '2099-01-06T10:00:00',
  }), { opt_out_window_hours: 4, require_explicit_confirmation: true, source: 'short_notice' });
});

test('optOutDeadline: adds the window without UTC-shifting the wall clock', () => {
  assert.equal(optOutDeadline({ noticeSentAt: '2099-01-06T10:15:30', optOutWindowHours: 4 }), '2099-01-06T14:15:00');
  assert.equal(optOutDeadline({ noticeSentAt: null, optOutWindowHours: 4 }), null);
  const deadline = optOutDeadline({ noticeSentAt: '2099-01-06T22:30:00', optOutWindowHours: 4 });
  assert.equal(deadline, '2099-01-07T02:30:00');
  assert.equal(deadline.endsWith('Z'), false);
});

test('autoConfirmDecision: manual-mode draft trap requires a sent tenant notice', () => {
  // relay_mode='manual' creates a draft first; a draft is not notice to the tenant.
  assert.deepEqual(autoConfirmDecision({
    state: 'AWAIT_TENANT', awaiting: 'tenant', tenant_notified_at: null,
    opt_out_deadline_at: '2099-01-06T14:00:00', policy_explicit_confirm: 0,
  }, '2099-01-06T15:00:00'), { action: 'skip', reason: 'notice_not_sent' });
});

test('autoConfirmDecision: explicit path, deadline, confirmed, no-deadline, and wrong-state branches', () => {
  assert.deepEqual(autoConfirmDecision({
    state: 'AWAIT_TENANT', awaiting: 'tenant', tenant_notified_at: '2099-01-06T10:00:00',
    opt_out_deadline_at: '2099-01-06T14:00:00', policy_explicit_confirm: 1,
  }, '2099-01-06T15:00:00'), { action: 'skip', reason: 'explicit_confirmation_required' });
  assert.deepEqual(autoConfirmDecision({
    state: 'AWAIT_TENANT', awaiting: 'tenant', tenant_notified_at: '2099-01-06T10:00:00',
    opt_out_deadline_at: '2099-01-06T14:00:00', policy_explicit_confirm: 0,
  }, '2099-01-06T13:59:00'), { action: 'wait', reason: 'before_deadline' });
  assert.deepEqual(autoConfirmDecision({
    state: 'AWAIT_TENANT', awaiting: 'tenant', tenant_notified_at: '2099-01-06T10:00:00',
    opt_out_deadline_at: '2099-01-06T14:00:00', policy_explicit_confirm: 0,
  }, '2099-01-06T14:00:00'), { action: 'auto_confirm', reason: 'window_elapsed' });
  assert.deepEqual(autoConfirmDecision({
    state: 'AWAIT_TENANT', awaiting: 'tenant', tenant_notified_at: '2099-01-06T10:00:00',
    opt_out_deadline_at: '2099-01-06T14:00:00', auto_confirmed_at: '2099-01-06T14:01:00',
  }, '2099-01-06T15:00:00'), { action: 'skip', reason: 'already_confirmed' });
  assert.deepEqual(autoConfirmDecision({
    state: 'AWAIT_TENANT', awaiting: 'tenant', tenant_notified_at: '2099-01-06T10:00:00',
    opt_out_deadline_at: null,
  }, '2099-01-06T15:00:00'), { action: 'skip', reason: 'no_deadline' });
  assert.deepEqual(autoConfirmDecision({
    state: 'RELAY_TO_PROSPECT', awaiting: 'prospect',
  }, '2099-01-06T15:00:00'), { action: 'skip', reason: 'not_awaiting_tenant' });
});

// Cadence is 1h → 6h → escalate at 24h (operator decision, 2026-08-12). The second
// nudge sits at 6h rather than 24h because the escalation ALSO lands at 24h: it
// fires first, moves the row to NEEDS_STAFF, and nudging stops — so a 24h second
// nudge could never fire and customer_nudge_cap=2 would be dead config. The
// assertions below are what prove both nudges are reachable before escalation.
test('nudgeDecision: customer nudges at 1h and 6h, caps, and times out at 24h', () => {
  const base = { state: 'ASK_PROSPECT_DAY', awaiting: 'prospect', customer_asked_at: '2099-01-06T10:00:00' };
  assert.deepEqual(nudgeDecision({ ...base, customer_nudge_count: 0 }, S, '2099-01-06T10:59:00'),
    { action: 'none', party: 'prospect', nudgeNumber: null, reason: 'not_due' });
  assert.deepEqual(nudgeDecision({ ...base, customer_nudge_count: 0 }, S, '2099-01-06T11:00:00'),
    { action: 'nudge', party: 'prospect', nudgeNumber: 1, reason: 'customer_nudge_1_due' });
  // Not yet due at 5h59m…
  assert.deepEqual(nudgeDecision({ ...base, customer_nudge_count: 1 }, S, '2099-01-06T15:59:00'),
    { action: 'none', party: 'prospect', nudgeNumber: null, reason: 'not_due' });
  // …due at 6h, comfortably inside the 24h escalation.
  assert.deepEqual(nudgeDecision({ ...base, customer_nudge_count: 1 }, S, '2099-01-06T16:00:00'),
    { action: 'nudge', party: 'prospect', nudgeNumber: 2, reason: 'customer_nudge_2_due' });
  assert.deepEqual(nudgeDecision({ ...base, customer_nudge_count: 2 }, S, '2099-01-06T16:00:00'),
    { action: 'none', party: 'prospect', nudgeNumber: null, reason: 'nudge_cap_reached' });
  assert.deepEqual(nudgeDecision({ ...base, customer_nudge_count: 2 }, S, '2099-01-07T10:00:00'),
    { action: 'escalate', party: 'prospect', nudgeNumber: null, reason: 'customer_timeout' });
});

test('nudgeDecision: tenant auto-confirm path is intentionally not nudged', () => {
  assert.deepEqual(nudgeDecision({
    state: 'AWAIT_TENANT', awaiting: 'tenant', tenant_notified_at: '2099-01-06T10:00:00',
    tenant_nudge_count: 0, policy_explicit_confirm: 0,
  }, S, '2099-01-06T14:00:00'),
  { action: 'none', party: 'tenant', nudgeNumber: null, reason: 'opt_out_path_no_nudge' });
});

test('nudgeDecision: tenant explicit path nudges, anchors are required, and recent nudges suppress repeats', () => {
  assert.deepEqual(nudgeDecision({
    state: 'AWAIT_TENANT', awaiting: 'tenant', tenant_notified_at: '2099-01-06T10:00:00',
    tenant_nudge_count: 0, policy_explicit_confirm: 1,
  }, S, '2099-01-06T14:00:00'), { action: 'nudge', party: 'tenant', nudgeNumber: 1, reason: 'tenant_nudge_due' });
  assert.deepEqual(nudgeDecision({
    state: 'AWAIT_TENANT', awaiting: 'tenant', tenant_notified_at: null,
    tenant_nudge_count: 0, policy_explicit_confirm: 1,
  }, S, '2099-01-06T14:00:00'), { action: 'none', party: 'tenant', nudgeNumber: null, reason: 'anchor_missing' });
  assert.deepEqual(nudgeDecision({
    state: 'ASK_PROSPECT_DAY', awaiting: 'prospect', customer_asked_at: '2099-01-06T10:00:00',
    customer_nudge_count: 0, last_nudge_at: '2099-01-06T13:40:00',
  }, S, '2099-01-06T14:00:00'), { action: 'none', party: 'prospect', nudgeNumber: null, reason: 'nudged_recently' });
});

test('reversalClassification: committed tenant replies classify reversal states', () => {
  assert.deepEqual(reversalClassification({
    state: STATE_AUTO_CONFIRMED, party: 'tenant', intent: { cancel: true },
  }), { state: STATE_TENANT_REVERSED, reason: 'tenant_declined_after_auto_confirm' });
  assert.deepEqual(reversalClassification({
    state: 'CONFIRMED', party: 'tenant', intent: { when: '2099-01-07T15:00:00' },
  }), { state: STATE_RESCHEDULE_AFTER_COMMIT, reason: 'tenant_countered_after_auto_confirm' });
  assert.deepEqual(reversalClassification({
    state: STATE_AUTO_CONFIRMED, party: 'tenant', intent: { body: 'wait' },
  }), { state: 'NEEDS_STAFF', reason: 'tenant_reply_after_confirm' });
  assert.equal(reversalClassification({
    state: STATE_AUTO_CONFIRMED, party: 'prospect', intent: { cancel: true },
  }), null);
  assert.equal(reversalClassification({
    state: 'AWAIT_TENANT', party: 'tenant', intent: { cancel: true },
  }), null);
});

test('sendModeFor: only allowlisted nudges/alerts can be auto', () => {
  for (const type of ['customer_nudge', 'tenant_nudge', 'staff_alert']) {
    assert.equal(sendModeFor(type, { auto_send_nudges: 1 }), 'auto');
    assert.equal(sendModeFor(type, { auto_send_nudges: 0 }), 'approve');
  }
  for (const type of ['customer_booking_confirmed', 'tenant_opt_out_notice', 'customer_reversal_notice']) {
    assert.equal(sendModeFor(type, { auto_send_nudges: 1 }), 'approve');
  }
  // Unknown protocol types fail closed to staff approval.
  assert.equal(sendModeFor('new_protocol_event', { auto_send_nudges: 1 }), 'approve');
});

test('idempotencyKeyFor: stable output and required identifiers', () => {
  assert.equal(idempotencyKeyFor('123', 'customer_nudge', 1), '123:customer_nudge:1');
  assert.throws(() => idempotencyKeyFor(null, 'customer_nudge', 1), TypeError);
  assert.throws(() => idempotencyKeyFor('123', '', 1), TypeError);
});

test('withinQuietHours: outside viewing time or day is quiet', () => {
  assert.equal(withinQuietHours('2099-01-06T03:00:00', S), true);
  assert.equal(withinQuietHours('2099-01-06T14:00:00', S), false);
  assert.equal(withinQuietHours('2099-01-04T14:00:00', S), true);
});

test('terminal/closed state constants include AUTO_CONFIRMED', () => {
  assert.equal(TERMINAL_STATES.includes(STATE_AUTO_CONFIRMED), true);
  assert.equal(CLOSED_STATES.includes(STATE_AUTO_CONFIRMED), true);
});

// The two policy fields are INDEPENDENT decisions. viewing_access_policy allows
// opt_out_window_hours to be NULL, so resolving both from a single winning source
// dropped require_explicit_confirmation whenever the optional hours were absent —
// silently reverting a tenant who must be asked back to silence-is-consent.
test('resolvePolicy: require_explicit_confirmation survives a NULL opt_out_window_hours', () => {
  const stored = resolvePolicy({
    storedPolicy: { opt_out_window_hours: null, require_explicit_confirmation: 1 },
    setting: { tenant_opt_out_hours: 4 },
  });
  assert.equal(stored.require_explicit_confirmation, true);
  assert.equal(stored.opt_out_window_hours, 4); // hours still fall through to the setting
  assert.equal(stored.source, 'stored');

  const caller = resolvePolicy({
    callerPolicy: { require_explicit_confirmation: true },
    setting: { tenant_opt_out_hours: 8 },
  });
  assert.equal(caller.require_explicit_confirmation, true);
  assert.equal(caller.opt_out_window_hours, 8);

  // An absent flag defers to the next source; it must not be read as an explicit false.
  const deferred = resolvePolicy({
    callerPolicy: { opt_out_window_hours: 6 },
    storedPolicy: { require_explicit_confirmation: 1 },
    setting: { tenant_opt_out_hours: 4 },
  });
  assert.equal(deferred.opt_out_window_hours, 6);
  assert.equal(deferred.require_explicit_confirmation, true);

  // An explicit false from the higher-precedence source still wins.
  const overridden = resolvePolicy({
    callerPolicy: { opt_out_window_hours: 6, require_explicit_confirmation: false },
    storedPolicy: { require_explicit_confirmation: 1 },
    setting: { tenant_opt_out_hours: 4 },
  });
  assert.equal(overridden.require_explicit_confirmation, false);
});

// A timed-out negotiation belongs on a human's desk immediately. The
// anti-double-send guard must only suppress nudges, never an escalation.
test('nudgeDecision: a recent nudge does not suppress escalation', () => {
  const now = new Date('2026-08-12T14:00:00');
  const timedOut = nudgeDecision({
    state: 'ASK_PROSPECT_DAY', awaiting: 'prospect',
    customer_asked_at: new Date('2026-08-09T14:00:00'), // 72h idle, past the 48h timeout
    customer_nudge_count: 2,
    last_nudge_at: new Date('2026-08-12T13:40:00'),     // nudged 20 minutes ago
  }, {}, now);
  assert.equal(timedOut.action, 'escalate');
  assert.equal(timedOut.reason, 'customer_timeout');

  // …while a due nudge IS still suppressed by the same guard.
  const due = nudgeDecision({
    state: 'ASK_PROSPECT_DAY', awaiting: 'prospect',
    customer_asked_at: new Date('2026-08-12T09:00:00'), // 5h idle — nudge 1 is due
    customer_nudge_count: 0,
    last_nudge_at: new Date('2026-08-12T13:40:00'),
  }, {}, now);
  assert.equal(due.action, 'none');
  assert.equal(due.reason, 'nudged_recently');
});

// Without this branch the reschedule-after-commit path was a dead end: we relayed
// the occupant's new time to the customer, and their YES fell through to `ignore`.
test('nextStep: customer accepting a post-commit reschedule confirms without a second tenant window', () => {
  const accept = nextStep({
    state: STATE_RESCHEDULE_AFTER_COMMIT, party: 'prospect',
    intent: { accepted: true, currentWhen: '2099-01-07T15:00:00' }, roundCount: 0, maxRounds: 3,
  });
  // confirmOnFree short-circuits the tenant leg — the tenant proposed this slot.
  assert.deepEqual(accept, {
    type: 'staff_check', when: '2099-01-07T15:00:00', proposedBy: 'tenant',
    confirmOnFree: true, roundDelta: 0,
  });

  // A decline, or yet another counter, goes to staff rather than restarting the loop.
  for (const intent of [{ accepted: false }, { when: '2099-01-08T16:00:00' }, {}]) {
    assert.deepEqual(nextStep({
      state: STATE_RESCHEDULE_AFTER_COMMIT, party: 'prospect', intent, roundCount: 0, maxRounds: 3,
    }), { type: 'escalate', reason: 'reschedule_declined_after_commit' });
  }
});

// Historical opt-out notices rendered a deadline into the draft body at composition.
// Those rows act only on the QUOTED deadline, and only while it still leaves room
// to object.
test('noticeIsActionable: only a quoted deadline with time left can justify silence', () => {
  const { noticeIsActionable } = require('../src/services/viewingNegotiationLogic');
  // Composed 11:00 with a 4h window, approved promptly at 11:05 → 3h55m left.
  assert.equal(noticeIsActionable({
    quotedDeadlineAt: '2099-01-06T15:00:00', sentAt: '2099-01-06T11:05:00',
  }), true);
  // Approved at 18:00 — the quoted 15:00 has already passed. The tenant would be
  // asked to object by a time three hours gone.
  assert.equal(noticeIsActionable({
    quotedDeadlineAt: '2099-01-06T15:00:00', sentAt: '2099-01-06T18:00:00',
  }), false);
  // Under an hour left is not a real opportunity to object.
  assert.equal(noticeIsActionable({
    quotedDeadlineAt: '2099-01-06T15:00:00', sentAt: '2099-01-06T14:30:00',
  }), false);
  // Exactly one hour is the boundary, and it is inclusive.
  assert.equal(noticeIsActionable({
    quotedDeadlineAt: '2099-01-06T15:00:00', sentAt: '2099-01-06T14:00:00',
  }), true);
  // A missing deadline can never justify auto-confirming.
  assert.equal(noticeIsActionable({ quotedDeadlineAt: null, sentAt: '2099-01-06T11:00:00' }), false);
  assert.equal(noticeIsActionable({ quotedDeadlineAt: '2099-01-06T15:00:00', sentAt: null }), false);
  assert.equal(noticeIsActionable({}), false);
});

// The explicit-path nudge must be independent of tenant_opt_out_hours. Borrowing
// that setting meant widening the auto-confirm window to 24h pushed the nudge out to the
// 24h escalation, so the tenant was never nudged at all before being handed to staff.
test('nudgeDecision: explicit-path nudge is unaffected by the auto-confirm window', () => {
  const now = new Date('2026-08-12T14:00:00');
  const row = {
    state: 'AWAIT_TENANT', awaiting: 'tenant', policy_explicit_confirm: 1,
    tenant_notified_at: new Date('2026-08-12T09:00:00'), // 5h idle — past the 4h nudge
    tenant_nudge_count: 0,
  };
  for (const optOut of [4, 8, 24, 168]) {
    const d = nudgeDecision(row, { tenant_opt_out_hours: optOut, tenant_explicit_timeout_hours: 24 }, now);
    assert.equal(d.action, 'nudge', `opt_out_window_hours=${optOut} must not gate this path`);
    assert.equal(d.nudgeNumber, 1);
  }

  // Capped at half the timeout, so the nudge still precedes escalation on a short one.
  const shortTimeout = nudgeDecision({ ...row, tenant_notified_at: new Date('2026-08-12T12:30:00') },
    { tenant_explicit_timeout_hours: 3 }, now); // 1.5h idle, nudge at min(4, 1.5)=1.5h
  assert.equal(shortTimeout.action, 'nudge');
  // …and it has not yet escalated at that point.
  assert.notEqual(shortTimeout.action, 'escalate');
});

// ── service-level pure wiring helpers ───────────────────────────────────────
test('outboundSendDecision: manual defaults do not send any A6 event type', () => {
  const setting = { ...S, relay_mode: 'manual', auto_send_nudges: 0, respect_quiet_hours: 0 };
  for (const eventType of viewingService.EVENT_TYPES) {
    assert.deepEqual(viewingService.outboundSendDecision(eventType, setting, '2099-01-06T14:00:00'), {
      mode: 'approve',
      shouldSend: false,
      quietSuppressed: false,
    }, `${eventType} must stay draft by default`);
  }
});

test('outboundSendDecision: relay_mode auto sends every event type', () => {
  const setting = { ...S, relay_mode: 'auto', auto_send_nudges: 0, respect_quiet_hours: 0 };
  for (const eventType of viewingService.EVENT_TYPES) {
    const d = viewingService.outboundSendDecision(eventType, setting, '2099-01-06T14:00:00');
    assert.equal(d.shouldSend, true, `${eventType} should send under relay_mode auto`);
  }
});

test('outboundSendDecision: auto_send_nudges opens only the nudge door', () => {
  const setting = { ...S, relay_mode: 'manual', auto_send_nudges: 1, respect_quiet_hours: 0 };
  assert.equal(viewingService.outboundSendDecision('customer_nudge', setting, '2099-01-06T14:00:00').shouldSend, true);
  for (const type of ['customer_booking_confirmed', 'tenant_opt_out_notice', 'customer_reversal_notice']) {
    assert.equal(viewingService.outboundSendDecision(type, setting, '2099-01-06T14:00:00').shouldSend, false);
  }
});

test('outboundSendDecision: quiet hours suppress auto nudges only', () => {
  const setting = { ...S, relay_mode: 'manual', auto_send_nudges: 1, respect_quiet_hours: 1 };
  assert.deepEqual(viewingService.outboundSendDecision('customer_nudge', setting, '2099-01-06T03:00:00'), {
    mode: 'auto',
    shouldSend: false,
    quietSuppressed: true,
  });
  assert.deepEqual(viewingService.outboundSendDecision('customer_booking_confirmed', setting, '2099-01-06T03:00:00'), {
    mode: 'approve',
    shouldSend: false,
    quietSuppressed: false,
  });
});

test('chooseTenantNoticeTemplate: normal policy uses silence-confirm ask even without a deadline', () => {
  assert.deepEqual(viewingService.chooseTenantNoticeTemplate(
    { require_explicit_confirmation: true }, '2099-01-06T14:00:00'
  ), { templateType: 'Viewing-Tenant-Explicit', eventType: 'tenant_explicit_confirm_request', deadline: null });
  assert.deepEqual(viewingService.chooseTenantNoticeTemplate(
    { require_explicit_confirmation: false }, '2099-01-06T14:00:00'
  ), { templateType: 'Viewing-Tenant-Ask', eventType: 'tenant_silence_confirm', deadline: null });
  assert.deepEqual(viewingService.chooseTenantNoticeTemplate(
    { require_explicit_confirmation: false }, null
  ), { templateType: 'Viewing-Tenant-Ask', eventType: 'tenant_silence_confirm', deadline: null });
});

test('boardNextDeadline: auto-confirm deadline agrees with autoConfirmDecision', () => {
  const waiting = {
    state: 'AWAIT_TENANT', awaiting: 'tenant', policy_explicit_confirm: 0,
    tenant_notified_at: '2099-01-06T10:00:00', opt_out_deadline_at: '2099-01-06T14:00:00',
  };
  assert.equal(autoConfirmDecision(waiting, '2099-01-06T13:00:00').action, 'wait');
  assert.deepEqual(viewingService.boardNextDeadline(waiting, S, '2099-01-06T13:00:00'), {
    kind: 'opt_out_expiry',
    due_at: '2099-01-06T14:00:00',
    overdue: false,
  });
  assert.equal(autoConfirmDecision(waiting, '2099-01-06T14:01:00').action, 'auto_confirm');
  assert.deepEqual(viewingService.boardNextDeadline(waiting, S, '2099-01-06T14:01:00'), {
    kind: 'opt_out_expiry',
    due_at: '2099-01-06T14:00:00',
    overdue: true,
  });
});

test('CLOSED_STATES sweep predicates exclude AUTO_CONFIRMED', () => {
  const row = { state: STATE_AUTO_CONFIRMED, awaiting: 'prospect' };
  assert.equal(viewingService.isNudgeCandidate(row), false);
  assert.equal(viewingService.isStaleCandidate(row), false);
  assert.equal(viewingService.CLOSED_STATES.includes(STATE_AUTO_CONFIRMED), true);
});

// The reversal path is only reachable if TaneChat is TOLD to relay the tenant's
// message. It discovers negotiations through /viewing-negotiation/active, so a
// booked-but-not-yet-happened viewing has to stay routable for the tenant — the
// reply route accepting it is necessary but not sufficient on its own.
test('activeNegotiationPayload: a committed viewing stays routable for the tenant, not the prospect', () => {
  for (const state of ['AUTO_CONFIRMED', 'CONFIRMED']) {
    const rows = [{ id: '1', state, awaiting: null, prospect_digits: '11111111', tenant_digits: '22222222' }];

    const tenant = activeNegotiationPayload(rows, '22222222');
    assert.equal(tenant.active, true, `${state}: tenant must be able to withdraw`);
    assert.equal(tenant.negotiations[0].routable, true);
    assert.equal(tenant.negotiations[0].party, 'tenant');

    // The prospect cannot reopen a booked viewing: handleReply refuses a prospect
    // reply on a terminal state, so relaying it would drop the message silently.
    const prospect = activeNegotiationPayload(rows, '11111111');
    assert.equal(prospect.active, false, `${state}: prospect must not be routable`);
    assert.equal(prospect.negotiations[0].routable, false);
  }

  // A cancelled negotiation is routable for nobody — the SQL excludes it entirely,
  // but assert the shape here too so the two layers can't drift apart.
  const cancelled = [{ id: '2', state: 'CANCELLED', awaiting: null, prospect_digits: '33333333', tenant_digits: '44444444' }];
  assert.equal(activeNegotiationPayload(cancelled, '44444444').active, true); // not excluded by this pure fn
  // …which is exactly why the route's WHERE clause must keep excluding CANCELLED.
});
