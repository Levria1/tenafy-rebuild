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
const { WEBSITE_HIDDEN_CATEGORIES } = require('../src/utils/faqCategories');

function backendKeys() {
  // Required, not text-scraped: this is the live list the validator uses, so the
  // test cannot drift from it by reading a stale literal in the wrong file.
  const { FAQ_CATEGORIES } = require('../src/utils/faqCategories');
  return new Set(FAQ_CATEGORIES);
}

test('chat.js uses the shared list rather than its own copy', () => {
  // A private literal in the route would make every comparison below meaningless
  // while still passing — the test would agree with the util and the route would
  // quietly validate against something else.
  const src = read('../src/routes/chat.js');
  assert.match(src, /require\('\.\.\/utils\/faqCategories'\)/, 'chat.js must import the shared categories');
  assert.ok(
    !/const FAQ_CATEGORIES = \[/.test(src),
    'chat.js has re-declared its own FAQ_CATEGORIES array'
  );
});

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

test('every PUBLISHABLE category has a heading on the public FAQ page', () => {
  // A category with no entry in ORDER/LABELS renders its raw slug as a public
  // heading — "water_heating" on taneresidence.com. The bot-only categories are
  // excluded on purpose: they can never reach the page, so a heading for them
  // would be dead markup.
  const missing = sorted(backendKeys())
    .filter(k => !WEBSITE_HIDDEN_CATEGORIES.includes(k))
    .filter(k => !websiteKeys().has(k));
  assert.deepEqual(missing, [], 'these would render as raw slugs on the live site');
});

test('the bot-only categories are ABSENT from the public page', () => {
  // If one ever gained a heading it would look publishable, and the next person
  // to read this file would reasonably remove the SQL exclusion to make it work.
  const leaked = WEBSITE_HIDDEN_CATEGORIES.filter(k => websiteKeys().has(k));
  assert.deepEqual(leaked, [], 'bot-only categories must not appear in the page ORDER');
});

test('the bot-only categories are excluded in SQL, not in the browser', () => {
  // THE important one. website/faq/index.html is static and public: whatever the
  // endpoint returns sits in the response body, readable in devtools, whether or
  // not a heading is drawn. Filtering client-side would publish "Internal
  // (Private)" content to anyone who opened the network tab. The content must be
  // ABSENT from the query result.
  const src = read('../src/routes/websitePublic.js');
  const faqQuery = src.slice(src.indexOf("FROM chat_knowledge ck WHERE ck.kind='faq'"), src.indexOf('LIMIT 500'));
  assert.ok(faqQuery.length > 0, 'the website FAQ query was restructured');
  assert.ok(
    /WEBSITE_VISIBLE_CATEGORY_SQL/.test(faqQuery),
    'the FAQ query must exclude bot-only categories in SQL'
  );

  // And the fragment it interpolates must actually name every hidden category.
  const { WEBSITE_VISIBLE_CATEGORY_SQL } = require('../src/utils/faqCategories');
  for (const cat of WEBSITE_HIDDEN_CATEGORIES) {
    assert.ok(WEBSITE_VISIBLE_CATEGORY_SQL.includes(`'${cat}'`), `${cat} missing from the SQL fragment`);
  }
  assert.match(WEBSITE_VISIBLE_CATEGORY_SQL, /NOT IN/);
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
  assert.ok(WEBSITE_HIDDEN_CATEGORIES.length >= 2, 'the hidden list must be populated, or every leak test is vacuous');
  // Every hidden category must still be a VALID category, or it can never be saved.
  for (const cat of WEBSITE_HIDDEN_CATEGORIES) {
    assert.ok(backendKeys().has(cat), `${cat} is hidden from the website but not an accepted category`);
  }
});
