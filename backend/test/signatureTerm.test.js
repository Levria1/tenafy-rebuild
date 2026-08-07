const test = require('node:test');
const assert = require('node:assert');
const {
  applyTermOverride,
  effectiveStampEndDate,
} = require('../src/services/leaseTemplateVariables');

// ── rendering one period of a tenancy ───────────────────────────────────────

test('no term supplied leaves the context untouched', () => {
  const ctx = { lease: { start_date: '2025-09-01', end_date: '2026-08-19', stamp_end_date: '2027-08-31' } };
  applyTermOverride(ctx, null);
  assert.equal(ctx.lease.start_date, '2025-09-01');
  assert.equal(ctx.lease.end_date, '2026-08-19');
  assert.equal(ctx.lease.stamp_end_date, '2027-08-31');
});

test('a term override replaces the printed period', () => {
  const ctx = { lease: { start_date: '2025-09-01', end_date: '2026-09-19' } };
  applyTermOverride(ctx, { start_date: '2026-08-20', end_date: '2026-09-19' });
  assert.equal(ctx.lease.start_date, '2026-08-20');
  assert.equal(ctx.lease.end_date, '2026-09-19');
});

test('THE BUG: a stored stamped date must not leak into a period document', () => {
  // effectiveStampEndDate returns stamp_end_date || end_date, so the STORED
  // value wins. Overriding only the dates would print the ORIGINAL term's
  // stamped date as the extension's Term of Tenancy — a wrong date on a legal
  // document. The override must null it explicitly.
  const ctx = { lease: { start_date: '2025-09-01', end_date: '2026-09-19', stamp_end_date: '2027-08-31' } };
  applyTermOverride(ctx, { start_date: '2026-08-20', end_date: '2026-09-19' });
  assert.equal(effectiveStampEndDate(ctx.lease), '2026-09-19');
});

test('a stamped term supplied for THIS period is what prints', () => {
  const ctx = { lease: { start_date: '2025-09-01', end_date: '2026-09-19', stamp_end_date: '2027-08-31' } };
  applyTermOverride(ctx, {
    start_date: '2026-08-20', end_date: '2026-09-19', stamp_end_date: '2028-08-19',
  });
  assert.equal(effectiveStampEndDate(ctx.lease), '2028-08-19');
});

test('an incomplete term is ignored rather than half-applied', () => {
  const ctx = { lease: { start_date: '2025-09-01', end_date: '2026-08-19' } };
  applyTermOverride(ctx, { start_date: '2026-08-20' });
  assert.equal(ctx.lease.start_date, '2025-09-01');
  assert.equal(ctx.lease.end_date, '2026-08-19');
});

test('other lease fields survive the override', () => {
  // {{RENT}} deliberately still comes from the lease row, so an extension
  // prints the current rent.
  const ctx = { lease: { start_date: '2025-09-01', end_date: '2026-09-19', amount: 18000 } };
  applyTermOverride(ctx, { start_date: '2026-08-20', end_date: '2026-09-19' });
  assert.equal(ctx.lease.amount, 18000);
});

test('a context with no lease is returned unharmed', () => {
  const ctx = {};
  assert.doesNotThrow(() => applyTermOverride(ctx, { start_date: '2026-08-20', end_date: '2026-09-19' }));
});

// ── the lease status implied by its document ledger ─────────────────────────

const { nextSignatureStatus } = require('../src/utils/signatureLedger');

test('cancelling leaves a genuinely signed lease signed', () => {
  // The bug: cancel hardcoded 'none', so cancelling an extension request would
  // erase "signed" from a lease whose FIRST period really is signed.
  assert.equal(nextSignatureStatus([{ status: 3 }, { status: 6 }]), 'signed');
});

test('another request still in flight keeps the lease pending', () => {
  assert.equal(nextSignatureStatus([{ status: 1 }, { status: 6 }]), 'pending');
});

test('nothing signed and nothing in flight resets to none', () => {
  assert.equal(nextSignatureStatus([{ status: 6 }]), 'none');
});

test('no rows at all resets to none', () => {
  assert.equal(nextSignatureStatus([]), 'none');
});

test('signed wins over in-flight', () => {
  assert.equal(nextSignatureStatus([{ status: 3 }, { status: 2 }]), 'signed');
});

test('statuses arriving as strings still resolve', () => {
  assert.equal(nextSignatureStatus([{ status: '3' }]), 'signed');
  assert.equal(nextSignatureStatus([{ status: '2' }]), 'pending');
});
