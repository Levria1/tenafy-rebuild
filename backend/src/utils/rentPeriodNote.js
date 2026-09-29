const { periodEndFor } = require('./invoiceSchedule');

const MONTHS = [
  'Jan.', 'Feb.', 'Mar.', 'Apr.', 'May', 'June',
  'July', 'Aug.', 'Sept.', 'Oct.', 'Nov.', 'Dec.',
];

function localDate(value) {
  if (!value) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return new Date(value.getFullYear(), value.getMonth(), value.getDate());
  }
  if (typeof value === 'string') {
    const m = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return null;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }
  return null;
}

function dateKey(date) {
  return date.getFullYear() * 10000 + (date.getMonth() + 1) * 100 + date.getDate();
}

function formatMonthDay(date) {
  return `${MONTHS[date.getMonth()]} ${date.getDate()}`;
}

function formatMonthDayYear(date) {
  return `${formatMonthDay(date)}, ${date.getFullYear()}`;
}

function formatRentPeriod(start, end) {
  const s = localDate(start);
  const e = localDate(end);
  if (!s || !e || dateKey(e) < dateKey(s)) return null;

  if (dateKey(s) === dateKey(e)) return formatMonthDayYear(s);

  if (s.getFullYear() === e.getFullYear()) {
    if (s.getMonth() === e.getMonth()) {
      return `${MONTHS[s.getMonth()]} ${s.getDate()} - ${e.getDate()}, ${s.getFullYear()}`;
    }
    return `${formatMonthDay(s)} - ${formatMonthDay(e)}, ${s.getFullYear()}`;
  }

  return `${formatMonthDayYear(s)} - ${formatMonthDayYear(e)}`;
}

function hasSchedule(invoicing) {
  return invoicing !== null && invoicing !== undefined && String(invoicing) !== '';
}

function rentPeriodNote({ dueOn, invoicing, dueDay, leaseStart, leaseEnd } = {}) {
  let start;
  let end;

  if (hasSchedule(invoicing)) {
    start = localDate(dueOn);
    if (!start) return null;
    end = localDate(periodEndFor(start, invoicing, dueDay));
    const leaseEndDate = localDate(leaseEnd);
    if (leaseEndDate && dateKey(leaseEndDate) < dateKey(end)) end = leaseEndDate;
  } else {
    start = localDate(leaseStart);
    end = localDate(leaseEnd);
    if (!start || !end) return null;
  }

  const period = formatRentPeriod(start, end);
  return period ? `Rental payment for ${period}` : null;
}

module.exports = { formatRentPeriod, rentPeriodNote };
