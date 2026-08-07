const test = require('node:test');
const assert = require('node:assert');
const {
  applySectionPageBreaks,
  insertSectionPageBreaks,
  templateWantsSectionBreaks,
} = require('../src/services/leaseTemplateVariables');

// Titles exactly as the live contract templates store them.
const title = (t) =>
  `<p class="ql-align-center"><strong style="color: rgb(0, 0, 0); background-color: transparent;">${t}</strong></p>`;
const para = (t) => `<p>${t}</p>`;

const CONTRACT = [
  title('Tenancy&nbsp;Agreement'), para('The Landlord lets the Premises...'),
  title('Schedule&nbsp;I'), para('Bank details...'),
  title('Schedule&nbsp;II'), para('Name: Tane Residence Ltd'),
  title('Schedule&nbsp;III'), para('Inventory...'),
  title('Schedule&nbsp;IV'), para('Rules...'),
  title('Schedule&nbsp;V'), para('More...'),
  title('SPECIAL&nbsp;CONDITIONS'), para('Extra terms...'),
].join('');

const breaks = (html) => (html.match(/pdf-section-break/g) || []).length;

test('every section after the first starts a new page', () => {
  // 7 titles -> 6 breaks. The first must NOT break, or the PDF opens with a
  // blank leading page.
  const out = insertSectionPageBreaks(CONTRACT);
  assert.equal(breaks(out), 6);
});

test('the opening Tenancy Agreement title is left alone', () => {
  const out = insertSectionPageBreaks(CONTRACT);
  const firstTitleEnd = out.indexOf('</p>');
  assert.ok(!out.slice(0, firstTitleEnd).includes('pdf-section-break'));
});

test('the existing alignment class is preserved, not replaced', () => {
  // Losing ql-align-center would left-align every section heading.
  const out = insertSectionPageBreaks(CONTRACT);
  assert.ok(out.includes('class="ql-align-center pdf-section-break"'));
  assert.equal((out.match(/ql-align-center/g) || []).length, 7);
});

test('prose mentioning a Schedule is never broken', () => {
  const html = title('Tenancy&nbsp;Agreement')
    + para('The fixtures are as detailed in the Schedule hereto.')
    + para('Rent is payable per Schedule I of this Agreement.');
  assert.equal(breaks(insertSectionPageBreaks(html)), 0);
});

test('applying twice does not stack breaks', () => {
  const once = insertSectionPageBreaks(CONTRACT);
  const twice = insertSectionPageBreaks(once);
  assert.equal(breaks(twice), 6);
});

test('SPECIAL CONDITIONS is matched despite its own attribute order', () => {
  // The live templates write this one's style attributes the other way round.
  const html = title('Schedule&nbsp;I')
    + '<p class="ql-align-center"><strong style="background-color: transparent; color: rgb(0, 0, 0);">SPECIAL&nbsp;CONDITIONS</strong></p>';
  assert.equal(breaks(insertSectionPageBreaks(html)), 1);
});

test('lower-case and extra-spaced titles still match', () => {
  const html = title('Tenancy Agreement') + title('schedule   iv');
  assert.equal(breaks(insertSectionPageBreaks(html)), 1);
});

test('empty or missing html is safe', () => {
  assert.equal(insertSectionPageBreaks(''), '');
  assert.equal(insertSectionPageBreaks(null), '');
  assert.equal(insertSectionPageBreaks(undefined), '');
});

// ── scoping: contracts only ─────────────────────────────────────────────────

test('only templates named as contracts get section breaks', () => {
  assert.equal(templateWantsSectionBreaks('Tane Residence Contract Template'), true);
  assert.equal(templateWantsSectionBreaks('ACJ Contract Template'), true);
  assert.equal(templateWantsSectionBreaks('Naos Holdings Limited Contract Template'), true);
  assert.equal(templateWantsSectionBreaks('Parcelle Limited Contract Template'), true);
});

test('licence agreements are excluded even though they also have Schedule titles', () => {
  // This is the whole reason scoping cannot be by title pattern: the licences
  // carry centred bold "Schedule I"/"Schedule II" of their own.
  const LICENCE = title('Schedule&nbsp;I') + para('x') + title('Schedule&nbsp;II') + para('y');
  for (const n of ['Tane License Agreement', 'ACJ License Agreement',
                   'Parcelle License Agreement', 'Naos License Agreement']) {
    assert.equal(templateWantsSectionBreaks(n), false, n);
    assert.equal(breaks(applySectionPageBreaks(LICENCE, n)), 0, n);
  }
});

test('a contract template gets breaks through the gated entry point', () => {
  assert.equal(breaks(applySectionPageBreaks(CONTRACT, 'ACJ Contract Template')), 6);
});

test('a missing template name is treated as not-a-contract', () => {
  assert.equal(breaks(applySectionPageBreaks(CONTRACT, null)), 0);
  assert.equal(breaks(applySectionPageBreaks(CONTRACT, undefined)), 0);
});
