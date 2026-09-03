const test = require('node:test');
const assert = require('node:assert');
const {
  bitToBool, decodeLeasingBits, decodeLeasingBitsAll, LEASING_BIT_COLUMNS,
} = require('../src/utils/mysqlBit');

// ── the trap this module exists for ─────────────────────────────────────────

test('a zero bit arrives as a truthy Buffer, which is the whole bug', () => {
  // If this assertion ever fails, mysql2 changed its behaviour and the decoding
  // below stopped being necessary. Worth knowing either way.
  const zero = Buffer.from([0]);
  assert.equal(!!zero, true, 'Buffer.from([0]) is truthy in JS');
  assert.equal(bitToBool(zero), false, 'but the bit is 0, so this must be false');
});

test('a set bit decodes to true', () => {
  assert.equal(bitToBool(Buffer.from([1])), true);
});

test('an empty Buffer is false rather than throwing', () => {
  assert.equal(bitToBool(Buffer.alloc(0)), false);
});

// ── every other shape the driver or a caller might hand over ────────────────

test('null and undefined are false', () => {
  assert.equal(bitToBool(null), false);
  assert.equal(bitToBool(undefined), false);
});

test('numbers and booleans pass through', () => {
  assert.equal(bitToBool(0), false);
  assert.equal(bitToBool(1), true);
  assert.equal(bitToBool(false), false);
  assert.equal(bitToBool(true), true);
});

test('the string forms MySQL drivers produce are handled', () => {
  assert.equal(bitToBool('0'), false);
  assert.equal(bitToBool(''), false);
  assert.equal(bitToBool('false'), false);
  assert.equal(bitToBool('1'), true);
  assert.equal(bitToBool(' 1 '), true);
});

// ── row decoding ────────────────────────────────────────────────────────────

test('a lease row comes back with real booleans, matching what was stored', () => {
  // The reported case: created with check-in and check-out only, reviewed as all nine on.
  const row = {
    lease_no: 'LEA3381',
    tenant_posted: Buffer.from([0]),
    tenant_due: Buffer.from([0]),
    tenant_overdue: Buffer.from([0]),
    tenant_checkin: Buffer.from([1]),
    tenant_checkout: Buffer.from([1]),
    payment_receipt: 0,               // tinyint(1): never a Buffer, was always correct
  };
  const out = decodeLeasingBits(row);
  assert.equal(out.tenant_posted, false);
  assert.equal(out.tenant_due, false);
  assert.equal(out.tenant_overdue, false);
  assert.equal(out.tenant_checkin, true);
  assert.equal(out.tenant_checkout, true);
  assert.equal(out.payment_receipt, 0, 'left alone; it is not a bit column');
  assert.equal(out.lease_no, 'LEA3381', 'non-flag fields untouched');
});

test('a column that was not selected is not invented', () => {
  // A partial SELECT must not start reporting flags it never fetched as `false`.
  const out = decodeLeasingBits({ lease_no: 'LEA1' });
  assert.equal('tenant_posted' in out, false);
});

test('decoding survives null, non-objects and arrays of rows', () => {
  assert.equal(decodeLeasingBits(null), null);
  assert.equal(decodeLeasingBits('nope'), 'nope');
  const rows = decodeLeasingBitsAll([{ tenant_checkin: Buffer.from([1]) }, { tenant_checkin: Buffer.from([0]) }]);
  assert.deepEqual(rows.map(r => r.tenant_checkin), [true, false]);
  assert.equal(decodeLeasingBitsAll(null), null);
});

test('the covered-column list matches what was verified against the database', () => {
  // Honest about what this proves: it pins the constant so an accidental edit is caught.
  // It CANNOT detect a migration adding a twelfth bit(1) column — nothing in a unit test
  // can, without a database. If you add one, add it here by hand.
  assert.deepEqual([...LEASING_BIT_COLUMNS].sort(), [
    'landlord_due', 'landlord_expired', 'landlord_overdue', 'landlord_posted',
    'tenant_checkin', 'tenant_checkout', 'tenant_deposit_posted', 'tenant_due',
    'tenant_overdue', 'tenant_posted', 'tenant_renewal',
  ]);
  assert.equal(LEASING_BIT_COLUMNS.length, 11);
});

test('the frontend pattern that caused this now yields the right answer', () => {
  // The edit page does `tenant_posted: !!d.tenant_posted`. Against a decoded row that
  // is finally correct, which is why the fix belongs server-side.
  const decoded = decodeLeasingBits({ tenant_posted: Buffer.from([0]) });
  assert.equal(!!decoded.tenant_posted, false);
});

test('the check-in gate agrees with the decoder on a zero bit', () => {
  // Asserted through the real gate rather than by checking that a module loads, which
  // proved nothing. A stored 0 must not send; a stored 1 in the window must.
  const { shouldSendCheckinNow } = require('../src/utils/checkinWindow');
  const base = { leaseState: 'active', startDate: '2026-09-10', today: '2026-09-04', leadDays: 14 };
  const off = shouldSendCheckinNow({ ...base, tenantCheckin: Buffer.from([0]) });
  const on  = shouldSendCheckinNow({ ...base, tenantCheckin: Buffer.from([1]) });
  assert.equal(off.send, false);
  assert.equal(off.reason, 'checkin_disabled', 'a zero bit stops at the first gate');
  assert.equal(on.send, true, 'a set bit sends');
  assert.equal(on.reason, 'in_window');
});

test('malformed values fail CLOSED, because these flags send email', () => {
  // An earlier draft ended in `Boolean(value)`, so every object and array read as
  // enabled, and a negative number did too.
  for (const junk of [{}, [], [1], -1, NaN, Infinity, () => {}]) {
    assert.equal(bitToBool(junk), false, `${String(junk)} must not mean "on"`);
  }
  // "true" is not malformed; it means on, and the implementation this replaced agreed.
  assert.equal(bitToBool('true'), true);
});

// ── the write path ──────────────────────────────────────────────────────────

test('the strings that used to switch a notification ON now switch it off', () => {
  // POST/PUT bound `tenant_posted ? 1 : 0`. Both of these are truthy strings in JS, so
  // a client sending "false" turned the email on while believing it had turned it off.
  assert.equal(bitToBool('false') ? 1 : 0, 0);
  assert.equal(bitToBool('0') ? 1 : 0, 0);
  assert.equal(bitToBool('') ? 1 : 0, 0);
  // and the genuine "on" shapes still write 1
  assert.equal(bitToBool(true) ? 1 : 0, 1);
  assert.equal(bitToBool(1) ? 1 : 0, 1);
  assert.equal(bitToBool('1') ? 1 : 0, 1);
});

// ── the field that must NOT go through this decoder ─────────────────────────

test('is_default_template is a tinyint where 2 means NON-default, not a bit', () => {
  // Caught by codex on 2026-09-04 and confirmed in production: email_template holds 66
  // rows at 1 and 20 at 2. bitToBool(2) is true, so routing this field through the
  // decoder would report every ordinary template as the default one, and template
  // selection would return the first candidate instead of the real default.
  assert.equal(bitToBool(2), true, 'which is exactly why this field must not use it');

  const { pickTemplate } = require('../src/utils/pickTemplate');
  const rows = [
    { id: 'newer-but-not-default', is_default_template: 2, created_time: '2026-01-01' },
    { id: 'the-real-default',      is_default_template: 1, created_time: '2020-01-01' },
  ];
  assert.equal(pickTemplate(rows).id, 'the-real-default',
    'an explicit default must beat a newer non-default');
});

test('a NULL before_date must not be answered as false', () => {
  // scheduler.js and leasing.js read absent as "send BEFORE the end date". If an API
  // handler flattens NULL to false, an edit form renders it unticked and saves 0,
  // flipping checkout email timing with no user intent. Raised by grok, 2026-09-04.
  // The handlers therefore guard with `!= null` rather than `in row`.
  const row = { before_date: null };
  assert.equal('before_date' in row, true, 'the key exists, so an `in` check is not enough');
  assert.equal(bitToBool(null), false, 'which is why the guard cannot be bitToBool alone');
});
