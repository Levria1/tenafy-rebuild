# TaneChat ↔ Tenafy — Viewing Scheduler Handoff

How the TaneChat bot drives a prospect viewing through Tenafy's public API.
All endpoints are under `/api/public` and require the org's `X-API-Key` header
(the `pk_...` key from Tenafy master → API Keys).

**Division of labour:** TaneChat owns the prospect *conversation* (intent,
unit resolution, time parsing). Tenafy owns the *wording* (templates), the
*state-gating*, the *booking*, and *all* messaging to the tenant/host.

---

## Flow

```
1. Prospect: "Can I view Mong Kok 1A on Thursday?"
2. Bot resolves the unit_id (use GET /api/public/units search if needed).
3. Bot → GET  /api/public/viewing-prompt?unit_id=...        ── get the prompt
   Bot sends the returned `prompt` text verbatim to the prospect.
4. Prospect replies with free text ("Thu 3pm or Fri morning").
5. Bot PARSES that into ISO times → POST /api/public/viewing-request.
   Tenafy IMMEDIATELY creates the booking and asks the current tenant to pick
   a time. No wait on the prospect.
6. Bot sends the prospect `summary_text` + `review_url` so they can SEE what
   was sent and fix a mis-parse if needed:
   "Got these times, sent to the occupant:
    1. Thu Jul 3, 3:00 PM
    2. Fri Jul 4, 11:00 AM
    Need to change them? <review_url>"
7. Tenant taps a time → confirmed → prospect + host notified + calendar/.ics.
   If the prospect EDITS on review_url first, that supersedes: the old request
   is cancelled and the tenant is re-asked with the new times (rejected if the
   tenant already picked).
```

So the prospect doesn't gate the flow — the tenant is asked right away — but
the prospect still gets a review link as a safety net (editing re-asks the
tenant). Everything from the tenant's tap onward is Tenafy.

---

## Endpoints

### GET `/api/public/viewing-prompt?unit_id=<id>`
Returns the "please give 2–3 times" prompt for the unit. Wording comes from the
org's `Viewing-Prospect-Prompt` template (Tenafy → Settings → Email Templates),
with a built-in fallback. State-gated.

```json
200 { "code":200, "data": {
  "available": true,
  "prompt": "Hi! We'd be glad to arrange a viewing of 1A at Nam Pak Hong...",
  "unit": { "id":"...", "name":"1A", "property":"Nam Pak Hong" }
}}
200 { "code":200, "data": { "available": false, "reason": "not_marketing" } }
   reason ∈ { "not_marketing", "unit_not_found" }
```
If `available:false`, do NOT prompt — tell the prospect the unit isn't open for
viewings (or hand to a human).

### POST `/api/public/viewing-request`
Submit the parsed times. Tenafy validates them (Mon–Sat 11:00–19:00, future,
max 3, de-duped), **creates the booking and asks the tenant immediately**,
dropping any time the host is busy, and returns a review link for the prospect.

```json
// request
{ "unit_id": "8300...", 
  "prospect": { "name":"Jane Doe", "phone":"+85290000000", "email":"jane@x.com" },
  "candidates": ["2026-07-03T15:00", "2026-07-04T11:00"] }   // ISO, with or without seconds

// response
200 { "code":200, "data": {
  "available": true,
  "review_url": "https://platform.tenafy.com/book/viewing/invite/vbi_...",
  "token": "vbi_...",
  "expires_at": "2026-07-07T...",
  "booking_id": "...",
  "has_tenant": true,                                            // false → host was asked instead
  "candidates": [ { "label":"Thu, Jul 3, 3:00 PM" }, { "label":"Fri, Jul 4, 11:00 AM" } ],  // booked
  "summary_text": "1. Thu, Jul 3, 3:00 PM\n2. Fri, Jul 4, 11:00 AM",  // ready to paste into the message
  "dropped": [ "Sat, Jul 5, 2:00 PM" ],                         // host busy → not booked (if any)
  "invalid": [ { "value":"2026-07-06T10:00", "reason":"Viewings are not available on Sundays" } ]
}}
200 { "code":200, "data": { "available": false, "reason": "not_marketing" } }
   reason ∈ { "not_marketing", "unit_not_found", "no_host", "no_free_times" }
400 { "code":400, "message":"No valid times", "invalid":[ ... ] }   // none parseable/in-window
```
- Send `review_url` to the prospect, with `summary_text` above it so they see
  the parsed times **and** the link in one message, e.g.:
  > Here are your viewing times for 1A:
  > {summary_text}
  > Confirm or adjust here: {review_url}
- The invite expires in 7 days.
- If some times were dropped (`invalid` present) but others accepted, the link
  still works with the accepted ones — optionally tell the prospect which were
  dropped and why.
- The prospect can add/replace times on the review page, so a partial parse is
  recoverable.

### (existing) POST `/api/public/viewing-link`
The simpler path: mint a prefilled link from just a **desired date** (no parsed
times). Use this if the bot can't reliably parse times — the prospect picks from
scratch on the page.
```json
{ "unit_id":"...", "desired_date":"2026-07-03", "prospect":{...} }
→ { "available":true, "url":"...", "expires_at":"...", ... }
```

---

## Multiple units
There is no special multi-unit call — to request several units, the bot simply
makes **one `viewing-request` per unit**. Each unit is handled independently
(its own tenant/host is asked), so confirmed times may differ between units.

## Occupied vs vacant units
- **Occupied** (a current tenant): that tenant is asked to pick the time.
- **Vacant** (no current tenant, but staff have assigned a host link): there's
  no tenant, so the **host** is asked to pick — no tenant prompt. A unit only
  counts as "vacant-marketable" if it has an active assigned viewing link.
The bot doesn't need to know which case applies — `viewing-request` handles it;
`has_tenant` in the response tells you who was asked (true = tenant, false = host).

## Notes
- **Phone format:** pass E.164-ish (`+852...`); Tenafy normalises digits.
- **Idempotency:** each `viewing-request` mints a NEW invite. Don't retry on
  success. If the prospect changes their mind, just call it again — the latest
  link is the one to send.
- **Time zone:** times are treated as Hong Kong wall-clock. Send local times.
- **What Tenafy sends (not the bot):** the tenant "which time works?" prompt,
  all confirmations, cancellations, and reschedule links. The bot never messages
  the tenant.

---

## Relay Scheduler (2026-07-26) — the NEW conversational flow

Supersedes the link-based invite flow for staff-initiated viewings. Tenafy owns
the whole negotiation state machine + all outbound WhatsApp; the bot only (a)
triggers `start` when staff press "Schedule Viewing", and (b) forwards each
PARSED reply as a structured `intent`. See the design doc:
`docs/superpowers/specs/2026-07-26-viewing-relay-scheduler-design.md`.

**Endpoints (all `/api/public`, API-key):**
- `POST /viewing-negotiation/start` `{ unit_id, prospect:{name,phone,email} }`
  → `{ negotiation_id, state, events }`. (Idempotent per open unit+phone.)
- `POST /viewing-negotiation/:id/prospect-reply` `{ intent, text }`
- `POST /viewing-negotiation/:id/tenant-reply` `{ intent, text }`
- `GET  /viewing-negotiation/active?phone=` → `{ active, negotiations:[{ negotiation_id, party, state, awaiting, routable }] }`
  — call this on ANY inbound WhatsApp to route it to the right negotiation/party.

**`intent` shapes (what the bot parses the reply into):**
- Propose a time: `{ date:"YYYY-MM-DD", time:"HH:mm" }` (or `{ datetime:"YYYY-MM-DDTHH:mm" }`)
- Accept the offered time: `{ accepted:true }`
- Decline + counter: `{ accepted:false, counter:{ date, time } }` (send as `date`/`time` on the intent)
- Decline, no time: `{ accepted:false }`
- Not interested / stop: `{ cancel:true }`

Tenafy decides the next message and (in auto mode) sends it; in manual mode it
queues a draft for staff to approve on the dashboard. The bot does NOT send the
tenant anything — Tenafy relays both sides. Times are Hong Kong wall-clock.

### `/viewing-negotiation/active` and staff handoff

`NEEDS_STAFF` negotiations now appear in the `negotiations` list, but with
`routable:false`. TaneChat should show/track them as handed to a human, not post
new replies into them. `active` remains the routing gate: it is true only when at
least one matched negotiation has `routable:true`.

Open relay negotiations that sit silent get one light reminder to the party
Tenafy is awaiting after 12 hours. After 24 hours with no activity, Tenafy flips
the negotiation to `NEEDS_STAFF`, notifies staff once for the hourly sweep, and
sends the standard escalation message to the prospect and tenant when present.
In manual relay mode, both the 12-hour reminder and the 24-hour escalation are
queued as drafts for staff approval.

---

## Addendum (2026-08-01): Unit resolution from free text + reconfirmation

Design: `docs/superpowers/specs/2026-08-01-unit-resolution-reconfirmation.md`.

**What changed:** `start` can now begin from the prospect's RAW TEXT — the bot no
longer has to resolve a unit_id itself. Tenafy fuzzy-matches the phrase (handles
"mongkok 6a", "mk 6a", "MongKok 6A", light typos, and stray unit-name suffixes
like "6A Test"), and if it isn't a confident single match, it reconfirms /
disambiguates over WhatsApp BEFORE the day-ask. This is fully backward compatible
— passing `unit_id` still works exactly as before.

**`start` now accepts `unit_text` OR `unit_id`:**
- `POST /viewing-negotiation/start` `{ unit_text:"mongkok 6a", prospect:{...} }`
  (send `unit_text` = whatever the prospect typed; omit `unit_id`).
- Response is the same shape (`{ negotiation_id, state, awaiting, events, parties, awaiting_phone }`).
  The initial `state` will be one of: `CONFIRM_UNIT` (one confident match — Tenafy
  asks "Confirm — Mong Kok 6A? YES"), `RESOLVE_UNIT` (several candidates or a
  property-only phrase — Tenafy sends a numbered list, or "which unit?"), or, if a
  confident match is also marketable + in-window, straight to `ASK_PROSPECT_DAY`
  after confirmation.

**New reply intents during the resolution phase** (same `prospect-reply` endpoint,
same `/active` routing — nothing else changes):
- Confirm the single match ("yes"): `{ accepted:true }`
- Pick from the offered numbered list ("2"): `{ index:2 }` (1-based)
- Give a different / corrected unit ("actually jervois 4b"): `{ unit_text:"jervois 4b" }`
- Not interested / stop: `{ cancel:true }`

Once the unit is confirmed/picked, Tenafy pins it and the flow continues into the
EXISTING day-ask → tenant relay unchanged; from that point the time intents above
(`date`/`time`, `accepted`, `cancel`) apply as before. If the resolved unit isn't
open for viewings (or its lease ends too far out), Tenafy soft-holds the prospect
and routes it to staff — the bot doesn't need to handle that.

**Bot responsibilities (unchanged principle):** forward the prospect's parsed reply
as an `intent`; Tenafy owns matching, wording, and sending. The only new work is
(1) send `unit_text` on `start`, and (2) parse a "yes" / a number / a unit name
into the three intents above during `CONFIRM_UNIT`/`RESOLVE_UNIT`.

---

## Addendum (2026-08-02): Manual mode — approve drafts INSIDE TaneChat

Tenafy composes every relay message; the only difference between modes is whether a
human releases it first. Previously that approval lived on the Tenafy dashboard.
This makes it possible to approve **inside the TaneChat thread** instead, so staff
never leave TaneChat.

**How to tell a draft from a sent message — it's a FLAG, never in the text.**
Every outbound Tenafy returns (in the `events` array of the `start` / `*-reply`
responses) already carries a `status` field:
  - `status: "sent"`  → Tenafy already delivered it (AUTO mode). Nothing to do; it
    will arrive on WhatsApp as normal.
  - `status: "draft"` → MANUAL mode. Tenafy did NOT send it. Show `body` in the
    thread as a pending/suggested reply with an Approve/Send button. Do NOT deliver
    it yourself.
The approval state is this `status` flag (plus the event's `id`) — there is NEVER
any marker inside the message `body`. Track "pending approval" as your own UI state.

Each event you get is: `{ id, party, to_phone, template_type, body, status }`.

**Who sends it:** TaneChat. Tenafy has no WhatsApp of its own, and in manual mode
the draft already lives in TaneChat — so on approval **TaneChat sends the message
itself** (a native send in the thread, to the event's `to_phone`). Then, so Tenafy's
log/dashboard stay accurate, TaneChat tells Tenafy it went out:
  POST /api/public/viewing-negotiation/:id/draft-sent   { "event_id": "<event id>" }
  → `{ recorded: true, negotiation_id, event_id, already_sent }`
Tenafy just flips that event's `status` to `sent` — it does NOT re-send (that would
double-deliver). Idempotent, so a retried call is safe.

**Auto mode** needs none of this — outbounds come back `status:"sent"`, already
delivered. (The relay_mode is a Tenafy setting; staff flip manual→auto on the
Tenafy "Viewing Requests" dashboard once they trust it.)

Editing a draft before sending is not supported yet — approve as-is, or a staffer
can take over the conversation manually.
