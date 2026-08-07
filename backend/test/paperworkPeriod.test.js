const test = require('node:test');
const assert = require('node:assert');
const {
  addDays,
  addOneMonthMinusDay,
  computePaperworkState,
} = require('../src/utils/paperworkPeriod');

// ── date maths ──────────────────────────────────────────────────────────────

test('addDays crosses a month boundary', () => {
  assert.equal(addDays('2026-08-31', 1), '2026-09-01');
});

test('addOneMonthMinusDay: a plain month', () => {
  // A period starting 20 Aug is exactly one month long through 19 Sep.
  assert.equal(addOneMonthMinusDay('2026-08-20'), '2026-09-19');
});

test('addOneMonthMinusDay: clamps into a short month', () => {
  // 31 Jan + 1 month clamps to 28 Feb, minus a day -> 27 Feb. Same convention
  // as defaultStampEndDate, dayjs .add(1,"month") and MySQL DATE_ADD.
  assert.equal(addOneMonthMinusDay('2026-01-31'), '2026-02-27');
});

test('addOneMonthMinusDay: 1 Feb in a non-leap year', () => {
  assert.equal(addOneMonthMinusDay('2026-02-01'), '2026-02-28');
});

test('addOneMonthMinusDay: 1 Feb in a leap year', () => {
  assert.equal(addOneMonthMinusDay('2028-02-01'), '2028-02-29');
});

test('addOneMonthMinusDay: December rolls into the next year', () => {
  assert.equal(addOneMonthMinusDay('2026-12-15'), '2027-01-14');
});

test('date maths reads a mysql2 Date as wall-clock, not UTC', () => {
  // mysql2 hands back DATE columns as LOCAL-midnight Date objects. On the HK
  // server toISOString() would report the previous day.
  assert.equal(addDays(new Date(2026, 7, 31), 1), '2026-09-01');
});

// ── the gap decision ────────────────────────────────────────────────────────

const signed = (term_start, term_end) => ({ status: 3, term_start, term_end });
const inFlight = (term_start, term_end) => ({ status: 1, term_start, term_end });

test('a lease whose only request was CANCELLED is not flagged', () => {
  // The paper-signed lease from 2026-08-05 had its request cancelled. Counting
  // an abandoned attempt as "documented" would nag about a lease nobody ever
  // papered. Only signed or in-flight documents opt a lease in.
  const s = computePaperworkState({
    leaseEndDate: '2027-08-31',
    documents: [{ status: 6, term_start: null, term_end: null }],
  });
  assert.equal(s.needs_document, false);
  assert.equal(s.reason, 'no_documents');
  assert.equal(s.has_documents, false);
});

test('a lease with no documents is never flagged', () => {
  // 110 of 113 live leases predate e-signature. Nagging about them would make
  // the marker useless — documenting a lease is what opts it in.
  const s = computePaperworkState({ leaseEndDate: '2027-08-31', documents: [] });
  assert.equal(s.needs_document, false);
  assert.equal(s.reason, 'no_documents');
  assert.equal(s.has_documents, false);
});

test('a signed document covering the lease end is enough', () => {
  const s = computePaperworkState({
    leaseEndDate: '2026-08-19',
    documents: [signed('2025-08-20', '2026-08-19')],
  });
  assert.equal(s.needs_document, false);
  assert.equal(s.reason, 'covered');
  assert.equal(s.covered_end, '2026-08-19');
});

test('under a month uncovered stays quiet', () => {
  // covered to 19 Aug, extended to 5 Sep -> 17 days. No contract needed.
  const s = computePaperworkState({
    leaseEndDate: '2026-09-05',
    documents: [signed('2025-08-20', '2026-08-19')],
  });
  assert.equal(s.needs_document, false);
  assert.equal(s.reason, 'under_a_month');
  assert.deepEqual(s.uncovered, { from: '2026-08-20', to: '2026-09-05' });
});

test('exactly one month uncovered DOES need a document', () => {
  // covered to 19 Aug -> period starts 20 Aug -> one month ends 19 Sep.
  const s = computePaperworkState({
    leaseEndDate: '2026-09-19',
    documents: [signed('2025-08-20', '2026-08-19')],
  });
  assert.equal(s.needs_document, true);
  assert.equal(s.reason, 'gap');
  assert.deepEqual(s.uncovered, { from: '2026-08-20', to: '2026-09-19' });
});

test('more than a month uncovered needs a document', () => {
  const s = computePaperworkState({
    leaseEndDate: '2026-10-19',
    documents: [signed('2025-08-20', '2026-08-19')],
  });
  assert.equal(s.needs_document, true);
  assert.equal(s.reason, 'gap');
});

test('short extensions accumulate against the last SIGNED period', () => {
  // Three-week rollovers each look short in isolation. Measuring from the last
  // signed document is what stops a month-to-month tenant drifting a year past
  // their paperwork.
  const docs = [signed('2025-08-20', '2026-08-19')];
  const after21Days = computePaperworkState({ leaseEndDate: '2026-09-09', documents: docs });
  assert.equal(after21Days.needs_document, false);
  const after42Days = computePaperworkState({ leaseEndDate: '2026-09-30', documents: docs });
  assert.equal(after42Days.needs_document, true);
});

test('an in-flight request covering the end date suppresses the flag', () => {
  const s = computePaperworkState({
    leaseEndDate: '2027-08-31',
    documents: [signed('2025-08-20', '2026-08-19'), inFlight('2026-08-20', '2027-08-31')],
  });
  assert.equal(s.needs_document, false);
  assert.equal(s.reason, 'in_flight');
  assert.equal(s.in_flight, true);
});

test('an in-flight request with no recorded period also suppresses the flag', () => {
  // Pre-existing requests carry no period. Nothing should nag while a document
  // is genuinely out for signature.
  const s = computePaperworkState({
    leaseEndDate: '2027-08-31',
    documents: [inFlight(null, null)],
  });
  assert.equal(s.needs_document, false);
  assert.equal(s.reason, 'in_flight');
});

test('a signed document with no recorded period asks for the period', () => {
  const s = computePaperworkState({
    leaseEndDate: '2027-08-31',
    documents: [signed(null, null)],
  });
  assert.equal(s.needs_document, true);
  assert.equal(s.reason, 'period_not_recorded');
  assert.equal(s.covered_end, null);
});

test('the latest signed period wins, whatever order the rows arrive in', () => {
  const s = computePaperworkState({
    leaseEndDate: '2026-09-19',
    documents: [signed('2026-08-20', '2026-09-19'), signed('2025-08-20', '2026-08-19')],
  });
  assert.equal(s.needs_document, false);
  assert.equal(s.covered_end, '2026-09-19');
});

test('a cancelled or declined document does not count as coverage', () => {
  // status 4 = declined, 6 = cancelled.
  const s = computePaperworkState({
    leaseEndDate: '2026-09-19',
    documents: [
      signed('2025-08-20', '2026-08-19'),
      { status: 6, term_start: '2026-08-20', term_end: '2026-09-19' },
    ],
  });
  assert.equal(s.needs_document, true);
  assert.equal(s.covered_end, '2026-08-19');
});

test('an open-ended lease is never flagged', () => {
  const s = computePaperworkState({
    leaseEndDate: null,
    documents: [signed('2025-08-20', '2026-08-19')],
  });
  assert.equal(s.needs_document, false);
});

test('bigNumberStrings: a status arriving as a STRING still counts', () => {
  // The pools run with bigNumberStrings, so a value can arrive as "3".
  const s = computePaperworkState({
    leaseEndDate: '2026-08-19',
    documents: [{ status: '3', term_start: '2025-08-20', term_end: '2026-08-19' }],
  });
  assert.equal(s.needs_document, false);
  assert.equal(s.reason, 'covered');
});

test('mysql2 Date term ends are compared as wall-clock dates', () => {
  const s = computePaperworkState({
    leaseEndDate: new Date(2026, 8, 19),
    documents: [signed(new Date(2025, 7, 20), new Date(2026, 7, 19))],
  });
  assert.equal(s.needs_document, true);
  assert.deepEqual(s.uncovered, { from: '2026-08-20', to: '2026-09-19' });
});
