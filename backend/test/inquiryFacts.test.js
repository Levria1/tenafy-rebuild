const test = require('node:test');
const assert = require('node:assert');
const {
  hkDate,
  appendFactsToNotes,
  resolveWritableFields,
  mergeApiSetFields,
  validateFields,
  payloadHash,
} = require('../src/utils/inquiryFacts');

test('hkDate returns the Hong Kong calendar date of an instant', () => {
  assert.equal(hkDate('2026-08-07T14:12:00+08:00'), '2026-08-07');
  assert.equal(hkDate('2026-08-06T23:00:00Z'), '2026-08-07');
  assert.equal(hkDate('2026-08-07T00:30:00+08:00'), '2026-08-07');
  assert.equal(hkDate(''), '');
  assert.equal(hkDate('not a date'), '');
});

test('appendFactsToNotes adds the heading once and appends below it', () => {
  const first = appendFactsToNotes('', ['Budget set to HK$18,000'], '2026-08-07');
  assert.equal(first, '── Updates from chat ──\n2026-08-07: Budget set to HK$18,000');

  const second = appendFactsToNotes(first, ['Move-in date set for September 20'], '2026-08-07');
  assert.equal(
    second,
    '── Updates from chat ──\n' +
      '2026-08-07: Budget set to HK$18,000\n' +
      '2026-08-07: Move-in date set for September 20'
  );
});

test('appendFactsToNotes keeps prior notes separated by one blank line', () => {
  assert.equal(
    appendFactsToNotes('Prospect seeking studio.', ['Needs parking'], '2026-08-07'),
    'Prospect seeking studio.\n\n── Updates from chat ──\n2026-08-07: Needs parking'
  );
});

test('appendFactsToNotes leaves notes unchanged when there are no facts', () => {
  assert.equal(appendFactsToNotes('Existing notes', [], '2026-08-07'), 'Existing notes');
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
  assert.equal(validateFields({ budget: -1 }).ok, false);
  assert.equal(validateFields({ budget: 18.001 }).ok, false);
  assert.equal(validateFields({ budget: '18,000' }).ok, false);
  assert.deepEqual(validateFields({ budget: 18000 }), { ok: true, fields: { budget: 18000 } });
  assert.deepEqual(validateFields({ budget: 18000.50 }), { ok: true, fields: { budget: 18000.50 } });
});

test('validateFields validates desired_start_date and lowercases email', () => {
  assert.equal(validateFields({ desired_start_date: '2026-9-20' }).ok, false);
  assert.equal(validateFields({ desired_start_date: '20/09/2026' }).ok, false);
  assert.deepEqual(
    validateFields({ desired_start_date: '2026-09-20', email: 'ALICE@EXAMPLE.COM' }),
    { ok: true, fields: { desired_start_date: '2026-09-20', email: 'alice@example.com' } }
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

// ── regression tests for defects found reviewing the generated code ──────────

test('an unparseable occurred_at must not yield a bare ": fact" note line', () => {
  // hkDate('') is the tell; the route now rejects with invalid_occurred_at rather
  // than appending a line whose date prefix is empty, which would silently destroy
  // the audit trail the notes log exists to be.
  assert.equal(hkDate('not-a-date'), '');
  assert.equal(hkDate(undefined), '');
  assert.equal(appendFactsToNotes('', ['Budget set to HK$18,000'], hkDate('not-a-date')),
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
