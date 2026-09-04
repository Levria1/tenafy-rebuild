/**
 * The lease search boxes look up a lease by its LEA number.
 *
 * The gap this closes: searching "LEA3381" returned nothing while the lease sat
 * plainly in the list, because the WHERE clause matched unit, property and tenant
 * name and never lease_no. A lease that exists but cannot be found reads as a
 * missing lease, and the natural next move is to create a duplicate.
 *
 * Hitting the endpoints needs Express and a MySQL pool, so this reads the source —
 * the same approach checkinWiring.test.js takes, and for the same reason: the
 * realistic regression is a later edit dropping a term, not someone rewriting the
 * query. The placeholder-vs-parameter count is the half worth guarding hardest;
 * adding a `?` without pushing its value throws at runtime, not at review.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'routes', 'leasing.js'), 'utf8');

// The two search clauses, each paired with the push that supplies its values.
const CLAUSES = [
  {
    what: 'POST /list',
    clause: /whereClause \+= ' AND \(u\.name LIKE[^;]*;/,
    push: /params\.push\((searchParam(?:,\s*searchParam)*)\);/,
    column: 'l.lease_no LIKE ?',
  },
  {
    what: 'GET /calendar',
    clause: /unitWhere \+= ' AND \(u\.name LIKE[^;]*;/,
    push: /unitParams\.push\((s(?:,\s*s)*)\);/,
    column: 't_search_l.lease_no LIKE ?',
  },
];

for (const { what, clause, push, column } of CLAUSES) {
  test(`${what} search matches on the lease number`, () => {
    const m = source.match(clause);
    assert.ok(m, `${what}: search clause not found`);
    assert.ok(m[0].includes(column),
      `${what}: search clause must include ${column}, got:\n${m[0]}`);
  });

  test(`${what} binds one parameter per placeholder`, () => {
    const clauseText = source.match(clause)[0];
    const placeholders = (clauseText.match(/\?/g) || []).length;

    const after = source.slice(source.indexOf(clauseText));
    const p = after.match(push);
    assert.ok(p, `${what}: parameter push not found after the clause`);
    const bound = p[1].split(',').length;

    assert.equal(bound, placeholders,
      `${what}: ${placeholders} placeholders but ${bound} bound parameters — ` +
      'mysql2 throws on this at request time, not at review time');
  });
}

// The calendar reaches lease_no through a join that only exists when a search term
// was supplied. Qualifying the column against the wrong alias would still parse
// here but fail in MySQL, so pin the alias to the join that provides it.
test('GET /calendar joins the table its lease_no column comes from', () => {
  const clause = source.match(/unitWhere \+= ' AND \(u\.name LIKE[^;]*;/)[0];
  if (!clause.includes('t_search_l.lease_no')) return;
  assert.match(source, /LEFT JOIN leasing t_search_l ON t_search_l\.unit_id = u\.id/,
    'calendar search references t_search_l but never joins it');
});
