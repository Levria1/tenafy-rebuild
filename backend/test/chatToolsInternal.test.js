/**
 * Internal-vs-prospect toolset boundary. Guards the PII rule: internal-only tools
 * (search_vacancies, ask_data) must never appear in the prospect toolset, and the
 * internal set must contain the staff data tools.
 */
const test = require('node:test');
const assert = require('node:assert');
const {
  toolsForCapabilities, toolsForInternal, INTERNAL_SYSTEM_PROMPT,
} = require('../src/services/chatTools');

test('internal toolset contains the staff data tools + vacancy', () => {
  const internal = toolsForInternal();
  for (const n of ['search_leases', 'search_invoices', 'search_services', 'search_documents', 'search_inquiries', 'search_vacancies']) {
    assert.ok(internal.byName[n], `internal set has ${n}`);
  }
});

test('prospect toolset EXCLUDES internal-only tools even with all caps on', () => {
  const prospect = toolsForCapabilities({
    can_search: true, can_show_details: true, can_book_viewings: true, can_capture_leads: true,
    can_search_inquiries: true, can_search_leases: true, can_search_invoices: true,
    can_search_services: true, can_search_documents: true,
  });
  assert.ok(!prospect.byName.search_vacancies, 'prospect set must exclude search_vacancies');
  assert.ok(!prospect.byName.ask_data, 'prospect set must exclude ask_data');
  // sanity: prospect DOES still get its normal tools
  assert.ok(prospect.byName.search_available_units, 'prospect keeps search_available_units');
});

test('internal system prompt is a non-empty ops persona (no qualify gate)', () => {
  assert.ok(typeof INTERNAL_SYSTEM_PROMPT === 'string' && INTERNAL_SYSTEM_PROMPT.length > 50);
  assert.match(INTERNAL_SYSTEM_PROMPT, /STAFF/);
  assert.doesNotMatch(INTERNAL_SYSTEM_PROMPT, /qualify the lead/i);
});
