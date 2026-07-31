# Viewing Window Gate + Default-On Marketability

**Date:** 2026-07-31
**Status:** Approved (policy + knobs locked with user)
**Related:** `2026-07-26-viewing-relay-scheduler-design.md`, `project_viewing_relay` memory

## Problem

`leasing.viewing_enabled` conflates two separate concerns:
1. **Is the unit marketable?** — should be *yes* for essentially every unit.
2. **Should we disturb the *current tenant* right now?** — only when their departure is near.

Because the single flag defaults **off**, staff must tick "Request viewings" on every
lease (we just had to bulk-enable 112 leases by hand), and ticking it *immediately*
WhatsApps the tenant for availability — the opposite of "don't bother them yet."

## Policy (locked with user)

- **All new leases default to marketable** (`viewing_enabled = 1`). The toggle stays so a
  specific unit can be opted *out*.
- **The current tenant is only contacted when their lease ends within a lead window**, which
  is **per renewal status**:
  - **NR (Not Renewing, contract_type 3) → 60 days**
  - **MTM / MR / UC / unset (2,1,4,0) → 45 days**
- **Outside the window a prospect is never rejected.** The request is recorded as a
  `NEEDS_STAFF` negotiation with the reason ("tenant's lease ends 2026-12-01"), the prospect
  gets a soft *"let me check with our team"*, and staff can **Start viewing anyway** with one tap.
- **Vacant units** (no current lease) are always viewable — no tenant to bother (host-link path,
  unchanged).
- **Enabling a unit no longer pings the tenant.** The tenant is contacted only by the on-demand
  relay, and only inside the window.

## Design

### 1. Config — per-org `viewing_setting` (migration 027)
Add two columns (both editable in the Setup drawer):
- `lead_days_nr    INT NOT NULL DEFAULT 60`  — Not-Renewing window.
- `lead_days_other INT NOT NULL DEFAULT 45`  — every other status.

Same migration flips the column default so new leases are marketable by default:
- `ALTER TABLE leasing ALTER COLUMN viewing_enabled SET DEFAULT 1`
  (information_schema-guarded; existing rows already bulk-set to 1).

### 2. Pure window helper — `viewingNegotiationLogic.js`
```
viewingWindow({ endDate, contractType, leadDaysNr, leadDaysOther, today })
  -> { inWindow: boolean, leadDays: number, reason: 'ok'|'beyond_window'|'no_end_date' }
```
- `leadDays = Number(contractType) === 3 ? leadDaysNr : leadDaysOther`
- `endDate == null` → `inWindow:false, reason:'no_end_date'` (open-ended → staff decides).
- else `inWindow = endDate <= today + leadDays` (endDate is the active lease, so already ≥ today).
- `today` passed in (kept pure/testable; prod passes real today via a thin wrapper).

### 3. Gate in `startNegotiation` (viewingNegotiation.js)
- Extend `findActiveLeaseForUnit` (viewingBooking.js) to also return `contract_type`, `end_date`
  (additive — safe for its other callers).
- In `startNegotiation`, when a **current lease exists** and `viewingWindow(...).inWindow === false`:
  - INSERT the negotiation as `state='NEEDS_STAFF', awaiting='staff'`, store
    `needs_staff_reason` (new nullable col, migration 027) = e.g. `off_window`.
  - Log a `viewing_negotiation_event` describing the reason + lease end date + leadDays.
  - Send the prospect the soft `Viewing-Hold-OffWindow` template (fallback: *"Thanks! Let me
    check with our team and get back to you about a viewing."*).
  - `notifyStaff(...)`.
  - Return `{ available:true, negotiation_id, state:'NEEDS_STAFF', awaiting:'staff', off_window:true, ... }`.
- Vacant unit or in-window → the existing `ASK_PROSPECT_DAY` flow, unchanged.

### 4. Staff "Start viewing anyway" — `POST /api/viewing/negotiations/:id/proceed`
- Guard: `state='NEEDS_STAFF'`, `booking_id IS NULL`.
- Transition to `ASK_PROSPECT_DAY`, `awaiting='prospect'`, clear `needs_staff_reason`, and
  dispatch `Viewing-Prospect-Day-Ask` to the prospect (reuses `dispatchOutbounds`, honouring
  `relay_mode`). Optimistic-locked (`WHERE id=? AND state='NEEDS_STAFF'`).

### 5. Decouple the create/update tenant ping (leasing.js)
- New leases: persist `viewing_enabled` default-on unless the body explicitly opts out
  (`viewing_enabled === false/0`). Done via an explicit value so opt-out actually sticks
  (the current INSERT omits the column).
- **Remove the automatic `sendViewingAvailabilityRequest` call** from lease *create* (≈1103) and
  the `fireViewingRequest` path in *update* (≈1149). The function stays (old link flow / manual
  use); it is just no longer auto-fired. Enabling a unit no longer messages the tenant.

### 6. Settings route (viewing.js) + `getSetting`
- `getSetting` returns `lead_days_nr`, `lead_days_other` (defaults 60/45).
- PUT validates each as an integer 1–365.
- `DEFAULT_SETTING` in the logic file gains `lead_days_nr:60, lead_days_other:45`.

### 7. Frontend
- **Setup drawer** (`negotiations/page.js`): two number fields — "Lead time · Not Renewing (days)"
  and "Lead time · other statuses (days)".
- **Lease form**: the "Open for viewings" checkbox defaults **checked** (unchecking opts out).
- **Dashboard**: off-window `NEEDS_STAFF` rows show the reason + a **Start viewing anyway** button
  → `viewingApi.proceed(id)`.

### 8. Tests
- `viewingWindow`: NR in/at/beyond 60; other in/at/beyond 45; `no_end_date`; unset status → 45.
- `nextStep`/existing suite unchanged.

## Non-goals (YAGNI)
- Per-status windows beyond the NR-vs-rest split (two knobs cover the requirement).
- Auto-deriving `viewing_enabled` from status changes (staff still opt a unit *out* manually).
- Reworking the old link-based availability flow (only its auto-trigger is removed).

## Rollout
Per-org migration 027 (idempotent), backend, frontend rebuild. Behind existing manual
`relay_mode`, so nothing auto-sends regardless. Ask before deploy.
