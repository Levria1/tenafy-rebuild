# In-Relay Unit Resolution + Reconfirmation

**Date:** 2026-08-01
**Status:** Approved (architecture + disambiguation policy locked with user)
**Related:** `2026-07-26-viewing-relay-scheduler-design.md`, `2026-07-31-viewing-window-gate-design.md`

## Problem

TaneChat resolves a prospect's free-text ("mongkok 6a", "mk 6a", "mongkok") to a
unit_id by matching against Tenafy's flat unit list itself, and fails hard —
*"Couldn't identify the unit"* — with no "did you mean?" and no reconfirmation. A
unit named `6A Test` won't match "6a"; a bare "mongkok" can't pick a unit. The user
wants (a) robust, consistent matching that Tenafy owns and can test, and (b) the
system to **always reconfirm** the unit before starting a viewing. **Units must NOT
be renamed** — the resolver handles messy names.

## Locked decisions

- **Resolution + reconfirmation live INSIDE the relay** (Tenafy-owned). TaneChat
  passes raw text; Tenafy resolves and, if it isn't a confident single match, the
  first relay messages reconfirm / disambiguate before the day-ask. Keeps TaneChat a
  thin relay (the original principle).
- **Ambiguity lists MARKETABLE units only** (would pass `resolveMarketedUnit`:
  current lease `viewing_enabled=1`, or vacant with an active host link).

## Flow

```
/start {unit_text}                      (unit_id path still supported, unchanged)
  → resolver:
    one confident full match  → CONFIRM_UNIT  "Confirm — Mong Kok 6A? Reply YES"
        YES        → pin unit → gate → ASK_PROSPECT_DAY | off-window hold | not-open
        other text → re-resolve
        no/cancel  → re-ask / cancel
    2+ candidates / property-only → RESOLVE_UNIT  "Which one? 1) Mong Kok 6A  2) …"
        pick (index or name) → pin unit (an explicit pick IS the confirmation) → gate
        other text           → re-resolve
    nothing → RESOLVE_UNIT  "I couldn't find that — which property and unit?"
```
A **single** match always gets the YES reconfirm (user requirement). An **explicit
pick** from a listed choice is itself the confirmation → straight to the gate (no
double-confirm). Everything after the unit is pinned is unchanged.

## Design

### 1. Schema — migration 028 (per-org, idempotent)
- `viewing_negotiation.unit_id`, `.property_id` → **NULLABLE** (unknown during resolution).
- `+ pending_unit_text  VARCHAR(255) NULL` — the text being resolved / last confirmed target.
- `+ pending_unit_id    BIGINT NULL`       — the single match awaiting a YES (CONFIRM_UNIT).
- `+ unit_candidates    TEXT NULL`         — JSON `[{unit_id,label}]` offered in RESOLVE_UNIT (maps a "1"/name pick back to an id).
- New `state` values `RESOLVE_UNIT` / `CONFIRM_UNIT` need no DDL (state is VARCHAR).

### 2. Resolver — `services/unitResolver.js`
`resolveUnit(pool, orgId, text)` → `{ status, match?, candidates[], propertyMatches[] }`,
`status ∈ confident | ambiguous | property_only | none`.
- One query loads all active units for the org + per-unit **marketable** flag
  (current-lease `viewing_enabled`, or vacant + active host link).
- Pure `scoreUnits(text, units, aliasIndex)` (unit-tested):
  - `norm` (lowercase, non-alphanumerics→space, collapse) and `squish` (spaces removed).
  - **Auto aliases**: each property's initials (e.g. "Mong Kok"→"mk") + squished name.
  - Property hit: `squish(query)` contains `squish(propertyName)` or an alias token; light
    fuzzy (edit-distance ≤1 on the property squish) tolerates "mongok"/"mongko".
  - Unit hit: a query token equals the unit's **core token** (first token of the name,
    so `6A Test`→`6a`), or prefix-matches it.
  - **full match** = property hit AND unit hit; rank by score.
  - `confident` = exactly one full match; `ambiguous` = >1 full match (or a unit token
    matching across properties); `property_only` = property hit, no unit token;
    `none` = nothing.
- Candidate lists filter to **marketable** units (fall back to all active only if none
  marketable, so the prospect still gets options).

### 3. State machine — `viewingNegotiationLogic.nextStep`
New pure transitions (orchestrator does the DB-backed resolving; nextStep only
interprets the reply intent, mirroring the `staff_check` pattern):
- `CONFIRM_UNIT` (prospect): `accepted:true`→`{type:'unit_confirmed'}`;
  `unit_text`→`{type:'resolve_unit',text}`; `cancel`→`{type:'cancel'}`;
  `accepted:false`→`{type:'reask_unit'}`; else `ignore`.
- `RESOLVE_UNIT` (prospect): `index`/`choice`→`{type:'unit_picked',…}`;
  `unit_text`→`{type:'resolve_unit',text}`; `cancel`→`{type:'cancel'}`; else `ignore`.

### 4. Orchestration — `services/viewingNegotiation.js`
- Extract the current inline window/marketable gate into a reusable
  `gateAndProceed(pool, orgId, neg, unit, lease, setting)` used by BOTH the direct
  `unit_id` path and the post-resolution path. Outcomes unchanged: in-window →
  `ASK_PROSPECT_DAY`; off-window → `NEEDS_STAFF off_window` hold; not-marketable →
  inform the prospect + `NEEDS_STAFF` (reason `not_marketing`) so staff see the lead.
- `startNegotiation` accepts `{ unitText }`: run resolver, create the row with the
  resolved state (`CONFIRM_UNIT`/`RESOLVE_UNIT`), store `pending_unit_text` /
  `pending_unit_id` / `unit_candidates`, send the first message. Dedupe an open
  resolving negotiation for the same `prospect_phone`.
- New handleReply handling: `resolve_unit` (re-run resolver, update state/candidates/
  message), `unit_picked`/`unit_confirmed` (load unit+lease+tenant, set the real
  unit_id/property_id, clear pending_*, then `gateAndProceed`), `reask_unit`, `cancel`.

### 5. Templates + FALLBACKS
- `Viewing-Confirm-Unit`  — "Just to confirm — you'd like to view %Unit Full Name%? Reply YES, or tell me the correct unit."
- `Viewing-Choose-Unit`   — "Which unit would you like to view?\n%Unit Options%"
- `Viewing-Unit-NotFound` — "I couldn't find that unit. Which property and unit would you like to view?"
Vars: `%Unit Full Name%` = "Property Unit" (e.g. "Mong Kok 6A"), `%Unit Options%`, `%Property Name%`.

### 6. Endpoints — `routes/public.js`
- `/viewing-negotiation/start` accepts `unit_text` (string) OR `unit_id`. `unit_id` →
  unchanged path. Neither → 400.
- `/:id/prospect-reply` unchanged endpoint; the resolve-phase intents (`accepted`,
  `unit_text`, `index`/`choice`, `cancel`) route through `handleReply` by state.

### 7. Frontend — dashboard
- Add `RESOLVE_UNIT` / `CONFIRM_UNIT` to the state-tag + awaiting maps; show
  `pending_unit_text` on the row so staff see what's being resolved. No new controls.

### 8. TaneChat contract (needs their team)
- `/start` accepts `unit_text`. During `RESOLVE_UNIT`/`CONFIRM_UNIT` TaneChat forwards
  the prospect reply as it already does, parsed to an intent: a YES → `{accepted:true}`,
  a numbered/label pick → `{index:1}` or `{choice:"6A"}`, a fresh name → `{unit_text:"…"}`,
  cancel → `{cancel:true}`. Documented in `docs/tanechat-viewing-handoff.md`.

### 9. Tests
- `scoreUnits`: `6A Test`↔"6a"; alias "mk 6a"; case/space ("MongKok 6A"); property-only
  "mongkok"; two `6A` across properties → ambiguous; junk → none; light typo "mongok 6a".
- `nextStep`: CONFIRM_UNIT (yes/text/no/cancel), RESOLVE_UNIT (pick/text/cancel).

## Non-goals (YAGNI)
- Manual per-property alias editor (auto initials + normalization for v1).
- Cross-property "unit-only" auto-pick (stays ambiguous → ask which property).
- Fuzzy beyond edit-distance ≤1 on the property (reconfirm loop covers the rest).

## Rollout
Migration 028, backend, frontend rebuild. Behind manual `relay_mode`. Kimi review
before deploy. Ask before push/deploy.
