const test = require('node:test');
const assert = require('node:assert');
const {
  applyPageBreakMarkers,
  PAGE_BREAK_TOKEN,
  substitute,
  sampleContext,
} = require('../src/services/leaseTemplateVariables');

// Titles exactly as the live contract templates store them.
const title = (t) =>
  `<p class="ql-align-center"><strong style="color: rgb(0, 0, 0); background-color: transparent;">${t}</strong></p>`;
const para = (t) => `<p>${t}</p>`;
const marker = () => `<p>${PAGE_BREAK_TOKEN}</p>`;

const breaks = (html) => (html.match(/class="page-break"/g) || []).length;

test('a marker alone in a paragraph becomes a real page break', () => {
  const out = applyPageBreakMarkers(marker() + title('Schedule&nbsp;I'));
  assert.equal(breaks(out), 1);
  assert.ok(out.includes('<div class="page-break"></div>'));
});

test('the marker REPLACES its paragraph rather than nesting inside it', () => {
  // <div> inside <p> makes the browser close the paragraph early, which shifts
  // the surrounding layout.
  const out = applyPageBreakMarkers(marker());
  assert.equal(out, '<div class="page-break"></div>');
  assert.ok(!out.includes('<p'));
});

test('one marker per section gives one break each', () => {
  const contract = [
    title('Tenancy&nbsp;Agreement'), para('The Landlord lets...'),
    marker(), title('Schedule&nbsp;I'), para('Bank details...'),
    marker(), title('Schedule&nbsp;II'), para('Name: Tane Residence Ltd'),
    marker(), title('Schedule&nbsp;III'), para('Inventory...'),
    marker(), title('Schedule&nbsp;IV'), para('Rules...'),
    marker(), title('Schedule&nbsp;V'), para('More...'),
    marker(), title('SPECIAL&nbsp;CONDITIONS'), para('Extra terms...'),
  ].join('');
  assert.equal(breaks(applyPageBreakMarkers(contract)), 6);
});

test('a marker Quill has wrapped with formatting still converts', () => {
  // Quill may store the marker inside a styled span or with an alignment class.
  const html = '<p class="ql-align-center"><span style="color: rgb(0, 0, 0);">'
    + PAGE_BREAK_TOKEN + '</span></p>';
  assert.equal(breaks(applyPageBreakMarkers(html)), 1);
});

test('a marker padded with &nbsp; still converts', () => {
  assert.equal(breaks(applyPageBreakMarkers(`<p>&nbsp;${PAGE_BREAK_TOKEN}&nbsp;</p>`)), 1);
});

test('a marker in a div converts too', () => {
  assert.equal(breaks(applyPageBreakMarkers(`<div>${PAGE_BREAK_TOKEN}</div>`)), 1);
});

test('a marker typed mid-sentence is removed, never printed', () => {
  // Leaving the raw token visible on a signed contract would be worse than
  // ignoring a break the author probably did not mean there.
  const out = applyPageBreakMarkers(`<p>Rent is payable ${PAGE_BREAK_TOKEN} monthly.</p>`);
  assert.equal(breaks(out), 0);
  assert.ok(!out.includes(PAGE_BREAK_TOKEN));
  assert.ok(out.includes('Rent is payable'));
  assert.ok(out.includes('monthly.'));
});

test('the literal token can never survive to the PDF', () => {
  const out = applyPageBreakMarkers(`${PAGE_BREAK_TOKEN}<p>loose marker outside a block</p>`);
  assert.ok(!out.includes(PAGE_BREAK_TOKEN));
});

test('templates with no marker are untouched', () => {
  // This is what keeps the Licence Agreements exactly as they are: no marker,
  // no breaks, no dependence on template names.
  const licence = title('Schedule&nbsp;I') + para('x') + title('Schedule&nbsp;II') + para('y');
  const out = applyPageBreakMarkers(licence);
  assert.equal(breaks(out), 0);
  assert.equal(out, licence);
});

test('prose mentioning a Schedule is never broken', () => {
  const html = para('The fixtures are as detailed in the Schedule hereto.')
    + para('Rent is payable per Schedule I of this Agreement.');
  assert.equal(breaks(applyPageBreakMarkers(html)), 0);
});

test('applying twice does not stack breaks', () => {
  const once = applyPageBreakMarkers(marker() + title('Schedule&nbsp;I'));
  assert.equal(breaks(applyPageBreakMarkers(once)), 1);
});

test('empty or missing html is safe', () => {
  assert.equal(applyPageBreakMarkers(''), '');
  assert.equal(applyPageBreakMarkers(null), '');
  assert.equal(applyPageBreakMarkers(undefined), '');
});

test('substitution leaves the marker intact for the transform', () => {
  // PAGE_BREAK resolves to ITSELF, so variable substitution must not consume it.
  const html = marker() + para('Tenant: {{TENANT_NAME}}');
  const substituted = substitute(html, sampleContext());
  assert.ok(substituted.includes(PAGE_BREAK_TOKEN), 'marker survived substitute()');
  assert.ok(!substituted.includes('{{TENANT_NAME}}'), 'real variables still resolved');
  assert.equal(breaks(applyPageBreakMarkers(substituted)), 1);
});
