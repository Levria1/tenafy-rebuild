/**
 * Hong Kong dates — behavioural tests, not shape checks.
 *
 * Every test here runs at an instant where the UTC date and the Hong Kong date
 * DISAGREE. That is the only kind of instant that can tell the bug from the fix:
 * between 00:00 and 15:59 UTC the two zones agree, so the same test run then
 * would pass with the old code still in place.
 *
 * Each test asserts a business outcome (this invoice is Overdue, this lease is
 * Active) rather than "the SQL mentions orgTodaySql()", so reverting the fix
 * turns them red for the right reason.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { orgToday, dbDate } = require('../src/utils/orgTime');

// 16:05 UTC on the 15th == 00:05 on the 16th in Hong Kong.
const STRADDLE = new Date('2026-08-15T16:05:00Z');
const UTC_DATE = '2026-08-15';
const HK_DATE = '2026-08-16';

// Freeze the clock. node:test's mock.timers cannot fake Date on Node 18, and the
// production code calls orgToday() with no argument by design, so the clock is
// stubbed directly. Restored in a finally, so a failing assertion cannot leak a
// frozen Date into the rest of the suite.
async function atInstant(instant, fn) {
  const Real = Date;
  class Frozen extends Real {
    constructor(...args) {
      if (args.length === 0) super(instant.getTime());
      else super(...args);
    }
    static now() { return instant.getTime(); }
  }
  global.Date = Frozen;
  try { return await fn(); } finally { global.Date = Real; }
}

test('sanity: the chosen instant really does straddle the date line', () => {
  assert.equal(STRADDLE.toISOString().slice(0, 10), UTC_DATE);
  assert.equal(orgToday(STRADDLE), HK_DATE);
  assert.notEqual(UTC_DATE, HK_DATE);
});

test('sanity: the clock stub actually takes effect', async () => {
  await atInstant(STRADDLE, () => {
    assert.equal(orgToday(), HK_DATE, 'orgToday() must see the frozen instant');
    assert.equal(new Date().toISOString().slice(0, 10), UTC_DATE);
  });
  // ...and is put back afterwards.
  assert.notEqual(Date.now(), STRADDLE.getTime());
});

// ---------------------------------------------------------------------------
// Invoice status — this one WRITES. A wrong answer persists in the database
// until the nightly job corrects it, and drives overdue reminder emails.
// ---------------------------------------------------------------------------

const { recalcInvoiceStatuses } = require('../src/utils/invoiceStatus');

// Minimal fake: one invoice plus a payment total, answering what the code asks.
function invoicePool({ dueOn, amount, paid, status = 0 }) {
  const updates = [];
  return {
    updates,
    execute: async (sql, params = []) => {
      if (/SELECT DISTINCT al\.invoice_code/.test(sql)) return [[{ invoice_code: 'INV-1' }]];
      if (/SELECT invoice_code FROM accounting/.test(sql)) return [[{ invoice_code: 'INV-1' }]];
      if (/SELECT org_id FROM accounting/.test(sql)) return [[{ org_id: 'ORG' }]];
      if (/SELECT id, amount, due_on, status FROM invoice/.test(sql)) {
        return [[{ id: 'I1', amount, due_on: dueOn, status }]];
      }
      if (/SUM\(al\.amount\)/.test(sql)) return [[{ total_paid: paid }]];
      if (/UPDATE invoice SET status/.test(sql)) { updates.push(params[0]); return [{ affectedRows: 1 }]; }
      return [[]];
    },
  };
}

test('an invoice that fell due yesterday HK-time is marked Overdue, not Open', async () => {
  // due_on is the 15th. In Hong Kong it is already the 16th, so this is late.
  // Reading "today" off the UTC clock gives the 15th — equal, not past — and the
  // invoice would sit at Open while the tenant is already overdue.
  await atInstant(STRADDLE, async () => {
    const pool = invoicePool({ dueOn: new Date(2026, 7, 15), amount: 15000, paid: 0 });
    await recalcInvoiceStatuses(pool, 'ACC-1', 'ORG');
    assert.deepEqual(pool.updates, [2], 'expected a write of status 2 (Overdue)');
  });
});

test('an invoice due today HK-time is NOT marked overdue', async () => {
  await atInstant(STRADDLE, async () => {
    const pool = invoicePool({ dueOn: new Date(2026, 7, 16), amount: 15000, paid: 0 });
    await recalcInvoiceStatuses(pool, 'ACC-1', 'ORG');
    assert.ok(!pool.updates.includes(2), 'must not mark an invoice overdue on its own due date');
  });
});

test('a fully paid invoice is Paid regardless of the date', async () => {
  await atInstant(STRADDLE, async () => {
    const pool = invoicePool({ dueOn: new Date(2026, 7, 1), amount: 15000, paid: 15000 });
    await recalcInvoiceStatuses(pool, 'ACC-1', 'ORG');
    assert.deepEqual(pool.updates, [1]);
  });
});

test('due_on is read with dbDate, which survives a non-UTC server timezone', () => {
  // mysql2 returns a DATE as LOCAL midnight. The old toISOString() route reports
  // the PREVIOUS day anywhere east of UTC, so an invoice would flip between Open
  // and Overdue purely on where the server happens to run. dbDate uses the local
  // getters and is therefore stable in both zones this suite runs under.
  assert.equal(dbDate(new Date(2026, 7, 16)), '2026-08-16');
  assert.equal(dbDate(new Date(2026, 0, 1)), '2026-01-01');
});

// ---------------------------------------------------------------------------
// Lease status — drives what staff see as Active / Upcoming / Inactive, and
// which tenants appear under the Active filter.
// ---------------------------------------------------------------------------

test('a lease starting today HK-time counts as started, not future', async () => {
  await atInstant(STRADDLE, () => {
    const start = HK_DATE;
    assert.equal(start > orgToday(), false, 'a lease starting today must not read as upcoming');
    assert.equal(start > UTC_DATE, true, 'and it WOULD have, on the UTC clock');
  });
});

test('a lease that ended yesterday HK-time counts as ended', async () => {
  await atInstant(STRADDLE, () => {
    const end = UTC_DATE;
    assert.equal(end < orgToday(), true, 'a lease that ended yesterday must read as past');
    assert.equal(end < UTC_DATE, false, 'and it would NOT have, on the UTC clock');
  });
});

// ---------------------------------------------------------------------------
// Generated SQL and the LLM prompt.
// ---------------------------------------------------------------------------

test('ask_data rewrites CURDATE() to the Hong Kong date at query time', async () => {
  await atInstant(STRADDLE, () => {
    const { validateSelect } = require('../src/services/askDataService');
    const r = validateSelect('SELECT id FROM invoice WHERE due_on < CURDATE()');
    assert.equal(r.ok, true);
    assert.ok(r.sql.includes(`'${HK_DATE}'`), `expected the HK date, got: ${r.sql}`);
    assert.ok(!r.sql.includes(`'${UTC_DATE}'`), 'must not use the UTC date');
  });
});

test('the chat prompt states the Hong Kong date, recomputed per call', async () => {
  await atInstant(STRADDLE, () => {
    const { internalSystemPrompt } = require('../src/services/chatTools');
    const prompt = internalSystemPrompt();
    assert.ok(prompt.includes(`'${HK_DATE}'`), 'prompt must state the Hong Kong date');
    assert.ok(!prompt.includes(`Today in Hong Kong is '${UTC_DATE}'`), 'must not state the UTC date');
  });
});

test('the chat prompt is not frozen at require() time', async () => {
  // The prompt used to be a module-level constant. Had the date been interpolated
  // into it as one, it would have reported the boot day forever — which is the
  // failure this whole refactor was most at risk of introducing.
  const { internalSystemPrompt } = require('../src/services/chatTools');
  const a = await atInstant(new Date('2026-08-15T16:05:00Z'), () => internalSystemPrompt());
  const b = await atInstant(new Date('2026-09-20T16:05:00Z'), () => internalSystemPrompt());
  assert.ok(a.includes("'2026-08-16'"), 'first call reflects the first instant');
  assert.ok(b.includes("'2026-09-21'"), 'second call reflects the second instant');
  assert.notEqual(a, b, 'the prompt must track the clock, not the boot time');
});
