const test = require('node:test');
const assert = require('node:assert');
const { effectiveOriginalEndDate } = require('../src/routes/leasing');

// Minimal stub of the mysql2 promise connection surface used by the helper.
function fakeConn(rows, { throws = false } = {}) {
  return {
    calls: 0,
    async execute() {
      this.calls++;
      if (throws) throw new Error("Table 'lease_moveout_request' doesn't exist");
      return [rows];
    },
  };
}

test('no move-out recorded: falls back to the lease end date', async () => {
  const conn = fakeConn([]);
  assert.equal(await effectiveOriginalEndDate(conn, 'org1', 'L1', '2026-10-31'), '2026-10-31');
});

test('move-out recorded: uses the snapshot, NOT the shortened lease end', async () => {
  // The whole point: end_date is already 2026-08-06, but rent is owed to 2026-10-31.
  const conn = fakeConn([{ original_end_date: '2026-10-31' }]);
  assert.equal(await effectiveOriginalEndDate(conn, 'org1', 'L1', '2026-08-06'), '2026-10-31');
});

test('a Date lease end is read as wall-clock, not UTC-shifted', async () => {
  // mysql2 hands back DATE columns as LOCAL-midnight Date objects.
  const conn = fakeConn([]);
  assert.equal(await effectiveOriginalEndDate(conn, 'org1', 'L1', new Date(2026, 9, 31)), '2026-10-31');
});

test('un-migrated org (table missing): falls back instead of throwing', async () => {
  const conn = fakeConn([], { throws: true });
  assert.equal(await effectiveOriginalEndDate(conn, 'org1', 'L1', '2026-10-31'), '2026-10-31');
});

test('snapshot with a null original_end_date falls back to the lease end', async () => {
  const conn = fakeConn([{ original_end_date: null }]);
  assert.equal(await effectiveOriginalEndDate(conn, 'org1', 'L1', '2026-09-30'), '2026-09-30');
});

test('no lease end and no snapshot yields null (open-ended lease)', async () => {
  const conn = fakeConn([]);
  assert.equal(await effectiveOriginalEndDate(conn, 'org1', 'L1', null), null);
});
