# TaneChat → Tenafy — Inquiry Facts API (request)

Moving prospect-conversation ownership fully to TaneChat: TaneChat extracts the
facts from a conversation and sends Tenafy the **facts**, instead of sending
Tenafy the **transcript** and having Tenafy extract them.

**Direction:** TaneChat calls Tenafy. All endpoints are under `/api/public` and
require the org's `X-API-Key` header (the `pk_...` key from Tenafy master →
API Keys). **Use the same write-capable key as `/chat/log` (`Tane Chatbot`, or
`TaneChat Test` for staging).** Two read-only keys also exist — `TaneChat Lookups
(read-only)` and `Website (read-only)` — and either would make every one of these
calls fail with `403`, since `read_only` blocks all non-GET methods.

**Division of labour after this change:**

| | Owns |
|---|---|
| **TaneChat** | the conversation, its full history, search over it, extracting facts, and not sending the same fact twice |
| **Tenafy** | the inquiry record, whether an update is applied, and never overwriting what a human entered |

---

## Why — what this replaces

Today TaneChat posts raw conversation turns to `POST /api/public/chat/log`, and
Tenafy stores them (`chat_session` + `chat_message`) so it can run its own
extraction: once on first contact, then nightly at 23:00 HK over new messages.

Four problems with that:

1. **Tenafy holds a partial copy.** 1,147 conversations / 17,875 messages against
   TaneChat's ~2,250 / ~66k, and only from 5 June 2026 — the date logging began.
   Any search or analysis on the Tenafy side silently covers ~27% of the messages.
2. **The nightly job needs a question TaneChat's API can't answer** — *"which
   conversations have new messages since timestamp T?"* Tenafy can only answer it
   because it keeps the copy.
3. **TaneChat already knows the answer the moment a message arrives**, and already
   has an LLM. The extraction is happening in the wrong place, one day late.
4. **Email conversations are never re-extracted.** The nightly job is gated on
   `cs.channel = 'whatsapp'`. Email inquiries are auto-created on first contact and
   then never updated again — live since the integration started. Moving extraction
   to TaneChat fixes it, provided email is in scope on your side.

Also: the nightly job handles at most **200 sessions per run** (`LIMIT 200`). Below
current volume, so invisible today, but a real ceiling that disappears with this.

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
- **intent shifts** — "no longer looking", "found a place", "budget went up".
  **Required in v1**, not deferrable: this is the highest-value signal in the feature,
  because it tells staff a lead is dead without anyone reading the thread. It does not
  need free-form narrative extraction — a change in the conversation's stage/status on
  your side is enough to emit a deterministic sentence.

Real example of what Tenafy produces today, and what it should keep looking like:

```
Prospect seeking 2-month rental in Central or Sheung Wan, Hong Kong.
No specific start date or budget mentioned.

── Updates from chat ──
2026-08-07: Move-in date set for September 20, 2026
2026-08-07: Move-out date set for November 21, 2026
2026-08-07: Will be working at Four Seasons Hong Kong by IFC mall
```

Each `facts[]` entry is **one self-contained English sentence** describing a single
fact. Not a paragraph, not a JSON blob rendered as prose. Tenafy dates and appends
them verbatim.

Timing is TaneChat's choice — per message, debounced, or scheduled.

### 2. Do not send the same fact twice

`notes` is append-only and **Tenafy does not de-duplicate content.** Idempotency
keys only protect against a *retried delivery* (same key). If your extractor
re-derives "budget is 18,000" on three consecutive messages and sends it three times
under three different keys, the inquiry gets three identical lines.

So TaneChat must track what it has already sent per conversation and send only
genuinely new or changed facts. This is the one obligation that cannot move to
Tenafy — only you know what you extracted last time.

**Advance that last-sent snapshot only on a `2xx`.** If a delivery fails and the
snapshot has already moved on, the next diff sees no change and those facts are lost
permanently, with nothing to detect it. A retry on the next inbound or heartbeat only
recovers them if the snapshot still shows them as unsent.

### 3. Keep serving conversation search

Tenafy's internal assistant will call TaneChat live instead of reading its local
copy, using the endpoints in
[`tanechat-message-search-api.md`](./tanechat-message-search-api.md):
`GET /search/messages` and `GET /conversations/{id}/messages`. No change needed —
this just becomes the only path rather than one of two.

### 4. Stop calling `/api/public/chat/log` — last, not first

See **Cutover**. Until the facts endpoints are live and verified, logging must keep
running: it is what currently keeps inquiries updated.

---

## Identity — how Tenafy matches a conversation

`channel` + `channel_user_id` is the identity. **`channel` is normalised** (trimmed and
lowercased, see below). **`channel_user_id` is only trimmed** — never case-folded, never
reformatted — so two different normalisations on your side become two sessions and two
inquiries for one person. The format is therefore fixed here:

| channel | `channel_user_id` format |
|---|---|
| `whatsapp` | E.164 **digits only** — no `+`, no spaces: `85291234567` |
| `email` | the full address, **lowercased**: `alice@example.com` |
| OTA (`airbnb`, …) | reservation code where one exists, else the conversation id, prefixed: `airbnb:HMABC123` — unique per conversation and **frozen on first delivery** |

Send `conversation_id` too. Tenafy stores it on the session
(`chat_session.external_conversation_id`, added for this) so the internal assistant
can deep-link back into TaneChat. **Last value wins** — if a conversation is
recreated on your side, the newest id replaces the old. It is never used for matching.

---

## Endpoints Tenafy will expose

### `channel` — open, but shaped, and it is half the session identity

**No allow-list to agree in advance.** Any channel matching `^[a-z0-9-]{2,20}$` is accepted,
registered on first sight, and staff are notified once. So a new source — `booking`,
`agoda` — works with no change and no deploy on our side. The value is trimmed and
lowercased, so `" Airbnb "` and `airbnb` are the same channel and cannot fork into two.

- **20 characters max** — the width of both `chat_session.channel` and `inquiry.source`.
- **`booking.com` is rejected.** Dots, underscores, spaces and non-ASCII all fail the shape
  and return `400 unsupported_channel`. Send the provider name, not the domain.
- **`staff-*` is reserved** — `400 reserved_channel`. Those channels are Tenafy's internal
  assistant namespace and are treated as trusted/local by staff search; an external caller
  must not be able to write into them.

The first delivery on an unseen channel raises a staff notification. That is deliberate: a
typo'd channel is accepted rather than refused, so it must be *visible*. Sessions created
under `bookng` are a separate identity from `booking`, and once real conversations land there
the only fix is a manual merge — so correct a typo at source the same day.

**A channel does not by itself separate conversations.** Session identity is
`(channel, channel_user_id)`. `conversation_id` is stored but is not part of any key. Any
source whose messages share one sender address — OTA mail from `automated@airbnb.com`, a
forwarding relay — must send a `channel_user_id` that is unique per conversation, and
**stable** for it: an identifier that changes between deliveries fragments one conversation
into several inquiries, which is the same bug as collapsing them, only harder to see.

On `whatsapp` we derive `phone` from `channel_user_id`, and on `email` we derive `email`.
On any other channel neither is derived — correct when the identifier is a reservation
rather than a contact.

### 1. `POST /api/public/inquiry/from-chat` — first contact

```json
{
  "schema_version": 1,
  "channel": "whatsapp",
  "channel_user_id": "85291234567",
  "conversation_id": "conv_456",
  "occurred_at": "2026-08-07T14:12:00+08:00",
  "is_inquiry": true,
  "unit_text": "Mong Kok Luxury Studio 5C",
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

**Required:** `schema_version`, `channel`, `channel_user_id`, `occurred_at`,
`is_inquiry`, `idempotency_key`.

**Do not send `facts` to this endpoint** — it has no notes-append path, so they would be
validated and then dropped while still returning `applied: true`. It rejects them with
`400 facts_not_allowed_here`. Send the first contact's `summary` here and everything else
to `/inquiry/facts`. `summary` is capped at 2,000 characters.

**What it does, in order:**

1. **Creates the `chat_session`** if this `(channel, channel_user_id)` has none.
   Post-cutover a brand-new prospect has no session, so this is not a lookup-only
   call — it must create one.
2. `is_inquiry: false` → records nothing, returns `{ "created": false }`. Use it for
   chats that are not lettings enquiries, so both sides agree on what was skipped.
3. Session has no inquiry → creates one, with `source` set from `channel`.
4. Session has an inquiry that is **still live** (passes the Rule 2 gate) → returns
   it, applying `fields` and `summary` per Rules 3 and 4.
5. Session has an inquiry that is **closed or converted** → **creates a NEW inquiry**
   and re-points the session at it. A `viewing_active` inquiry is deliberately NOT
   superseded — a viewing is human-managed and a "running late" message must not spawn
   a duplicate deal; Tenafy just keeps rejecting until the viewing resolves.
   This is the returning-prospect case: someone enquires in March, views, goes quiet,
   then comes back in October. Without it the session points at a dead record forever
   and every later fact is rejected.

Response:

```json
{
  "code": 200,
  "data": {
    "inquiry_id": "1786…",
    "created": true,
    "applied": true,
    "reason": null,
    "superseded_inquiry_id": "1699…",
    "skipped_fields": [],
    "summary_applied": true,
    "facts_applied": 0,
    "facts_skipped": 0,
    "unit_resolution": {
      "status": "confident",
      "unit_id": "1785…",
      "property_id": "1772…",
      "label": "Mong Kok Luxury Studio 5C",
      "applied": true,
      "candidates": []
    }
  }
}
```

`superseded_inquiry_id` appears only in case 5.

### 2. `POST /api/public/inquiry/facts` — ongoing updates

```json
{
  "schema_version": 1,
  "channel": "whatsapp",
  "channel_user_id": "85291234567",
  "conversation_id": "conv_456",
  "occurred_at": "2026-08-07T14:12:00+08:00",
  "unit_text": "COSY CAUSEWAY BAY STUDIO 105",
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
{ "code": 200, "data": { "inquiry_id": "1786…", "created": false, "applied": true,
                         "reason": null, "superseded_inquiry_id": null,
                         "skipped_fields": ["budget"], "summary_applied": false,
                         "facts_applied": 3, "facts_skipped": 0,
                         "unit_resolution": null } }
```

**Both endpoints always return the same ten keys**, `null`, `0` or empty where not
applicable, so one parser handles either response.

### Optional `unit_text`

Send `unit_text` as a top-level request field when the source knows the exact listing
title the guest is asking about. This is common for Airbnb/OTA arrivals. Send the
listing title verbatim, for example `"Mong Kok Luxury Studio 5C"` or
`"COSY CAUSEWAY BAY STUDIO 105"`. It is optional, trimmed by Tenafy, empty strings are
treated as absent, and the trimmed value is capped at 255 characters.

Do **not** send `unit_id` inside `fields`. `unit_id` is not a writable fact field; it
requires text resolution and provenance checks. A payload with
`"fields": { "unit_id": "..." }` is rejected with `400 unknown_field: unit_id`.

When `unit_text` is present and the delivery reaches a live inquiry/create path,
Tenafy resolves it to a unit using the same resolver as the viewing relay. Only
`status: "confident"` can write `inquiry.unit_id` and `inquiry.property_id`. The
statuses `ambiguous`, `property_only`, `multi_unit` and `none` never write a unit.

`unit_resolution` is always present in the response. It is `null` when no `unit_text`
was processed, including early-return paths such as `no_session`, `no_inquiry`,
`inquiry_closed`, `inquiry_converted`, `inquiry_deleted` and `is_inquiry: false`.
When processed, it has this shape:

```json
{
  "status": "ambiguous",
  "unit_id": null,
  "property_id": null,
  "label": null,
  "applied": false,
  "candidates": [
    { "unit_id": "1785…", "label": "Mong Kok Luxury Studio 5C" },
    { "unit_id": "1786…", "label": "Mong Kok Luxury Studio 6C" }
  ]
}
```

For a confident match, `unit_id`, `property_id` and `label` describe the matched
unit and `candidates` is empty. `applied: false` with `status: "confident"` means
the resolver found a unit, but Tenafy refused to overwrite an existing human-owned
`unit_id`. Treat that differently from `ambiguous`: the listing text was understood,
but the inquiry record was intentionally left unchanged.

**`unit_text` is part of the payload hash.** Adding a listing to a fact set you have
already delivered therefore needs a **NEW `idempotency_key`** — re-sending the old key
with `unit_text` added returns `409 idempotency_key_conflict`, by design, because the
payload is genuinely different. A replay of the *same* key returns the original
`unit_resolution` verbatim, candidate list included.

`facts_applied` and `facts_skipped` complete the picture `skipped_fields` started: facts
can be dropped for reasons the caller cannot see. **A fact already recorded is not written
again** — notes are append-only and kept forever, and idempotency only stops the SAME
delivery replaying, so a different delivery carrying an already-recorded fact would
otherwise duplicate it permanently. Comparison ignores the date prefix, case, spacing and
trailing punctuation, and also catches the same fact twice inside one payload.

Note that `reason` may be set **with** `applied: true`. That means the delivery was
accepted but part of it did not land — today the only such reason is
`notes_limit_reached`.

### `applied: true` does not mean anything changed

`applied` means the delivery was accepted and processed. Two things can still be
declined without it being an error, and both used to be invisible:

- **`skipped_fields`** — fields Tenafy refused to overwrite because they already
  carry a value it did not set (a human edit, or Tenafy's own pre-cutover
  extraction). Re-sending the same value will not help; the field is a human's
  until a human clears it.
- **`summary_applied`** — whether `summary` was used. It only ever seeds *empty*
  notes, so a conversation that already has notes keeps them. On
  `/inquiry/facts` a summary is recorded but never applied (that endpoint appends
  dated fact lines instead), so `summary_applied` is always `false` there.

Both are recorded on the delivery row, so the parallel-run report can show them.

**On a replay** (same key, same payload) the original outcome is returned in full,
including `created`, `superseded_inquiry_id` and `skipped_fields` — the delivery row
stores every value it reported.

**Call `from-chat` once per conversation first.** Tenafy will not create an inquiry
from a bare fact list — that would manufacture records from conversations nobody
classified as enquiries.

**`applied: false` is a normal outcome, not an error.** Do not retry the same
delivery. The fact is discarded, notes included.

**But keep sending on `viewing_active`.** Do not stop delivering for a conversation
just because the gate is closed. A viewing can be cancelled, which makes the inquiry
live again — and if you have stopped sending, nothing tells you that happened, so
updates never resume. Sending into a rejection is cheap and makes resumption
automatic. (Do NOT auto-reopen a new inquiry on `viewing_active` — a "running late"
message must not spawn a duplicate deal. Superseding is only for
`inquiry_closed` / `inquiry_converted`.)

`reason` is one of:

| reason | meaning |
|---|---|
| `no_session` | Tenafy has never seen this conversation — call `from-chat` |
| `no_inquiry` | session exists but no inquiry linked — call `from-chat` |
| `inquiry_closed` | `status != 0` |
| `inquiry_converted` | already has a tenant |
| `viewing_active` | a confirmed or completed viewing exists |
| `inquiry_deleted` | soft-deleted |
| `not_inquiry` | returned by `from-chat` for `is_inquiry: false`. Note it is not persisted, so a later `/facts` call for that conversation returns `no_inquiry`, not this |

---

## Rules Tenafy enforces

**1. Idempotency is required.** Every call carries an `idempotency_key` stable for
that extraction — a message id, or `conversation_id:message_id`. A repeat returns the
**original** result and applies nothing.

Send the same key with a *different* payload and Tenafy returns
**`409 idempotency_key_conflict`** rather than silently replaying the old result and
dropping the new facts. Do not retry a 409 — fix the key.

⚠️ **The key must NOT be a hash of the content alone.** A content fingerprint makes
identical facts collide across time, and two flows depend on being able to send the
same sentence twice:

- **Re-engagement.** A fact rejected with `applied: false` on a dead inquiry, then
  re-sent after `from-chat` supersedes it, has identical content. A content-hash key
  replays the stored rejection and the fact never reaches the new inquiry.
- **Value reversions.** Budget 18k → 25k → back to 18k emits "Budget set to
  HK$18,000" a second time, legitimately. A content-hash key drops it.

Include something monotonic: `<conversation_id>:facts:<message_id>` (preferred), or
put `occurred_at` in the hash input alongside the content.

*Tenafy build note:* no idempotency store exists yet. It needs:

```sql
CREATE TABLE inquiry_fact_delivery (
  id               BIGINT       NOT NULL,
  org_id           BIGINT       NOT NULL,
  idempotency_key  VARCHAR(191) NOT NULL,
  payload_hash     CHAR(64)     NOT NULL,   -- sha256 of the canonical body
  inquiry_id       BIGINT       DEFAULT NULL,
  applied          TINYINT      NOT NULL DEFAULT 0,
  reason           VARCHAR(64)  DEFAULT NULL,
  created_at       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_ifd_org_key (org_id, idempotency_key)
);
```

The delivery row and the inquiry update **must commit in one transaction**. Insert
first and apply afterwards, and a crash between them records the key as `applied = 0`
permanently — every retry then replays "not applied" and those facts are lost with
nothing to notice it.

**2. Tenafy decides whether to apply.** Send what you find; don't track lettings
state. An update applies only while the inquiry is live, which today means **all** of:

- `inquiry.status = 0` (open)
- `inquiry.tenant_id IS NULL` (not converted to a tenant)
- no `viewing_booking` with `status IN (1, 3)` (no confirmed or completed viewing)
- `inquiry.deleted_at IS NULL`

A confirmed **viewing** is enough to stop updates, not just a lease — existing
behaviour, carried over deliberately. The gate check and the write happen under a row
lock on the inquiry, so a viewing confirmed mid-request cannot slip through.

**3. `fields` may update a value the API set, never one a human set.** This is what
makes "budget went up to 25k" land in the structured column rather than only in notes.

Tenafy tracks provenance per field (`inquiry.api_set_fields`, a JSON list of field
names last written by this API). A field is written when it is empty, **or** when it
appears in that list. The moment a human edits that field in the UI, Tenafy drops it
from the list and the API can never touch it again.

Stated plainly, because it is a real consequence: **a human clearing a field is not a
"leave this blank" instruction.** If the API set it before, a later fact can refill
it. Making "unknown" stick needs a UI-level lock, which is out of scope here.

Only these keys are accepted under `fields`:

```
first_name, last_name, email, phone,
budget, desired_start_date, desired_end_date, nightly_rate, stay_total
```

Anything else — `status`, `tenant_id`, `org_id`, `deleted_at`, or an unknown name —
is rejected with `400 unknown_field`. `org_id` always comes from the API key and is
never read from the body. Without that whitelist a leaked `pk_` could set `status` or
`tenant_id` directly and walk straight through the Rule 2 gate.

All money fields are numbers in **HKD** — no symbol, no thousands separators, `>= 0`,
max two decimals. Dates are `YYYY-MM-DD`.

#### Short stays: `nightly_rate` and `stay_total`, never `budget`

**`budget` means a MONTHLY figure, always.** It is compared against unit rent and summed
in reports, so a nightly rate placed there is not merely mislabelled — it makes an
HK$18,000-a-month guest read as an HK$590-a-month prospect, and it silently corrupts any
total that mixes the two. Send `budget` only when the prospect is talking about a monthly
amount.

For a per-night stay send instead:

| field | meaning |
|---|---|
| `nightly_rate` | the per-night figure, HKD |
| `stay_total` | the total for the whole stay, HKD |
| `desired_start_date` | check-in |
| `desired_end_date` | check-out |

Nights are **derived** by Tenafy as `desired_end_date - desired_start_date`; do not send a
night count.

**`stay_total` is NOT `nightly_rate × nights`, so it must be sent, not computed.** A real
example from this integration: a 16-night stay quoted at HK$590/night had a total of
HK$8,361, not HK$9,440 — a long-stay discount. Deriving the total would have overstated it
by 13%. Send what the platform actually charges.

`desired_end_date` is useful well beyond OTA — a lettings prospect saying "Aug 14th until
around Jan 1st" has an intended term, and we had nowhere to put it.

#### Do not attribute a price we set to the prospect

`nightly_rate` on an inbound OTA request is **our listing price**, not something the guest
stated. An extractor that emits `"Budget set to HK$590"` from it is asserting the guest said
something she never said, which is worse than a unit error because it survives into a record
staff act on. State the source:

```
Airbnb listing price HK$590/night · 16 nights · HK$8,361 total
```

Where the prospect genuinely states a figure, say so plainly — `"Budget raised to
HK$25,000"` — and send `budget`.

**4. Tenafy owns note formatting; the DATE comes from `occurred_at`.** Send the
sentence only — Tenafy prefixes the date and manages the `── Updates from chat ──`
block. The date is `occurred_at` **converted to Asia/Hong_Kong**, not the time the
call arrived: otherwise a batched send or a next-day retry stamps facts with the
wrong date, and these notes are meant to be an audit trail of when the prospect
actually said things. `occurred_at` is required; missing → `400`.

`summary` becomes the first line of `notes`, above the updates block, and **only when
notes is empty**. It never replaces an existing summary or human text.

Lines append in **arrival order, not `occurred_at` order** — a delayed retry sits
below newer lines carrying an older date. Appends use an atomic
`UPDATE … SET notes = CONCAT(notes, ?)` so concurrent deliveries cannot lose lines.

**5. `schema_version` is required.** Send `1`. An unknown version is rejected with
`400 unsupported_schema_version` rather than guessed at — a prompt or shape change on
your side must not look like the extraction quietly getting worse. Missing → `400`.

**6. Limits.** Max **50** facts per call, **500** characters per fact, `summary` 2,000
characters. `notes` is a MySQL `TEXT` column capped at 65,535 **bytes** — not characters —
so the limit is measured in UTF-8 bytes. Chinese text is 3 bytes per character in
`utf8mb4`, so a Cantonese conversation reaches the ceiling in roughly a third of the
characters an English one would.

An append that would pass **60,000 bytes** is **not** written and **not** an error: the
response is `applied: true` with `reason: "notes_limit_reached"` and `facts_applied: 0`,
the fields still apply, and the delivery is recorded. It used to be a `413`, which rolled
the transaction back and released the idempotency claim — so the retry hit the same limit
and the conversation was stuck on `413` forever. The notes column needs a human to trim
it; the integration must not stall waiting for that. Silently truncating an audit trail
is still worse than refusing to add to it.

**7. Error envelope** mirrors the success shape, with `code` equal to the HTTP status:

```json
{ "code": 400, "message": "unknown_field: status" }
```

**Retries:** `2xx` → done, including `applied: false`. `409` and other `4xx` → do not
retry, the payload is wrong. `429` and `5xx` → retry with backoff, reusing the
**same** `idempotency_key`. `429` carries `Retry-After` in seconds.

---

## Cutover — order matters

1. **Tenafy** builds and deploys both endpoints, the delivery table, the provenance
   column and `external_conversation_id`.
2. **Parallel run.** TaneChat starts sending facts while still calling `/chat/log`.
   During this window Tenafy's own nightly extraction writes to a **staging table,
   not to `notes`** — two extractors appending differently-worded versions of the
   same facts would bake weeks of duplicate lines into an audit trail kept forever,
   and no later cleanup could tell them apart.
3. **Compare and sign off**, on a criterion agreed up front rather than by eyeball.
   Over **50 conversations across one month** (9 Aug – 9 Sep 2026; extended from two
   weeks at TaneChat's request):
   - field-level match on `budget` and `desired_start_date` against the staged output;
   - every **intent shift** the staged output found is also present in TaneChat's facts;
   - **free-form narrative facts are OUT of scope for v1 sign-off.** Tenafy's extractor
     produces them today (e.g. "Will be working at Four Seasons Hong Kong by IFC mall")
     and TaneChat's v1 emits a deterministic set instead, so requiring notes-line parity
     would make sign-off unpassable by construction. They are a v2 item and need a date,
     not an open end.
   - during the window, TaneChat also reports extractions **suppressed by confidence
     gating** — otherwise a suppressed fact looks identical to "nothing changed" and the
     comparison reads as agreement where it is really silence on both sides.

   Sign-off is a single named person; on this project that is the same individual for
   both sides, which is accepted deliberately rather than by oversight.
4. **Tenafy** disables its own extraction — the 23:00 job and the auto-create inside
   `/chat/log`. `/chat/log` keeps returning `200` but **discards** the payload, so
   nothing is written that no longer has a reader.
5. **TaneChat** stops calling `/chat/log`.
6. **Tenafy** points `search_chats` / `get_conversation` at TaneChat's search API and
   deletes the local prospect transcripts.

**The heartbeat is part of the deal, not an optional extra.** The failure mode we are
moving away from is silence: extraction stops, inquiries stop updating, nothing is
logged. After step 5 that gets worse, because Tenafy no longer holds transcripts to
fall back on. So TaneChat sends at least one call per active conversation per day — an empty
`facts: []` no-op is fine — and Tenafy alerts when deliveries stop.

**Two corrections to how Tenafy detects this, from building it.** First, the alert is
**delivery-based, not inbound-based**: after cutover TaneChat stops calling `/chat/log`, so
`chat_message` stops being written and Tenafy can no longer see inbound activity at all —
an inbound-based rule would go permanently quiet exactly when it became load-bearing.
Second, the alert is **org-level, not per-conversation**: since you only heartbeat
conversations with inbound activity in the last 3 days, a single conversation going quiet is
the normal end of a lead, and alerting on it would fire for every closed enquiry until the
alert got muted. Tenafy therefore alarms when **every** tracked conversation goes silent, or
when there is delivery history but nothing at all inside the window — which is what a dead
emitter, a bad deploy or a revoked key looks like.

**"Active" must mean the same thing on both sides or the alert is useless.** Agreed
definition: an inquiry exists, and the conversation had inbound activity **within the
last 3 days**. TaneChat stops heartbeating outside that window and Tenafy stops
alerting on it — otherwise Tenafy alarms on conversations TaneChat has correctly
stopped sending, and a noisy alert gets muted, which is how this failure mode returns.

Without the heartbeat we have moved the silent failure, not removed it.

---

## What Tenafy keeps regardless

`chat_session` and `chat_message` do **not** go away — they are also the internal
staff assistant's own memory (`routes/chat.js` reads and writes them for conversation
history and intermediate tool results). Of 1,250 sessions today, 103 are
`staff-internal` / `staff-test` and stay local. Only the ~1,147 prospect sessions
stop being written.

## Open questions for TaneChat

1. Can you extract per-message in near-real-time, or would you rather batch
   (hourly/nightly)? Either works; it only affects how fresh the notes are.
2. Do you already keep structured extraction per conversation that overlaps with the
   field list? If so we should align rather than duplicate.
3. Are inbound **email** conversations in scope on your side, or WhatsApp only?
   Tenafy auto-creates inquiries from both today, so WhatsApp-only leaves email
   exactly where it is — created once, never updated.
4. **Backfill: do you want to send history for the ~1,100 conversations Tenafy has
   never seen?** It would close the 27% coverage gap that motivates this change, but
   it mass-creates inquiries with 2025 / early-2026 `occurred_at` dates appended below
   newer lines. Our default is **no backfill** — new conversations only — unless you
   say otherwise. Better decided than discovered.
5. Can you meet the daily heartbeat, including for conversations where nothing new
   was extracted?
