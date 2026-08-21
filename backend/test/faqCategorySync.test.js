const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// ---------------------------------------------------------------------------
// The FAQ category list exists in THREE places and every one of them fails
// silently when they drift:
//
//   backend/src/routes/chat.js          the VALIDATOR — an unknown value is
//                                       rewritten to 'other' on save, so a
//                                       category added only to the UI appears in
//                                       the dropdown, saves without error, and
//                                       comes back as "Other"
//   frontend .../KnowledgeCard.jsx      the admin dropdown and the table label
//   website/faq/index.html              the public page — a missing entry renders
//                                       the raw slug as a heading ("water_heating")
//
// None of those three failures throws. This test is the only thing that notices.
//
// Labels are deliberately NOT compared: the public page says "General" where the
// admin says "Other", which is a real editorial choice, not drift. Only the SET
// OF KEYS has to agree.
// ---------------------------------------------------------------------------

const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');

function backendKeys() {
  const src = read('../src/routes/chat.js');
  const start = src.indexOf('const FAQ_CATEGORIES = [');
  assert.ok(start !== -1, 'FAQ_CATEGORIES not found in chat.js');
  const body = src.slice(start, src.indexOf('];', start));
  return new Set([...body.matchAll(/'([a-z_]+)'/g)].map(m => m[1]));
}

function adminKeys() {
  const src = read('../../frontend/src/components/chatbot/KnowledgeCard.jsx');
  const start = src.indexOf('const FAQ_CATEGORIES = [');
  assert.ok(start !== -1, 'FAQ_CATEGORIES not found in KnowledgeCard.jsx');
  const body = src.slice(start, src.indexOf('];', start));
  // Each entry is ['key','Label'] — take the first string of each pair.
  return new Set([...body.matchAll(/\['([a-z_]+)'\s*,/g)].map(m => m[1]));
}

function websiteKeys() {
  const src = read('../../website/faq/index.html');
  const start = src.indexOf('var ORDER = [');
  assert.ok(start !== -1, 'ORDER not found in website/faq/index.html');
  const body = src.slice(start, src.indexOf('];', start));
  return new Set([...body.matchAll(/'([a-z_]+)'/g)].map(m => m[1]));
}

const sorted = (set) => [...set].sort();

test('every category the admin offers is accepted by the validator', () => {
  // The dangerous direction: the UI offers it, the backend silently downgrades it
  // to 'other', and the operator's filing is lost without any error.
  const missing = sorted(adminKeys()).filter(k => !backendKeys().has(k));
  assert.deepEqual(missing, [], 'these would save as "Other" without warning');
});

test('every category the validator accepts can be chosen in the admin UI', () => {
  // The other direction is milder but still wrong: an entry filed under a category
  // nobody can select is unreachable and uneditable from the dropdown.
  const missing = sorted(backendKeys()).filter(k => !adminKeys().has(k));
  assert.deepEqual(missing, [], 'accepted by the API but not offered in the UI');
});

test('every stored category has a heading on the public FAQ page', () => {
  // A category with no entry in ORDER/LABELS renders its raw slug as a public
  // heading — "water_heating" on taneresidence.com.
  const missing = sorted(backendKeys()).filter(k => !websiteKeys().has(k));
  assert.deepEqual(missing, [], 'these would render as raw slugs on the live site');
});

test('the public page lists no category the backend would reject', () => {
  const extra = sorted(websiteKeys()).filter(k => !backendKeys().has(k));
  assert.deepEqual(extra, [], 'dead headings that can never receive an entry');
});

test('the positive control — the lists are non-trivially populated', () => {
  // Without this, three empty sets would satisfy every assertion above.
  assert.ok(backendKeys().size >= 10, `validator has only ${backendKeys().size} categories`);
  assert.ok(adminKeys().size >= 10, `admin has only ${adminKeys().size} categories`);
  assert.ok(websiteKeys().size >= 10, `website has only ${websiteKeys().size} categories`);
  // 'other' is the fallback every unknown value collapses to; it must exist.
  assert.ok(backendKeys().has('other'), "'other' is the validator's fallback and must be present");
});
