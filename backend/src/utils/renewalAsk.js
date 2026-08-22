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

const DEFAULT_NOTICE_DAYS = 45;   // the operator's standard notice period
const DEFAULT_MIN_TENANCY_DAYS = 7;

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
//
// Non-primitives are refused for the same reason, one step further out: Number([]) is 0 and
// Number(true) is 1, so junk would arrive looking like a deliberate setting — and for the
// minimum-tenancy floor a deliberate 0 means "no floor", i.e. junk would switch the rule OFF
// and message a tenant on their second day. Every one of these failures has to land on the
// side of not messaging someone. Mirrors hasAvailabilityValue() in advertisingPlan.js, which
// exists for exactly this.
function definedNumber(value) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;   // arrays, objects, booleans
  if (value.trim() === '') return null;
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
function renewalAskEligibility(lease, {
  today, defaultNoticeDays = DEFAULT_NOTICE_DAYS, minTenancyDays = DEFAULT_MIN_TENANCY_DAYS,
} = {}) {
  const todayMs = parseYmd(today);
  if (todayMs == null) return { eligible: false, reason: 'bad_today' };
  if (!lease) return { eligible: false, reason: 'no_lease' };

  const endMs = parseYmd(lease.end_date);
  if (endMs == null) return { eligible: false, reason: 'no_end_date' };
  if (endMs < todayMs) return { eligible: false, reason: 'lease_already_ended' };

  if (!UNDECIDED_CONTRACT_TYPES.includes(Number(lease.contract_type))) {
    return { eligible: false, reason: 'already_decided' };
  }
  // Already answered — asking again would be nagging a tenant who replied. "Unsure" is
  // not an answer (see isDefiniteReply), so those leases stay eligible.
  if (isDefiniteReply(lease.renewal_reply)) return { eligible: false, reason: 'already_replied' };

  const dueOn = renewalDecisionDueOn(lease.end_date, lease.notice_period_days, defaultNoticeDays);
  if (dueOn == null) return { eligible: false, reason: 'no_decision_date' };
  if (parseYmd(dueOn) > todayMs) return { eligible: false, reason: 'too_early', decision_due_on: dueOn };

  const configuredMin = definedNumber(minTenancyDays);
  const floorDays = configuredMin != null && configuredMin >= 0
    ? Math.trunc(configuredMin) : DEFAULT_MIN_TENANCY_DAYS;
  const startMs = parseYmd(lease.start_date);
  // Without a trustworthy move-in date we cannot prove the tenant has lived there long
  // enough. Failing closed avoids sending an intrusive question prematurely.
  if (startMs == null) return { eligible: false, reason: 'no_start_date' };
  const eligibleFrom = toYmd(startMs + floorDays * 86400000);
  if (todayMs < parseYmd(eligibleFrom)) {
    return { eligible: false, reason: 'too_soon_after_move_in', eligible_from: eligibleFrom };
  }

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

// A clause opening with one of these is a question even when the tenant omitted the
// question mark, which in a chat message they routinely do.
const QUESTION_OPENER = /^(?:can|could|would|will|shall|should|may|might|is|are|was|were|do|does|did|have|has|how|what|when|where|which|who|why|any\s+chance)\b/i;

function isInterrogative(clause) {
  const t = clause.trim();
  if (!t) return false;
  return t.endsWith('?') || QUESTION_OPENER.test(t);
}

// Split on sentence terminators, KEEPING them, so a trailing '?' survives to be tested.
function splitClauses(text) {
  return String(text).split(/(?<=[.!?\n])/).map(s => s.trim()).filter(Boolean);
}

/**
 * Classify a free-text tenant reply. Deliberately conservative: anything that is not
 * an unambiguous yes or no is UNSURE. A wrong "leaving" is the expensive direction —
 * see applyRenewalReply, which refuses to act on it automatically anyway.
 *
 * ASKING ABOUT SOMETHING IS NOT AGREEING TO IT. The keyword lists cannot tell the two
 * apart on their own: "extend", "continue" and "renew" are exactly the words a tenant
 * uses to enquire, so "how much to extend?" and "can I extend?" both read as a
 * confirmation. That is the one misreading with a real cost — "extend" is the only
 * intent that acts automatically, so it would set renewal_reply and pull a home off
 * the market on the strength of a question. A real message showed this: "Would it be
 * possible to pause the lease for 25th Sep to 7th Oct and then continue it until
 * December?" classified as extend, from a tenant who was simultaneously asking about
 * a different studio.
 *
 * So signals are counted only OUTSIDE interrogative clauses. A yes that exists solely
 * inside a question leaves nothing to count, and the answer falls through to UNSURE —
 * recorded, non-acting, and put in front of a human. A statement alongside a question
 * still counts: "Yes please. How much is it?" is an answer with a question attached.
 */
function classifyRenewalReply(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  let hasYes = false;
  let hasNo = false;
  for (const clause of splitClauses(text)) {
    if (isInterrogative(clause)) continue;
    // Negation is stripped per clause, so "not renewing" in one sentence cannot
    // silence a plain "renewing" in another.
    const stripped = clause.replace(NEGATED, ' ');
    if (stripped !== clause) hasNo = true;
    if (YES.test(stripped)) hasYes = true;
    if (NO.test(stripped)) hasNo = true;
  }
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
/**
 * Is this reply an ANSWER, or just noise we have filed?
 *
 * "extend" and "leaving" are answers: the tenant told us something. "unsure" is not —
 * and crucially it is also what an unrelated message becomes, because the classifier
 * is deliberately conservative and anything ambiguous lands there. Treating "unsure"
 * as an answer therefore let a tenant who typed "ok thanks" mid-conversation end their
 * own ask sequence, with no further asks and no hand-off to staff. Operator decision,
 * 2026-08-19: a vague reply is recorded and we keep monitoring.
 *
 * Any other non-null value counts as definite. Unknown codes stop us messaging rather
 * than start us messaging, which is the safe direction for a tenant's phone.
 */
function isDefiniteReply(intent) {
  if (intent == null) return false;
  return Number(intent) !== REPLY_UNSURE;
}

/**
 * @param {object} row  aggregated ask row: { reply_intent, reply_applied, escalated,
 *                      asks_delivered, slots_used }  (values may be strings from SQL)
 * @returns {string} one of the six renewal ask status strings
 */
function renewalAskStatus(row = {}) {
  const replyIntent = row.reply_intent != null && row.reply_intent !== '' ? Number(row.reply_intent) : null;
  if (isDefiniteReply(replyIntent)) {
    if (String(row.reply_applied) !== '1') return 'replied_but_stale_check_lease';
    return replyIntent === REPLY_EXTEND ? 'extend_pending_paperwork' : 'replied_needs_review';
  }
  if (Number(row.escalated) === 1) return 'no_answer_call_them';
  if (Number(row.asks_delivered) === 0 && Number(row.slots_used) > 0) return 'could_not_reach_them';
  return 'awaiting_reply';
}

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

/**
 * The digits a WhatsApp conversation is keyed by. Deliberately the LAST 8: Hong Kong numbers
 * are eight digits, and the same person is stored variously as `9123 4567`, `+852 91234567`
 * and `85291234567`. Comparing the full string would treat those as three different people,
 * which for this check means failing open — the outcome that messages a tenant twice.
 */
function conversationKey(phone) {
  const digits = String(phone == null ? '' : phone).replace(/\D/g, '');
  return digits.length >= 8 ? digits.slice(-8) : (digits || null);
}

/**
 * The name two racers must agree on to be serialised against each other.
 *
 * It has to be derived the SAME way from either lease, or the two sides take different locks
 * and both proceed — the failure this lock exists to prevent. Phone first, since that is the
 * WhatsApp thread; then email, because an email-only tenant has an inbox that is equally one
 * conversation; then the lease itself, which serialises nothing but is a stable name for a
 * tenant we cannot contact at all.
 *
 * Email is hashed down to a short stable key: MySQL lock names are capped at 64 characters and
 * an address can be longer than what is left after the org id.
 */
function conversationLockKey(lease) {
  const phone = conversationKey(lease && lease.tenant_phone);
  if (phone) return `p${phone}`;
  const email = typeof lease?.tenant_email === 'string' ? lease.tenant_email.trim().toLowerCase() : '';
  if (email) {
    let h = 0;
    for (let i = 0; i < email.length; i += 1) h = (h * 31 + email.charCodeAt(i)) >>> 0;
    return `e${h.toString(36)}`;
  }
  const leaseId = lease && (lease.lease_id ?? lease.id);
  return leaseId != null ? `l${String(leaseId)}` : null;
}

/**
 * The ask already outstanding on this tenant's conversation, if any.
 *
 * A tenant renting two units can hit both notice periods in the same week. Ask them both
 * questions at once and their "yes, we'd like to stay" says nothing about WHICH lease — and
 * neither we nor the relay can tell, because the reply arrives on one WhatsApp thread with
 * no reference to either message. Guessing writes a renewal decision onto the wrong lease.
 *
 * So we serialise rather than agree a tie-break: one open question per conversation, the
 * other lease waits. Asks only start inside a notice period and a full sequence runs about a
 * week, so the wait is short and the ambiguity is gone rather than managed.
 *
 * ONE identity, the same one the lock is named for. They must not be able to disagree: if the
 * conflict check thought two leases shared a conversation while the lock named them
 * differently, both sides would take their own lock, both would see a clear conversation, and
 * both would send. An earlier version matched on tenant id OR phone OR email while the lock
 * used only the first of those — so two tenant records sharing an email but holding different
 * phone numbers raced.
 *
 * Deriving both from `conversationLockKey` also makes the semantics the right ones: a
 * conversation is a messaging thread, not a person. Two different phone numbers are two
 * different threads, and a reply on either is unambiguous even if the same human owns both.
 *
 * @param {Array} openAsks rows with { id, lease_id, tenant_phone, tenant_email, escalated_at }
 * @param {object} lease   the lease we are about to ask about
 * @returns {object|null}  the blocking ask, or null when the conversation is clear
 */
function conflictingOpenAsk(openAsks, lease) {
  if (!lease) return null;
  const leaseId = String(lease.lease_id ?? lease.id ?? '');
  const key = conversationLockKey(lease);
  if (!key) return null;

  for (const ask of Array.isArray(openAsks) ? openAsks : []) {
    if (!ask) continue;
    // The same lease's later asks are the SAME question repeated — never a conflict.
    if (String(ask.lease_id) === leaseId) continue;
    // An escalated cycle has finished: three asks went unanswered and a person took over.
    // Its rows stay SENT-and-unanswered forever, so counting them here would block the
    // tenant's OTHER lease permanently — one silent tenant costing us a second question we
    // never ask. The partner's correlation list still shows them, because a late reply must
    // still be attributable.
    if (ask.escalated_at) continue;
    if (conversationLockKey(ask) === key) return ask;
  }
  return null;
}

const MONTH_NAMES = ['January','February','March','April','May','June',
  'July','August','September','October','November','December'];

/** 'YYYY-MM-DD' → '29 September 2026'. Null in, null out. */
function longDate(ymd) {
  const m = String(ymd || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const month = MONTH_NAMES[Number(m[2]) - 1];
  return month ? `${Number(m[3])} ${month} ${m[1]}` : null;
}

/**
 * Everything an ask template can refer to, built in ONE place.
 *
 * Both the nightly job and the demand-triggered route render asks. A placeholder that
 * resolved in one and not the other would send a tenant a message with `{notice_days}`
 * printed in it, so the variables are built here and neither caller assembles its own.
 *
 * On `notice_days`: most leases record nothing — 242 of 313 at the time of writing — and the
 * scheduler already treats a missing value as the org default. This reports the SAME number
 * the system acts on, because a message quoting a deadline we do not act on is worse than one
 * quoting a default. `notice_source` exists so the sentence can stay honest either way:
 * "45 days, as set out in your lease" versus "45 days, our standard notice period". An
 * operator who would rather say nothing when it is a guess can build their sentence from
 * `{decision_sentence}`, which is empty in that case.
 */
function renewalAskVars(lease, { defaultNoticeDays = DEFAULT_NOTICE_DAYS, today } = {}) {
  const recorded = definedNumber(lease && lease.notice_period_days);
  const noticeDays = recorded == null ? definedNumber(defaultNoticeDays) ?? DEFAULT_NOTICE_DAYS : recorded;
  const decisionBy = renewalDecisionDueOn(lease && lease.end_date, lease && lease.notice_period_days, defaultNoticeDays);
  const fromLease = recorded != null;
  const decisionByLong = longDate(decisionBy);

  // Has the deadline already gone? A long default notice period against a short lease puts the
  // decision date before the tenant has properly moved in — six of ten tenants waiting today
  // are in that shape. Telling someone they must confirm by a date five weeks past, and then
  // warning that the flat may be re-let if they miss it, is the first thing they would reply
  // to, and rightly.
  const todayMs = parseYmd(today);
  const dueMs = parseYmd(decisionBy);
  const overdue = todayMs != null && dueMs != null && dueMs < todayMs;

  // Two placeholders rather than one, because a bare date swap cannot fix the sentence: both
  // "let us know by {date}" and "before {date}" break the moment the value stops being a date.
  // Each of these carries its own preposition, so the wording stays grammatical either way.
  const decisionDeadline = overdue || !decisionByLong ? 'as soon as possible' : `by ${decisionByLong}`;
  const confirmBefore = overdue || !decisionByLong ? 'shortly' : `before ${decisionByLong}`;
  // Kept SEPARATE from the deadline rather than baked into it, so the operator decides whether
  // to explain where the date comes from. Empty once the date has passed, because "which is 45
  // days before the end" makes no sense attached to "as soon as possible".
  const noticeContext = overdue || !decisionByLong
    ? ''
    : `, which is ${noticeDays} days before the end (${fromLease ? 'as set out in your lease' : 'our standard notice period'})`;

  return {
    decision_deadline: decisionDeadline,
    notice_context: noticeContext,
    confirm_before: confirmBefore,
    decision_overdue: overdue,
    tenant_name: (lease && lease.tenant_name) || 'there',
    first_name: (lease && lease.tenant_first_name) || (lease && lease.tenant_name) || 'there',
    unit: [lease && lease.property_name, lease && lease.unit_name].filter(Boolean).join(' '),
    end_date: (lease && lease.end_date) || '',
    end_date_long: longDate(lease && lease.end_date) || (lease && lease.end_date) || '',
    notice_days: String(noticeDays),
    notice_source: fromLease ? 'as set out in your lease' : 'our standard notice period',
    // The bare value. Reads 'as soon as possible' once the date has passed, so a template using
    // it alone still says something true — but prefer decision_deadline, which stays
    // grammatical because it brings its own "by".
    decision_by: overdue ? 'as soon as possible' : (decisionByLong || decisionBy || ''),
    // A whole sentence, or nothing. For an operator who would rather assert no deadline at
    // all where the lease records none — the safe choice, since it claims nothing.
    decision_sentence: fromLease && decisionByLong
      ? (overdue
          ? `Your lease asks for ${noticeDays} days' notice, so we need to know as soon as possible.`
          : `Your lease asks for ${noticeDays} days' notice, so we would need to know by ${decisionByLong}.`)
      : '',
  };
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
  isDefiniteReply,
  renewalAskStatus,
  conversationKey,
  conversationLockKey,
  conflictingOpenAsk,
  renewalAskVars,
  longDate,
  renderRenewalAsk,
};

/**
 * Which ask (if any) is due for this lease right now.
 *
 * `asks` is the cycle's history: [{ ask_number, sent_at, escalated_at }]. `sent_at` is a
 * YYYY-MM-DD business date, not a timestamp — the caller derives it from the org's
 * clock, so nothing here reads the process clock.
 */
function nextAskDue(asks, { today, gapDays = 3, hasDefiniteReply = false } = {}) {
  const todayMs = parseYmd(today);
  if (todayMs == null) return { due: false, reason: 'bad_today' };
  // A DEFINITE reply ends the sequence — we asked a question and got an answer. "Unsure"
  // does not: the tenant has not decided (or never meant to reply at all), so the
  // remaining asks still have work to do.
  if (hasDefiniteReply) return { due: false, reason: 'already_replied' };

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
function shouldEscalate(asks, { today, gapDays = 3, hasDefiniteReply = false } = {}) {
  // Three asks and still nothing definite — including three "not sure yet"s — is exactly
  // when a person should pick up the phone.
  if (hasDefiniteReply) return false;
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
