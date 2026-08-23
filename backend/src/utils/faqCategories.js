/**
 * FAQ categories — the single backend definition.
 *
 * Two lists, because a category is not only a label: two of them also mean
 * "never render this on the public FAQ page".
 *
 * WEBSITE_HIDDEN_CATEGORIES is enforced in the SQL of the public website
 * endpoint, NOT by filtering the rendered list in the browser. That distinction
 * is the whole point. `website/faq/index.html` is static and public: anything the
 * endpoint returns is in the response body, readable in the network tab, whether
 * or not a heading is drawn for it. Hiding these client-side would publish
 * "Internal (Private)" content to anyone who opened devtools.
 *
 * So the rule is scope-by-omission: content in these categories must be ABSENT
 * from the query result, never filtered afterwards.
 *
 * This is deliberately belt-and-braces alongside `publish_website`. That flag is
 * a per-entry toggle an operator can set wrongly; the category is a standing
 * statement about what the content IS. An entry filed as Internal (Private) stays
 * off the website even if someone ticks the publish box by mistake.
 */

// Every value the API will accept. Anything else is rewritten to 'other' on save.
// MUST stay in sync with FAQ_CATEGORIES in
// frontend/src/components/chatbot/KnowledgeCard.jsx.
const FAQ_CATEGORIES = [
  'your_unit', 'power', 'appliances_laundry', 'water_heating', 'getting_here',
  'internet', 'rubbish', 'building_access', 'access_safety', 'nearby',
  'house_rules', 'payments', 'maintenance', 'booking', 'moving_in', 'moving_out',
  'lease_renewal', 'internal_private', 'inquiries', 'other',
];

// Readable by Tenafy's own assistant and by TaneChat, never rendered on the
// public FAQ site. `inquiries` holds prospect-facing answers that belong in a
// conversation rather than on a page a resident browses.
const WEBSITE_HIDDEN_CATEGORIES = ['internal_private', 'inquiries'];

// Ready-to-interpolate SQL. Parameter-free on purpose: the values are constants,
// so a caller can drop this into a WHERE clause without disturbing its own
// placeholder ordering — the edit that silently misaligns params.
const WEBSITE_VISIBLE_CATEGORY_SQL =
  `ck.category NOT IN (${WEBSITE_HIDDEN_CATEGORIES.map(c => `'${c}'`).join(',')})`;

module.exports = { FAQ_CATEGORIES, WEBSITE_HIDDEN_CATEGORIES, WEBSITE_VISIBLE_CATEGORY_SQL };
