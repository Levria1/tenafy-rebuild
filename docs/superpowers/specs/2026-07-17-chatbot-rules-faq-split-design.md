# Chatbot Settings — split into Settings / Rules / FAQ + visibility filter

**Date:** 2026-07-17
**Status:** Approved

## Problem

`/chatbot/settings` is one 563-line page doing three unrelated jobs: bot configuration
(master switch, capabilities, guardrails), the **Rules** rulebook, and the **FAQ** list.
Managing the rulebook means scrolling past the config form every time.

Separately, there is no way to answer "**which entries are actually public?**" without
eyeballing the Public/Internal switch on every row. Since `visibility='public'` is the
prospect-facing boundary (public entries are served to TaneChat/WhatsApp via
`GET /api/public/chat/knowledge`), that list is exactly the thing worth auditing.

## Scope

Frontend only. **No backend, API, or DB changes** — `/api/chat/knowledge` already returns
every entry with `kind` and `visibility`, and `/api/chat/settings` already returns
`settings_locked`.

Explicit non-goals:
- No change to the public/internal boundary or its semantics.
- No new permissions or migrations.
- No mobile card variant (the current settings page has none; keeping parity).

## Design

### 1. Extract the shared component

The Rules/FAQ UI is already a self-contained `KnowledgeCard` parameterised by `kind`.
Move it, plus the `useKnowledge` hook and the `parseFaqText` bulk-import parser, out of
`app/chatbot/settings/page.js` into:

    frontend/src/components/chatbot/KnowledgeCard.jsx

(matches the existing `components/mobile/` convention). Behaviour is unchanged: same
table, add/edit modal, bulk import, and Public/Internal switch.

This drops `settings/page.js` from ~563 to ~190 lines.

### 2. Three pages

| Route | Contains |
|---|---|
| `/chatbot/settings` | Master switch, capabilities, guardrails **only** (Divider + both cards removed) |
| `/chatbot/rules` *(new)* | `<KnowledgeCard kind="rule" />` |
| `/chatbot/faq` *(new)* | `<KnowledgeCard kind="faq" />` |

The two new pages are thin: fetch `settings_locked` via `chatApi.getSettings()` (needed to
disable editing when the platform operator has locked settings), then render the card.
Each keeps its own heading + Refresh button, consistent with the current page.

### 3. Navigation (`components/Layout.jsx`)

Replace the single `Settings` child with three siblings, all gated on the **existing**
`CHAT_SETTINGS_VIEW` permission:

```
Chatbot ▾
 ├── Sessions          [CHAT_SESSION_LIST]
 ├── Assistant         [CHAT_SESSION_LIST]
 ├── Chatbot Settings  [CHAT_SETTINGS_VIEW]   → /chatbot/settings
 ├── Rules             [CHAT_SETTINGS_VIEW]   → /chatbot/rules
 └── FAQ               [CHAT_SETTINGS_VIEW]   → /chatbot/faq
```

Flat siblings (not a nested sub-dropdown): one click each, and the sidebar collapses to
80px where deep nesting becomes a fiddly flyout.

### 4. Filter + search (inside `KnowledgeCard`, so both pages inherit it)

- **Segmented control:** `All (n) | Public (n) | Internal (n)`. Counts are derived from
  that page's entries, so they reflect Rules-only or FAQ-only totals.
- **Search box:** case-insensitive substring across `title` + `body` combined — works for
  rules too, which have no title.
- Both filters are **client-side** (data is already loaded — instant, no extra requests).
- Filters **combine** (e.g. Public + "pets"). State is local, defaults to `All`, resets on
  reload.
- **Empty states must differ:**
  - filtering, no matches → "No FAQs match this filter"
  - genuinely empty → existing "No FAQs yet — click Add FAQ or Bulk Import to start."

  Otherwise a filter that hides everything reads as data loss.

## Verification

Frontend-only, so:
- `npm run build` passes in `frontend/`.
- Code review: each route renders, filter/search logic correct, `locked` still disables
  editing on all three pages, counts match the unfiltered per-kind set.

Verified by review + build, not by driving a browser (per standing user preference).

## Risks

- **Bookmarks/links to `/chatbot/settings`** still work — the route is kept, only its
  Rules/FAQ sections move out.
- `KnowledgeCard` is imported by two pages; a regression there hits both. Mitigated by it
  being a pure move with filter added on top, and by the build + review gate.
