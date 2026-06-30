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
5. Bot PARSES that into ISO times, then ECHOES them back to confirm:
   "Got it — Thu Jul 3 3:00 PM or Fri Jul 4 11:00 AM, correct?"
6. Bot → POST /api/public/viewing-request                    ── create + review
   Bot sends the returned `review_url` to the prospect:
   "Please confirm your times here: <review_url>"
7. Prospect opens the link, the times are PRE-FILLED, fixes any mis-parse,
   and submits. Tenafy then notifies the current tenant to pick one.
   (Everything from here — tenant pick, confirmations, calendar — is Tenafy.)
```

Step 5's echo + step 7's review page are the **two safety nets** against a
parsing mistake: the prospect sees the parsed times in chat AND on the page.

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
max 3, de-duped), mints a prefilled invite, and returns a **review link**.

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
  "candidates": ["2026-07-03T15:00:00","2026-07-04T11:00:00"],  // accepted (sorted, ≤3)
  "summary_text": "1. Thu, Jul 3, 3:00 PM\n2. Fri, Jul 4, 11:00 AM",  // ready to paste into the message
  "invalid": [ { "value":"2026-07-06T10:00", "reason":"Viewings are not available on Sundays" } ]
}}
200 { "code":200, "data": { "available": false, "reason": "not_marketing" } }
400 { "code":400, "message":"No valid times", "invalid":[ ... ] }   // none usable
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

## Notes
- **Phone format:** pass E.164-ish (`+852...`); Tenafy normalises digits.
- **Idempotency:** each `viewing-request` mints a NEW invite. Don't retry on
  success. If the prospect changes their mind, just call it again — the latest
  link is the one to send.
- **Time zone:** times are treated as Hong Kong wall-clock. Send local times.
- **What Tenafy sends (not the bot):** the tenant "which time works?" prompt,
  all confirmations, cancellations, and reschedule links. The bot never messages
  the tenant.
