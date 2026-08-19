/**
 * Renewal ask — pure decision logic.
 *
 * A unit whose tenant has not decided is unsellable: we can only offer it hedged,
 * and prospects walk. Rather than publish a guessed "decision due" date, we ask the
 * tenant — but only for units someone actually wants, and only once per cycle.
 *
 * Everything here is pure so it can be tested without a database or a clock. The
 * caller supplies `today` as a YYYY-MM-DD business date (orgToday()), never a Date,
 * so nothing in this file can drift with the process timezone.
 */

const REPLY_EXTEND = 1;   // the operator's button wording: "Extend"
const REPLY_LEAVING = 2;
const REPLY_UNSURE = 3;

// leasing.contract_type values that mean "we do not know yet".
const UNDECIDED_CONTRACT_TYPES = [1, 4];   // 1 = MR (may renew), 4 = UC (unconfirmed)

const DEFAULT_NOTICE_DAYS = 30;

// Three asks per decision cycle, then a human takes over. Silence is not an answer and
// is emphatically not "leaving", so the sequence ends in escalation rather than a guess.
const MAX_ASKS = 3;
// Hard floor, independent of the configured gap: a tenant must never be messaged twice
// in one day, whatever the setting says.
const MIN_HOURS_BETWEEN_ASKS = 24;

function parseYmd(value) {
  if (typeof value !== 'string') return null;
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return t;
}

function toYmd(utcMs) {
  const d = new Date(utcMs);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

// Stricter than Number() on purpose: Number(null), Number(undefined ?? '') and
// Number('  ') are all 0, and 0 is a legitimate notice period. Treating a missing
// value as "0 days notice" would make every undecided lease look due today.
function definedNumber(value) {
  if (value == null) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function noticeDays(noticePeriodDays, defaultNoticeDays = DEFAULT_NOTICE_DAYS) {
  const n = definedNumber(noticePeriodDays);
  if (n != null && n >= 0) return Math.trunc(n);
  const d = definedNumber(defaultNoticeDays);
  return d != null && d >= 0 ? Math.trunc(d) : DEFAULT_NOTICE_DAYS;
}

/**
 * The date by which the tenant's decision is due: lease end minus the notice period.
 * Falls back to the configured default when the lease has no notice period recorded —
 * which, on this operator's data, is every undecided lease. That default is fine as an
 * internal "ask now" heuristic and is NOT fit to be published to a prospect as a date.
 */
function renewalDecisionDueOn(endDate, noticePeriodDays, defaultNoticeDays = DEFAULT_NOTICE_DAYS) {
  const end = parseYmd(endDate);
  if (end == null) return null;
  return toYmd(end - noticeDays(noticePeriodDays, defaultNoticeDays) * 86400000);
}

/**
 * Is a lease eligible to be asked today? Returns a reason string when not, so the
 * caller can tell the difference between "not yet" and "already handled" instead of
 * getting a bare false.
 */
function renewalAskEligibility(lease, { today, defaultNoticeDays = DEFAULT_NOTICE_DAYS } = {}) {
  const todayMs = parseYmd(today);
  if (todayMs == null) return { eligible: false, reason: 'bad_today' };
  if (!lease) return { eligible: false, reason: 'no_lease' };

  const endMs = parseYmd(lease.end_date);
  if (endMs == null) return { eligible: false, reason: 'no_end_date' };
  if (endMs < todayMs) return { eligible: false, reason: 'lease_already_ended' };

  if (!UNDECIDED_CONTRACT_TYPES.includes(Number(lease.contract_type))) {
    return { eligible: false, reason: 'already_decided' };
  }
  // Already answered — asking again would be nagging a tenant who replied.
  if (lease.renewal_reply != null) return { eligible: false, reason: 'already_replied' };

  const dueOn = renewalDecisionDueOn(lease.end_date, lease.notice_period_days, defaultNoticeDays);
  if (dueOn == null) return { eligible: false, reason: 'no_decision_date' };
  if (parseYmd(dueOn) > todayMs) return { eligible: false, reason: 'too_early', decision_due_on: dueOn };

  return { eligible: true, reason: null, decision_due_on: dueOn };
}

/**
 * The cooldown key. Both dates are stamped so that extending a lease, or correcting
 * its notice period, opens a NEW cycle rather than being suppressed by the old one —
 * a unit must not go quiet at exactly the moment it needs asking again.
 */
function renewalAskCycleKey(lease, { today, defaultNoticeDays = DEFAULT_NOTICE_DAYS } = {}) {
  const dueOn = renewalDecisionDueOn(lease?.end_date, lease?.notice_period_days, defaultNoticeDays);
  if (dueOn == null) return null;
  return { lease_id: String(lease.lease_id ?? lease.id), lease_end_at_ask: lease.end_date, decision_due_on: dueOn };
}

const YES = /\b(yes|yeah|yep|yup|staying|stay|renew|renewing|extend|extending|continue|keep)\b/i;
const NO = /\b(no|nope|leaving|leave|moving out|move out|vacate|vacating|terminate)\b/i;
// "not renewing" contains "renewing", so a plain two-regex test sees both a yes and a
// no and gives up. Strip negated phrases first and the sentence reads correctly.
const NEGATED = /\b(?:not|never|won'?t|will not|do not|don'?t|cannot|can'?t)\s+(?:be\s+)?(?:renew(?:ing)?|stay(?:ing)?|extend(?:ing)?|continu(?:e|ing))\b/ig;

/**
 * Classify a free-text tenant reply. Deliberately conservative: anything that is not
 * an unambiguous yes or no is UNSURE. A wrong "leaving" is the expensive direction —
 * see applyRenewalReply, which refuses to act on it automatically anyway.
 */
function classifyRenewalReply(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const withoutNegations = text.replace(NEGATED, ' ');
  const negated = withoutNegations !== text;
  const hasYes = YES.test(withoutNegations);
  const hasNo = negated || NO.test(withoutNegations);
  if (hasYes && hasNo) return REPLY_UNSURE;   // "yes but I might leave" — a human should read it
  if (hasYes) return REPLY_EXTEND;
  if (hasNo) return REPLY_LEAVING;
  return REPLY_UNSURE;
}

/**
 * What a reply is allowed to change.
 *
 * The asymmetry is the whole point. "Staying" WITHDRAWS the unit from customer-facing
 * feeds automatically, because the cost of being wrong is a listing we can restore.
 * "Leaving" does NOT mark the unit firmly available, because the cost of being wrong
 * there is promising a customer a home that a tenant never vacates — so it goes to a
 * human instead.
 *
 * `askedLease` is the lease as it was when we asked; `currentLease` is what it looks
 * like now. If they differ the reply is stale: record it, act on nothing.
 */
function applyRenewalReply(intent, { askedLease, currentLease } = {}) {
  const code = Number(intent);
  if (![REPLY_EXTEND, REPLY_LEAVING, REPLY_UNSURE].includes(code)) {
    return { valid: false, reason: 'bad_intent' };
  }
  if (!askedLease || !currentLease) return { valid: false, reason: 'missing_lease' };

  if (String(askedLease.id) !== String(currentLease.id)) {
    return { valid: true, applied: false, stale_reason: 'lease_replaced', suppress: false, needs_staff: true, intent: code };
  }
  if (askedLease.end_date !== currentLease.end_date) {
    // Extended or shortened since we asked — the question we put is no longer the
    // question that matters.
    return { valid: true, applied: false, stale_reason: 'lease_end_changed', suppress: false, needs_staff: true, intent: code };
  }
  if (Number(askedLease.contract_type) !== Number(currentLease.contract_type)) {
    return { valid: true, applied: false, stale_reason: 'intent_changed_elsewhere', suppress: false, needs_staff: true, intent: code };
  }

  if (code === REPLY_EXTEND) {
    return { valid: true, applied: true, stale_reason: null, suppress: true, needs_staff: true, intent: code };
  }
  // Leaving or unsure: recorded, surfaced to staff, but never auto-promoted to
  // "firmly available".
  return { valid: true, applied: true, stale_reason: null, suppress: false, needs_staff: true, intent: code };
}

/** Fill the operator-authored template. Unknown placeholders are left alone. */
function renderRenewalAsk(template, vars = {}) {
  if (typeof template !== 'string' || !template.trim()) return null;
  return template.replace(/\{(\w+)\}/g, (whole, key) => (
    Object.prototype.hasOwnProperty.call(vars, key) && vars[key] != null ? String(vars[key]) : whole
  ));
}

module.exports = {
  REPLY_EXTEND, REPLY_LEAVING, REPLY_UNSURE,
  UNDECIDED_CONTRACT_TYPES, DEFAULT_NOTICE_DAYS,
  renewalDecisionDueOn,
  renewalAskEligibility,
  renewalAskCycleKey,
  classifyRenewalReply,
  applyRenewalReply,
  renderRenewalAsk,
};

/**
 * Which ask (if any) is due for this lease right now.
 *
 * `asks` is the cycle's history: [{ ask_number, sent_at, escalated_at }]. `sent_at` is a
 * YYYY-MM-DD business date, not a timestamp — the caller derives it from the org's
 * clock, so nothing here reads the process clock.
 */
function nextAskDue(asks, { today, gapDays = 3, hasReply = false } = {}) {
  const todayMs = parseYmd(today);
  if (todayMs == null) return { due: false, reason: 'bad_today' };
  // Any reply at all ends the sequence — we asked a question and got an answer.
  if (hasReply) return { due: false, reason: 'already_replied' };

  // `attempted_on` counts a delivered ask OR one we gave up on after retries. Counting
  // only delivered asks would strand a tenant whose first message failed: the row still
  // occupies its slot, so nothing new could ever be inserted for it.
  const sent = (Array.isArray(asks) ? asks : [])
    .map(a => ({ n: Number(a?.ask_number) || 1, ms: parseYmd(a?.attempted_on || a?.sent_at) }))
    .filter(a => a.ms != null)
    .sort((a, b) => b.ms - a.ms || b.n - a.n);

  if (sent.length >= MAX_ASKS) return { due: false, reason: 'max_asks_reached' };
  if (!sent.length) return { due: true, ask_number: 1 };

  const gap = definedNumber(gapDays);
  const effectiveGapDays = Math.max(
    gap != null && gap >= 0 ? Math.trunc(gap) : 3,
    MIN_HOURS_BETWEEN_ASKS / 24,
  );
  const daysSinceLast = Math.round((todayMs - sent[0].ms) / 86400000);
  if (daysSinceLast < effectiveGapDays) return { due: false, reason: 'too_soon', days_since_last: daysSinceLast };

  return { due: true, ask_number: sent[0].n + 1 };
}

/**
 * All three asks sent, the gap has elapsed, and still nothing back. At that point a
 * person should call them — we have said all we usefully can by message.
 */
function shouldEscalate(asks, { today, gapDays = 3, hasReply = false } = {}) {
  if (hasReply) return false;
  const todayMs = parseYmd(today);
  if (todayMs == null) return false;
  const list = Array.isArray(asks) ? asks : [];
  const sent = list.filter(a => a && (a.attempted_on || a.sent_at));
  if (sent.length < MAX_ASKS) return false;
  if (list.some(a => a && a.escalated_at)) return false;   // already handed over

  // The third ask must have had the same window to be answered as the others. Escalating
  // the day it goes out would hand a "no answer" to staff before the tenant has had a
  // chance to give one.
  const lastMs = sent
    .map(a => parseYmd(a.attempted_on || a.sent_at))
    .filter(ms => ms != null)
    .sort((a, b) => b - a)[0];
  if (lastMs == null) return false;
  const gap = definedNumber(gapDays);
  const effectiveGapDays = Math.max(
    gap != null && gap >= 0 ? Math.trunc(gap) : 3,
    MIN_HOURS_BETWEEN_ASKS / 24,
  );
  return Math.round((todayMs - lastMs) / 86400000) >= effectiveGapDays;
}

/** WhatsApp when we have a phone, otherwise email. null = unreachable by either. */
function renewalAskChannel({ tenant_phone, tenant_email } = {}) {
  const phone = typeof tenant_phone === 'string' ? tenant_phone.trim() : '';
  const email = typeof tenant_email === 'string' ? tenant_email.trim() : '';
  if (phone) return 'whatsapp';
  if (email) return 'email';
  return null;
}

module.exports.MAX_ASKS = MAX_ASKS;
module.exports.MIN_HOURS_BETWEEN_ASKS = MIN_HOURS_BETWEEN_ASKS;
module.exports.nextAskDue = nextAskDue;
module.exports.shouldEscalate = shouldEscalate;
module.exports.renewalAskChannel = renewalAskChannel;
