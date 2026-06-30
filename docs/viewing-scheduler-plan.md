# Viewing Scheduler — Build Plan

Consolidated plan for the prospect-led viewing booking flow with staff-availability
checking (Google), tenant click-to-confirm, WhatsApp automation, and change handling.
Written 2026-06-26. Decisions below are locked unless noted.

---

## 1. Goal & guiding principles

Let a prospect request a viewing, automatically check that staff (CL / Dennis) are
free, get the current tenant to confirm a time, and notify everyone — with no bot
*conversation* on the tenant side and no permanent public links.

Principles:
- **Prospect-led**: prospect proposes time(s) → staff availability is checked → tenant confirms. (No collecting tenant "windows" up front.)
- **Deterministic confirms**: tenant/prospect/staff actions are **link clicks**, not LLM-parsed free text. The bot never converses with the tenant; all workflow messages are templated notifications.
- **No permanent shared links**: prospect links are **per-prospect, prefilled, short-lived**, and only live while the unit is being marketed.
- **Any time change ⇒ re-confirm. Any cancel ⇒ notify the other two + free the slot.**
- **Reuse what exists**: three-party booking, action tokens, `.ics`, Google push, WhatsApp transport, bookings dashboard, 24h auto-decline.

---

## 2. End-to-end flow (happy path)

1. **Open the unit for viewings** — staff set Tenant Status = **NR** on the lease and tick **"Request viewings"**. The tenant gets a templated courtesy heads-up ("we'll be arranging viewings during your remaining stay"). *(Phase 0 — already built.)*
2. **Prospect asks** in TaneChat/WhatsApp: "Can I view Mong Kok 1A on Thursday?"
3. **TaneChat** detects intent + resolves the unit, then calls Tenafy `POST /api/public/viewing-link` with the unit + prospect (phone/name) + desired day.
4. **Tenafy** checks the unit is open for viewings, computes valid slots that day (within the X–Y rule, **staff-free via Google free/busy**, minus existing bookings + buffer), mints a **per-prospect, prefilled, expiring link**, returns it.
5. **TaneChat replies** to the prospect with the link.
6. **Prospect** opens it (no login), the date is prefilled; they pick **up to 3 candidate times** that work for them, enter/confirm name+phone, submit. Candidates are **soft-held** (tentative).
7. **Tenant** gets one templated WhatsApp: *"[Prospect] would like to view [unit] — which works for you?"* with a tap per candidate.
8. **Tenant taps one** → that slot is **Confirmed**, other candidates released. Auto-messages fire:
   - tenant: "thank you for confirming"
   - prospect: confirmation (date/time/place)
   - staff: notification
   - + Google Calendar event on the assigned staffer's calendar + `.ics` to all.
9. Tenant taps **none** before expiry → prospect gets a link to re-pick.

---

## 3. Architecture — who does what

| Layer | Responsibility |
|---|---|
| **TaneChat (bot)** | Prospect-facing conversation only: detect viewing intent, resolve the unit, call the `viewing-link` API, reply with the link. |
| **TaneChat (gateway)** | Delivers Tenafy's templated WhatsApp messages (tenant prompt, all confirmations) via `/api/integration/send`. |
| **Tenafy** | Everything else: state-gating, slot computation (incl. Google free/busy), per-prospect links, candidates + soft-hold, status machine, change handling, **sending** all workflow messages via the WhatsApp transport, calendar push, dashboard. |

Note: workflow messages (tenant prompt, confirmations, staff notify) are **Tenafy-sent** through the gateway — TaneChat's bot only handles the prospect conversation. Minimizes TaneChat build.

---

## 4. Data model

Already exists: `viewing_link`, `viewing_booking` (viewer info, `tenant_decision`, `employee_decision`, `status`, `ics_uid`, `gcal_event_id`, `viewer_contact_id`, `source`, `employee_id`, `unit_id`), master `viewing_link_registry`. *(Verify exact columns at build.)*

New:
- `leasing.viewing_enabled`, `leasing.viewing_requested_at` — *(Phase 0, built.)*
- **`viewing_invite`** — per-prospect prefilled link: `token, unit_id, prospect_name, prospect_phone, prospect_email, prefill_date, expires_at, status (active|used|expired)`. Registered in `viewing_link_registry` for org resolution.
- **`viewing_candidate`** — the proposed times for one request: `id, booking_id, proposed_datetime, confirm_token, status (tentative|picked|released)`. Tenant taps a candidate's `confirm_token`.
- On `viewing_booking`: a clear **status** (see §6) + `awaiting` ('prospect' | 'tenant' | null) for the dashboard, and `superseded_by` (links a rescheduled request to its replacement).

---

## 5. API endpoints

**Public (API-key, TaneChat):**
- `POST /api/public/viewing-link` — `{ unit_id|property+unit, prospect:{name,phone,email}, desired_date }` → `{ available, url, expires_at }` or `{ available:false, reason }`. State-gated + staff-free aware.

**Public (token-resolved, no login — prospect/tenant facing):**
- `GET  /api/viewing-public/invite/:token` — resolve a prefilled invite (date prefilled, valid slots that day).
- `POST /api/viewing-public/invite/:token/submit` — prospect submits up to 3 candidates → creates the request, soft-holds candidates, triggers tenant prompt.
- `POST /api/viewing-public/candidate/:confirm_token/pick` — tenant picks a candidate → confirm + fire all messages + calendar.
- `POST /api/viewing-public/manage/:token/cancel` — prospect self-cancel.

**Staff (JWT):**
- `GET  /api/viewing/bookings` — extend existing list with the new statuses + tenant/prospect filters.
- `POST /api/viewing/bookings/:id/reschedule` — staff cancel + issue new link (emergency).
- `POST /api/viewing/bookings/:id/cancel` — staff cancel.

---

## 6. Status machine + change handling

States: `awaiting_prospect` → `awaiting_tenant` → `confirmed` → (`cancelled` | `expired` | `declined` | `rescheduled`).

| Who | Action | System |
|---|---|---|
| Prospect | submit candidates | `awaiting_tenant`; soft-hold candidates; prompt tenant |
| Prospect | new time before confirm | supersede old; void tenant prompt; re-prompt |
| Prospect | cancel | `cancelled`; notify tenant + staff; release holds |
| Prospect | reschedule after confirmed | cancel confirmed (notify tenant+staff); new prefilled link → fresh cycle |
| Tenant | pick a candidate | `confirmed`; release others; thank-you + prospect confirmation + staff notify + calendar block + `.ics` |
| Tenant | none picked / expires | `declined`/`expired`; prospect gets re-pick link; notify staff |
| Staff | emergency reschedule (dashboard) | cancel (notify prospect+tenant "sorry, please rebook") → offer next slots |

Rules: any **date/time change ⇒ tenant re-confirms** (cancel + new request, never in-place edit). Pending requests **auto-expire** (reuse the 24h auto-decline cron). **Idempotency**: tapping a confirm link on a cancelled/expired request → "no longer valid."

Staff emergency: v1 = staff cancel/reschedule from the dashboard (deterministic). Later = a poller reading Google free/busy that flags confirmed viewings now clashing.

---

## 7. Staff availability (Google free/busy)

CL & Dennis keep availability in Google Calendar (confirmed). Build:
- `getFreeBusy({ calendarId, timeMin, timeMax })` in `services/googleCalendar.js` (scope already `calendar`).
- Fold into slot computation: a time is offerable only if the **assigned employee** is free in Google **and** has no conflicting Tenafy booking (+ buffer).
- **Graceful no-op**: if the employee has no `google_calendar_id`, fall back to today's Tenafy-only check.

**Config prerequisite (one-time, per staffer):** only `alextn@gmail.com` is linked today. For CL & Dennis: share their Google Calendar with the service-account email + set `user.google_calendar_id` via `scripts/setUserCalendar.js`.

---

## 8. Messaging (editable templates, WhatsApp + email)

All workflow messages are **editable templates** (Settings → Email/WhatsApp Templates) with built-in fallbacks. New types:
- `Viewing-Availability-Request` *(Phase 0, built — reframed as the courtesy heads-up)*
- `Viewing-Tenant-Confirm` — the multi-time "which works for you?" prompt to the tenant
- `Viewing-Confirmed-Tenant`, `Viewing-Confirmed-Prospect`, `Viewing-Confirmed-Staff`
- `Viewing-Cancelled` / `Viewing-Reschedule` (reuse existing viewing templates where possible)

Transport: Tenafy → `sendTemplateWhatsApp` / `sendWhatsApp` → TaneChat gateway (live). Email via existing template engine.

---

## 9. Dashboard (v1 = filterable list, no grid)

Extend the existing staff bookings dashboard:
- Columns: when, prospect (name/phone), unit/property, host, **status**, candidate times, age.
- Filters/grouping: by **status**, by **tenant**, by **prospect**, date range, search.
- Actions: view, cancel, reschedule (→ new link).
- Surfaces "who are we waiting on" (`awaiting_prospect` vs `awaiting_tenant`).

Calendar visual = **Google Calendar** (already gets confirmed viewings). No in-app grid; if ever wanted, a week time-grid — not a month grid (viewings are time-specific appointments).

---

## 10. Build order

- **Phase 0 — Open-for-viewings trigger** — NR checkbox + tenant heads-up. ✅ *built (pending deploy).*
- **Phase A — Staff availability** — `getFreeBusy` + fold into slot computation. Prereq: connect CL/Dennis calendars.
- **Phase B — Prospect link + prefilled multi-time booking** — `viewing-link` API (state-gated, per-prospect, prefilled, expiring) + `viewing_invite` + booking page with up to 3 candidates + soft-hold. + TaneChat handoff (prospect side).
  - *Slice 1 ✅ built:* `POST /api/public/viewing-link` + `viewing_invite` (migration 011).
  - *Slice 2 ✅ built (pending deploy):* `GET /api/viewing-public/invite/:token` (prefill + busy windows) + `POST /invite/:token/submit` (1–3 candidates → one pending `viewing_booking` + `viewing_candidate` rows (migration 012) + soft-hold + tenant prompt) + frontend `/book/viewing/invite/[token]`.
  - *Bot endpoints ✅ built (pending deploy):* `GET /api/public/viewing-prompt` (renders `Viewing-Prospect-Prompt` template for the unit, state-gated) + `POST /api/public/viewing-request` (TaneChat posts parsed times → validates → **creates the booking + asks the tenant immediately** (drops host-busy times) → returns `summary_text` + `review_url`). The prospect doesn't gate the flow; the review link lets them fix a mis-parse, which **supersedes** (cancels the pending booking, re-asks the tenant; rejected if the tenant already picked). `viewing_invite.prefill_times` (migration 013). Booking creation centralised in `services/viewingBooking.js` (`createCandidateBooking`) — shared by `/invite/submit` + `/viewing-request` + supersede. Handoff spec: `docs/tanechat-viewing-handoff.md`.
  - *Vacant units ✅ supported:* `resolveMarketedUnit` now also accepts a vacant unit (no current lease) that has an active **assigned host link** — no tenant to ask, so the host is prompted to pick instead (`has_tenant:false`). Multi-unit = the bot loops one `viewing-request` per unit (no batch endpoint, by design).
  - *Remaining:* TaneChat bot-side implementation (it owns intent + time parsing per the spec).
- **Phase C — Tenant confirm + auto-messages** — ✅ core built (pending deploy): `viewing_candidate` tap-to-confirm via `GET /confirm/:token` + `POST /confirm/:token/pick` (release others, confirm, gcal + `.ics` + confirmation emails) + frontend `/book/viewing/confirm/[token]`. Tenant prompt sent via email (`Viewing-Tenant-Confirm` template + fallback) **and WhatsApp** (plain-text with per-candidate links). *Remaining:* dedicated WhatsApp templates, prospect re-pick on full decline/expiry.
- **Phase D — Change handling + dashboard** — ✅ built (pending deploy):
  - Staff `PATCH /api/viewing/bookings/:id/cancel` (release candidates + drop gcal event + notify prospect & tenant via email/WhatsApp) and `POST /bookings/:id/reschedule` (cancel + `mintInvite` fresh prospect link + notify). Shared services `viewingNotify.sendViewingMail` + `viewingInvite.mintInvite` (also used by `public.js`).
  - `GET /bookings` returns `awaiting` + `source` + `candidate_times`, with `awaiting`/`source`/`q` filters.
  - Auto-expire: the hourly auto-decline cron now releases tentative candidates + clears `awaiting` on stale invite bookings (guarded for pre-012 org DBs).
  - Dashboard (`property/viewings/bookings`): "waiting on" tags, proposed-times count + list, source/awaiting filters, Reschedule action (modal shows the fresh link to copy).
  - *Remaining*: prospect auto re-pick message on cron expiry (cron releases holds but doesn't yet message the prospect); dedicated `Viewing-Reschedule` WhatsApp/email templates (fallbacks in place).

---

## 11. Prerequisites / config (not code)
- **WhatsApp number** paired in TaneChat (in progress — number change).
- **CL & Dennis Google calendars** connected (only `alextn` done).
- **Viewing time rule (X–Y)** — currently Mon–Sat 11:00–19:00; confirm before Phase B.

## 12. Reuse vs new
- **Reuse:** three-party booking + action tokens, `.ics`, Google push, WhatsApp transport, bookings dashboard, 24h auto-decline, lead capture, token→org registry.
- **New:** Google free/busy read, `viewing-link` API + `viewing_invite`, multi-candidate + soft-hold, the click-to-confirm-via-WhatsApp chain, status taxonomy + change handling, dashboard extensions.
