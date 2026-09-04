/**
 * A running lease cannot be voided through the Status dropdown.
 *
 * The bug this closes reached production three times: an occupied flat was set to
 * "Inactive (Terminated)" while its term still had months to run. Because every
 * scheduler job and every availability query filters `l.status = 1`, that silently
 * stopped the rent invoices AND handed the unit to advertising as empty stock —
 * two of the three were being offered at the ladder's 10% long-vacant discount
 * while a tenant lived in them. Nothing in the UI showed anything was wrong,
 * because the Leasing list derives its Active/Inactive column from dates and never
 * reads this column at all.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { checkTermination } = require('../src/utils/leaseTermination');

const TODAY = '2026-09-04';
const verdict = (over = {}) => checkTermination({
  requestedStatus: 0, currentStatus: 1, endDate: '2026-12-31', today: TODAY, ...over,
});

test('blocks voiding a lease whose term is still running', () => {
  const v = verdict();
  assert.equal(v.blocked, true);
  assert.match(v.message, /Move Out/, 'must name the flow to use instead');
});

test('blocks a lease ending today — the tenant is still in it', () => {
  assert.equal(verdict({ endDate: TODAY }).blocked, true);
});

test('allows voiding a lease that has already ended', () => {
  // 1,800 leases sit at status 0 and every one ended in the past. That is the
  // column's real use and it must keep working.
  assert.equal(verdict({ endDate: '2026-09-03' }).blocked, false);
});

test('allows an ordinary edit of a lease that is ALREADY inactive', () => {
  // The edit form posts `status` on every save, so a historical record re-sends 0.
  // Blocking that would make old leases uneditable.
  assert.equal(verdict({ currentStatus: 0 }).blocked, false);
});

test('never blocks a change that is not setting status to 0', () => {
  // undefined is "leave this field alone" — the route does not even reach the guard.
  for (const requestedStatus of [1, '1', 2, undefined]) {
    assert.equal(verdict({ requestedStatus }).blocked, false, `status=${requestedStatus}`);
  }
});

test('treats a null status the same as 0', () => {
  // leasing.status is `tinyint NOT NULL`. A null reaching the UPDATE either throws
  // or, with strict mode off, is coerced to 0 — the exact value this guard exists
  // to stop. Number(null) is 0, so the guard catches it either way.
  assert.equal(verdict({ requestedStatus: null }).blocked, true);
});

test('judges the end date the lease will HAVE, not the one it had', () => {
  // Shortening the lease and voiting it in one request is legitimate once the new
  // end date is in the past.
  assert.equal(verdict({ endDate: '2026-08-01' }).blocked, false);
});

test('fails closed on a missing or unreadable end date', () => {
  // An open-ended lease has time left by definition. Unreadable input takes the
  // same branch on purpose: a wrong block costs one support question, a wrong
  // allow costs unbilled rent on an occupied flat.
  for (const endDate of [null, undefined, '', 'not-a-date', '2026-13-45']) {
    assert.equal(verdict({ endDate }).blocked, true, `endDate=${JSON.stringify(endDate)}`);
  }
});

test('reads a MySQL DATE object as the day it stores', () => {
  // mysql2 builds DATE columns at LOCAL midnight; UTC getters would report the
  // previous day everywhere east of Greenwich, which is every machine here.
  assert.equal(verdict({ endDate: new Date(2026, 8, 3) }).blocked, false); // 3 Sep, ended
  assert.equal(verdict({ endDate: new Date(2026, 8, 5) }).blocked, true);  // 5 Sep, running
});

test('the route actually calls the guard before writing anything', () => {
  // The helper being right proves nothing about the endpoint asking it. Same
  // reasoning as checkinWiring.test.js.
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'routes', 'leasing.js'), 'utf8');
  const call = src.indexOf('checkTermination({');
  const write = src.indexOf("fields.push('status = ?')");
  assert.ok(call > 0, 'PUT /:id must call checkTermination');
  assert.ok(write > 0, 'the status write should still exist');
  assert.ok(call < write, 'the guard must run BEFORE status is assembled into the UPDATE');
});
