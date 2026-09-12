/**
 * Period-boundary math for rent invoices, shared by:
 *   - services/scheduler.js  (auto-publish)
 *   - routes/invoice.js      (manual Publish Invoice button)
 *   - routes/leasing.js      (initial invoice batch on lease creation, optional)
 *
 * Pure functions, no DB access.
 */

/**
 * Given a due date and a lease's billing cycle, returns the NEXT due date.
 *
 * For monthly+ cycles, snaps to lease.due_day (day-of-month) when provided,
 * clamping to the last day of the target month if it doesn't have that day
 * (e.g. due_day=31 lands on Feb 28 in Feb).
 *
 * @param {Date}   date     - this period's due date
 * @param {string|number} schedule - leasing.invoicing value
 * @param {number} dueDay   - leasing.due_date (day-of-month, optional)
 * @returns {Date} next period's due date
 */
/**
 * Add whole months without letting a short month push the date into the month
 * after next.
 *
 * `setMonth(m + 1)` on 31 August asks for 31 September, which does not exist, so
 * JavaScript rolls it forward to 1 October. Clamping to the lease's due day AFTER
 * that measures the wrong month: it saw October, capped at 31, and returned
 * 31 October. September was never billed, and because the next period then ran
 * 31 Oct to 30 Dec, its prorata was computed over two months — Mong Kok 2C was
 * invoiced HK$790 against a HK$12,000 rent that way.
 *
 * Anchoring to the 1st first makes the month arithmetic exact, so the clamp is
 * applied to the month actually being billed.
 */
function addMonthsClamped(date, months, dueDay) {
  const next = new Date(date);
  // The day we are aiming for: the lease's due day when it has one, otherwise
  // the day we started from (a lease billed on the 31st with no due_date set
  // hit the same rollover).
  const wanted = dueDay ? Number(dueDay) : next.getDate();
  next.setDate(1);
  next.setMonth(next.getMonth() + months);
  const maxDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
  next.setDate(Math.min(wanted, maxDay));
  return next;
}

function advanceInvoiceDate(date, schedule, dueDay) {
  const inv = String(schedule).toLowerCase();
  const next = new Date(date);

  if (inv === '1' || inv === 'daily') { next.setDate(next.getDate() + 1); }
  else if (inv === '7' || inv === 'weekly') { next.setDate(next.getDate() + 7); }
  else if (inv === '14' || inv === 'bi-weekly') { next.setDate(next.getDate() + 14); }
  else if (inv === '28') { next.setDate(next.getDate() + 28); }
  else if (inv === '30' || inv === 'monthly') { return addMonthsClamped(date, 1, dueDay); }
  else if (inv === '60' || inv === 'bi-monthly') { return addMonthsClamped(date, 2, dueDay); }
  else if (inv === '90' || inv === 'quarterly') { return addMonthsClamped(date, 3, dueDay); }
  else if (inv === '180' || inv === 'bi-annually') { return addMonthsClamped(date, 6, dueDay); }
  else if (inv === '365' || inv === 'annually') { return addMonthsClamped(date, 12, dueDay); }
  else { return addMonthsClamped(date, 1, dueDay); }

  return next;
}

/**
 * Convenience: returns this period's end (the day BEFORE the next due date).
 */
function periodEndFor(periodStart, schedule, dueDay) {
  const periodAfter = advanceInvoiceDate(periodStart, schedule, dueDay);
  const end = new Date(periodAfter);
  end.setDate(end.getDate() - 1);
  return end;
}

module.exports = { advanceInvoiceDate, periodEndFor, addMonthsClamped };
