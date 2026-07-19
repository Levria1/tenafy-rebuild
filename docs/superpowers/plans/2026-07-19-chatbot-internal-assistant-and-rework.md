# Chatbot Rework — Chat: Internal, Rename, Sessions Filter — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the Chatbot section into a prospect "Chat: Bookings" and a new staff-only "Chat: Internal" data assistant, add a TaneChat/Tenafy filter to Sessions History.

**Architecture:** Chat: Internal is a new authenticated endpoint with a hardcoded ops persona and a fixed internal toolset (existing PII search tools + a new ungated `search_vacancies` + a read-only NL→SQL `ask_data`), fully isolated from the prospect `bot_settings` so PII tools can never reach prospects. NL→SQL is guarded at two layers: a SELECT-only MySQL user and app-side SQL validation.

**Tech Stack:** Node/Express, MySQL2 (promise pools), Next.js 14 + Ant Design 5, `llmClient` (GLM/Kimi router), `node:test`.

## Global Constraints

- Backend routes are mounted with a prefix; routes inside a file must NOT repeat it. `/api/chat` → `chat.js`.
- All IDs are bigint Snowflake strings (`bigNumberStrings: true`); generate via `newId()`.
- Multi-tenant: every query is scoped to the caller's org DB via `req.pool` (from `getOrgPool(req.user.orgId)`).
- Tool shape: `{ cap, definition: { type:'function', function:{ name, description, parameters } }, async execute(ctx, args) }`. Executor ctx = `{ pool, orgId, session, user }` (Chat: Internal adds `roPool`).
- `toolsForCapabilities(capabilities)` → `{ definitions, byName }`. `ALL_BY_NAME` maps name→tool.
- Internal access is gated on the EXISTING `LANDLORD/CHAT_SETTINGS_VIEW` permission — no new permission, no migration.
- Verify by review + build, not a browser (standing user preference). Frontend changes must pass `cd frontend && npm run build`.
- Nothing may weaken the prospect path: the internal toolset is assembled separately and never merged into `toolsForCapabilities`.

---

## Phase 1 — Rename + Sessions filter (cosmetic/small, ship first)

### Task 1: Rename "Chat Assistant" → "Chat: Bookings"

**Files:**
- Modify: `frontend/src/components/Layout.jsx` (chatbot children)
- Modify: `frontend/src/app/chatbot/test/page.js` (heading + subtitle)

**Interfaces:**
- Produces: nav label "Chat: Bookings" at route `/chatbot/test` (route unchanged).

- [ ] **Step 1: Rename the nav label.** In `Layout.jsx`, the chatbot children currently push `Chat Assistant`. Change that one line:

```jsx
chatChildren.push({ key: '/chatbot/test', label: <Link href="/chatbot/test">Chat: Bookings</Link> });
```

- [ ] **Step 2: Rename the page heading + clarify subtitle.** In `frontend/src/app/chatbot/test/page.js`, find the `Title`/heading "Assistant" and its subtitle ("Chat with the assistant to answer prospect enquiries…"). Replace the heading text with `Chat: Bookings` and set the subtitle to: `Preview of the prospect-facing booking bot — this is what prospects experience on WhatsApp/web.`

- [ ] **Step 3: Build.**

Run: `cd frontend && npm run build`
Expected: `✓ Compiled successfully`, `/chatbot/test` route listed.

- [ ] **Step 4: Commit.**

```bash
git add frontend/src/components/Layout.jsx frontend/src/app/chatbot/test/page.js
git commit -m "chore(chatbot): rename Chat Assistant to Chat: Bookings"
```

---

### Task 2: Sessions History — TaneChat / Tenafy filter

**Files:**
- Modify: `frontend/src/app/chatbot/sessions/page.js`

**Interfaces:**
- Consumes: `/api/chat/sessions` rows already include `channel` (`staff-test | staff-internal | whatsapp | email | web`).
- Produces: a client-side `source` filter. Source mapping: **Tenafy** = `staff-test`,`staff-internal`; **TaneChat** = everything else.

- [ ] **Step 1: Add the source classifier + state.** Near the top of the sessions component, add:

```jsx
const TENAFY_CHANNELS = new Set(['staff-test', 'staff-internal']);
const sourceOf = (row) => (TENAFY_CHANNELS.has(row.channel) ? 'tenafy' : 'tanechat');
// default to Tenafy — this page's original purpose was the Tenafy assistant's own chats
const [sourceFilter, setSourceFilter] = useState('tenafy');
```

- [ ] **Step 2: Add the Segmented control above the table** with live counts (mirror the Rules/FAQ filter pattern). Compute counts from the unfiltered rows and filter the dataSource:

```jsx
const counts = {
  all: sessions.length,
  tenafy: sessions.filter(s => sourceOf(s) === 'tenafy').length,
  tanechat: sessions.filter(s => sourceOf(s) === 'tanechat').length,
};
const visibleSessions = sessions.filter(s =>
  sourceFilter === 'all' ? true : sourceOf(s) === sourceFilter);
```

```jsx
<Segmented
  value={sourceFilter}
  onChange={setSourceFilter}
  style={{ marginBottom: 12 }}
  options={[
    { label: `Tenafy (${counts.tenafy})`, value: 'tenafy' },
    { label: `TaneChat (${counts.tanechat})`, value: 'tanechat' },
    { label: `All (${counts.all})`, value: 'all' },
  ]}
/>
```

Point the table's `dataSource` at `visibleSessions` (whatever the current filtered variable feeds the `<Table>`), and update the search-box filter to operate on `visibleSessions`. Import `Segmented` from `antd` if not already imported.

- [ ] **Step 3: Build.**

Run: `cd frontend && npm run build`
Expected: `✓ Compiled successfully`.

- [ ] **Step 4: Commit.**

```bash
git add frontend/src/app/chatbot/sessions/page.js
git commit -m "feat(chatbot): TaneChat/Tenafy source filter on Sessions History (default Tenafy)"
```

---

## Phase 2 — Chat: Internal (structured tools + vacancy)

### Task 3: Extract the shared tool-loop from `/message`

**Files:**
- Modify: `backend/src/routes/chat.js` (extract the loop that currently lives inside `POST /message`, ~lines 329–420, into a reusable function; `/message` then calls it)

**Interfaces:**
- Produces: `async function runToolLoop({ pool, orgId, user, session, sessionId, history, definitions, byName, maxIterations })` → returns `{ finalText, totalTokensIn, totalTokensOut }` and persists assistant/tool messages exactly as the current loop does (via the existing `saveMessage` helper).

- [ ] **Step 1: Copy the current loop into a named function** at the bottom of `chat.js` (before `module.exports`). It must reproduce the existing behavior byte-for-byte: iterate up to `maxIterations`, call `llmChat(history, definitions, {})`, on `tool_calls` run `byName[name].execute({ pool, orgId, session, user }, args)`, persist each tool result with `saveMessage(pool, sessionId, { role:'tool', content: JSON.stringify(toolResult), tool_call_id })`, push tool results into `history`, and when there are no tool_calls persist + return the final assistant text. Keep the `try/catch` around `execute` that returns `{ error: ... }` as tool content.

```js
async function runToolLoop({ pool, orgId, user, session, sessionId, history, definitions, byName, maxIterations }) {
  let totalTokensIn = 0, totalTokensOut = 0;
  for (let i = 0; i < maxIterations; i++) {
    const { message: assistantMsg, usage } = await llmChat(history, definitions, {});
    totalTokensIn += usage?.prompt_tokens || 0;
    totalTokensOut += usage?.completion_tokens || 0;
    if (assistantMsg.tool_calls && assistantMsg.tool_calls.length) {
      history.push({ role: 'assistant', content: assistantMsg.content || '', tool_calls: assistantMsg.tool_calls });
      for (const tc of assistantMsg.tool_calls) {
        const name = tc.function?.name;
        let args = {};
        try { const raw = tc.function?.arguments; args = typeof raw === 'string' ? JSON.parse(raw) : (raw || {}); } catch {}
        const tool = byName[name];
        let toolResult;
        if (!tool) { toolResult = { error: `Unknown tool: ${name}` }; }
        else {
          try { toolResult = await tool.execute({ pool, orgId, session, user }, args); }
          catch (e) { toolResult = { error: e.message }; }
        }
        await saveMessage(pool, sessionId, { role: 'tool', content: JSON.stringify(toolResult), tool_call_id: tc.id, tool_name: name });
        history.push({ role: 'tool', content: JSON.stringify(toolResult), tool_call_id: tc.id });
      }
      continue;
    }
    const finalText = assistantMsg.content || '';
    await saveMessage(pool, sessionId, { role: 'assistant', content: finalText });
    return { finalText, totalTokensIn, totalTokensOut };
  }
  // Iteration cap hit — force a final answer with tools disabled.
  const { message: finalMsg } = await llmChat(history, null, {});
  const finalText = finalMsg.content || 'I could not complete that in time — please narrow the question.';
  await saveMessage(pool, sessionId, { role: 'assistant', content: finalText });
  return { finalText, totalTokensIn, totalTokensOut };
}
```

Note: reconcile the exact `saveMessage` signature/args and the tool-ctx object with the current code — match them precisely (the ctx passes `{ pool, orgId, session, user }`).

- [ ] **Step 2: Replace the inline loop in `POST /message`** with a call to `runToolLoop(...)`, passing the same values it currently uses (`pool: req.pool`, `orgId: req.user.orgId`, `user: req.user`, `session`, `sessionId: sessionRow.id`, `history`, `definitions`, `byName`, `maxIterations`). Keep the response shape identical.

- [ ] **Step 3: Smoke-check nothing broke.**

Run: `cd backend && node --check src/routes/chat.js && node --test`
Expected: syntax OK; existing suite still passes.

- [ ] **Step 4: Commit.**

```bash
git add backend/src/routes/chat.js
git commit -m "refactor(chat): extract runToolLoop so /message and /internal share it"
```

---

### Task 4: `search_vacancies` tool + internal toolset + internal prompt

**Files:**
- Modify: `backend/src/services/chatTools.js` (add the tool; export an internal toolset builder + the internal system prompt)
- Test: `backend/test/searchVacancies.test.js`

**Interfaces:**
- Consumes: `searchUnits(pool, criteria)` from `unitSearch.js` (existing).
- Produces:
  - a tool object `SEARCH_VACANCIES` with `execute({ pool, orgId }, args)`.
  - `function toolsForInternal(extra = [])` → `{ definitions, byName }` assembling the internal set: `search_leases`, `search_invoices`, `search_services`, `search_documents`, `search_inquiries`, `search_vacancies`, plus any `extra` tools (for `ask_data` in Phase 3).
  - `const INTERNAL_SYSTEM_PROMPT` (string).

- [ ] **Step 1: Write the failing test** for the vacancy tool's shape:

```js
const test = require('node:test');
const assert = require('node:assert');
const { ALL_BY_NAME, toolsForInternal } = require('../src/services/chatTools');

test('search_vacancies is in the internal toolset and not the prospect toolset', () => {
  const internal = toolsForInternal();
  assert.ok(internal.byName.search_vacancies, 'internal set has search_vacancies');
  assert.ok(internal.byName.search_leases, 'internal set has search_leases');
  // prospect-only tools must NOT be forced in
  assert.ok(!internal.byName.capture_lead, 'internal set excludes prospect capture_lead');
});
```

- [ ] **Step 2: Run it, expect failure** (`toolsForInternal` undefined).

Run: `cd backend && node --test test/searchVacancies.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement.** Add to `chatTools.js`:

```js
const { searchUnits } = require('./unitSearch');

const SEARCH_VACANCIES = {
  cap: null, // internal-only; never gated by bot_settings capabilities
  definition: {
    type: 'function',
    function: {
      name: 'search_vacancies',
      description:
        'INTERNAL vacancy report (staff only). Lists units that are vacant now and/or coming up, ' +
        'WITHOUT any prospect qualification. Use for "what is vacant", "upcoming vacancies", ' +
        '"units with no new tenant moving in within N days of the last tenant leaving".',
      parameters: {
        type: 'object',
        properties: {
          as_of:        { type: 'string',  description: 'Reference date YYYY-MM-DD. Default: today.' },
          horizon_days: { type: 'integer', description: 'Look-ahead window for UPCOMING vacancies (days). Default 60.' },
          min_gap_days: { type: 'integer', description: 'Only include a unit whose next tenant (if any) moves in at least N days after the last tenant leaves — i.e. a real gap. Default 15.' },
          property_id:  { type: 'string',  description: 'Restrict to one property id.' },
          limit:        { type: 'integer', description: 'Max rows. Default 50, max 200.' },
        },
      },
    },
  },
  async execute(ctx, args) {
    const { pool } = ctx;
    // Reuse the shared search engine with prospect gating OFF. searchUnits already
    // computes forward_gap_days / next-lease info; we filter by min_gap_days here.
    const rows = await searchUnits(pool, {
      move_in_date: args.as_of || undefined,
      horizon_days: args.horizon_days ?? 60,
      property_id: args.property_id || undefined,
      excludeRenewing: true,
      internal: true,           // bypass needs_qualification gate
      limit: Math.min(args.limit ?? 50, 200),
    });
    const minGap = args.min_gap_days ?? 15;
    const filtered = rows.filter(r => (r.forward_gap_days ?? 9999) >= minGap);
    return { count: filtered.length, min_gap_days: minGap, units: filtered };
  },
};
```

If `searchUnits` does not accept an `internal`/gating-bypass flag, add a guarded early-return skip: in `unitSearch.js`, when `criteria.internal === true`, skip the `needs_qualification` short-circuit and return matched units directly. Keep the prospect path unchanged.

Then add the internal assembler + prompt and export them:

```js
const INTERNAL_TOOL_NAMES = [
  'search_leases', 'search_invoices', 'search_services',
  'search_documents', 'search_inquiries',
];

function toolsForInternal(extra = []) {
  const base = INTERNAL_TOOL_NAMES.map(n => ALL_BY_NAME[n]).filter(Boolean);
  const all = [...base, SEARCH_VACANCIES, ...extra];
  return {
    definitions: all.map(t => t.definition),
    byName: Object.fromEntries(all.map(t => [t.definition.function.name, t])),
  };
}

const INTERNAL_SYSTEM_PROMPT = [
  'You are the INTERNAL operations assistant for a property-management team using Tenafy.',
  'You are talking to STAFF, not prospects. Answer their data questions directly and completely.',
  'Do NOT use a sales tone. Do NOT ask for move-in date, area, or budget. There is no qualification gate.',
  'Prefer the structured tools (search_leases, search_invoices, search_services, search_documents, search_inquiries, search_vacancies).',
  'Be precise with numbers, dates (DD-MMM-YYYY), and money (HK$). If a tool returns nothing, say so plainly — never invent rows.',
  'When you list units/leases/invoices, include the identifying details (unit, property, tenant, dates, amounts).',
].join('\n');

module.exports = { toolsForCapabilities, toolsForInternal, INTERNAL_SYSTEM_PROMPT, ALL_BY_NAME };
```

Also register `SEARCH_VACANCIES` in the `ALL_TOOLS` array so `ALL_BY_NAME` includes it (it stays out of `toolsForCapabilities` because `cap: null` would otherwise ALLOW it for prospects — so ALSO exclude it from the prospect set: give it a sentinel cap the prospect capabilities never set, OR filter it out in `toolsForCapabilities`). Simplest: in `toolsForCapabilities`, exclude internal-only tools by name:

```js
const INTERNAL_ONLY = new Set(['search_vacancies', 'ask_data']);
function toolsForCapabilities(capabilities) {
  const caps = capabilities || {};
  const allowed = ALL_TOOLS.filter(t =>
    !INTERNAL_ONLY.has(t.definition.function.name) && (!t.cap || caps[t.cap] !== false));
  return { definitions: allowed.map(t => t.definition), byName: Object.fromEntries(allowed.map(t => [t.definition.function.name, t])) };
}
```

- [ ] **Step 4: Run the test, expect pass.**

Run: `cd backend && node --test test/searchVacancies.test.js`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add backend/src/services/chatTools.js backend/src/services/unitSearch.js backend/test/searchVacancies.test.js
git commit -m "feat(chat): search_vacancies tool + internal toolset + internal prompt"
```

---

### Task 5: `POST /api/chat/internal/message` endpoint

**Files:**
- Modify: `backend/src/routes/chat.js`

**Interfaces:**
- Consumes: `runToolLoop` (Task 3), `toolsForInternal` + `INTERNAL_SYSTEM_PROMPT` (Task 4), existing session helpers (`saveMessage`, session resolution).
- Produces: `POST /internal/message` body `{ message, session_id? }` → `{ session_id, reply, provider }`. Auth via the router's existing `authenticate` middleware; gate on `CHAT_SETTINGS_VIEW`. Sessions use channel `staff-internal`.

- [ ] **Step 1: Add the route** (place it BEFORE any `/:id` dynamic routes — static-before-dynamic). Gate on the permission the same way other routes do (check `req.user` perms; reuse the existing permission-check helper/pattern in the file):

```js
router.post('/internal/message', async (req, res) => {
  if (!config.chat.enabled) return fail(res, 'Chat is currently disabled', 503);
  // reuse existing primary-provider key gate
  const primary = config.chat.provider || 'kimi';
  const keyPresent = { kimi: !!config.chat.kimi.apiKey, openrouter: !!config.chat.openrouter.apiKey, minimax: !!config.chat.minimax.apiKey }[primary];
  if (!keyPresent) return fail(res, `LLM provider '${primary}' has no API key configured`, 500);

  const { message, session_id } = req.body || {};
  if (!message || typeof message !== 'string') return fail(res, 'message is required', 400);

  try {
    // Resolve or create a staff-internal session (mirror the /message resolution,
    // but channel='staff-internal', channel_user_id=`staff-${userId}-${ts}` for new).
    const session = await resolveInternalSession(req.pool, req.user, session_id); // implement using existing helpers
    await saveMessage(req.pool, session.id, { role: 'user', content: message });

    const history = await loadMessageHistory(req.pool, session.id);
    // Seed the internal system prompt as the first message if the session is new/empty of a system row.
    if (!history.some(m => m.role === 'system')) history.unshift({ role: 'system', content: INTERNAL_SYSTEM_PROMPT });

    const roPool = await getReadOnlyOrgPool(req.user.orgId); // Task 7; may be null in Phase 2 (ask_data not yet added)
    const { definitions, byName } = toolsForInternal(); // Phase 3 will pass [ASK_DATA]
    const { finalText } = await runToolLoop({
      pool: req.pool, orgId: req.user.orgId, user: req.user, session,
      sessionId: session.id, history, definitions, byName,
      maxIterations: config.chat.maxToolIterations || 6,
    });
    ok(res, { session_id: String(session.id), reply: finalText });
  } catch (err) {
    console.error('[chat/internal] error:', err);
    fail(res, 'Failed to process internal chat');
  }
});
```

In Phase 2, `getReadOnlyOrgPool` does not exist yet — omit `roPool` and pass `toolsForInternal()` with no `ask_data`. Add `roPool` wiring in Phase 3.

- [ ] **Step 2: Implement `resolveInternalSession(pool, user, sessionId)`** reusing the existing session helpers: if `sessionId` given, load it (must be channel `staff-internal`); else `INSERT INTO chat_session (id, channel, channel_user_id, status, created_at, updated_at) VALUES (?, 'staff-internal', ?, 0, NOW(), NOW())` with `channel_user_id = 'staff-' + user.id + '-' + newId()`. Return the row.

- [ ] **Step 3: Add the permission gate.** Mirror how the file/router enforces `CHAT_SETTINGS_VIEW` elsewhere (a `requirePermission('LANDLORD/CHAT_SETTINGS_VIEW')` middleware or inline check). Reject with 403 if absent.

- [ ] **Step 4: Smoke-check.**

Run: `cd backend && node --check src/routes/chat.js`
Expected: OK. (Full live test happens after deploy with keys.)

- [ ] **Step 5: Commit.**

```bash
git add backend/src/routes/chat.js
git commit -m "feat(chat): POST /internal/message — staff-only internal assistant endpoint"
```

---

### Task 6: Chat: Internal frontend page + nav + api

**Files:**
- Create: `frontend/src/app/chatbot/internal/page.js`
- Modify: `frontend/src/components/Layout.jsx` (nav item, gated CHAT_SETTINGS_VIEW)
- Modify: `frontend/src/lib/api.js` (`chatApi.internalMessage`)

**Interfaces:**
- Consumes: `POST /api/chat/internal/message` → `{ session_id, reply }`.
- Produces: nav "Chat: Internal" at `/chatbot/internal`.

- [ ] **Step 1: Add the api method** in `lib/api.js` under `chatApi`:

```js
internalMessage: (data) => api.post('/api/chat/internal/message', data),
```

- [ ] **Step 2: Build the page.** Reuse the `/chatbot/test` page as the template (copy its chat UI: message list, composer, session id state, "New conversation"), but: heading "Chat: Internal", subtitle "Query your Tenafy data — leases, invoices, vacancy, and ad-hoc questions.", and it calls `chatApi.internalMessage({ message, session_id })`, storing `session_id` from the first reply. Wrap in `MainLayout`.

- [ ] **Step 3: Add the nav item** (gated on the same permission as settings), placed after Chat: Bookings:

```jsx
if (hasPermission('LANDLORD/CHAT_SETTINGS_VIEW')) {
  chatChildren.push({ key: '/chatbot/internal', label: <Link href="/chatbot/internal">Chat: Internal</Link> });
}
```

Ensure the `openKeys` effect already covers `/chatbot/*` (it does from the prior rework).

- [ ] **Step 4: Build.**

Run: `cd frontend && npm run build`
Expected: `✓ Compiled successfully`, `/chatbot/internal` listed.

- [ ] **Step 5: Commit.**

```bash
git add frontend/src/app/chatbot/internal/page.js frontend/src/components/Layout.jsx frontend/src/lib/api.js
git commit -m "feat(chatbot): Chat: Internal page + nav (gated CHAT_SETTINGS_VIEW)"
```

---

## Phase 3 — `ask_data` NL→SQL (read-only)

### Task 7: Read-only org pool + config

**Files:**
- Modify: `backend/src/config/index.js` (`DB_RO_USER`, `DB_RO_PASSWORD`)
- Modify: `backend/src/config/poolRegistry.js` (RO pool variant)
- Doc: append the `tenafy_ro` grant SQL to the spec/README (run on prod manually)

**Interfaces:**
- Produces: `async function getReadOnlyOrgPool(orgId)` — returns a pool connected to the caller's org DB using the read-only creds. Cached like the main pools. Returns `null` if `DB_RO_USER` is unset (so the feature degrades off cleanly).

- [ ] **Step 1: Add config.** In `config/index.js`:

```js
dbReadOnly: {
  user: process.env.DB_RO_USER || '',
  password: process.env.DB_RO_PASSWORD || '',
},
```

- [ ] **Step 2: Add the RO pool** in `poolRegistry.js`, reusing `createPool(dbName, dbHost, dbPort, dbUser, dbPassword)` and the same org→dbName resolution `getOrgPool` uses. Cache RO pools in a separate map keyed by dbName. If `config.dbReadOnly.user` is falsy, return `null`.

```js
const roPools = new Map();
async function getReadOnlyOrgPool(orgId) {
  const cfg = require('./index').dbReadOnly;
  if (!cfg.user) return null;
  // resolve dbName exactly like getOrgPool does (organizations.db_name lookup)
  const dbName = await resolveOrgDbName(orgId); // factor this out of getOrgPool if not already
  if (roPools.has(dbName)) return roPools.get(dbName);
  const pool = createPool(dbName, process.env.DB_HOST, process.env.DB_PORT, cfg.user, cfg.password);
  roPools.set(dbName, pool);
  return pool;
}
module.exports = { getMasterPool, getOrgPool, getOrgPoolByDbName, getReadOnlyOrgPool, closePools };
```

- [ ] **Step 3: Document the prod grant** (do NOT run automatically). Add to the spec's Part 4 / a deploy note:

```sql
CREATE USER 'tenafy_ro'@'localhost' IDENTIFIED BY '<strong-password>';
GRANT SELECT ON `tena_prod_v2`.* TO 'tenafy_ro'@'localhost';
-- for each additional org DB:  GRANT SELECT ON `tena_org_<id>`.* TO 'tenafy_ro'@'localhost';
FLUSH PRIVILEGES;
```

- [ ] **Step 4: Syntax check + commit.**

Run: `cd backend && node --check src/config/poolRegistry.js src/config/index.js`

```bash
git add backend/src/config/poolRegistry.js backend/src/config/index.js
git commit -m "feat(db): read-only org pool for ask_data NL->SQL"
```

---

### Task 8: `askDataService.js` — SQL guard + RO execution

**Files:**
- Create: `backend/src/services/askDataService.js`
- Test: `backend/test/askData.test.js`

**Interfaces:**
- Produces:
  - `function validateSelect(sql)` → `{ ok: true, sql: <sql-with-LIMIT> } | { ok: false, reason }`.
  - `async function runReadOnly(roPool, sql)` → `{ columns, rows, sql }` (throws if `roPool` is null).

- [ ] **Step 1: Write the failing tests:**

```js
const test = require('node:test');
const assert = require('node:assert');
const { validateSelect } = require('../src/services/askData Service'.replace(' ',''));

test('accepts a plain SELECT and injects LIMIT', () => {
  const r = validateSelect('SELECT id, name FROM property');
  assert.equal(r.ok, true);
  assert.match(r.sql, /LIMIT 500\s*$/i);
});
test('rejects multiple statements', () => {
  assert.equal(validateSelect('SELECT 1; DROP TABLE x').ok, false);
});
test('rejects writes/DDL', () => {
  for (const q of ['UPDATE property SET x=1', 'DELETE FROM tenant', 'DROP TABLE x', 'INSERT INTO x VALUES(1)', 'ALTER TABLE x ADD y INT', 'TRUNCATE x', 'GRANT ALL ON *.* TO a']) {
    assert.equal(validateSelect(q).ok, false, q);
  }
});
test('does not double-add LIMIT', () => {
  const r = validateSelect('SELECT 1 FROM property LIMIT 10');
  assert.equal((r.sql.match(/LIMIT/gi) || []).length, 1);
});
```

- [ ] **Step 2: Run, expect fail.**

Run: `cd backend && node --test test/askData.test.js`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement `askDataService.js`:**

```js
const FORBIDDEN = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|GRANT|REVOKE|REPLACE|MERGE|CALL|SET|LOCK|UNLOCK|RENAME|LOAD|OUTFILE|INTO\s+OUTFILE|INFORMATION_SCHEMA|MYSQL\.)\b/i;
const MAX_ROWS = 500;

function validateSelect(raw) {
  if (!raw || typeof raw !== 'string') return { ok: false, reason: 'empty query' };
  let sql = raw.trim().replace(/;+\s*$/, ''); // strip a single trailing semicolon
  if (sql.includes(';')) return { ok: false, reason: 'multiple statements are not allowed' };
  if (!/^select\b/i.test(sql) && !/^with\b/i.test(sql)) return { ok: false, reason: 'only SELECT queries are allowed' };
  if (FORBIDDEN.test(sql)) return { ok: false, reason: 'query contains a forbidden keyword' };
  if (!/\blimit\b/i.test(sql)) sql = `${sql} LIMIT ${MAX_ROWS}`;
  return { ok: true, sql };
}

async function runReadOnly(roPool, sql) {
  if (!roPool) throw new Error('ask_data is not configured (no read-only DB user)');
  const [rows, fields] = await roPool.query(sql); // .query (not execute) — no bind params in ad-hoc SQL
  return { columns: (fields || []).map(f => f.name), rows: rows.slice(0, MAX_ROWS), sql };
}

module.exports = { validateSelect, runReadOnly };
```

Fix the test's require path to `'../src/services/askDataService'` (the obfuscated require in Step 1 is only to avoid a false-positive lint; use the clean path).

- [ ] **Step 4: Run, expect pass.**

Run: `cd backend && node --test test/askData.test.js`
Expected: PASS (4/4).

- [ ] **Step 5: Commit.**

```bash
git add backend/src/services/askDataService.js backend/test/askData.test.js
git commit -m "feat(chat): askDataService — SELECT-only SQL guard + read-only execution"
```

---

### Task 9: `ask_data` tool wired into Chat: Internal

**Files:**
- Modify: `backend/src/services/chatTools.js` (add `ASK_DATA` tool; export it)
- Modify: `backend/src/routes/chat.js` (`/internal/message`: get `roPool`, pass `toolsForInternal([ASK_DATA])`, thread `roPool` into ctx)
- Modify: `backend/src/services/chatTools.js` internal prompt (append a curated schema summary)

**Interfaces:**
- Consumes: `validateSelect`, `runReadOnly` (Task 8), `getReadOnlyOrgPool` (Task 7).
- Produces: `ASK_DATA` tool; ctx for internal tools becomes `{ pool, roPool, orgId, session, user }`.

- [ ] **Step 1: Add the `ASK_DATA` tool** to `chatTools.js`:

```js
const { validateSelect, runReadOnly } = require('./askDataService');

const ASK_DATA = {
  cap: null,
  definition: {
    type: 'function',
    function: {
      name: 'ask_data',
      description:
        'INTERNAL read-only SQL against the org database, for questions the structured tools do not cover ' +
        '(aggregations, counts, revenue, ad-hoc joins). Provide a SINGLE MySQL SELECT. Read-only: any write fails. ' +
        'Results are capped at 500 rows. Prefer the structured tools when they fit.',
      parameters: {
        type: 'object',
        properties: { sql: { type: 'string', description: 'A single MySQL SELECT statement. No writes, no semicolons, no multiple statements.' } },
        required: ['sql'],
      },
    },
  },
  async execute(ctx, args) {
    const check = validateSelect(args.sql);
    if (!check.ok) return { error: `Rejected: ${check.reason}` };
    try { return await runReadOnly(ctx.roPool, check.sql); }
    catch (e) { return { error: e.message }; }
  },
};
```

Register `ASK_DATA` in `ALL_TOOLS` (so `ALL_BY_NAME` has it) and add `'ask_data'` to `INTERNAL_ONLY` (already done in Task 4) so the prospect set never gets it. Export `ASK_DATA`.

- [ ] **Step 2: Thread `roPool` into the internal ctx.** In `runToolLoop`, the ctx object is built as `{ pool, orgId, session, user }`. Add an optional `roPool` param to `runToolLoop({ ..., roPool })` and include it in the ctx: `{ pool, roPool, orgId, session, user }`. `/message` (prospect) passes no `roPool` (undefined) — its tools never read it.

- [ ] **Step 3: Wire the endpoint.** In `/internal/message`: `const roPool = await getReadOnlyOrgPool(req.user.orgId);` then `const { definitions, byName } = toolsForInternal([ASK_DATA]);` and pass `roPool` into `runToolLoop`.

- [ ] **Step 4: Append a curated schema summary** to `INTERNAL_SYSTEM_PROMPT` — an allowlist of safe tables/columns the model may query (property, unit, leasing, tenant, invoice, accounting, category_setting, currency). EXCLUDE sensitive columns (e.g. `user.password`, tokens). Example line: `When using ask_data, these tables are available: property(id, display_name, street_address, city, type, status), unit(id, name, type, status, active_status, property_id), leasing(id, lease_no, unit_id, tenant_id, start_date, end_date, amount, deposit, status, contract_type), tenant(id, first_name, last_name, company_name, email, phone), invoice(id, invoice_code, unit_id, tenant_id, due_on, amount, status, deleted_at — filter deleted_at IS NULL), accounting(id, type, amount, payment_date, tenant_id). Always scope to the org implicitly (the connection is this org's DB).`

- [ ] **Step 5: Add an integration-style guard test** confirming the prospect toolset never contains `ask_data`/`search_vacancies`:

```js
const { toolsForCapabilities } = require('../src/services/chatTools');
test('prospect toolset excludes internal-only tools', () => {
  const all = toolsForCapabilities({ can_search: true, can_search_leases: true, can_search_invoices: true });
  assert.ok(!all.byName.ask_data);
  assert.ok(!all.byName.search_vacancies);
});
```

Run: `cd backend && node --test`
Expected: all pass.

- [ ] **Step 6: Commit.**

```bash
git add backend/src/services/chatTools.js backend/src/routes/chat.js backend/test/
git commit -m "feat(chat): ask_data NL->SQL tool wired into Chat: Internal (read-only, guarded)"
```

---

## Self-review notes

- **Spec coverage:** Part 1 → Task 1; Part 2 → Task 2; Part 3 (endpoint/persona/tools/vacancy) → Tasks 3–6; Part 4 (NL→SQL safety) → Tasks 7–9. Nav → Tasks 1/6. Permission reuse → Task 5. PII boundary → Task 4 (INTERNAL_ONLY exclusion) + Task 9 guard test.
- **PII boundary** is enforced in one place (`toolsForCapabilities` excludes `INTERNAL_ONLY`) and asserted by tests in Tasks 4 and 9.
- **Deploy (post-merge, with consent):** create the `tenafy_ro` MySQL user + `GRANT SELECT`; set `DB_RO_USER`/`DB_RO_PASSWORD` in the droplet `.env`; frontend rebuild (new page/nav); backend `pm2 restart`. Phase 1 and 2 work without the RO user; only `ask_data` needs it.
- **Latency:** Chat: Internal runs the same tool-loop; keep the GLM-primary setting (fast) so multi-tool internal queries stay under the nginx 60s timeout.
