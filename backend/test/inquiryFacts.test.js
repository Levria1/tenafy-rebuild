const test = require('node:test');
const assert = require('node:assert');
const {
  hkDate,
  appendFactsToNotes,
  resolveWritableFields,
  mergeApiSetFields,
  validateFields,
  validateUnitText,
  shouldApplyUnitResolution,
  payloadHash,
  API_WRITABLE_FIELDS,
} = require('../src/utils/inquiryFacts');

test('hkDate returns the Hong Kong calendar date of an instant', () => {
  assert.equal(hkDate('2026-08-07T14:12:00+08:00'), '2026-08-07');
  assert.equal(hkDate('2026-08-06T23:00:00Z'), '2026-08-07');
  assert.equal(hkDate('2026-08-07T00:30:00+08:00'), '2026-08-07');
  assert.equal(hkDate(''), '');
  assert.equal(hkDate('not a date'), '');
});

test('appendFactsToNotes adds the heading once and appends below it', () => {
  const first = appendFactsToNotes('', ['Budget set to HK$18,000'], '2026-08-07').notes;
  assert.equal(first, '── Updates from chat ──\n2026-08-07: Budget set to HK$18,000');

  const second = appendFactsToNotes(first, ['Move-in date set for September 20'], '2026-08-07').notes;
  assert.equal(
    second,
    '── Updates from chat ──\n' +
      '2026-08-07: Budget set to HK$18,000\n' +
      '2026-08-07: Move-in date set for September 20'
  );
});

test('appendFactsToNotes keeps prior notes separated by one blank line', () => {
  assert.equal(
    appendFactsToNotes('Prospect seeking studio.', ['Needs parking'], '2026-08-07').notes,
    'Prospect seeking studio.\n\n── Updates from chat ──\n2026-08-07: Needs parking'
  );
});

test('appendFactsToNotes leaves notes unchanged when there are no facts', () => {
  assert.equal(appendFactsToNotes('Existing notes', [], '2026-08-07').notes, 'Existing notes');
});

test('resolveWritableFields writes empty or API-owned fields and skips human-owned fields', () => {
  const result = resolveWritableFields(
    { first_name: 'Alice', last_name: 'Wong', budget: 25000, phone: '1234' },
    { first_name: '', last_name: 'Human', budget: '18000', phone: null },
    ['budget']
  );
  assert.deepEqual(result.writable, { first_name: 'Alice', budget: 25000, phone: '1234' });
  assert.deepEqual(result.skipped, ['last_name']);
});

test('resolveWritableFields treats numeric zero and string zero as set values', () => {
  assert.deepEqual(
    resolveWritableFields({ budget: 100 }, { budget: 0 }, []).writable,
    {}
  );
  assert.deepEqual(
    resolveWritableFields({ budget: 100 }, { budget: '0' }, []).writable,
    {}
  );
});

test('mergeApiSetFields unions stable field lists', () => {
  assert.deepEqual(mergeApiSetFields(null, ['budget']), ['budget']);
  assert.deepEqual(mergeApiSetFields('[]', ['budget']), ['budget']);
  assert.deepEqual(
    mergeApiSetFields('["budget","email"]', ['budget', 'desired_start_date']),
    ['budget', 'email', 'desired_start_date']
  );
});

test('validateFields rejects unsafe and unknown fields', () => {
  for (const field of ['status', 'tenant_id', 'org_id', 'deleted_at', 'other']) {
    assert.deepEqual(validateFields({ [field]: 'x' }), { ok: false, error: `unknown_field: ${field}` });
  }
});

test('validateFields validates budget', () => {
  assert.deepEqual(validateFields({ budget: -1 }), { ok: false, error: 'invalid_budget' });
  assert.equal(validateFields({ budget: 18.001 }).ok, false);
  assert.equal(validateFields({ budget: '18,000' }).ok, false);
  assert.deepEqual(validateFields({ budget: 18000 }), { ok: true, fields: { budget: 18000 } });
  assert.deepEqual(validateFields({ budget: 18000.50 }), { ok: true, fields: { budget: 18000.50 } });
});

test('validateFields validates short-stay money fields', () => {
  assert.deepEqual(validateFields({ nightly_rate: 590 }), { ok: true, fields: { nightly_rate: 590 } });
  assert.deepEqual(validateFields({ stay_total: 8361.5 }), { ok: true, fields: { stay_total: 8361.5 } });
  assert.deepEqual(
    validateFields({
      nightly_rate: 590,
      stay_total: 8361.5,
      desired_start_date: '2026-08-12',
      desired_end_date: '2026-08-28',
    }),
    {
      ok: true,
      fields: {
        nightly_rate: 590,
        stay_total: 8361.5,
        desired_start_date: '2026-08-12',
        desired_end_date: '2026-08-28',
      },
    }
  );
});

test('validateFields rejects invalid nightly_rate values', () => {
  for (const nightly_rate of [-1, '590', 590.123, Infinity]) {
    assert.deepEqual(validateFields({ nightly_rate }), { ok: false, error: 'invalid_nightly_rate' });
  }
});

test('validateFields rejects invalid stay_total values', () => {
  for (const stay_total of [-1, '590', 590.123, Infinity]) {
    assert.deepEqual(validateFields({ stay_total }), { ok: false, error: 'invalid_stay_total' });
  }
});

test('validateFields validates desired_start_date, desired_end_date and lowercases email', () => {
  assert.equal(validateFields({ desired_start_date: '2026-9-20' }).ok, false);
  assert.equal(validateFields({ desired_start_date: '20/09/2026' }).ok, false);
  assert.deepEqual(
    validateFields({ desired_end_date: '2026-08-28' }),
    { ok: true, fields: { desired_end_date: '2026-08-28' } }
  );
  assert.deepEqual(
    validateFields({ desired_end_date: '28-08-2026' }),
    { ok: false, error: 'invalid_desired_end_date' }
  );
  assert.deepEqual(
    validateFields({ desired_end_date: 20260828 }),
    { ok: false, error: 'invalid_desired_end_date' }
  );
  assert.deepEqual(
    validateFields({ desired_start_date: '2026-09-20', email: 'ALICE@EXAMPLE.COM' }),
    { ok: true, fields: { desired_start_date: '2026-09-20', email: 'alice@example.com' } }
  );
});

test('validateFields accepts and uppercases reservation_code', () => {
  assert.deepEqual(
    validateFields({ reservation_code: 'hmqk4qjk9m' }),
    { ok: true, fields: { reservation_code: 'HMQK4QJK9M' } }
  );
});

test('validateFields rejects invalid reservation_code values', () => {
  for (const reservation_code of ['ABC', 'A'.repeat(33), 'HMQK 4QJK9M', 'HMQK4QJK@M', 42]) {
    assert.deepEqual(validateFields({ reservation_code }), { ok: false, error: 'invalid_reservation_code' });
  }
});

test('validateFields treats blank reservation_code as null', () => {
  assert.deepEqual(validateFields({ reservation_code: '' }), { ok: true, fields: { reservation_code: null } });
  assert.deepEqual(validateFields({ reservation_code: '   ' }), { ok: true, fields: { reservation_code: null } });
});

test('reservation_code is API-writable for human-edit provenance removal', () => {
  assert.equal(API_WRITABLE_FIELDS.has('reservation_code'), true);
});

test('validateFields accepts discounted stay_total without deriving arithmetic', () => {
  // Long-stay discounts mean stay_total is sent by the source, not computed as
  // nightly_rate times derived nights.
  assert.deepEqual(
    validateFields({
      nightly_rate: 590,
      stay_total: 8361,
      desired_start_date: '2026-08-12',
      desired_end_date: '2026-08-28',
    }),
    {
      ok: true,
      fields: {
        nightly_rate: 590,
        stay_total: 8361,
        desired_start_date: '2026-08-12',
        desired_end_date: '2026-08-28',
      },
    }
  );
});

test('validateFields accepts desired_end_date before desired_start_date', () => {
  // Cross-field validation is deliberately absent: a correction may carry only
  // the field that changed, or dates may arrive in separate deliveries.
  assert.deepEqual(
    validateFields({ desired_start_date: '2026-08-28', desired_end_date: '2026-08-12' }),
    {
      ok: true,
      fields: { desired_start_date: '2026-08-28', desired_end_date: '2026-08-12' },
    }
  );
});

test('payloadHash is stable by key order and includes changed facts and occurred_at', () => {
  const a = payloadHash({
    fields: { budget: 18000, email: 'a@example.com' },
    facts: ['Budget set to HK$18,000'],
    summary: 'Summary',
    is_inquiry: true,
    occurred_at: '2026-08-07T14:12:00+08:00',
  });
  const b = payloadHash({
    occurred_at: '2026-08-07T14:12:00+08:00',
    is_inquiry: true,
    summary: 'Summary',
    facts: ['Budget set to HK$18,000'],
    fields: { email: 'a@example.com', budget: 18000 },
  });
  const changedFact = payloadHash({
    fields: { budget: 18000, email: 'a@example.com' },
    facts: ['Budget set to HK$19,000'],
    summary: 'Summary',
    is_inquiry: true,
    occurred_at: '2026-08-07T14:12:00+08:00',
  });
  const changedOccurredAt = payloadHash({
    fields: { budget: 18000, email: 'a@example.com' },
    facts: ['Budget set to HK$18,000'],
    summary: 'Summary',
    is_inquiry: true,
    occurred_at: '2026-08-08T14:12:00+08:00',
  });
  assert.equal(a, b);
  assert.notEqual(a, changedFact);
  assert.notEqual(a, changedOccurredAt);
});

test('payloadHash differs when unit_text differs', () => {
  const base = {
    fields: { budget: 18000 },
    facts: ['Budget set to HK$18,000'],
    summary: 'Summary',
    is_inquiry: true,
    occurred_at: '2026-08-07T14:12:00+08:00',
    unit_text: 'Mong Kok Luxury Studio 5C',
  };
  const changed = { ...base, unit_text: 'COSY CAUSEWAY BAY STUDIO 105' };
  // Without this, adding a listing to an already-seen idempotency key is swallowed.
  assert.notEqual(payloadHash(base), payloadHash(changed));
});

test('payloadHash ignores irrelevant keys and remains stable by nested key order', () => {
  const a = payloadHash({
    fields: { email: 'a@example.com', budget: 18000 },
    facts: ['Budget set to HK$18,000'],
    summary: 'Summary',
    unit_text: 'Mong Kok Luxury Studio 5C',
    is_inquiry: true,
    occurred_at: '2026-08-07T14:12:00+08:00',
    ignored: 'x',
  });
  const b = payloadHash({
    occurred_at: '2026-08-07T14:12:00+08:00',
    is_inquiry: true,
    unit_text: 'Mong Kok Luxury Studio 5C',
    summary: 'Summary',
    facts: ['Budget set to HK$18,000'],
    fields: { budget: 18000, email: 'a@example.com' },
    another_ignored: 'y',
  });
  assert.equal(a, b);
});

test('validateUnitText accepts absent and blank values as null', () => {
  assert.deepEqual(validateUnitText(undefined), { ok: true, unitText: null });
  assert.deepEqual(validateUnitText(null), { ok: true, unitText: null });
  assert.deepEqual(validateUnitText(''), { ok: true, unitText: null });
  assert.deepEqual(validateUnitText('   '), { ok: true, unitText: null });
});

test('validateUnitText trims titles and rejects unsafe values', () => {
  assert.deepEqual(validateUnitText('  Mong Kok Luxury Studio 5C  '), {
    ok: true,
    unitText: 'Mong Kok Luxury Studio 5C',
  });
  assert.deepEqual(validateUnitText('x'.repeat(256)), { ok: false, error: 'unit_text_too_long' });
  assert.deepEqual(validateUnitText(42), { ok: false, error: 'invalid_unit_text' });
  assert.deepEqual(validateUnitText({ title: 'Mong Kok Luxury Studio 5C' }), { ok: false, error: 'invalid_unit_text' });
});

test('shouldApplyUnitResolution only allows confident matches with empty or API-owned unit_id', () => {
  assert.equal(shouldApplyUnitResolution({ status: 'confident', currentUnitId: null, apiSetFields: [] }), true);
  assert.equal(shouldApplyUnitResolution({ status: 'confident', currentUnitId: '123', apiSetFields: [] }), false);
  assert.equal(shouldApplyUnitResolution({ status: 'confident', currentUnitId: '123', apiSetFields: ['unit_id'] }), true);
  assert.equal(shouldApplyUnitResolution({ status: 'confident', currentUnitId: '123', apiSetFields: '["unit_id"]' }), true);
  for (const status of ['ambiguous', 'property_only', 'multi_unit', 'none']) {
    assert.equal(shouldApplyUnitResolution({ status, currentUnitId: null, apiSetFields: ['unit_id'] }), false);
  }
});

test('shouldApplyUnitResolution treats numeric and string zero unit ids as set', () => {
  assert.equal(shouldApplyUnitResolution({ status: 'confident', currentUnitId: '0', apiSetFields: [] }), false);
  assert.equal(shouldApplyUnitResolution({ status: 'confident', currentUnitId: 0, apiSetFields: [] }), false);
});

// ── regression tests for defects found reviewing the generated code ──────────

test('an unparseable occurred_at must not yield a bare ": fact" note line', () => {
  // hkDate('') is the tell; the route now rejects with invalid_occurred_at rather
  // than appending a line whose date prefix is empty, which would silently destroy
  // the audit trail the notes log exists to be.
  assert.equal(hkDate('not-a-date'), '');
  assert.equal(hkDate(undefined), '');
  assert.equal(appendFactsToNotes('', ['Budget set to HK$18,000'], hkDate('not-a-date')).notes,
    '── Updates from chat ──\n: Budget set to HK$18,000');
});

test('string fields reject a non-string rather than reaching MySQL', () => {
  assert.equal(validateFields({ first_name: { a: 1 } }).ok, false);
  assert.equal(validateFields({ first_name: 42 }).ok, false);
  assert.equal(validateFields({ phone: ['x'] }).ok, false);
});

test('string fields reject values wider than the column', () => {
  // inquiry.first_name is VARCHAR(255), phone VARCHAR(50). Overlong values used to
  // pass validation and surface as a 500 from MySQL instead of a 400.
  assert.equal(validateFields({ first_name: 'x'.repeat(256) }).ok, false);
  assert.equal(validateFields({ first_name: 'x'.repeat(255) }).ok, true);
  assert.equal(validateFields({ phone: '9'.repeat(51) }).ok, false);
  assert.equal(validateFields({ phone: '9'.repeat(50) }).ok, true);
});

test('string fields are trimmed, and blank becomes null', () => {
  assert.equal(validateFields({ first_name: '  Alice  ' }).fields.first_name, 'Alice');
  assert.equal(validateFields({ first_name: '   ' }).fields.first_name, null);
  assert.equal(validateFields({ email: '  ALICE@Example.COM ' }).fields.email, 'alice@example.com');
  assert.equal(validateFields({ last_name: null }).fields.last_name, null);
});

// ── fact deduplication ───────────────────────────────────────────────────────
// Notes are append-only and kept forever. Idempotency stops the SAME delivery
// replaying; it does nothing about a DIFFERENT delivery carrying a fact already
// recorded, which is what an extractor with a slipped snapshot produces.

test('appendFactsToNotes does not record a fact already in notes', () => {
  const first = appendFactsToNotes('', ['Prefers Wan Chai over Sheung Wan'], '2026-08-07');
  assert.equal(first.applied, 1);

  const again = appendFactsToNotes(first.notes, ['Prefers Wan Chai over Sheung Wan'], '2026-08-09');
  assert.equal(again.applied, 0);
  assert.equal(again.skipped, 1);
  assert.equal(again.notes, first.notes, 'notes must be byte-identical');
});

test('appendFactsToNotes ignores case, spacing and trailing punctuation when comparing', () => {
  const first = appendFactsToNotes('', ['Needs parking'], '2026-08-07');
  const again = appendFactsToNotes(first.notes, ['  needs   parking. '], '2026-08-09');
  assert.equal(again.applied, 0);
  assert.equal(again.skipped, 1);
});

test('appendFactsToNotes deduplicates within a single payload', () => {
  const r = appendFactsToNotes('', ['Wants 2BR', 'Wants 2BR', 'Has a cat'], '2026-08-07');
  assert.equal(r.applied, 2);
  assert.equal(r.skipped, 1);
  assert.equal((r.notes.match(/Wants 2BR/g) || []).length, 1);
});

test('appendFactsToNotes still records genuinely new facts alongside duplicates', () => {
  const first = appendFactsToNotes('', ['Needs parking'], '2026-08-07');
  const next = appendFactsToNotes(first.notes, ['Needs parking', 'Budget raised to HK$25,000'], '2026-08-09');
  assert.equal(next.applied, 1);
  assert.equal(next.skipped, 1);
  assert.match(next.notes, /2026-08-09: Budget raised to HK\$25,000/);
});

// A fact matching the free-text summary paragraph is also a duplicate — the
// summary is notes content too, not a separate field.
test('appendFactsToNotes compares against un-dated notes lines as well', () => {
  const r = appendFactsToNotes('Needs parking', ['Needs parking'], '2026-08-09');
  assert.equal(r.applied, 0);
  assert.equal(r.notes, 'Needs parking');
});

test('appendFactsToNotes keeps the heading when every fact is a duplicate', () => {
  const first = appendFactsToNotes('Base summary.', ['Needs parking'], '2026-08-07');
  const again = appendFactsToNotes(first.notes, ['Needs parking'], '2026-08-09');
  assert.equal((again.notes.match(/── Updates from chat ──/g) || []).length, 1);
});
