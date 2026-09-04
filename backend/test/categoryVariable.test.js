/**
 * %Category% must render the category NAME, never its ID.
 *
 * The gap this closes: resolveVariables looked the category up with
 * `SELECT display_name FROM category_setting`, but that table has no
 * `display_name` column. Every call threw, an empty catch swallowed it, and
 * `categoryName` kept the raw bigint it had been seeded with. Nobody noticed
 * because no live template used %Category% — the moment one did, tenants would
 * have been mailed "8497095072747520" instead of "Utilities".
 *
 * Two things are worth pinning. First, the column has to exist: this reads the
 * org schema template rather than hard-coding a column list, so renaming the
 * column in the schema fails the test instead of silently re-breaking email.
 * Second, the failure mode has to stay safe — categoryName is cleared before
 * the lookup, so a future error degrades to a blank word rather than leaking an
 * ID into a tenant's inbox.
 *
 * Source inspection, not a live call: resolveVariables needs a MySQL pool and a
 * fully joined lease row, and the realistic regression here is an edit to the
 * query, not someone rewriting the function.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const emailService = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'services', 'emailService.js'), 'utf8');

const schema = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'migrations', 'org_schema_template.sql'), 'utf8');

// Columns of `category_setting` as the schema actually declares them.
function schemaColumns(table) {
  const create = schema.match(
    new RegExp('CREATE TABLE `' + table + '` \\(([\\s\\S]*?)\\n\\) ENGINE'));
  assert.ok(create, `CREATE TABLE for ${table} not found in org_schema_template.sql`);
  return create[1]
    .split('\n')
    .map((line) => line.trim().match(/^`([a-z_]+)`\s+(?:bigint|varchar|int|bit|timestamp|datetime|text|decimal|tinyint)/i))
    .filter(Boolean)
    .map((m) => m[1]);
}

// The single query resolveVariables uses to turn a category ID into a name.
const LOOKUP = /SELECT (\w+) FROM category_setting WHERE id = \?/;

test('category_setting has a `name` column and no `display_name`', () => {
  const cols = schemaColumns('category_setting');
  assert.ok(cols.includes('name'), `expected a name column, got: ${cols.join(', ')}`);
  assert.ok(!cols.includes('display_name'),
    'schema grew a display_name column; the lookup below may need revisiting');
});

test('the category lookup selects a column that exists in the schema', () => {
  const m = emailService.match(LOOKUP);
  assert.ok(m, 'category lookup query not found in emailService.js');
  const selected = m[1];
  const cols = schemaColumns('category_setting');
  assert.ok(cols.includes(selected),
    `lookup selects \`${selected}\`, which category_setting does not have. Columns: ${cols.join(', ')}`);
});

test('the row is read through the same column the query selected', () => {
  const m = emailService.match(LOOKUP);
  assert.ok(m, 'category lookup query not found');
  const selected = m[1];
  assert.ok(
    new RegExp(`catRow\\s*\\?\\s*\\(?catRow\\.${selected}\\b`).test(emailService),
    `query selects \`${selected}\` but the result is not read as catRow.${selected}`);
});

test('a failed lookup cannot leak the raw category ID', () => {
  // categoryName is seeded with the caller's value, which for an invoice is the
  // bigint FK. It must be cleared BEFORE the try, so a throw leaves it blank.
  const block = emailService.match(
    /let categoryName = category \|\| '';[\s\S]*?SELECT \w+ FROM category_setting/);
  assert.ok(block, 'category resolution block not found');
  const beforeQuery = block[0];
  assert.ok(/categoryName = '';/.test(beforeQuery),
    'categoryName must be reset to empty before the lookup so a failure cannot emit the ID');
});

test('the lookup failure is logged rather than swallowed', () => {
  const catchBlock = emailService.match(
    /SELECT \w+ FROM category_setting[\s\S]*?catch \(err\) \{([\s\S]*?)\n {4}\}/);
  assert.ok(catchBlock, 'catch block after the category lookup not found');
  assert.ok(/console\.error/.test(catchBlock[1]),
    'a silent catch is what hid this bug for months; the catch must log');
});

test('no backend query reads display_name from category_setting', () => {
  const srcDir = path.join(__dirname, '..', 'src');
  const offenders = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const text = fs.readFileSync(full, 'utf8');
      if (/display_name\s+FROM\s+category_setting/i.test(text)) offenders.push(full);
    }
  })(srcDir);
  assert.deepEqual(offenders, [],
    `these files select a column category_setting does not have: ${offenders.join(', ')}`);
});

// ---------------------------------------------------------------------------
// Tenant-facing wording. The ledger name and the word a tenant should read are
// not always the same thing.
// ---------------------------------------------------------------------------

const { tenantCategoryLabel } = require('../src/services/emailService');

test('rent reads as rent, not as a ledger account', () => {
  // "Details: Rental Income for August" is the accounting name leaking into a
  // tenant's inbox, and rent is the common case: 1,111 of 2026's invoices
  // against 218 utilities.
  assert.equal(tenantCategoryLabel('Rental Income'), 'Rent payment');
});

test('categories that already read plainly pass through untouched', () => {
  for (const name of ['Utilities', 'Deposit', 'Stamp Fee', 'Cleaning', 'Movers']) {
    assert.equal(tenantCategoryLabel(name), name);
  }
});

test('a category added later needs no code change', () => {
  assert.equal(tenantCategoryLabel('Bicycle Storage'), 'Bicycle Storage');
});

test('stored whitespace and casing do not defeat the lookup', () => {
  // One live category is stored as "Garbage disposal fee " with a trailing
  // space, so trimming is not hypothetical.
  assert.equal(tenantCategoryLabel('  rental income  '), 'Rent payment');
  assert.equal(tenantCategoryLabel('RENTAL INCOME'), 'Rent payment');
  assert.equal(tenantCategoryLabel('Garbage disposal fee '), 'Garbage disposal fee');
});

test('absent categories give an empty string, never "undefined"', () => {
  for (const empty of [null, undefined, '', '   ']) {
    assert.equal(tenantCategoryLabel(empty), '');
  }
});

test('%Category% is rendered through the tenant label, not raw', () => {
  assert.match(emailService, /'%Category%': tenantCategoryLabel\(categoryName\)/,
    'the variable must go through the label map, or ledger jargon reaches tenants');
});

test('both overdue senders forward the category they were given', () => {
  for (const kind of ['Overdue-Tenant', 'Overdue-Landlord']) {
    const fn = emailService.match(
      new RegExp(`async function sendOverdueTo${kind.split('-')[1]}\\(([\\s\\S]*?)\\n\\}`));
    assert.ok(fn, `sendOverdueTo${kind.split('-')[1]} not found`);
    assert.ok(/\{[^}]*\bcategory\b/.test(fn[1]),
      `${kind} sender must accept a category`);
    assert.ok(/^\s*category,\s*$/m.test(fn[1]),
      `${kind} sender must pass category on to sendTemplateEmail, or %Category% renders blank`);
  }
});
