/**
 * Internal-vs-prospect toolset boundary. Guards the PII rule: internal-only tools
 * (search_vacancies, ask_data) must never appear in the prospect toolset, and the
 * internal set must contain the staff data tools.
 */
const test = require('node:test');
const assert = require('node:assert');
const {
  toolsForCapabilities, toolsForInternal, INTERNAL_SYSTEM_PROMPT, ASK_DATA,
} = require('../src/services/chatTools');

test('internal toolset contains the staff data tools + vacancy + chats', () => {
  const internal = toolsForInternal();
  for (const n of ['search_leases', 'search_invoices', 'search_services', 'search_documents', 'search_inquiries', 'search_vacancies', 'search_chats']) {
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
  // Transcripts of other prospects' conversations must never be reachable by a prospect.
  assert.ok(!prospect.byName.search_chats, 'prospect set must exclude search_chats');
  // sanity: prospect DOES still get its normal tools
  assert.ok(prospect.byName.search_available_units, 'prospect keeps search_available_units');
});

test('internal system prompt is a non-empty ops persona (no qualify gate)', () => {
  assert.ok(typeof INTERNAL_SYSTEM_PROMPT === 'string' && INTERNAL_SYSTEM_PROMPT.length > 50);
  assert.match(INTERNAL_SYSTEM_PROMPT, /STAFF/);
  assert.doesNotMatch(INTERNAL_SYSTEM_PROMPT, /qualify the lead/i);
  // ask_data needs the schema allowlist to write valid SQL
  assert.match(INTERNAL_SYSTEM_PROMPT, /leasing\(id, lease_no/);
  // sensitive tables must NOT be advertised
  assert.doesNotMatch(INTERNAL_SYSTEM_PROMPT, /password/i);
});

test('ask_data is opt-in: only present when explicitly passed (needs a read-only pool)', () => {
  assert.ok(!toolsForInternal().byName.ask_data, 'omitted when no RO pool');
  assert.ok(toolsForInternal([ASK_DATA]).byName.ask_data, 'present when passed');
});

test('ask_data rejects a write before touching the DB', async () => {
  // roPool intentionally null — a rejected query must never reach runReadOnly.
  const r = await ASK_DATA.execute({ roPool: null }, { sql: 'DELETE FROM tenant' });
  assert.match(r.error, /rejected/i);
});

test('ask_data reports missing read-only config rather than using the RW pool', async () => {
  const r = await ASK_DATA.execute({ roPool: null }, { sql: 'SELECT id FROM property' });
  assert.match(r.error, /not configured/i);
});
