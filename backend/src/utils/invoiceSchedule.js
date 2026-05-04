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
function advanceInvoiceDate(date, schedule, dueDay) {
  const inv = String(schedule).toLowerCase();
  const next = new Date(date);

  if (inv === '1' || inv === 'daily') { next.setDate(next.getDate() + 1); }
  else if (inv === '7' || inv === 'weekly') { next.setDate(next.getDate() + 7); }
  else if (inv === '14' || inv === 'bi-weekly') { next.setDate(next.getDate() + 14); }
  else if (inv === '28') { next.setDate(next.getDate() + 28); }
  else if (inv === '30' || inv === 'monthly') {
    next.setMonth(next.getMonth() + 1);
    if (dueDay) {
      const maxDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
      next.setDate(Math.min(Number(dueDay), maxDay));
    }
  } else if (inv === '60' || inv === 'bi-monthly') {
    next.setMonth(next.getMonth() + 2);
    if (dueDay) {
      const maxDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
      next.setDate(Math.min(Number(dueDay), maxDay));
    }
  } else if (inv === '90' || inv === 'quarterly') {
    next.setMonth(next.getMonth() + 3);
    if (dueDay) {
      const maxDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
      next.setDate(Math.min(Number(dueDay), maxDay));
    }
  } else if (inv === '180' || inv === 'bi-annually') {
    next.setMonth(next.getMonth() + 6);
    if (dueDay) {
      const maxDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
      next.setDate(Math.min(Number(dueDay), maxDay));
    }
  } else if (inv === '365' || inv === 'annually') {
    next.setFullYear(next.getFullYear() + 1);
    if (dueDay) {
      const maxDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
      next.setDate(Math.min(Number(dueDay), maxDay));
    }
  } else {
    next.setMonth(next.getMonth() + 1);
  }

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

module.exports = { advanceInvoiceDate, periodEndFor };
