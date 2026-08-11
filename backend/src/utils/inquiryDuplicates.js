function normalizeName(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim().replace(/\s+/g, ' ').toLowerCase();
}

function normalizeReservationCode(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim().toUpperCase();
}

function compareSnowflakeStrings(a, b) {
  const sa = String(a);
  const sb = String(b);
  if (sa.length !== sb.length) return sa.length - sb.length;
  return sa < sb ? -1 : (sa > sb ? 1 : 0);
}

function pairKey(idA, idB) {
  const a = String(idA);
  const b = String(idB);
  return compareSnowflakeStrings(a, b) <= 0 ? `${a}:${b}` : `${b}:${a}`;
}

function isEmptyId(value) {
  return value === null || value === undefined || value === '';
}

/**
 * a, b: { id, first_name, last_name, unit_id, status, deleted_at }
 * Returns { isCandidate: boolean, reason: string }
 */
function isDuplicateCandidate(a, b) {
  if (String(a.id) === String(b.id)) return { isCandidate: false, reason: 'same_inquiry' };
  // Number(): a status arriving as the STRING '0' would otherwise read as not-open and
  // silently disable every suggestion — a failure with no error and no output.
  if (Number(a.status) !== 0 || Number(b.status) !== 0) return { isCandidate: false, reason: 'not_open' };
  if (a.deleted_at || b.deleted_at) return { isCandidate: false, reason: 'deleted' };

  const aReservationCode = normalizeReservationCode(a.reservation_code);
  const bReservationCode = normalizeReservationCode(b.reservation_code);
  if (aReservationCode && bReservationCode) {
    if (aReservationCode === bReservationCode) {
      return { isCandidate: true, reason: 'reservation_code_match' };
    }
    return { isCandidate: false, reason: 'different_reservation_code' };
  }

  if (isEmptyId(a.unit_id) || isEmptyId(b.unit_id)) return { isCandidate: false, reason: 'no_unit' };
  if (String(a.unit_id) !== String(b.unit_id)) return { isCandidate: false, reason: 'different_unit' };

  const aFirst = normalizeName(a.first_name);
  const bFirst = normalizeName(b.first_name);
  if (!aFirst || !bFirst) return { isCandidate: false, reason: 'no_name' };
  if (aFirst !== bFirst) return { isCandidate: false, reason: 'different_first_name' };

  const aLast = normalizeName(a.last_name);
  const bLast = normalizeName(b.last_name);
  if (aLast && bLast && aLast !== bLast) return { isCandidate: false, reason: 'different_last_name' };

  return { isCandidate: true, reason: 'name_and_unit_match' };
}

const MERGE_FIELDS = [
  'first_name',
  'last_name',
  'email',
  'phone',
  'reservation_code',
  'budget',
  'desired_start_date',
  'desired_end_date',
  'nightly_rate',
  'stay_total',
  'unit_id',
  'property_id',
];

function isEmptyMergeValue(value) {
  return value === null || value === undefined || value === '';
}

/**
 * Which of the survivor's EMPTY fields can be filled from the loser.
 * Returns { values: {field: value}, filled: [fieldNames] }
 */
function mergeFieldPlan(survivor, loser) {
  const values = {};
  const filled = [];
  for (const field of MERGE_FIELDS) {
    if (!isEmptyMergeValue(survivor[field]) || isEmptyMergeValue(loser[field])) continue;
    values[field] = loser[field];
    filled.push(field);
  }
  return { values, filled };
}

/**
 * Append the loser's notes to the survivor's under a header.
 * Returns { notes, appended: boolean }
 */
function buildMergedNotes(survivorNotes, loserNotes, loserInquiryId, dateStr) {
  const loser = loserNotes == null ? '' : String(loserNotes);
  if (!loser.trim()) {
    return { notes: survivorNotes == null ? '' : String(survivorNotes), appended: false };
  }

  const survivor = survivorNotes == null ? '' : String(survivorNotes);
  const header = `── Merged from inquiry ${loserInquiryId} (${dateStr}) ──`;
  const block = `${header}\n${loser}`;
  const notes = survivor.trimEnd() ? `${survivor.trimEnd()}\n\n${block}` : block;
  return { notes, appended: true };
}

module.exports = {
  normalizeName,
  normalizeReservationCode,
  pairKey,
  isDuplicateCandidate,
  mergeFieldPlan,
  buildMergedNotes,
};
