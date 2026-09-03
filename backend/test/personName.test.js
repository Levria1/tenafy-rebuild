const test = require('node:test');
const assert = require('node:assert');

const {
  sanitiseNamePart,
  joinPersonName,
  personOrCompanyName,
} = require('../src/utils/personName');

test('sanitiseNamePart strips commas from contract names', () => {
  // Commas make a person's name read as separate parties in a contract clause.
  assert.strictEqual(sanitiseNamePart('Marie, Balthazar, Geoffroy'), 'Marie Balthazar Geoffroy');
});

test('sanitiseNamePart preserves accented letters', () => {
  // Portfolio names must not lose letters outside the ASCII alphabet.
  assert.strictEqual(sanitiseNamePart('Zoltán'), 'Zoltán');
  assert.strictEqual(sanitiseNamePart('SCHÖNERT'), 'SCHÖNERT');
});

test('sanitiseNamePart preserves hyphens', () => {
  // Hyphenated legal names are a single valid name part.
  assert.strictEqual(sanitiseNamePart('Anne-Marie'), 'Anne-Marie');
});

test('sanitiseNamePart preserves straight and curly apostrophes', () => {
  // Both apostrophe forms commonly occur in legal names.
  assert.strictEqual(sanitiseNamePart("O'Brien"), "O'Brien");
  assert.strictEqual(sanitiseNamePart('O’Brien'), 'O’Brien');
});

test('sanitiseNamePart strips digits but keeps the period', () => {
  // Accidental digits must not enter a contract name. The period stays: initials and
  // suffixes need it, and "Edouard Marie Balthazar G." is a real record here.
  assert.strictEqual(sanitiseNamePart('G.'), 'G.');
  assert.strictEqual(sanitiseNamePart('Ulpo Jr.'), 'Ulpo Jr.');
  assert.strictEqual(sanitiseNamePart('John2'), 'John');
});

test('sanitiseNamePart collapses and trims whitespace', () => {
  // Contract output should have consistent spacing regardless of input.
  assert.strictEqual(sanitiseNamePart('  Marie   Balthazar '), 'Marie Balthazar');
});

test('sanitiseNamePart returns null when no name remains', () => {
  // Empty and invalid values should be omitted when names are assembled.
  assert.strictEqual(sanitiseNamePart(''), null);
  assert.strictEqual(sanitiseNamePart('   '), null);
  assert.strictEqual(sanitiseNamePart(123), null);
});

test('joinPersonName drops a missing middle name', () => {
  // Existing tenants without middle names must keep natural spacing.
  assert.strictEqual(joinPersonName('Edouard', null, 'Chenain'), 'Edouard Chenain');
});

test('joinPersonName includes and sanitises a full middle name', () => {
  // All legal-name parts belong in first-middle-last order.
  assert.strictEqual(
    joinPersonName('Edouard', 'Marie, Balthazar, Geoffroy', 'Chenain'),
    'Edouard Marie Balthazar Geoffroy Chenain'
  );
});

test('personOrCompanyName leaves company punctuation intact', () => {
  // Company punctuation is legally meaningful and must remain untouched.
  assert.strictEqual(
    personOrCompanyName({ type: 1, company_name: 'Black Sheep Restaurants Ltd. & Co.' }),
    'Black Sheep Restaurants Ltd. & Co.'
  );
});

test('personOrCompanyName falls back when a company name is empty', () => {
  // Company tenants without a company value still need a printable party name.
  assert.strictEqual(
    personOrCompanyName({ type: 1, company_name: '', first_name: 'Edouard', middle_name: null, last_name: 'Chenain' }),
    'Edouard Chenain'
  );
});

// ── rejection at the API boundary ───────────────────────────────────────────
// The operator's decision (2026-09-04): show an error, do not silently rewrite.

const { nameProblem } = require('../src/utils/personName');

test('a comma is refused and the message names it', () => {
  // The case that started this: "Marie, Balthazar, Geoffroy" reached a signed lease.
  const problem = nameProblem('Marie, Balthazar, Geoffroy', 'Middle name');
  assert.match(problem, /Middle name/);
  assert.match(problem, /","/);
});

test('parentheses are refused', () => {
  assert.match(nameProblem('Qin (Hazel)', 'First name'), /"\("/);
  assert.match(nameProblem('Qin (Hazel)', 'First name'), /"\)"/);
});

test('the message lists every offending character once, not per occurrence', () => {
  const problem = nameProblem('a,b,c,d', 'First name');
  assert.equal((problem.match(/","/g) || []).length, 1);
});

test('a clean name passes, accents, hyphens and apostrophes included', () => {
  for (const ok of ['Edouard', 'Zoltán', 'SCHÖNERT', 'Anne-Marie', "O'Brien", 'O’Brien', 'Marie Balthazar']) {
    assert.equal(nameProblem(ok, 'First name'), null, `should accept ${ok}`);
  }
});

test('an absent or empty value is not an error, since middle names are optional', () => {
  assert.equal(nameProblem(null, 'Middle name'), null);
  assert.equal(nameProblem(undefined, 'Middle name'), null);
  assert.equal(nameProblem('', 'Middle name'), null);
});

test('a non-string is refused rather than coerced', () => {
  assert.match(nameProblem(42, 'First name'), /must be text/i);
});

test('digits are refused', () => {
  assert.match(nameProblem('John2', 'First name'), /"2"/);
});

test('a period is accepted, for suffixes and initials', () => {
  // Operator decision 2026-09-04, after the stricter rule would have blocked staff from
  // saving "Ulpo Jr." and the older "Edouard Marie Balthazar G." record.
  assert.equal(nameProblem('Ulpo Jr.', 'Last name'), null);
  assert.equal(nameProblem('Edouard Marie Balthazar G.', 'First name'), null);
});

test('the renderer still cleans on output, because stored rows are not fixed yet', () => {
  // Existing data keeps its commas until the backfill runs. A lease generated in the
  // meantime must not print them, so validation on input does not replace sanitisation
  // on output; both are load-bearing.
  assert.equal(sanitiseNamePart('Marie, Balthazar, Geoffroy'), 'Marie Balthazar Geoffroy');
});
