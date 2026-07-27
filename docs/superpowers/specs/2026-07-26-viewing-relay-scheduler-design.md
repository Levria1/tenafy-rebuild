# Viewing Relay Scheduler — Design

**Date:** 2026-07-26
**Status:** approved (design), building
**Supersedes (for new bookings):** the link-based "prospect picks 3, tenant taps" invite flow
(`docs/viewing-scheduler-plan.md`). The old invite/candidate machinery is **reused** for the
final confirmed appointment; only the *front half* (how a time is agreed) changes.

## 1. Summary

Staff press **"Schedule Viewing"** in TaneChat while chatting with a prospect. Tenafy then runs a
**conversational relay**: it asks the prospect for a day, checks the responsible staffer's Google
calendar, asks the current tenant (via WhatsApp) whether that time works, and shuttles counter-offers
between the two sides until they agree — then blocks the calendar and confirms all three parties using
the existing confirmation path. One unit, one prospect, one proposed time at a time.

**Ownership:** Tenafy owns the state machine, calendar checks, templates, and **all outbound sending**
(via the existing `sendWhatsApp` gateway, to either prospect or tenant phone). TaneChat is a thin relay:
it triggers `start` and forwards each *parsed inbound reply* (structured intent) back to Tenafy. All
conversation wording lives in editable templates with built-in fallbacks.

## 2. State machine (`viewing_negotiation.state`)

```
ASK_PROSPECT_DAY   staff pressed button → ask prospect "which day/time?"          awaiting=prospect
      │  prospect gives {date,time}
      ▼
CHECK_STAFF        resolve staff-of-day (property × weekday) → getFreeBusy
      │  busy  → send prospect "that slot's taken, another time?"  → stay ASK_PROSPECT_DAY
      │  no roster/host → NEEDS_STAFF
      │  free  → send prospect "let me check with the occupant…"
      ▼
AWAIT_TENANT       send tenant "can a viewing happen <time>?"                      awaiting=tenant
      │  tenant {accepted:true}                    → CONFIRMED
      │  tenant {accepted:false, counter:{d,t}}    → RELAY_TO_PROSPECT (proposed_by=tenant, round++)
      │  tenant {accepted:false, no counter}       → ASK_TENANT_ALT
      ▼
ASK_TENANT_ALT     send tenant "which day/time works for you?"                     awaiting=tenant
      │  tenant {counter:{d,t}}                     → RELAY_TO_PROSPECT (round++)
      ▼
RELAY_TO_PROSPECT  send prospect "sorry <old> didn't work — would <new> work?"     awaiting=prospect
      │  prospect {accepted:true}   → CHECK_STAFF (re-verify staffer free for new time)
      │                                free → AWAIT_TENANT(confirm)   busy → tell prospect, ASK again
      │  prospect {accepted:false, counter} → AWAIT_TENANT (relay prospect's counter, round++)
      ▼
CONFIRMED          create/confirm viewing_booking + reuse sendViewingConfirmation  awaiting=NULL
NEEDS_STAFF        round_count >= max_rounds, or no roster/host, or a hard error    awaiting=staff
CANCELLED          staff cancel, or either side says "not interested"              awaiting=NULL
```

- `round_count` increments on every counter-offer hop. When it reaches `viewing_setting.max_rounds`
  (default 3) the machine goes to **NEEDS_STAFF** and notifies the team (in-app notification +
  dashboard flag). No infinite loops.
- **Vacant unit** (no current lease but an active host link): there is no tenant to ask, so `AWAIT_TENANT`
  is instead an **AWAIT host** — the resolved staffer both hosts and approves. `tenant_id` NULL,
  `awaiting='staff'` cosmetically.

## 3. Data model (per-org migrations 021–024)

**`viewing_negotiation`** (021) — the state row:
`id, unit_id, property_id, lease_id (NULL vacant), tenant_id (NULL vacant), inquiry_id,
prospect_name, prospect_phone, prospect_email, staff_employee_id (resolved for current proposed date),
state VARCHAR(32), current_proposed_datetime DATETIME NULL, proposed_by VARCHAR(16) (prospect|tenant),
round_count INT DEFAULT 0, awaiting VARCHAR(16), booking_id BIGINT NULL (FK viewing_booking on CONFIRMED),
created_at, updated_at, closed_at NULL`. Indexes on `(prospect_phone, state)` and `(state)`.

**`viewing_negotiation_event`** (022) — audit log **and** staff-approval queue:
`id, negotiation_id, direction (in|out), party (prospect|tenant|staff|system), to_phone,
template_type NULL, body TEXT, intent JSON NULL, status (draft|sent), created_at, sent_at NULL`.
Outbound in manual mode → `status='draft'`; auto mode → inserted already `sent` after the gateway send.

**`viewing_staff_roster`** (023) — property × weekday assignment:
`id, property_id, weekday TINYINT (0=Sun..6=Sat), employee_id, active TINYINT DEFAULT 1,
UNIQUE(property_id, weekday)`.

**`viewing_setting`** (024) — one row per org:
`org_id PK, relay_mode ENUM('manual','auto') DEFAULT 'manual', max_rounds INT DEFAULT 3,
viewing_days VARCHAR(20) DEFAULT '1,2,3,4,5,6' (0=Sun), viewing_start TIME DEFAULT '11:00:00',
viewing_end TIME DEFAULT '19:00:00', updated_at, created_at`. PUT is a partial upsert (advertising_setting pattern).

All migrations idempotent: `CREATE TABLE IF NOT EXISTS` + information_schema-guarded ALTERs.

## 4. Service — `services/viewingNegotiation.js`

Pure-ish state machine, unit-testable:
- `resolveStaffOfDay(pool, propertyId, whenDate)` → employee row (+ email, google_calendar_id) from
  `viewing_staff_roster` by weekday; NULL → caller routes to NEEDS_STAFF.
- `checkStaffFree(pool, {employeeId, unitId, when})` → reuse `findBlocking` from viewingBooking
  (host bookings + `getFreeBusy` + buffer). Returns `{free, reason}`.
- `startNegotiation(pool, orgId, {unit, lease, prospect})` → insert row (ASK_PROSPECT_DAY), return
  first outbound (`Viewing-Prospect-Day-Ask`).
- `applyProspectReply(pool, orgId, negId, intent)` and `applyTenantReply(...)` → advance the machine,
  return `{ negotiation, outbounds:[{party,to_phone,templateType,body}], done }`.
- `dispatchOutbounds(pool, orgId, neg, outbounds)` → for each: render template (fallback), then in
  **auto** mode `sendWhatsApp` + insert event `sent`; in **manual** mode insert event `draft` (no send).
- `approveDraft(pool, orgId, eventId)` → staff releases a draft: `sendWhatsApp` + mark `sent`.
- `confirmNegotiation(pool, orgId, neg, when)` → build a single-candidate confirmed booking and call the
  **existing** `sendViewingConfirmation` (calendar block + `.ics` + 3-party emails). Sets
  `booking_id`, state CONFIRMED.
- `escalate(pool, orgId, neg, reason)` → NEEDS_STAFF + in-app notification to the org's viewing staff.
- Pure helpers exported for tests: `nextState(current, party, intent, roundCount, maxRounds)` and
  `withinWindow(when, setting)`.

## 5. Endpoints

**TaneChat contract (public, API-key, `/api/public`):**
- `POST /viewing-negotiation/start` `{unit_id, prospect:{name,phone,email}}` → resolves marketed unit,
  creates negotiation, dispatches first outbound. → `{negotiation_id, state, message?}` (`message` only
  when auto mode returns the text for logging; sending is done by Tenafy either way).
- `POST /viewing-negotiation/:id/prospect-reply` `{intent}` — `intent = {date, time}` or
  `{accepted:bool, counter:{date,time}}` or `{cancel:true}`.
- `POST /viewing-negotiation/:id/tenant-reply` `{intent}` — same intent shape.
- `GET /viewing-negotiation/active?phone=` → `{negotiation_id, party, state, awaiting}` or `{active:false}`
  — routing helper so TaneChat can tag an inbound WhatsApp message to the right negotiation/party.

**Staff (authed, `/api/viewing`, permission `LEASING_LIST`):**
- `GET /negotiations` (filters: state, awaiting, q) · `GET /negotiations/:id` (+ event log)
- `POST /negotiations/:id/approve` `{event_id}` (manual-mode send) ·
  `POST /negotiations/:id/message` `{party, text}` (staff takeover / free message) ·
  `POST /negotiations/:id/cancel`
- Roster: `GET /roster`, `PUT /roster` (`[{property_id, weekday, employee_id}]`, rebuild)
- Settings: `GET /settings`, `PUT /settings` (partial upsert)

## 6. Templates (register in emailService `TEMPLATE_TYPES`; all have built-in fallbacks)

Reuse existing `Viewing-Tenant-Confirm` / confirmation types where possible. New relay types:
- `Viewing-Prospect-Day-Ask` — "Which day and time would you like to view %Unit Name%?"
- `Viewing-Slot-Taken` — "Sorry, %Proposed Time% is taken. Could you suggest another time?"
- `Viewing-Tenant-Ask` — to tenant: "A prospect would like to view %Unit Name% at %Proposed Time%. Does that work?"
- `Viewing-Tenant-Alt-Ask` — to tenant: "Got it. May I ask which day and time works for you?"
- `Viewing-Relay-Prospect` — to prospect: "Sorry, %Old Time% doesn't work. Would %Proposed Time% work instead?"
- `Viewing-Checking` — to prospect: "Let me check on that for you and confirm the viewing that day."

Template variables: `%Unit Name% %Property Name% %Property Address% %Proposed Time% %Old Time%
%Prospect Name%`.

## 7. Frontend

- **Settings → Viewing Scheduler** (new tab/section): relay-mode toggle (Manual approval ↔ Auto),
  max-rounds number, viewing days/hours; **Staff Roster** grid (rows = properties, cols = Mon–Sun,
  cell = employee select).
- **Advertising/Viewings dashboard** — new **"Negotiations"** list: prospect, unit, state chip,
  "waiting on" tag, round count, last message; drawer shows the event log and, in manual mode,
  **Approve & Send** buttons on draft outbounds, plus a staff **Send message** box and **Cancel**.

## 8. Testing

- Unit tests (`backend/test/viewingNegotiation.test.js`) on the pure helpers: `nextState` transitions
  (accept → CONFIRMED; counter → relay + round++; N rounds → NEEDS_STAFF; cancel), `withinWindow`,
  and `resolveStaffOfDay` weekday mapping (with a stubbed pool).
- Manual/live smoke after deploy (documented in the TaneChat handoff): start → prospect day →
  tenant no+counter → prospect yes → CONFIRMED, in both manual and auto modes.

## 9. Non-goals (this iteration)

Multi-unit batch in one negotiation (bot loops per unit, as today); prospect/tenant identity de-dupe;
WhatsApp quick-reply buttons (free-text + TaneChat parsing only); auto-flip manual→auto (manual is the
default, staff flip the setting when confident).

**Known limitation (pre-existing, systemic):** viewing times are handled as naive wall-clock strings
(no property timezone), matching the rest of the viewing subsystem. Prod runs UTC and the business is
single-region (HK), so the "in the past" guard in `withinWindow` can under-detect same-day near-now
times by the server↔local offset. Fixing this properly needs an app-wide property-timezone concept and
is out of scope for this feature.

## Review notes (2026-07-26)

Reviewed by **Codex** (2 rounds) and **Kimi K3** (1 round; a final confirmation pass was blocked by
Kimi API network timeouts, so Codex ran the confirmation instead). 14 findings fixed: atomic confirm +
approveDraft claims (no double-booking / double-send), tenant-counter staff-validation before relay,
locked-staffer confirm re-check, wall-clock datetime formatting (no `toISOString` TZ shift), buffer
default, overlap query widening, `/active` awaiting-priority routing, start dedupe, tenant-no-phone
escalation, outside-hours message, failed-auto-send → retryable draft, optimistic-locked final persist,
partial-confirm compensation, and a stale-negotiation reaper (hourly cron).

## 10. Reuse map

`findBlocking`/`getFreeBusy` (calendar), `createCandidateBooking`-style confirmed row + `viewing_candidate`,
`sendViewingConfirmation`/`sendViewingMail` (confirmation + `.ics`), `sendWhatsApp` (gateway),
`loadTemplate`/`substituteVariables`/`stripToText` (templates), the viewing token registry, the staff
bookings dashboard, and the hourly auto-decline cron (extended to time-out stale negotiations → NEEDS_STAFF).
