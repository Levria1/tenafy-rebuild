/**
 * Every scheduler job must actually RUN.
 *
 * This exists because of a live failure. dcaa2e4 converted the scheduler's SQL to
 * bind "today" as a parameter, and in sendOverdueRemindersForOrg the parameter was
 * added but the variable was never declared:
 *
 *     [today, today, orgId]      // `today` did not exist in that scope
 *
 * Nothing caught it. The existing scheduler tests asserted the SHAPE of the SQL —
 * that it no longer said CURDATE() — which stayed true, because the bug was in the
 * parameters, not the query text. Node only raises a ReferenceError when the line
 * executes, the scheduler wraps each org in its own try/catch, and the result went
 * to stderr at 10:00 Hong Kong every day while overdue reminder emails silently
 * stopped going out.
 *
 * So these tests do the one thing the others did not: invoke each job. A fake pool
 * returns empty result sets, which is enough — the ReferenceError fires while the
 * arguments are being evaluated, before the query is ever sent.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const scheduler = require('../src/services/scheduler');

// Returns nothing for every query. Enough to prove a job can be entered and its
// arguments evaluated without throwing.
function emptyPool() {
  const queries = [];
  const pool = {
    queries,
    execute: async (sql, params = []) => {
      queries.push({ sql, params });
      if (/COUNT\(|SUM\(|MAX\(|MIN\(/i.test(sql)) return [[{}]];
      return [[]];
    },
    query: async (sql, params = []) => pool.execute(sql, params),
    getConnection: async () => ({
      execute: pool.execute, query: pool.query,
      beginTransaction: async () => {}, commit: async () => {},
      rollback: async () => {}, release: () => {},
    }),
  };
  return pool;
}

const ORG = '8300127259922432';

// The jobs exported for testing. Each must survive being called.
const JOBS = [
  'markOverdueInvoicesForOrg',
  'promoteServiceTasksForOrg',
  'generateRecurringInvoicesForOrg',
  'sendOverdueRemindersForOrg',
  'sendLeaseExpiryForOrg',
  'sendUpcomingInvoiceRemindersForOrg',
];

for (const name of JOBS) {
  test(`${name} runs without a ReferenceError`, async () => {
    const job = scheduler[name];
    assert.equal(typeof job, 'function',
      `${name} is not exported for testing — a job nothing can invoke is a job nothing checks`);
    try {
      await job(emptyPool(), ORG);
    } catch (err) {
      // A missing variable or typo'd identifier is always a defect. Anything else
      // is the fake pool being too thin, which is not what this test is about.
      if (err instanceof ReferenceError || err instanceof TypeError) {
        assert.fail(`${name} threw ${err.constructor.name}: ${err.message}`);
      }
    }
  });
}

test('every job binds a real value for each SQL placeholder', async () => {
  // The other half of the same failure: a placeholder whose parameter is undefined
  // reaches MySQL as "Bind parameters must not contain undefined" at runtime.
  const offenders = [];
  for (const name of JOBS) {
    const job = scheduler[name];
    if (typeof job !== 'function') continue;
    const pool = emptyPool();
    try { await job(pool, ORG); } catch { /* covered by the tests above */ }
    for (const { sql, params } of pool.queries) {
      const placeholders = (sql.match(/\?/g) || []).length;
      if (params.some(p => p === undefined)) {
        offenders.push(`${name}: a bound parameter is undefined`);
      } else if (placeholders !== params.length) {
        offenders.push(`${name}: ${placeholders} placeholder(s) but ${params.length} parameter(s)`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});
