# TaneChat ↔ Tenafy integration guide

**For:** the TaneChat team.
**Covers:** answering availability inquiries, and running a viewing from first message to booked.
**Base URL:** `https://platform.tenafy.com/api/public`
**Auth:** `X-API-Key: <key>` on every request. Availability (Part A) needs only a **read-only** key.
Viewings (Part B) need a **read-write** key: four of its endpoints are POSTs — `start`,
`prospect-reply`, `tenant-reply`, `draft-sent` — and a read-only key is rejected on any of them with a
`403` before the handler runs. See the table in §9.

Verified against production on 2026-08-13. Where this doc shows a payload, it was captured from a
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
GET /vacancies?target_date=2026-10-12&free_on=2026-10-12
```

| Param | Default | Notes |
|---|---|---|
| `target_date` | none | `YYYY-MM-DD`. **Send it whenever you know it.** This ranks and warns by move-in fit. Without it there is no gap to judge, so no ranking, no warnings and no hiding. |
| `free_on` | none | `YYYY-MM-DD`. This filters to units the customer can actually take on that date. It answers a different question from `target_date`, and the two can be combined. |
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
      "source": "lease", "manual": null,
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
you.

## 4. The four fields that decide your wording

**`availability.certain`** — branch on **this**, not on `tier`. `true` means the unit will definitely
be free (vacant now, or the tenant has confirmed they are leaving). `false` means the tenant may renew
or may move out early. If a tier is ever added or re-numbered, `certain` keeps your logic correct.

**`source`** — always present. `"lease"` means availability comes from lease records. `"manual"` means
an operator-authored override because the tenant may move out early. Manual rows also include
`manual.override_id`, `manual.expires_on`, and `manual.reason`.

**`gap_days`** — signed, and the sign matters:

- **positive** → the flat sits empty this many days before your customer arrives. Lost rent.
- **zero** → perfect fit.
- **negative** → the flat is not free until *after* they want it; they would wait. Costs nothing.

**`gap_warning`** — `true` past `max_gap_days` (10). Advisory. The unit is still offered; use
`phrasing.earlier`.

**`available_after_target`** — the negative-gap case. Never carries a `gap_warning`, because waiting
costs the operator nothing.

`available_from` is **already the first free day** (lease end + 1). Do not add a day.

## 5. What to say

| Situation | Say |
|---|---|
| `certain: true`, `status: "now"` | "available now" |
| `certain: true`, `status: "from_date"` | "available from {available_from}" |
| `gap_warning: true` | still offer it — use `phrasing.earlier` |
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

Past `hard_max_gap_days` (20) a unit is **removed** from the response. Two exemptions:

- **A unit that is already vacant is never hidden**, however large its gap. It is the one most
  urgently needing a tenant.
- **`available_after_target` units are never hidden.** Waiting costs no rent.

`hidden_by_gap_cap` tells you how many were removed. In §3 it is `3` — so the operator has six
suitable-ish units and you were shown the best three. **This is normal. Do not treat a short list as
an error or ask for `max_tier=3` to compensate.**

## 7. When there is nothing — you send the partner message

If `vacancies` is empty, `partner_forward.applies` is `true` and **TaneChat sends
`partner_forward.message` to the partner agencies.**

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
- `"none_free_on_date"` — units exist, none are free on the requested `free_on` date
- `"no_vacancies"` — nothing at all
- `null` — the list is non-empty

Also tell the customer. Either reason means the same thing to them: nothing suitable right now, and
we are passing it to partners.

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
| `/viewing-negotiation/:id/prospect-reply` | POST | ✗ write |
| `/viewing-negotiation/:id/tenant-reply` | POST | ✗ write |
| `/viewing-negotiation/:id/draft-sent` | POST | ✗ write |
| `/viewing-negotiation/active?phone=` | GET | ✓ |
| `/viewing-negotiation/drafts` | GET | ✓ |
| `/viewing-negotiations` | GET | ✓ |

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

- [ ] Swap `/units/available` → `/vacancies`, and send `target_date` whenever known
- [ ] Send `free_on` when the customer has a firm date and you need a hard availability filter
- [ ] Branch wording on `availability.certain`, never on `tier`
- [ ] Use the `phrasing` templates rather than your own copy
- [ ] Do not re-sort or re-filter `vacancies`
- [ ] On `partner_forward.applies`, substitute the placeholders and send — **unless `message` is
      `null`, in which case send nothing**
- [ ] Trust `routable` from `/active`; never infer from `state`
- [ ] Accept the three new states; tolerate unknown ones
- [ ] Read `needs_staff_reason`, and keep the relay row alive on `closed: true`
- [ ] Poll `/drafts`, send `body` verbatim, then `draft-sent` — and never `draft-sent` on a failed send
- [ ] Prefer `unit_id` or `listing_url` over `unit_text` when starting a viewing
- [ ] Delete any timer you have for viewings

## 19. Questions

Two behaviours in this doc are deliberate and get queried every time:

**"Why is the list so short?"** — the hard cap removed the rest. `hidden_by_gap_cap` says how many.
Working as intended.

**"Why did the same draft appear twice?"** — you did not call `draft-sent`, or the call failed. That is
the safety property, not a bug.
