/**
 * When may an invoice be chased for being overdue?
 *
 * The old rule was one comparison: is the due date before today? That is wrong
 * for any invoice that is created after the period it bills for. Utility bills
 * are dated to the end of the meter period but cannot exist until someone reads
 * the meter, so they are born past due. Deposits and adjustments back-date the
 * same way. In 2026 alone 458 invoices were created after their own due date,
 * 179 of them utilities.
 *
 * The consequence was not cosmetic. The tenant's FIRST notice of the charge was
 * a past-due chaser opening "your invoice is currently past due" and closing
 * with a late-fee clause of 5% of monthly rent per week, on a bill they had
 * never been sent. Nobody was late; the invoice simply arrived carrying an old
 * date.
 *
 * So an invoice is chaseable only once BOTH are true: the due date has passed,
 * and the tenant has had the grace period to act since the invoice was issued.
 * The grace matches the window Tane's own overdue template grants ("Rent over 7
 * days late will result in a penalty fee"), so the system stops chasing before
 * the contract starts charging.
 *
 * For an ordinary recurring invoice, raised around a month ahead of its due
 * date, `created_at + 7 days` is well before `due_on` and this changes nothing.
 * It only bites on the back-dated ones, which is the whole point.
 *
 * This does NOT touch the stored `invoice.status` flag. Marking an invoice
 * Overdue in the ledger is a bookkeeping fact about the due date; whether to
 * send someone a dunning email is a separate judgement, and only the second one
 * is being changed here.
 */

const CHASE_GRACE_DAYS = 7;

/**
 * Normalise a Date, a MySQL DATE/DATETIME or a 'YYYY-MM-DD' string to a plain
 * calendar date string. Comparing 'YYYY-MM-DD' strings lexicographically is the
 * same as comparing the dates, and it keeps timezone drift out of the answer.
 */
function toCalendarDate(value) {
  if (!value) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return value.toISOString().slice(0, 10);
  }
  const s = String(value).trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function addDays(calendarDate, days) {
  const d = new Date(`${calendarDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * @param {object} args
 * @param {*} args.dueOn      invoice.due_on (nullable)
 * @param {*} args.createdAt  invoice.created_at
 * @param {*} args.today      the org's today, as 'YYYY-MM-DD'
 * @returns {boolean} true when a dunning email is fair to send
 */
function isChaseable({ dueOn, createdAt, today } = {}) {
  const due = toCalendarDate(dueOn);
  const now = toCalendarDate(today);
  // No due date, or no idea what day it is: never chase. An invoice with no due
  // date was never late.
  if (!due || !now) return false;
  // Not past due yet.
  if (due >= now) return false;
  const created = toCalendarDate(createdAt);
  // created_at is NOT NULL in the schema. If it is somehow missing, fall back to
  // the old due-date-only rule rather than silently suppressing the reminder.
  if (!created) return true;
  return addDays(created, CHASE_GRACE_DAYS) < now;
}

/**
 * The same rule as SQL, for queries that must not waste their LIMIT on invoices
 * they will only discard afterwards. Emits a fragment with TWO placeholders,
 * both of which take the org's today.
 *
 * `created + grace < today` is the algebraic twin of `created < today - grace`,
 * and the second form lets MySQL keep a plain column on the left.
 */
function chaseableSql(dueCol, createdCol) {
  return `${dueCol} < ? AND DATE(${createdCol}) < DATE_SUB(?, INTERVAL ${CHASE_GRACE_DAYS} DAY)`;
}

module.exports = { isChaseable, chaseableSql, toCalendarDate, CHASE_GRACE_DAYS };
