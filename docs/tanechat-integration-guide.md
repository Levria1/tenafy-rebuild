# TaneChat ↔ Tenafy integration guide

**For:** the TaneChat team.
**Covers:** answering availability inquiries, and running a viewing from first message to booked.
**Base URL:** `https://platform.tenafy.com/api/public`
**Auth:** `X-API-Key: <key>` on every request. Availability (Part A) needs only a **read-only** key.
Viewings (Part B) need a **read-write** key: six of its endpoints are POSTs — `start`,
`compose`, `prospect-reply`, `tenant-reply`, `draft-sent`, `cancel` — and a read-only key is rejected on any of them with a
`403` before the handler runs. See the table in §9.

Verified against production on 2026-08-14. Where this doc shows a payload, it was captured from a
real call, not written by hand.

---

## 1. The one idea to hold on to

Tenafy answers two different questions, and they are governed by two independent sets of settings:

| Question | Answered by | Configured in |
|---|---|---|
| **What units are in play?** | the availability windows | Advertising → Settings *(Facebook)* and Chatbot → Settings → Leasing *(inquiries)* |
| **What do we offer *this* person?** | the gap thresholds | Chatbot → Settings → Leasing |

Nothing is shared between the two. The operator can advertise a unit on Facebook 60 days before it
frees and still choose not to mention it to a caller — or the reverse.

**You never need to implement either.** Both are applied server-side before you get a response. Your
job is to read the flags and choose words.

---

# PART A — ANSWERING "WHAT'S AVAILABLE?"

## 2. The call

```
GET /vacancies?free_on=2026-10-12
```

| Param | Default | Notes |
|---|---|---|
| `target_date` | none | `YYYY-MM-DD`. Ranks and warns by move-in fit, and **hides** units with a positive gap past `hard_max_gap_days` (default 20). Use it to rank "what fits this move-in", not to answer a firm future date. Without it there is no gap to judge, so no ranking, no warnings and no hiding. |
| `free_on` | none | `YYYY-MM-DD`. **Send this when the customer has a firm future move-in date.** Hard filter to units they can actually take that day. Does not apply `hard_max_gap_days`. Within 60 days, anything it removes that merely frees up *later* comes back in `next_available` — see §7. **Beyond 60 days a separate rule applies — see §2a.** Do **not** also send `target_date` for a future date: the gap cap runs first, so `free_on` can only filter what already survived, and a 6-week enquiry will look like no availability. |
| `move_out` | none | `YYYY-MM-DD`. Optional. The customer's intended move-out. Only used **beyond** the 60-day booking horizon, where how much vacancy we accept depends on the stay length — see §2a. Malformed values are a `400`. |
| `max_tier` | `3` | `1` vacant only, `2` + NR, `3` all. Leave it alone unless you have a reason. |
| `property_id` | none | optional filter |
| `limit` | `50` | max 200 |

A malformed `target_date` or `free_on` is a **400**, deliberately — it is not silently ignored.

**Without `target_date` these keys are absent from the response — not null:** `target_date`,
`max_gap_days`, `phrasing.earlier`, and the three per-unit gap fields `gap_days`, `gap_warning`,
`available_after_target`. There is no date to measure a gap against, so nothing is ranked, warned about
or hidden. Don't assume those keys exist if you ever call without a date.

`GET /units/available` is **deprecated**. It answers a strictly worse question: it cannot see units
coming free later, and until recently it reported units already re-let. Responses carry
`Deprecation: true`. Migrate off it.


### 2a. Beyond 60 days we only offer confirmed units

A requested date more than **60 days** out is beyond the **booking horizon**. Past that point we will
not hold a flat empty on spec, so the answer narrows to units whose tenant has **confirmed they are
leaving** and who free up close enough to the date. Already-empty units, may-renew units and manual
overrides are all withheld.

If nothing qualifies you get a distinct outcome — not "no availability":

```json
"no_match_reason": "too_far_out",
"booking_horizon_days": 60,
"booking_gap_days": 10,
"check_back_in_days": 51,
"check_back_on": "2026-10-07",
"partner_forward": { "applies": false, "message": null }
```

- Tell the customer to **check back on `check_back_on`**. That is when their date comes inside the
  horizon — the earliest the answer could change, **not** a promise that something will be free.
- `phrasing.too_far_out` is the operator's template, `null` until they write one. If `null`, use your
  own wording; do not invent ours.
- **`partner_forward.applies` is `false` here even though `count` is `0`.** Do not forward this lead.
  It is a customer to talk to later, not one to hand to an agency.
- `next_available` is **absent** beyond the horizon. Inside it, unchanged.

How much gap we accept scales with the stay, so send `move_out` when you know it:

| Requested stay | Maximum gap |
|---|---:|
| 1 month | 3 days |
| 2 months | 6 days |
| 3 months or longer | 10 days |
| Not stated | 10 days |

Most far-future enquiries will land on `too_far_out`, and that is honest rather than evasive: of the
units whose leases end beyond 60 days, the large majority are **may-renew** — the tenant has not yet
said whether they are staying, so there is genuinely nothing to promise.


## 3. What comes back

Example response shape:

```json
{ "code": 200, "data": {
  "target_date": "2026-10-12",
  "count": 3,
  "hidden_by_gap_cap": 3,
  "no_match_reason": null,
  "max_gap_days": 10,
  "hard_max_gap_days": 20,
  "partner_forward": { "applies": false, "message": null },
  "phrasing": { "certain": "…", "uncertain": "…", "earlier": "…" },
  "vacancies": [
    { "label": "Hollywood 5B", "tier": 2, "intent": "NR",
      "source": "lease",
      "unit_id": "123", "listing_url": "https://taneresidence.com/product/hollywood-5b/",
      "property_name": "Hollywood", "district": "Sheung Wan", "city": "Hong Kong",
      "availability": { "status": "from_date", "available_from": "2026-10-12",
                        "next_move_in_date": null, "days_until": 60, "certain": true },
      "gap_days": 0, "gap_warning": false, "available_after_target": false }
  ]
}}
```

**Results are already ranked best-fit-first. Do not re-sort.**

Each vacancy includes `unit_id` and `listing_url`. `listing_url` is `null` when the unit has none
(roughly a third of units), so treat it as a fast exact path when present, not a guarantee.

Use `district` and `city` for "I want to live in X" filtering. Property names do not reliably encode
the area.

`availability.next_move_in_date` means somebody is already moving in then, so the unit is only free
until that date. Send `free_on` when the customer has a firm date and Tenafy will remove those rows for
you — but read §7 first, because a unit that frees up a fortnight after their date is still worth
offering, and Tenafy hands it back to you separately rather than dropping it.

## 4. The four fields that decide your wording

**`availability.certain`** — branch on **this**, not on `tier`. `true` means the unit will definitely
be free (vacant now, or the tenant has confirmed they are leaving). `false` means the tenant may renew
or may move out early. If a tier is ever added or re-numbered, `certain` keeps your logic correct.

**`source`** — always present. `"lease"` means availability comes from lease records. `"manual"` means
an operator has flagged the unit because the tenant may move out early; nothing is confirmed and the
lease has not ended. `source` is all you get and all you need — the override's internal details are
deliberately not exposed, because the note behind it is staff-only.

**`gap_days`** — signed, and the sign matters:

- **positive** → the flat sits empty this many days before your customer arrives. Lost rent.
- **zero** → perfect fit.
- **negative** → the flat is not free until *after* they want it; they would wait. Costs nothing.

**`gap_warning`** — `true` past `max_gap_days` (10). Advisory. The unit is still offered; use
`phrasing.earlier`.

**`available_after_target`** — the negative-gap case. Never carries a `gap_warning`, because waiting
costs the operator nothing.

`available_from` **is the lease end date** — the unit is free **on that day**
(same-day turnover). Do not add a day.

## 5. What to say

| Situation | Say |
|---|---|
| `certain: true`, `status: "now"` | "available now" |
| `certain: true`, `status: "from_date"` | "available from {available_from}" |
| `gap_warning: true` | still offer it — use `phrasing.earlier` |
| the unit came from `next_available` | use `phrasing.later` — ask whether a later start works. Never present it as free on their date. |
| `certain: false`, `source: "manual"` | **must** use `phrasing.manual`. Never state it as firm availability. |
| `certain: false`, `source: "lease"` | **must** use `phrasing.uncertain`. Never state it as firm availability. |

The `phrasing` templates are operator-authored and returned **unsubstituted**. Fill them yourself.
They exist so the operator controls the wording in one place — please use them rather than composing
your own.

`phrasing.manual` is returned when a manual early-move-out override is present in the response.

`phrasing.earlier` currently reads:

> `{units} is free from {date} — would you be able to start a little earlier? We try not to leave a flat empty too long.`

**Group the uncertain units into one caveated sentence** rather than repeating the caveat per unit.

Worked example from the payload in §3 plus two flagged units:

> Hollywood 5B is available from 12 October, which lines up well with your date.
> Jardine 2B and Hollywood 1B are free from 27 and 26 September — would you be able to start a
> little earlier? We try not to leave a flat empty too long.
> We may also have Mong Kok 1C available, however the tenant may renew, they're not sure.

## 6. Units you will never see, and why

When you send `target_date`, past `hard_max_gap_days` (20) a unit is **removed**
from the response. Two exemptions:

- **A unit that is already vacant is never hidden**, however large its gap. It is the one most
  urgently needing a tenant.
- **`available_after_target` units are never hidden.** Waiting costs no rent.

`hidden_by_gap_cap` tells you how many were removed. In §3 it is `3` — so the operator has six
suitable-ish units and you were shown the best three. **This is normal. Do not treat a short list as
an error or ask for `max_tier=3` to compensate.**

## 7. When there is nothing — later dates first, then the partner message

### 7a. `next_available` — what `free_on` took away

`free_on` is a hard filter and **does not apply the gap cap**. That is why a firm
future move-in date must go here, not in `target_date`: a unit freeing six weeks
out still comes back under `next_available` instead of disappearing. On a busy
portfolio it can empty `vacancies` while the operator still has flats coming free
three weeks later. Tenafy hands those back separately:

```json
"vacancies": [],
"count": 0,
"hidden_by_free_on": 6,
"next_available": [ { "label": "Gilman's Bazaar 5B", "availability": { "available_from": "2026-09-17" } } ],
"phrasing": { "later": "{units} available from {date} — a little later than you asked. Would that still work?" }
```

**If `next_available` is present, ask about a later start before you conclude anything.** These are
real, offerable units — the only thing wrong with them is the date.

- `next_available` appears **only** when `free_on` was sent and something offerable frees up later.
  Absent otherwise — not an empty array.
- Do **not** also send `target_date` for that future date. The gap cap runs first, so
  `free_on` / `next_available` only see what survived `hard_max_gap_days`.
- Sorted soonest-first, and `limit` applies to it independently.
- Units **already re-let** by the requested date appear in neither list. That is deliberate: they are
  spoken for, and offering them would be a promise Tenafy cannot keep.
- `phrasing.later` ships alongside it. Use it as written; it must never read as though the unit is
  free on the date they asked for.
- `hidden_by_free_on` counts **everything** `free_on` removed — both the later units and the re-let
  ones. It is not the length of `next_available`.

Same wording rules as everywhere else: if one of these units is `certain: false`, the caveat still
applies. A later date and an unconfirmed date are two separate hedges, and it needs both.

### 7b. The partner message

If `vacancies` is empty, `partner_forward.applies` is `true` and **TaneChat sends
`partner_forward.message` to the partner agencies.**

**`applies` is now `false` whenever `next_available` is non-empty**, even though `vacancies` is
empty — we are not handing a lead to a competitor while we have something to offer. Ask about the
later date instead.

```json
"partner_forward": {
  "applies": true,
  "message": "Hi, we have an enquiry we can't house — {customer_name} wants {target_date} in {area}…"
}
```

Rules, and the first is the important one:

1. **If `message` is `null`, send NOTHING.** There is deliberately no default: this text goes to real
   agencies under the operator's name, so an unwritten message means the feature is not configured
   yet. Do not compose a substitute, do not fall back to a generic line.
2. **Branch on `applies`, not on `no_match_reason`.** `applies` is the decision; the reason is
   internal reporting.
3. **You substitute the placeholders.** Tenafy returns the template verbatim, because a half-filled
   template reaching an agency is worse than an unfilled one.

| Placeholder | Fill with |
|---|---|
| `{customer_name}` | the enquirer's name |
| `{target_date}` | their requested move-in date |
| `{budget}` | stated budget |
| `{area}` | area or district requested |
| `{requirements}` | short free-text summary |

If you cannot fill one, drop that clause cleanly rather than sending a literal `{budget}`.

`no_match_reason` is for the operator's reporting, not your logic:

- `"all_beyond_hard_cap"` — units exist, none within policy
- `"none_free_on_date"` — units exist, none are free on the requested `free_on` date. **Check
  `next_available` before treating this as a dead end** — it fires even when later units exist.
- `"no_vacancies"` — nothing at all
- `null` — the list is non-empty

Also tell the customer — but only once `next_available` is empty too. Then either reason means the
same thing to them: nothing suitable right now, and we are passing it to partners.

---

# PART B — RUNNING A VIEWING

## 8. Who does what

**Tenafy owns every decision and all timers.** State machine, staff-availability and Google Calendar
checks, the tenant opt-out clock, the message wording, the booking.

**TaneChat owns the conversation.** You detect inbound messages, parse them into an intent, send the
words Tenafy composes, and surface drafts to staff.

**You have no timers.** Do not implement any.

## 9. The endpoints

| Call | Method | Read-only key? |
|---|---|---|
| `/viewing-negotiation/start` | POST | ✗ write |
| `/viewing-negotiation/:id/compose` | POST | ✗ write |
| `/viewing-negotiation/:id/prospect-reply` | POST | ✗ write |
| `/viewing-negotiation/:id/tenant-reply` | POST | ✗ write |
| `/viewing-negotiation/:id/draft-sent` | POST | ✗ write |
| `/viewing-negotiation/:id/cancel` | POST | ✗ write |
| `/viewing-negotiation/active?phone=` | GET | ✓ |
| `/viewing-negotiation/drafts` | GET | ✓ |
| `/viewing-negotiations` | GET | ✓ |

`POST /viewing-negotiation/:id/cancel` — body `{ "reason": "..." }` optional, max 500
characters, currently ignored (no column). Open → `{ cancelled: true,
already_cancelled: false, state: "CANCELLED" }`. Already cancelled →
`{ cancelled: true, already_cancelled: true }` (safe to retry). `CONFIRMED` /
`AUTO_CONFIRMED` → `409 { reason: "already_confirmed" }`; cancelling a committed
viewing stays a staff action so the tenant is told a human is not coming.
Unknown id / other org → `404`. Write-only: a read-only key is `403`.

## 10. Starting one

```json
POST /viewing-negotiation/start
{ "unit_text": "mongkok 6a", "prospect": { "name": "Alex", "phone": "+85255053651" } }
```

You can start with any one of three unit identifiers:

1. `unit_id` — exact, preferred, wins over everything.
2. `listing_url` — exact listing-link lookup. `listing_link` is accepted as an alias.
3. `unit_text` — fuzzy fallback for phrases like `"mongkok 6a"`.

Tenafy returns `resolved_by`: `"unit_id"`, `"listing_url"` or `"unit_text"`. Read it. If you sent a
listing URL and it falls back to text, this is how you know the exact path did not work.

Listing URLs are compared after stripping the scheme, `www.`, query string, fragment and trailing
slash, then lowercasing. An ad click with `?fbclid=...` still matches the stored listing URL.

If a listing URL cannot be matched and no `unit_text` fallback was supplied, the response is
`available:false` with reason `"listing_url_not_found"`. If more than one unit normalises to the same
URL, the reason is `"listing_url_ambiguous"` and Tenafy never guesses.

You do **not** need to send a proposed time or a policy:

- Tenafy resolves `unit_text` to a unit and asks the viewer to confirm if it is ambiguous.
- Tenafy asks the viewer for a day itself.
- Tenafy reads the per-tenant viewing policy from its own data.

If you send a time we will reconfirm it anyway, because time parsing is the most error-prone step.

## 11. Routing an inbound message

```
GET /viewing-negotiation/active?phone=+85255053651
→ { "active": true, "negotiations": [
      { "negotiation_id": "…", "party": "tenant", "state": "AUTO_CONFIRMED",
        "awaiting": null, "needs_staff_reason": null, "routable": true } ] }
```

**Trust `routable`. Do not infer from `state`.** In particular:

- A **booked** viewing (`CONFIRMED` / `AUTO_CONFIRMED`) whose date has not passed is still
  `routable: true` **for the tenant** — because they may withdraw, and that has to reach us.
- The same negotiation is `routable: false` **for the prospect**, because a prospect reply on a
  booked viewing is refused. Relaying it would drop the message silently.

Then POST the parsed intent to `/prospect-reply` or `/tenant-reply`:

```json
{ "intent": { "when": "2026-08-20T15:00:00", "accepted": true, "cancel": false }, "text": "yes 3pm works" }
```

Intents we act on: `accepted`, `cancel`, `when` (a proposed/counter time), `index`/`choice` (picking
from a unit list), `unit_text` (a fresh unit name).

**Extract from the customer's LATEST message.** Do not reuse a time from earlier in the thread — if
the current message has no time, send no `when` and Tenafy will ask.

## 12. States

Ten pre-existing states are unchanged. Three are new:

| State | Meaning |
|---|---|
| `AUTO_CONFIRMED` | the occupant was given a deadline, stayed silent, and the viewing is booked |
| `TENANT_CANCELS_AFTER_X` | the occupant withdrew **after** it was booked — reversal |
| `RESCHEDULE_AFTER_COMMIT` | the occupant proposed a different time after it was booked |

Handle an unknown state gracefully rather than erroring — more may be added.

## 13. `closed: true` does not mean the conversation is over

A reply may come back as:

```json
{ "closed": true, "state": "NEEDS_STAFF", "needs_staff_reason": "no_host",
  "message": "This viewing request is no longer active — our team will follow up." }
```

`needs_staff_reason` is **new** and tells you *why* we stopped. Three of these are **resumable**: staff
can press "Start viewing anyway" in Tenafy, after which the negotiation returns to asking the viewer
for a day and messaging resumes. **Do not tear down your relay row on `closed: true`** — you would
miss the resumption.

Resumable: **`off_window`** (lease not ending soon enough to disturb the tenant), **`not_marketing`**
(unit not open for viewings), **`no_host`** (nobody rostered to show it).

Not resumable: `multi_unit`, `stale`, `no_roster`, `confirm_no_staff`, `auto_confirm_no_staff`,
`slot_taken_at_confirm`, `slot_taken_at_reconfirm`, `tenant_no_phone`, `window_no_phone`,
`max_rounds`, `tenant_reply_after_confirm`, `reschedule_declined_after_commit`.

## 14. Sending the messages Tenafy composes — poll `/drafts`

The operator runs in **manual** mode: every outbound is a draft awaiting staff approval.

Drafts created by an inbound reply come back in that reply's `events[]`. But drafts created by the
**hourly cron** have no response for you to read — nudges, the booking-confirmed message after a
silence auto-confirm, reversal notices, stale escalations. Poll for those:

```
GET /viewing-negotiation/drafts
→ { "drafts": [ { "event_id": "…", "negotiation_id": "…", "party": "tenant",
                  "to_phone": "+852…", "body": "…final text…",
                  "event_type": "tenant_opt_out_notice", "send_mode": "approve",
                  "deadline_at": "2026-08-14T15:00:00", "age_hours": 4,
                  "unit": { "label": "Gilman's Bazaar 5B" } } ],
     "count": 1 }
```

Loop: **poll → send `body` verbatim to `to_phone` → `POST /viewing-negotiation/:id/draft-sent` with
the `event_id`.**

- **Send `body` verbatim.** It is final, rendered from the operator's template.
- A draft **keeps appearing until you call `draft-sent`** — intentional at-least-once. `draft-sent`
  is idempotent, and a duplicate appearance is far safer than a message never going out.
- **If the send fails, do NOT call `draft-sent`.**
- Oldest first. Poll every few minutes; the cron only runs hourly.
- Drafts whose viewing has already happened, or that are over 7 days old, are withheld — a
  confirmation for last Tuesday is worse than silence.

## 15. The one message you must not paraphrase

The tenant opt-out notice quotes an **exact deadline** and says silence will be taken as agreement.
Tenafy will only auto-confirm against a deadline the tenant was actually shown, and if you sit on the
draft until it has nearly lapsed, Tenafy falls back to requiring an explicit yes.

So: send it promptly, and **never** reword it.

## 16. The board

```
GET /viewing-negotiations?status=active&limit=50
```

Per row: state, `awaiting`, `needs_staff_reason`, unit, customer, tenant, viewing time, policy,
timestamps, `next_deadline { kind, due_at, overdue }`, `risk_flags`, `last_event`. Keyset pagination
via `cursor`. `status=active` includes `NEEDS_STAFF`, because a human still has to act.

`next_deadline` is computed by the same code the cron runs, so the board cannot disagree with what
will actually happen.

All times in these payloads are **Asia/Hong_Kong wall clock**, with no timezone
suffix. Do not convert. That includes appointment times (`viewing.proposed_start_at`
— always were Hong Kong) and system-stamped times (`timestamps.*`,
`last_event.created_at`, `next_deadline.due_at`, and on drafts `created_at` /
`expires_at` / `deadline_at`). Drafts expire in 30 minutes, so treating a stamp as
UTC misses the window.

---

## 17. Timers, for your information only

Tenafy owns these. Listed so you can explain the flow, not so you can implement it.

| Clock | Value |
|---|---|
| Nudge a quiet viewer | 1h, then 6h (max 2) |
| Hand to staff | 24h |
| Tenant opt-out window | 4h |
| Counter-offer ping-pong cap | 3 rounds |

Automatic sending is **off**. Nudges are drafts too until the operator enables it.

---

## 18. Migration checklist

- [ ] Swap `/units/available` → `/vacancies`
- [ ] For a firm future move-in date, send `free_on` — not `target_date`, and not both
- [ ] **Branch on `no_match_reason: "too_far_out"`** — offer `check_back_on`, never forward the lead
- [ ] Send `move_out` when the customer states their intended stay length
- [ ] Send `target_date` only when you want ranking by move-in fit (it hides units past
      `hard_max_gap_days`)
- [ ] **Read `next_available` and offer it with `phrasing.later` before telling anyone we have
      nothing** — this is the one that loses real leads
- [ ] Branch wording on `availability.certain`, never on `tier`
- [ ] Use the `phrasing` templates rather than your own copy
- [ ] Do not re-sort or re-filter `vacancies`
- [ ] On `partner_forward.applies`, substitute the placeholders and send — **unless `message` is
      `null`, in which case send nothing**
- [ ] Trust `routable` from `/active`; never infer from `state`
- [ ] Accept the three new states; tolerate unknown ones
- [ ] Read `needs_staff_reason`, and keep the relay row alive on `closed: true`
- [ ] Poll `/drafts`, send `body` verbatim, then `draft-sent` — and never `draft-sent` on a failed send
- [ ] Treat every time in a viewing-negotiation payload as Asia/Hong_Kong wall clock — no suffix, no conversion
- [ ] `POST /viewing-negotiation/:id/cancel` to drop an open negotiation; `409 already_confirmed` means staff must cancel a booked viewing
- [ ] Prefer `unit_id` or `listing_url` over `unit_text` when starting a viewing
- [ ] Delete any timer you have for viewings

## 19. Questions

Two behaviours in this doc are deliberate and get queried every time:

**"Why is the list so short?"** — you sent `target_date` and the hard cap removed the rest.
`hidden_by_gap_cap` says how many. Working as intended. For a firm future date, send `free_on`
instead.

**"Why did the same draft appear twice?"** — you did not call `draft-sent`, or the call failed. That is
the safety property, not a bug.
