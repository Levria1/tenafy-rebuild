const test = require('node:test');
const assert = require('node:assert');
const {
  normalizeName,
  normalizeReservationCode,
  pairKey,
  isDuplicateCandidate,
  mergeFieldPlan,
  buildMergedNotes,
} = require('../src/utils/inquiryDuplicates');

function inquiry(overrides = {}) {
  return {
    id: '1000000000000000001',
    first_name: 'Chiamaka',
    last_name: null,
    unit_id: '123',
    status: 0,
    deleted_at: null,
    ...overrides,
  };
}

test('normalizeName trims, collapses whitespace, lowercases, and handles nullish values', () => {
  assert.equal(normalizeName('  Anna   Maria  '), 'anna maria');
  assert.equal(normalizeName('\tChiamaka\nOkafor '), 'chiamaka okafor');
  assert.equal(normalizeName(null), '');
  assert.equal(normalizeName(undefined), '');
});

test('normalizeReservationCode trims, uppercases, and handles nullish values', () => {
  assert.equal(normalizeReservationCode('  hmqk4qjk9m  '), 'HMQK4QJK9M');
  assert.equal(normalizeReservationCode(null), '');
  assert.equal(normalizeReservationCode(undefined), '');
});

test('pairKey is order-independent and compares Snowflake ids as strings', () => {
  const a = '1800000000000000000001';
  const b = '1800000000000000000002';
  assert.equal(pairKey(a, b), pairKey(b, a));
  assert.equal(pairKey(a, b), `${a}:${b}`);
  assert.notEqual(pairKey(a, b), pairKey(a, '1800000000000000000003'));
});

test('isDuplicateCandidate accepts the Chiamaka case with same first name, no last names, same unit, both open', () => {
  const result = isDuplicateCandidate(
    inquiry({ id: '1000000000000000001' }),
    inquiry({ id: '1000000000000000002' })
  );
  assert.deepEqual(result, { isCandidate: true, reason: 'name_and_unit_match' });
});

test('isDuplicateCandidate rejects same_inquiry', () => {
  assert.deepEqual(
    isDuplicateCandidate(inquiry({ id: '1' }), inquiry({ id: '1' })),
    { isCandidate: false, reason: 'same_inquiry' }
  );
});

test('isDuplicateCandidate rejects not_open', () => {
  assert.equal(isDuplicateCandidate(inquiry(), inquiry({ id: '2', status: 2 })).reason, 'not_open');
});

test('isDuplicateCandidate rejects deleted', () => {
  assert.equal(isDuplicateCandidate(inquiry(), inquiry({ id: '2', deleted_at: '2026-08-11' })).reason, 'deleted');
});

test('isDuplicateCandidate rejects no_unit', () => {
  assert.equal(isDuplicateCandidate(inquiry(), inquiry({ id: '2', unit_id: null })).reason, 'no_unit');
});

test('isDuplicateCandidate rejects different_unit', () => {
  assert.equal(isDuplicateCandidate(inquiry(), inquiry({ id: '2', unit_id: '456' })).reason, 'different_unit');
});

test('isDuplicateCandidate rejects no_name', () => {
  assert.equal(isDuplicateCandidate(inquiry(), inquiry({ id: '2', first_name: '   ' })).reason, 'no_name');
});

test('isDuplicateCandidate rejects different_first_name', () => {
  assert.equal(isDuplicateCandidate(inquiry(), inquiry({ id: '2', first_name: 'Anna' })).reason, 'different_first_name');
});

test('isDuplicateCandidate rejects different_last_name', () => {
  assert.equal(
    isDuplicateCandidate(inquiry({ last_name: 'Okafor' }), inquiry({ id: '2', last_name: 'Smith' })).reason,
    'different_last_name'
  );
});

test('isDuplicateCandidate rejects the Victor case when units differ', () => {
  // Real prospect: same first name and dates, two listings. Must not be offered as a duplicate.
  const result = isDuplicateCandidate(
    inquiry({ id: '1', first_name: 'Victor', unit_id: '123', desired_start_date: '2026-08-21' }),
    inquiry({ id: '2', first_name: 'Victor', unit_id: '456', desired_start_date: '2026-08-21' })
  );
  assert.deepEqual(result, { isCandidate: false, reason: 'different_unit' });
});

test('isDuplicateCandidate accepts one missing last name', () => {
  const result = isDuplicateCandidate(
    inquiry({ id: '1', last_name: 'Okafor' }),
    inquiry({ id: '2', last_name: '' })
  );
  assert.deepEqual(result, { isCandidate: true, reason: 'name_and_unit_match' });
});

test('isDuplicateCandidate compares unit ids as strings', () => {
  const result = isDuplicateCandidate(
    inquiry({ id: '1', unit_id: '123' }),
    inquiry({ id: '2', unit_id: 123 })
  );
  assert.deepEqual(result, { isCandidate: true, reason: 'name_and_unit_match' });
});

test('isDuplicateCandidate accepts same reservation code without matching name or both units', () => {
  // Reservation code outranks both heuristics because it is an identifier, and
  // the enquiry thread usually has no unit yet while the later OTA thread does.
  const result = isDuplicateCandidate(
    inquiry({ id: '1', first_name: 'Chiamaka', unit_id: null, reservation_code: 'HMQK4QJK9M' }),
    inquiry({ id: '2', first_name: 'Anna', unit_id: '123', reservation_code: 'HMQK4QJK9M' })
  );
  assert.deepEqual(result, { isCandidate: true, reason: 'reservation_code_match' });
});

test('isDuplicateCandidate vetoes different reservation codes before name and unit', () => {
  // Same guest name and same flat can be two genuine bookings; different
  // reservation identifiers must never be offered for merge.
  const result = isDuplicateCandidate(
    inquiry({ id: '1', first_name: 'Victor', unit_id: '123', reservation_code: 'HMQK4QJK9M' }),
    inquiry({ id: '2', first_name: 'Victor', unit_id: '123', reservation_code: 'ABCD1234EF' })
  );
  assert.deepEqual(result, { isCandidate: false, reason: 'different_reservation_code' });
});

test('isDuplicateCandidate matches reservation codes case-insensitively after trim', () => {
  const result = isDuplicateCandidate(
    inquiry({ id: '1', reservation_code: '  hmqk4qjk9m ' }),
    inquiry({ id: '2', first_name: 'Anna', unit_id: null, reservation_code: 'HMQK4QJK9M' })
  );
  assert.deepEqual(result, { isCandidate: true, reason: 'reservation_code_match' });
});

test('isDuplicateCandidate falls through when only one side has a reservation code', () => {
  assert.deepEqual(
    isDuplicateCandidate(
      inquiry({ id: '1', first_name: 'Chiamaka', unit_id: '123', reservation_code: 'HMQK4QJK9M' }),
      inquiry({ id: '2', first_name: 'Chiamaka', unit_id: '123', reservation_code: null })
    ),
    { isCandidate: true, reason: 'name_and_unit_match' }
  );
  assert.deepEqual(
    isDuplicateCandidate(
      inquiry({ id: '1', first_name: 'Chiamaka', unit_id: '123', reservation_code: 'HMQK4QJK9M' }),
      inquiry({ id: '2', first_name: 'Anna', unit_id: '123', reservation_code: null })
    ),
    { isCandidate: false, reason: 'different_first_name' }
  );
});

test('isDuplicateCandidate treats empty reservation codes as missing and falls through', () => {
  assert.deepEqual(
    isDuplicateCandidate(
      inquiry({ id: '1', reservation_code: '' }),
      inquiry({ id: '2', reservation_code: '   ' })
    ),
    { isCandidate: true, reason: 'name_and_unit_match' }
  );
});

test('isDuplicateCandidate keeps not_open and deleted ahead of reservation-code matches', () => {
  assert.deepEqual(
    isDuplicateCandidate(
      inquiry({ id: '1', reservation_code: 'HMQK4QJK9M' }),
      inquiry({ id: '2', status: 2, reservation_code: 'HMQK4QJK9M' })
    ),
    { isCandidate: false, reason: 'not_open' }
  );
  assert.deepEqual(
    isDuplicateCandidate(
      inquiry({ id: '1', reservation_code: 'HMQK4QJK9M' }),
      inquiry({ id: '2', deleted_at: '2026-08-11', reservation_code: 'HMQK4QJK9M' })
    ),
    { isCandidate: false, reason: 'deleted' }
  );
});

test('mergeFieldPlan fills only empty survivor fields and preserves populated values', () => {
  const result = mergeFieldPlan(
    {
      first_name: '',
      last_name: 'Survivor',
      email: null,
      phone: undefined,
      reservation_code: '',
      budget: '0.00',
      desired_start_date: '',
      desired_end_date: '2026-08-30',
      nightly_rate: 0,
      stay_total: null,
      unit_id: '123',
      property_id: null,
    },
    {
      first_name: 'Chiamaka',
      last_name: 'Loser',
      email: 'guest@example.com',
      phone: '5555',
      reservation_code: 'HMQK4QJK9M',
      budget: '25000.00',
      desired_start_date: '2026-08-21',
      desired_end_date: '2026-09-01',
      nightly_rate: '500.00',
      stay_total: null,
      unit_id: '456',
      property_id: '789',
    }
  );
  assert.deepEqual(result.values, {
    first_name: 'Chiamaka',
    email: 'guest@example.com',
    phone: '5555',
    reservation_code: 'HMQK4QJK9M',
    desired_start_date: '2026-08-21',
    property_id: '789',
  });
  assert.deepEqual(result.filled, ['first_name', 'email', 'phone', 'reservation_code', 'desired_start_date', 'property_id']);
});

test('mergeFieldPlan never overwrites survivor reservation_code', () => {
  const result = mergeFieldPlan(
    { reservation_code: 'SURVIVOR1', first_name: 'Survivor' },
    { reservation_code: 'LOSER999', first_name: 'Loser' }
  );
  assert.equal(result.values.reservation_code, undefined);
  assert.equal(result.filled.includes('reservation_code'), false);
});

test('buildMergedNotes appends under the exact header and preserves survivor notes', () => {
  const result = buildMergedNotes('Existing survivor notes', 'Loser notes', '2002', '2026-08-11');
  assert.equal(result.appended, true);
  assert.equal(
    result.notes,
    'Existing survivor notes\n\n── Merged from inquiry 2002 (2026-08-11) ──\nLoser notes'
  );
  assert.equal(result.notes.startsWith('Existing survivor notes'), true);
});

test('buildMergedNotes leaves survivor notes unchanged when loser has no notes', () => {
  const result = buildMergedNotes('Existing survivor notes', '   ', '2002', '2026-08-11');
  assert.deepEqual(result, { notes: 'Existing survivor notes', appended: false });
});
