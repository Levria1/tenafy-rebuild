// Pure helpers for deciding whether signature requests cover the same lease period.

function toYmd(value) {
  if (!value) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const pad = n => String(n).padStart(2, '0');
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  const text = String(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function isExpiredRequest(doc, now = new Date()) {
  const status = Number(doc && doc.status);
  if (status !== 1 && status !== 2) return false;
  if (!doc || !doc.expires_at) return false;
  const expiry = doc.expires_at instanceof Date ? doc.expires_at : new Date(doc.expires_at);
  return !Number.isNaN(expiry.getTime()) && expiry < now;
}

function isLiveRequest(doc, now = new Date()) {
  const status = Number(doc && doc.status);
  return (status === 1 || status === 2) && !isExpiredRequest(doc, now);
}

function periodOf(doc = {}, lease = {}) {
  const hasRecordedTerm = toYmd(doc.term_start) || toYmd(doc.term_end);
  const start = hasRecordedTerm ? toYmd(doc.term_start) : toYmd(lease.start_date);
  const end = hasRecordedTerm ? toYmd(doc.term_end) : toYmd(lease.end_date);
  return start || end ? { start, end } : null;
}

function periodsOverlap(a, b) {
  const left = a || {};
  const right = b || {};
  return (!left.start || !right.end || left.start <= right.end)
    && (!right.start || !left.end || right.start <= left.end);
}

function findOverlappingLive(requests, period, lease, { now = new Date(), excludeId } = {}) {
  const target = {
    start: toYmd(period && period.start) || toYmd(lease && lease.start_date),
    end: toYmd(period && period.end) || toYmd(lease && lease.end_date),
  };
  return (Array.isArray(requests) ? requests : []).filter(request => (
    isLiveRequest(request, now)
    && (excludeId == null || String(request.id) !== String(excludeId))
    && periodsOverlap(periodOf(request, lease), target)
  ));
}

module.exports = {
  isExpiredRequest,
  isLiveRequest,
  periodOf,
  periodsOverlap,
  findOverlappingLive,
};
