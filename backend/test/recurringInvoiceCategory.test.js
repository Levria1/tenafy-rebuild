const test = require('node:test');
const assert = require('node:assert/strict');

// Drives the REAL scheduler job against a fake pool that models a tiny invoice
// table. The fake honours whatever the SQL actually filters on, so removing the
// category filter really does make the stamp fee match again — see the last test,
// which reintroduces the bug and asserts this suite catches it.

const ORG = '8300127259922432';
const RENT_CAT = '8491399213092100';
const STAMP_CAT = '8491399213092222';
const LEASE = '21452682192359424';
const TENANT = 'T-1';

// Dates are relative to today. The back-fill guard keys off past-vs-future, so a
// hardcoded date would quietly change meaning as the calendar moves.
const { orgTodayDate } = require('../src/utils/orgTime');
const shift = (days) => {
  const d = new Date(orgTodayDate().getTime() + days * 86400000);
  return d.toISOString().slice(0, 10);
};
// Derive the next due date with the REAL scheduler helper rather than assuming a
// fixed day count — invoicing '30' advances a calendar month, not 30 days.
const { advanceInvoiceDate } = require('../src/utils/invoiceSchedule');
const nextDue = (from) => advanceInvoiceDate(new Date(from), '30', null).toISOString().slice(0, 10);

const LAST_RENT_FUTURE = shift(-20);              // next period lands ~10 days ahead
const NEXT_DUE_FUTURE  = nextDue(LAST_RENT_FUTURE);
const LAST_RENT_PAST   = shift(-50);              // next period landed ~20 days ago
const NEXT_DUE_PAST    = nextDue(LAST_RENT_PAST);

// One lease: HK$11,500 monthly, due on the 19th, last rent invoice 2026-01-19.
function makePool({ invoices }) {
  const inserted = [];
  const rows = invoices.slice();

  const pool = {
    inserted,
    queries: [],
    execute: async (sql, params = []) => {
      pool.queries.push({ sql, params });
      const s = sql.replace(/\s+/g, ' ');

      if (/FROM leasing l JOIN unit u/.test(s)) {
        return [[{
          id: LEASE, tenant_id: TENANT, unit_id: 'U-1', price: 11500, invoicing: '30',
          due_date: null, first_invoice_date: null, start_date: new Date(shift(-400)),
          end_date: null, all_past: 0, currency_id: 'C1', booking_platform_id: null,
          sales_agent_id: null, org_id: ORG, property_name: 'Tai Yuen', unit_name: '5A',
          property_id: '3',
        }]];
      }
      if (/FROM category_setting/.test(s)) return [[{ id: RENT_CAT }]];

      // Cursor: latest RENT invoice. The real query is scoped to leasing_id, so
      // this must be too — otherwise an UNLINKED rent invoice would anchor the
      // cursor, the walk would start past the date under test, and the tests below
      // would pass without ever exercising the duplicate check.
      if (/SELECT due_on FROM invoice/.test(s)) {
        const rent = rows.filter(r => r.category === RENT_CAT && String(r.leasing_id) === LEASE)
          .sort((a, b) => (a.due_on < b.due_on ? 1 : -1));
        return [rent.length ? [{ due_on: new Date(rent[0].due_on) }] : []];
      }

      // The check under test. Honours exactly what the SQL filters on, so removing
      // the category filter — or the unlinked-invoice branch — really does change
      // the answer.
      if (/SELECT id FROM invoice/.test(s) && /due_on = \?/.test(s)) {
        const scoped = /AND category = \?/.test(s) || /category = \?/.test(s);
        const seesUnlinked = /leasing_id IS NULL/.test(s);
        const dueOn = params.find(v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v));
        const hit = rows.find(r =>
          r.due_on === dueOn &&
          (!scoped || String(r.category) === RENT_CAT) &&
          (String(r.leasing_id) === LEASE
            || (seesUnlinked && r.leasing_id == null && String(r.tenant_id) === TENANT)));
        return [hit ? [{ id: 'x' }] : []];
      }

      if (/FROM lease_revision/.test(s)) return [[]];
      if (/FROM currency/.test(s)) return [[{ id: 'C1' }]];
      if (/FROM sequence/.test(s)) return [[]];              // falls back to a generated code
      if (/INSERT INTO invoice/.test(s)) {
        inserted.push({ due_on: params[8], category: params[9], amount: params[7] });
        rows.push({ leasing_id: LEASE, org_id: ORG, due_on: params[8], category: params[9] });
        return [{ affectedRows: 1 }];
      }
      return [[]];
    },
  };
  return pool;
}

// emailService and notifications are fired after a successful insert; stub them so
// the test stays about invoice creation.
const emailService = require('../src/services/emailService');
emailService.sendInvoiceToLandlord = async () => null;

const { generateRecurringInvoicesForOrg } = require('../src/services/scheduler');

test('a stamp fee on an UPCOMING rent due date does NOT suppress that rent', async () => {
  // THE PRODUCTION BUG. A HK$106 stamp fee landing on a rent due date made the
  // scheduler believe rent already existed, so the period was skipped — and
  // because the cursor anchors on the latest RENT invoice, never revisited.
  const pool = makePool({ invoices: [
    { leasing_id: LEASE, org_id: ORG, due_on: LAST_RENT_FUTURE, category: RENT_CAT },
    { leasing_id: LEASE, org_id: ORG, due_on: NEXT_DUE_FUTURE, category: STAMP_CAT },
  ]});

  await generateRecurringInvoicesForOrg(pool, ORG);

  const rent = pool.inserted.find(i => i.due_on === NEXT_DUE_FUTURE);
  assert.ok(rent, `rent for ${NEXT_DUE_FUTURE} must still be created despite the stamp fee on that date`);
  assert.equal(String(rent.category), RENT_CAT);
});

test('a PAST period blocked by another invoice is NOT back-filled', async () => {
  // The operator's call: months the old bug suppressed were almost always billed
  // by hand once staff noticed, and raising them again now would chase a tenant
  // who has often already moved out. Skip and log instead of resurrecting.
  const pool = makePool({ invoices: [
    { leasing_id: LEASE, org_id: ORG, due_on: LAST_RENT_PAST, category: RENT_CAT },
    { leasing_id: LEASE, org_id: ORG, due_on: NEXT_DUE_PAST, category: STAMP_CAT },
  ]});

  await generateRecurringInvoicesForOrg(pool, ORG);

  assert.equal(pool.inserted.filter(i => i.due_on === NEXT_DUE_PAST).length, 0,
    'must not back-fill a past period that another invoice already occupies');
});

test('ordinary catch-up still creates past-dated rent on a clear date', async () => {
  // The guard must stay narrow. If the scheduler is late or was down, a past
  // period with NOTHING on that date is normal catch-up and must still be billed.
  const pool = makePool({ invoices: [
    { leasing_id: LEASE, org_id: ORG, due_on: LAST_RENT_PAST, category: RENT_CAT },
  ]});

  await generateRecurringInvoicesForOrg(pool, ORG);

  assert.ok(pool.inserted.some(i => i.due_on === NEXT_DUE_PAST),
    'a past period with no other invoice on it must still be created');
});

test('an existing RENT invoice on that date DOES suppress it — no duplicates', async () => {
  // The other half: scoping to category must not start double-billing.
  const pool = makePool({ invoices: [
    { leasing_id: LEASE, org_id: ORG, due_on: LAST_RENT_FUTURE, category: RENT_CAT },
    { leasing_id: LEASE, org_id: ORG, due_on: NEXT_DUE_FUTURE, category: RENT_CAT },
  ]});

  await generateRecurringInvoicesForOrg(pool, ORG);

  const febs = pool.inserted.filter(i => i.due_on === NEXT_DUE_FUTURE);
  assert.equal(febs.length, 0, 'must not create a second rent invoice for a date that already has one');
});

test('rent already billed MANUALLY, with no lease link, still suppresses it', async () => {
  // The case that would have double-billed a real tenant. Staff noticed a skipped
  // month and raised the rent by hand; those invoices carry tenant_id but leave
  // leasing_id NULL (117 of them exist in the main org). A leasing_id-only lookup
  // cannot see them, so scoping to category WITHOUT this branch would have
  // re-created rent the tenant had already been charged.
  const pool = makePool({ invoices: [
    { leasing_id: LEASE, org_id: ORG, due_on: LAST_RENT_FUTURE, category: RENT_CAT },
    { leasing_id: LEASE, org_id: ORG, due_on: NEXT_DUE_FUTURE, category: STAMP_CAT },
    { leasing_id: null, tenant_id: TENANT, org_id: ORG, due_on: NEXT_DUE_FUTURE, category: RENT_CAT },
  ]});

  await generateRecurringInvoicesForOrg(pool, ORG);

  assert.equal(pool.inserted.filter(i => i.due_on === NEXT_DUE_FUTURE).length, 0,
    'must not re-bill rent that was already raised manually without a lease link');
});

test('the duplicate check is scoped to org AND category AND sees unlinked rent', () => {
  // Pins the query shape. Losing the category filter silently skips rent; losing
  // the unlinked branch silently double-bills. Both are money bugs, so make each
  // a loud test failure.
  const pool = makePool({ invoices: [
    { leasing_id: LEASE, org_id: ORG, due_on: LAST_RENT_FUTURE, category: RENT_CAT },
  ]});

  return generateRecurringInvoicesForOrg(pool, ORG).then(() => {
    const check = pool.queries.find(q =>
      /SELECT id FROM invoice/.test(q.sql) && /due_on = \?/.test(q.sql));
    assert.ok(check, 'expected the duplicate check to run');
    assert.match(check.sql, /category = \?/);
    assert.match(check.sql, /org_id = \?/);
    assert.match(check.sql, /leasing_id IS NULL/);
    assert.match(check.sql, /tenant_id = \?/);
    assert.ok(check.params.includes(RENT_CAT), 'must bind the rental category');
  });
});

test('the rental category lookup is deterministic and matches lease creation', () => {
  // The scheduler used to resolve the category with an unordered LIKE '%Rental%'.
  // Org 8300127259922432 also has "Rental Expense", and another org has four
  // %Rental% matches — so which row came back was luck. Now that the duplicate
  // check binds this category, resolving a different one than lease creation uses
  // would make the check never match and create DUPLICATE rent every night.
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '../src/services/scheduler.js'), 'utf8');

  assert.equal(/name LIKE '%Rental%'/.test(src), false,
    "scheduler still resolves the rent category with an ambiguous LIKE '%Rental%'");
  assert.match(src, /name LIKE '%Rental Income%' ORDER BY id LIMIT 1/);
});
