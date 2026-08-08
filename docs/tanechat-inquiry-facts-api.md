# TaneChat → Tenafy — Inquiry Facts API (request)

Moving prospect-conversation ownership fully to TaneChat: TaneChat extracts the
facts from a conversation and sends Tenafy the **facts**, instead of sending
Tenafy the **transcript** and having Tenafy extract them.

**Direction:** TaneChat calls Tenafy. All endpoints are under `/api/public` and
require the org's `X-API-Key` header (the `pk_...` key from Tenafy master →
API Keys). The key must NOT be read-only — these are writes.

**Division of labour after this change:**

| | Owns |
|---|---|
| **TaneChat** | the conversation, its full history, search over it, and extracting facts from it |
| **Tenafy** | the inquiry record, whether an update is applied, and never overwriting human-entered data |

---

## Why — what this replaces

Today TaneChat posts raw conversation turns to `POST /api/public/chat/log`, and
Tenafy stores them (`chat_session` + `chat_message`) so it can run its own
extraction: once on first contact, then nightly at 23:00 HK over new messages.

Three problems with that:

1. **Tenafy holds a partial copy.** 1,147 conversations / 17,875 messages against
   TaneChat's ~2,250 / ~66k, and only from 5 June 2026 — the date logging began.
   Any search or analysis on the Tenafy side silently covers ~27% of the messages.
2. **The nightly job needs a question TaneChat's API can't answer** — *"which
   conversations have new messages since timestamp T?"* Tenafy can only answer it
   because it keeps the copy.
3. **TaneChat already knows the answer the moment a message arrives**, and already
   has an LLM. The extraction is happening in the wrong place, one day late.

TaneChat doing the extraction removes the copy, removes the nightly sweep, and
removes the need for any `?since=` endpoint on TaneChat's side.

---

## What TaneChat needs to do

### 1. Extract on new prospect messages

When a prospect conversation (WhatsApp or email) has new inbound messages, decide
whether anything **new or changed** was revealed. Extract:

- new **budget**, or a change to it
- new **desired start date**, or a change to it
- new **preferences** — bedrooms, neighbourhood, parking, pets, lease length
- **contact details** not already known — name, email, phone
- **intent shifts** — "no longer looking", "found a place", "budget went up"

Real example of what Tenafy currently produces for one conversation, and what it
should keep looking like:

```
Prospect seeking 2-month rental in Central or Sheung Wan, Hong Kong.
No specific start date or budget mentioned.

── Updates from chat ──
2026-08-07: Move-in date set for September 20, 2026
2026-08-07: Move-out date set for November 21, 2026
2026-08-07: Will be working at Four Seasons Hong Kong by IFC mall
```

Each `facts[]` entry is **one self-contained English sentence** describing a
single fact. Not a paragraph, not a JSON blob rendered as prose. Tenafy dates and
appends them verbatim.

Timing is TaneChat's choice — on each inbound message, debounced, or on a
schedule. Tenafy does not care, as long as each fact is sent once (see
idempotency below).

### 2. Keep serving conversation search

Tenafy's internal assistant will call TaneChat live instead of reading its local
copy, using the endpoints already specified in
[`tanechat-message-search-api.md`](./tanechat-message-search-api.md):
`GET /search/messages` and `GET /conversations/{id}/messages`. No change needed —
this just becomes the only path rather than one of two.

### 3. Stop calling `/api/public/chat/log` — but only at the end

See **Cutover** below. Until the facts endpoints are live and verified, the
logging must keep running, because it is what currently keeps inquiries updated.

---

## Endpoints Tenafy will expose

Both are **upserts keyed on the conversation**, so TaneChat does not need to know
Tenafy's inquiry ids.

### 1. `POST /api/public/inquiry/from-chat` — first contact

Creates the inquiry if this conversation has none yet; returns the existing one if
it does. Safe to call repeatedly.

```json
{
  "channel": "whatsapp",
  "channel_user_id": "85291234567",
  "conversation_id": "conv_456",
  "occurred_at": "2026-08-07T14:12:00+08:00",
  "is_inquiry": true,
  "fields": {
    "first_name": "Alice",
    "last_name": "Wong",
    "email": "alice@example.com",
    "phone": "85291234567",
    "budget": 18000,
    "desired_start_date": "2026-09-20"
  },
  "summary": "Prospect seeking 2-month rental in Central or Sheung Wan, Hong Kong.",
  "idempotency_key": "conv_456:init"
}
```

- `is_inquiry: false` → Tenafy records nothing and returns `{ created: false }`.
  Use it for chats that are not lettings enquiries at all, so both sides agree on
  what was skipped.
- `fields` are all optional. Only `channel_user_id` (or `conversation_id`) and
  `is_inquiry` are required.
- `budget` is a number, no currency symbol or thousands separator.
  `desired_start_date` is `YYYY-MM-DD`.

Response:

```json
{ "code": 200, "data": { "inquiry_id": "1786…", "created": true, "applied": true } }
```

### 2. `POST /api/public/inquiry/facts` — ongoing updates

```json
{
  "channel": "whatsapp",
  "channel_user_id": "85291234567",
  "conversation_id": "conv_456",
  "occurred_at": "2026-08-07T14:12:00+08:00",
  "facts": [
    "Move-in date set for September 20, 2026",
    "Move-out date set for November 21, 2026",
    "Will be working at Four Seasons Hong Kong by IFC mall"
  ],
  "fields": { "desired_start_date": "2026-09-20" },
  "idempotency_key": "conv_456:msg_9931"
}
```

Response:

```json
{ "code": 200, "data": { "inquiry_id": "1786…", "applied": true, "reason": null } }
```

`applied: false` with a `reason` is a normal outcome, not an error — see the rules
below. Treat it as success and do not retry.

---

## Rules Tenafy enforces (so TaneChat does not have to)

**1. Idempotency is required.** `notes` is append-only, so a retried delivery
would duplicate a line with nothing to distinguish it from a genuine repeat. Every
call must carry an `idempotency_key` that is stable for that extraction — a
message id, or `conversation_id:message_id`. Tenafy stores applied keys and
returns the original result for a repeat, applying nothing.

**2. Tenafy decides whether to apply.** TaneChat should send whatever it finds and
not track lettings state. Tenafy skips the update, returning `applied: false`, when
the inquiry is closed, already converted to a booking/lease, or soft-deleted.
Current behaviour, for reference: the nightly job only ran for `status = 0` with
no booking yet.

**3. Structured fields are never overwritten once a human has set them.** `facts`
always append to `notes`. `fields` only fill values that are still empty. This is
a Tenafy data-integrity rule and is enforced on receipt — TaneChat does not need
to know which fields a human touched.

**4. Tenafy owns the dating and formatting of notes.** Send the sentence only;
Tenafy prefixes the date and manages the `── Updates from chat ──` block. Do not
pre-format.

**5. Send a `schema_version`.** Add `"schema_version": 1` to both payloads. If
TaneChat's prompt or output shape changes, that number changes, and Tenafy can
tell a format change from a quality regression. Without it, a silent prompt edit
looks like the extraction getting worse for no reason.

---

## Cutover — order matters

The current failure mode is **silence**: if extraction stops, inquiries simply
stop gaining updates. Nothing errors, nothing alerts, and nobody notices for
weeks. So:

1. Tenafy builds and deploys both endpoints.
2. TaneChat starts sending facts **while still calling `/chat/log`**. Both run in
   parallel. Duplicate notes are expected in this window and are the signal that
   both paths work.
3. Compare on real conversations: does TaneChat's extraction find what Tenafy's
   nightly job finds? Tune the prompt until it does.
4. Tenafy disables its own extraction (the 23:00 job and the auto-create inside
   `/chat/log`), keeping the endpoint accepting for a grace period.
5. TaneChat stops calling `/chat/log`.
6. Tenafy points its `search_chats` / `get_conversation` tools at TaneChat's
   search API and drops the local prospect transcripts.

Do not skip step 2. Running both is the only way to find out whether the moved
extraction is as good, and it costs nothing but some duplicate note lines.

---

## What Tenafy keeps regardless

`chat_session` and `chat_message` do **not** go away. They are also the internal
staff assistant's own memory — `routes/chat.js` reads and writes them for
conversation history and intermediate tool results. Of 1,250 sessions today, 103
are `staff-internal` / `staff-test` and stay local. Only the ~1,147 prospect
sessions (WhatsApp/email) stop being written.

## Open questions for TaneChat

1. Can you extract per-message in near-real-time, or would you rather batch
   (hourly/nightly)? Either is fine for Tenafy; it affects only how fresh the
   inquiry notes are.
2. Do you already keep any structured extraction per conversation that overlaps
   with the field list above? If so, we should align rather than duplicate.
3. Which id do you want to key on — `channel_user_id` (stable per WhatsApp user)
   or `conversation_id`? Tenafy will accept either; `channel_user_id` is what
   `/chat/log` uses today, so it is the safer match for existing sessions.
4. Are inbound email conversations in scope for you, or WhatsApp only? Tenafy
   currently auto-creates inquiries from both.
