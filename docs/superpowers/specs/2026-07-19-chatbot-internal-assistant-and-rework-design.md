# Chatbot section rework — Chat: Internal, rename, sessions filter

**Date:** 2026-07-19
**Status:** Approved

## Problem

The Chatbot section conflates two very different jobs:

1. **Chat Assistant** (`/chatbot/test`) is actually a staff *preview of the
   prospect-facing sales bot* — it runs `defaultSystemPrompt` (a "warm leasing
   agent" with a hard **qualify-before-showing** gate). When staff try to use it
   to query their own data ("list vacant units"), it interrogates them for a
   move-in date/budget instead of answering. Wrong tool for internal queries.

2. **Sessions History** was built to show the Tenafy Assistant's own chats
   (`staff-test`), but the auto-inquiry connector (`POST /api/public/chat/log`,
   used by TaneChat) now logs every WhatsApp/email prospect conversation into the
   same `chat_session` table — so the page is dominated by ~200 TaneChat rows.

Staff need a **separate internal assistant** for querying Tenafy data, the
Assistant needs a clearer name, and Sessions History needs to distinguish
Tenafy-run chats from TaneChat's.

## Decisions (locked)

- Internal scope: **structured tools + NL→SQL** (`ask_data`).
- Config isolation: **hardcoded internal config** (fixed prompt + toolset in
  code) — nothing shared with the prospect `bot_settings`, so PII tools can never
  reach prospects.
- NL→SQL safety: **read-only DB user + app guard** (defense in depth).
- Access: **reuse `LANDLORD/CHAT_SETTINGS_VIEW`** (no new permission).
- Sessions History: **keep all data, add a TaneChat / Tenafy filter** (not a hard
  exclusion).

## Final navigation (`Layout.jsx`)

```
Chatbot ▾
 ├── Chat: Bookings     → /chatbot/test       (renamed from "Chat Assistant")
 ├── Chat: Internal     → /chatbot/internal    (NEW, gated CHAT_SETTINGS_VIEW)
 ├── Sessions History   → /chatbot/sessions    (TaneChat/Tenafy filter)
 ├── Chatbot Settings   → /chatbot/settings
 ├── Rules Database     → /chatbot/rules
 └── FAQ Database       → /chatbot/faq
```

## Part 1 — Rename Chat Assistant → Chat: Bookings (cosmetic)

Nav label + page heading/subtitle only. **Zero behavior change** — same prospect
persona, same `bot_settings`, same tools. Route stays `/chatbot/test` (no broken
bookmarks). Settings/Rules/FAQ keep configuring this bot.

## Part 2 — Sessions History: TaneChat / Tenafy filter (small)

Channels map to a **source**:
- **Tenafy** = `staff-test` (Bookings preview) + `staff-internal` (Chat: Internal)
- **TaneChat** = `whatsapp`, `email`, `web` (prospect convos logged for inquiries)

Add a segmented filter **`All | Tenafy | TaneChat`** above the table (mirrors the
Rules/FAQ visibility filter pattern). **Default = Tenafy** (matches the page's
original intent). Backend `/sessions` accepts a `source` param (or returns
`channel` and the frontend filters client-side — TBD by list size; the endpoint
already returns channel, so client-side filtering is simplest and needs no API
change). All data stays; nothing is deleted; inquiry logging is untouched.

## Part 3 — Chat: Internal (the build)

### Frontend
New page `/chatbot/internal` — a chat UI (reuse the `/chatbot/test` chat
component shell: message list + composer + session id + "New conversation"). Its
own heading "Chat: Internal" and subtitle "Query your Tenafy data — leases,
invoices, vacancy, and ad-hoc questions." Gated on `CHAT_SETTINGS_VIEW`.

### Backend
`POST /api/chat/internal/message` (authenticated, `req.user.orgId`,
`req.pool` = the caller's org DB). Separate from `/api/chat/message`:

- **Hardcoded internal system prompt** — ops persona: answer staff data questions
  directly and completely; no sales tone; no qualify/move-in/budget gate; be
  precise with numbers; when unsure, say so; never fabricate rows.
- **Fixed internal toolset** (assembled in code, never merged into the prospect
  toolset):
  - Existing internal tools, reused as-is: `search_leases`, `search_invoices`,
    `search_services`, `search_documents`, `search_inquiries`.
  - **NEW `search_vacancies`** — vacant-now + upcoming, built on `unitSearch.js`'s
    existing forward-gap logic but WITHOUT the prospect qualify-gate. Params:
    `as_of` date, `horizon_days`, and `min_gap_days` ("no new tenant moving in
    within N days of the last tenant"). Returns unit + property + the current/next
    lease dates and the gap.
  - **NEW `ask_data`** — NL→SQL (see Part 4).
- Reuses `llmClient` (GLM/Kimi router) and the same tool-loop shape as
  `/api/chat/message` (`CHAT_MAX_TOOL_ITERATIONS`), just with the internal prompt
  + toolset. Extract the shared loop so both endpoints use it (avoid a copy).
- Sessions logged as channel **`staff-internal`**, `channel_user_id =
  staff-{userId}-{timestamp}` — so they appear under Sessions History → Tenafy.

## Part 4 — `ask_data` NL→SQL safety (defense in depth)

**Layer 1 — DB (physical):** a dedicated read-only MySQL user `tenafy_ro` with
`GRANT SELECT` only on the org DB(s). A separate **read-only pool** resolves the
caller's org DB with `tenafy_ro` creds (mirror `poolRegistry`, RO variant; env
`DB_RO_USER` / `DB_RO_PASSWORD`). Any write physically fails at the DB.
*One-time prod grant — provide SQL, get explicit go before running on prod.*

**Layer 2 — app (`askDataService.js`):** validate the model-generated SQL before
executing:
- must parse as a **single statement** that starts with `SELECT` (reject `;`
  chaining, CTEs that hide writes, etc.),
- reject any DDL/DML keyword (`INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|
  CREATE|GRANT|REPLACE|MERGE|CALL|SET|LOCK|...`),
- force-inject `LIMIT 500` when absent (cap result size),
- run on the **read-only pool for the caller's org DB** (org isolation comes free
  — the pool is that org's DB).
- return rows (capped) + the SQL used, so the model can summarize and staff can
  see what ran.

The `ask_data` tool takes a `sql` arg the model writes (its system prompt carries
a **schema summary** — table/column list of the queryable tables). We validate +
execute; the model then summarizes the rows in its next turn.

## Phasing (each independently shippable)

1. **Phase 1 — Rename + Sessions filter.** Cosmetic + small; low risk. Ship first.
2. **Phase 2 — Chat: Internal with structured tools + `search_vacancies`.**
   Answers the vacancy asks; no raw SQL yet.
3. **Phase 3 — `ask_data` NL→SQL + read-only DB user.** The powerful, riskier bit.

## Files (rough)

**Backend**
- `routes/chat.js` (or new `routes/chatInternal.js`): `/internal/message` + shared
  tool-loop extraction; `/sessions` unchanged (returns channel).
- `services/chatTools.js`: add `search_vacancies` + `ask_data` definitions/
  executors (internal-only; NOT in the prospect toolset). Internal system prompt.
- `services/askDataService.js` (new): SQL guard + RO execution.
- `services/unitSearch.js`: internal vacancy entry point (ungated) if needed.
- `config/index.js` + a RO pool (poolRegistry RO variant): `DB_RO_*`.
- Migration/seed: none for permissions (reusing CHAT_SETTINGS_VIEW). Prod: create
  `tenafy_ro` user (documented, run manually with consent).

**Frontend**
- `app/chatbot/internal/page.js` (new).
- `app/chatbot/test/page.js`: relabel to "Chat: Bookings".
- `app/chatbot/sessions/page.js`: TaneChat/Tenafy segmented filter.
- `components/Layout.jsx`: nav rename + new Chat: Internal item (gated).
- `lib/api.js`: `chatApi.internalMessage`.

## Verification

- Existing internal tools already work — reused unchanged.
- `search_vacancies`: verify against the org DB (matches the "no one moving in
  within N days" semantics; cross-check a known unit like the Jardine 2B case).
- `ask_data`: unit tests for the SQL guard (reject write/DDL, force LIMIT, single
  statement, reject `;`); confirm the RO user rejects a write at the DB level.
- **PII boundary:** prove the prospect path (`/api/chat/message` + `bot_settings`)
  can't reach `search_leases`/`search_invoices`/`ask_data` — the internal toolset
  is assembled separately and never merged.
- Frontend `npm run build` passes; all chatbot routes 200.
- Verified by review + build, not browser (per standing preference).

## Non-goals / risks

- No per-org internal-bot settings UI (hardcoded config by design).
- `ask_data` schema summary must be curated (don't expose sensitive columns like
  password hashes); start with a safe allowlist of tables/columns.
- Route for Bookings stays `/chatbot/test` (rename is label-only) to avoid broken
  links; can rename the route later if desired.
