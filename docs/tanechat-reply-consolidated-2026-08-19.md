# Tenafy → TaneChat — consolidated reply (19 August 2026)

**One document, two conversations.** Part A answers your 16 August question list; Part B answers the
three API asks you sent on 19 August. Both supersede any earlier version you hold — the availability
rules changed during 18 August, so work from this file.

**Everything described here is live on production and verified against the live feed**, with one
exception clearly marked as switched off: the renewal-ask sequence in Part B §4.

**If you only read three things:** Part A §2 (you are sending the wrong parameter, and it is costing
leads), Part A §8 (three rules now decide what you get, plus a new "move in earlier" outcome), and
Part B §4 (the one item that needs code from you).

---

# Part A — your 16 August questions

Three of your items were bugs on our side and are fixed. Item 2 is about which parameter you send.
Item 7 we are not doing yet.

**Docs updated:** `public-api.md` and the integration guide.

---

## 1. `available_from` was a day late — fixed

You were right, and it was systematic. `available_from` is now **the lease end date**.

**a) Which was authoritative?** `days_until`. It always counted to the lease end date, so the two
fields contradicted each other inside one response. That was our bug, not an ambiguity.

**b) Was the +1 deliberate?** It was, and it was wrong for this operator — turnover here is same-day,
so a lease ending 26 Sep means the unit is free **on** 26 Sep. It is not a per-organisation setting
and now does not need to be.

**c) They now agree.** Re-checked on 18 August across every unit in the live feed: `today +
days_until` equals `available_from` on **16 of 16**.

One knock-on worth knowing: because `free_on` and `target_date` compare against `available_from`,
both now shift a day earlier too. That is intended.

⚠️ Our guide previously said *"`available_from` is already the first free day (lease end + 1). Do not
add a day."* If you compensated for that anywhere, please remove the compensation.

---

## 2. The 20-day cap — you are sending the wrong parameter

No code change, but this is the important one.

**a) It hides, it does not de-prioritise.** Past `hard_max_gap_days` the unit is removed from the
response entirely. That is deliberate — the operator does not want a flat sitting empty for 70 days —
but it was never meant to answer *"is anything available in December?"*

**b) Send `free_on`, not `target_date`.**

| You want | Send |
|---|---|
| A customer with a **firm future move-in date** | `free_on` only |
| Ranking of what best fits a move-in you already have options for | `target_date` |

Within 60 days of today, units that free up after the requested date come back under
`next_available` with `phrasing.later`, so you can say *"nothing on that date, but here is what frees
up sooner"* instead of *"no availability"*. Note that as of today's change `free_on` **does** apply the
ceiling and carries the gap fields — see Part A §8 — but it never hides on the band.

A live example measured on 18 August — `free_on=2026-09-16` returns `count: 0` with
`no_match_reason: "none_free_on_date"`, and **16 rows in `next_available`**: Mong Kok 1C from 20 Sep,
Hollywood 1B from 25 Sep, Jardine 2B from 26 Sep, and so on. That is a productive answer, not an
empty one.

### A live example from 18 August — this one cost a lead

A prospect with a firm 9 October move-in had already viewed one of our units and turned it down: no
lift, and it was on the fifth floor. They asked for a 1st or 2nd floor instead.

| Query | Units returned | Hollywood 1B (1st floor, free 25 Sep) |
|---|---:|---|
| `free_on=2026-10-09` | 14 | **offered** |
| `target_date=2026-10-09` | 13, `hidden_by_gap_cap: 3` | **hidden** |

You sent `target_date`. The cap, then 10 days, suppressed three units — Mong Kok 1C (19 days empty),
**Hollywood 1B (14)** and Jardine 2B (13).

So the unit that answered the customer's stated objection was the one removed — and Hollywood 5B, the
fifth-floor unit they had already rejected, was returned instead. That is the cost of `target_date` on
a firm date, in a single conversation.

**Both of those units are now returned** — the operator raised the ceiling to 15 and the band no
longer hides anything. Under today's rules that same query gives you Hollywood 1B and Jardine 2B with
an ask attached, and hides only Mong Kok 1C at 19 days empty. Still send one parameter, not both.

**c) Yes, these are configurable per organisation, and the operator has changed them twice this week.**
`hard_max_gap_days` went 20 → 10 → **15**. `max_gap_days` is superseded by the stay-length bands and no
longer drives anything. **Please read these from the response rather than hardcoding them** — that is
three changes in a week, and the bands are editable too.

**d) Your December probe will now behave differently — please read Part A §8.** Your test that returned all
18 units for `free_on=2026-12-06` was the behaviour we were fixing, not the behaviour we wanted.
Offering a flat that empties in September to a December enquiry means the operator carries a
seventy-day void.

---

## 3. Vacancy data

**a) `Mong Kok 5D` at 57,703 — you were right, and it is fixed. You can stop suppressing prices.**

The cause was not a formatting or transport problem. Some of our leases have no recurring invoice
schedule — short stays and similar — and on those the stored figure is unreliable: sometimes it is the
whole booking value, sometimes an already-monthly rent, with no way to tell from the record. That unit
held 57,703 against a flat that lets for about 9,000.

**We no longer publish anything derived from those leases.** Where a unit's lease has no schedule,
`rent` is now the unit's own advertised price instead.

Three fields now travel together so you never have to guess:

| Field | Meaning |
|---|---|
| `rent` | the figure to quote |
| `rent_price_min` / `rent_price_max` | the advertised range, so you can quote a band |
| `rent_basis` | `"lease"`, `"advertised"`, or `null` |

- `"lease"` — a scheduled lease; `rent` is what the tenant is genuinely invoiced.
- `"advertised"` — no schedule; `rent` is the advertised price.
- `null` — neither is available. **Present the unit without a price rather than inventing one.**

In the 18 August feed that is **14 `"lease"` and 2 `"advertised"` out of 16, with no `null`** — so
you should see stable prices, not a wholesale shift.

Separately, and also fixed: the feed had been reading a different rent column from the one we invoice,
so `/vacancies` and `/units/search` could disagree about the same unit. They now agree.

**b) Tiers — your reading is correct.**

| Tier | `tier_name` | Meaning | Safe to present as available? |
|---:|---|---|---|
| 1 | `VACANT` | Empty right now | Yes |
| 2 | `NR` | Tenant confirmed not renewing | Yes |
| 3 | `MR/other` | May renew / month-to-month / unconfirmed | Only with the caveat wording |

**Branch on `availability.certain`, never on `tier`** — it is `true` for tiers 1 and 2 and `false` for
tier 3, and it already accounts for a missing end date. Ranking firm units first and capping the
uncertain ones is exactly right.

**c) Tier 1 is used** — it means *vacant today*. `max_tier=1` returning 0 simply means nothing is
empty right now, which was the case on 18 August: the live feed is 3 tier-2 and 13 tier-3, with no
tier-1 at all. Firm availability starts at tier 1, not tier 2.

**d) For "is this unit free for a whole period", use `/units/search`, not `/vacancies`.**

`next_move_in_date` is null because nobody is booked in after those units — it is populated only when
a future lease exists. There is no `free_until` on `/vacancies`, but `/units/search` already answers
your exact question:

```
GET /units/search?move_in_date=2026-12-06&move_out_date=2027-03-29
```

It excludes any unit whose next lease starts on or before your `move_out_date`, so a 113-day stay is
validated in one call.

**e) Correct — use them as you guessed.** `/vacancies` is the roster (filters: `max_tier`,
`property_id`, `limit`, `target_date`, `free_on`). `/units/search` is the filtered route: district,
city, price, bedrooms, bathrooms, amenities, budget, sorting. **Neither filters by size** — size is
returned but not filterable. Tell us if you need it.

---

## 4. Unit resolution — yes, show the candidates

**a) They are already in the response you are receiving.** `candidates` is populated on
`property_only`, `ambiguous` and `multi_unit`, capped at 8:

```json
{ "unit_id": "…", "unit_name": "5B", "property_id": "…",
  "property_name": "Gilman Street Serviced Apartment",
  "label": "Gilman Street Serviced Apartment 5B", "marketable": true }
```

**The order is meaningful** — marketable units first, then by descending match strength. `label` is
display-ready. One caveat: `marketable: false` means we cannot currently arrange a viewing for that
unit, so prefer the marketable ones when you offer a choice.

Your policy of only acting on `confident` is right; you can keep it and still ask *"which of these did
you mean?"*

**b) The full list is five values:** `confident`, `ambiguous`, `property_only`, `multi_unit`, `none`.
Plus `resolved_by` (`unit_id` / `listing_url` / `unit_text`) so you can tell an exact match from a
fuzzy one. All five are documented in `public-api.md`.

---

## 5. Timestamps — you were right, they were UTC

Confirmed and fixed. **All times in these payloads are now Asia/Hong_Kong wall clock, with no
timezone suffix. Do not convert.**

The draft you observed at `2026-08-15T02:15:00` now renders as `2026-08-15T10:15:00`.

You were right not to infer it, because the payload was genuinely inconsistent: appointment times
(`viewing.proposed_start_at`) always were Hong Kong, while everything the system stamped was UTC, and
nothing in the response distinguished them. With a 30-minute draft lifetime that made every draft look
8 hours expired.

Now Hong Kong across the board: `created_at`, `expires_at`, `deadline_at`, `timestamps.*`,
`last_event.created_at`, `next_deadline.due_at`, and `viewing.proposed_start_at` (unchanged — it was
already correct).

---

## 6. Viewing relay

**a) There is now a cancel endpoint.** You were right that you had no way to retire a negotiation.

```
POST /api/public/viewing-negotiation/:id/cancel
Body: { "reason": "customer went cold" }     // optional, max 500 chars
```

- Open negotiation → `200 { "cancelled": true, "already_cancelled": false, "state": "CANCELLED" }`
- Already cancelled → `200 { "cancelled": true, "already_cancelled": true }` — **safe to retry** after
  a network timeout
- `CONFIRMED` / `AUTO_CONFIRMED` → `409 { "reason": "already_confirmed" }`
- Unknown id → `404`

The 409 is deliberate: once a viewing is committed, a tenant is expecting someone at their door and
there is a calendar entry, so cancelling needs a person to tell them. Treat `already_confirmed` as
*"escalate to staff"*. If that turns out to be too strict in practice, tell us.

`reason` is accepted but not yet stored — send it anyway and we will keep it once there is somewhere
to put it.

**b) That behaviour is intentional, and safe to act on.** When `awaiting` is `staff`, `/compose` will
not generate anything new. The draft you saw addressed to the prospect is the escalation notice —
*"our team will follow up"* — which we deliberately keep sendable so the customer is not left in
silence while a human picks the conversation up. **Send it, then stop**; do not nudge past it.

Fair point that nothing marks it as such. We can add an explicit flag if you would use it.

**c) `unit` is populated whenever the negotiation has a resolved unit.** It is null while we are still
working out which unit the customer means — which is precisely when the message body lists candidates.
So the nulls are honest rather than missing data, and you are right to prefer the structured field.
Note it reflects the negotiation, not the individual draft.

**d) The acknowledgement is not lost.** `/draft-sent` has no expiry check — it records the send and
applies the follow-on state change regardless of the draft's age. The 30-minute window only controls
what `/drafts` returns.

Your approach of discarding and calling `/compose` for a fresh one is still the better habit, since an
aged draft may no longer read correctly. Just be aware of the one combination to avoid: **do not call
`/draft-sent` on the stale draft and then send a fresh one** — that records two sends for one message.

---

## 7. FAQ scoping — not yet

FAQ entries cannot currently be scoped to a property or unit; there is no such field, and
`/chat/knowledge` returns the whole set. It is a change we can make, but the operator has parked it
for now. We will come back to you rather than leave it open-ended — please keep maintaining your
per-building FAQ separately in the meantime.

---

## 8. NEW — three rules decide what you get, and a new "move in earlier" outcome

Live now. This is the operator's commercial policy, and it replaces the flat caps you were working
against. Three **independent** rules, each answering a different question.

| Rule | Current value | What it does |
|---|---|---|
| **Ceiling** | 15 days empty (occupied units)<br>30 days from today (units already vacant) | Past this the unit is **not offered at all** |
| **Horizon** | 60 days from today | Past this, only **confirmed-leaving** units are eligible |
| **Band** | 3 / 6 / 10 days by stay length | Past this we **still offer**, and ask the customer to move in earlier |

"Days empty" throughout is the void the operator carries: the requested move-in minus the date the
unit frees up. For a unit that is **already vacant** it is measured from today, because the clock is
already running.

### The band, and why it varies by stay length

| Customer's stay | Empty days we accept |
|---|---:|
| 1 month | 3 |
| 2 months | 6 |
| 3+ months, or not stated | 10 |

Three days empty against a one-month let is a tenth of the income; against a year it is under one
percent. So a short stay has to line up tightly and a long one earns slack. **Send `move_out`** when
the customer tells you their stay length — without it we assume the 3+ month band and mark it
`gap_band_assumed: true`, so you can tell a precise answer from an assumed one.

### The new outcome: ask, do not drop

When the gap is past the band but still inside the ceiling, the unit comes back **with a date**:

```json
{
  "label": "Hollywood 1B",
  "availability": { "available_from": "2026-09-25", "certain": false },
  "gap_days": 14,
  "gap_band_days": 10,
  "gap_band_assumed": true,
  "gap_within_band": false,
  "suggested_move_in_date": "2026-10-05"
}
```

and the operator's wording arrives as `phrasing.gap_ask`:

> We're unable to accept a booking that would leave {units} empty for {gap_days} days. Would you be
> able to move in by {suggested_move_in_date}?

So for that row you would send: *"We're unable to accept a booking that would leave Hollywood 1B empty
for 14 days. Would you be able to move in by 5 October?"*

**Branch on `gap_within_band`.** `false` means send the ask. `suggested_move_in_date` is non-null
exactly when there is an ask to make, and is never a date in the past.

⚠️ **`phrasing.earlier` is deprecated.** It said "a little earlier" with no date, so the customer could
not act on it. It is still returned so nothing breaks, but use `phrasing.gap_ask`.

### Three changes to what you already read

1. **`free_on` now applies the ceiling and carries the gap fields.** It previously applied no gap
   logic at all. Measured on the live feed just now for `free_on=2026-10-09`: **13 units, one hidden**
   (Mong Kok 1C, 19 days empty, past the 15-day ceiling), and **two carrying an ask** — Hollywood 1B
   (move in by 5 Oct) and Jardine 2B (by 6 Oct). Our earlier advice that `free_on` avoids all gap
   logic is no longer true; it still avoids *hiding on the band*, which was the point.
2. **`target_date` no longer hides on the band.** Only the ceiling hides. Both parameters now behave
   the same way for gaps, so the choice between them is back to what it should always have been:
   `free_on` for a firm date, `target_date` for ranking.
3. **`gap_warning` now means "outside the band"** rather than "over `max_gap_days`". Your existing
   handling — *still offer it, use the earlier phrasing* — stays correct, and `gap_within_band` is the
   clearer field to move to.

### Beyond the horizon

Unchanged in the main: past 60 days only confirmed-leaving units are eligible, and if none qualify you
get `no_match_reason: "too_far_out"` with `check_back_on` — the date the request comes inside the
horizon — plus `check_back_in_days`.

One narrow change: a confirmed-leaving unit past the band but inside the ceiling is now **offered with
the ask** instead of dropped. In practice that is a five-day window per unit, so `too_far_out` still
behaves as before for a December enquiry.

⚠️ **`partner_forward.applies` is always `false` on `too_far_out`**, even though `count` is 0. The
operator's `phrasing.too_far_out` text ends by promising that a partner agency (Parcelle) will reach
out — **they arrange that themselves.** Do not also run your own referral path, or the customer gets
contacted twice.

### Vacant units are no longer always offered

Previously a unit standing empty was returned regardless of how far off the move-in was. Now a vacant
unit is withheld when the requested move-in is more than **30 days** away — beyond that the ask would
be so large it is not a negotiation. Inside 30 days it is offered, and carries the same ask if the gap
is past the band.

### Which phrasing you can rely on being current

Only two are operator-authored and editable at any time — read them fresh on every call:

| Template | Source |
|---|---|
| `phrasing.too_far_out` | **operator-authored** |
| `phrasing.gap_ask` | **operator-authored** |
| `phrasing.certain`, `uncertain`, `later`, `manual`, `earlier` | fixed text from us |

**Correction to an earlier version of this note:** we said the operator edits `phrasing.uncertain`.
They do not — it is fixed text. Still use it verbatim; just do not expect it to change.

### Worked examples, measured after deploy on 18 August

| Customer asks for | Days out | What you get |
|---|---:|---|
| 16 Sep | 29 | `count: 0`, `none_free_on_date`, 16 rows in `next_available` |
| 9 Oct | 52 | 13 units; 2 carry an ask; 1 hidden past the ceiling |
| 9 Oct, 1-month stay | 52 | band tightens to 3 — Hollywood 1B asks for **28 Sep** instead of 5 Oct |
| 17 Oct | 60 | 16 units, all tiers — 60 days is inside the horizon |
| 18 Oct | 61 | 2 units, confirmed-leaving only |
| 6 Dec | 110 | `too_far_out`, check back 7 Oct |

Row three is the commercial logic in one line: same unit, same date, but a longer commitment earns a
later start.

### Why December is usually empty

Not a system limit — the operator does not know yet. Of the 93 units whose leases end beyond 60 days,
**84 may renew**, 7 have no intent recorded, and only **2 are confirmed leaving**. "Check back nearer
the time" is the honest answer, and worth putting to the customer in those terms rather than implying
we are full.

---

## 9. Two things we noticed in your drafts on 18 August

Both are in draft generation, not in the data we send you.

### a) Uncertain units are being presented as firm

A draft on 18 August offered *"Gilman's Bazaar 2A is a 250 sqft studio in Central, available from
30 September at HK$17,000/month"* as plain fact. Our response for that unit, at that moment:

```json
{ "label": "Gilman's Bazaar 2A", "tier": 3, "tier_name": "MR/other",
  "availability": { "available_from": "2026-09-30", "certain": false } }
```

The same response carried `phrasing.uncertain`:

> We may also have {units} available, however the tenant may renew, they're not sure

Every fact in your draft was correct — 250 sqft, Central, 30 September, HK$17,000. Only the
uncertainty was dropped, and that is the part that matters: that tenant has not said whether they are
leaving.

Your own pre-send panel flagged it. So the check exists — it just runs as advice to a human after
generation rather than as a constraint during it. **When `availability.certain` is `false`, treat the
hedge as mandatory**, and use `phrasing.uncertain` verbatim rather than composing around it. The
operator edits that wording, and we serve the current version on every call.

### b) The drafts are formatted for email, not WhatsApp

Two specifics:

- **Double asterisks are not WhatsApp bold.** WhatsApp uses a single asterisk, so a heading written as
  `**Gilman's Bazaar 2A**` arrives with the asterisk characters visible — the message reads as broken
  as well as long.
- Multi-paragraph blocks separated by blank lines read as a letter rather than a chat message.

None of that formatting comes from us — every string we send (`phrasing.certain`,
`phrasing.uncertain`, `phrasing.later`, `phrasing.too_far_out`) is a single plain-text line with
`{units}` and `{date}` placeholders, ready to drop into a chat.

---

# Part B — your 19 August API asks

Thanks for the write-up, and for owning the incident so precisely — it made this quick to check from
our side.

One corroboration first: your diagnosis is right, and our data supports it. Our published viewing
window for this org is **Mon–Sat, 11:00–19:00**. The 11:00 in that draft is our opening hour, which is
exactly what a model would produce given our hours and a retired booking script but no actual
negotiation to read.

---

## B1. Confirmed slot on `/viewing-negotiation/active` — yes, with three caveats

Agreed, and it is smaller than you would think: `current_proposed_datetime` is already fetched by that
query and simply dropped when we build the payload.

### ⚠️ Settle the timezone question before you build anything

You wrote that you run the box in UTC and derive Hong Kong wall-clock in application code. **Our
payloads are already Hong Kong wall clock, with no offset** — `proposed_start_at` included, and that
was true before this change. If your new server applies its own "derive Hong Kong" step to a value
that is already Hong Kong, every viewing time lands **eight hours out**, and a verification check built
on it would confirm wrong times rather than catch them.

Given you have just moved servers, please confirm this independently of this ask: **is the new box
treating our timestamps as UTC?** It is the same failure class we fixed together last week, and a
server move is exactly how it comes back.

On the format: we would rather not put an offset on this one field, because a single
offset-suffixed value sitting beside zone-less ones — with nothing in the payload distinguishing them —
is precisely how the original mix-up arose. But you are right that "trust the prose" is not good enough
after the week you have had. So we propose making the object **self-describing** instead:

```json
"confirmed_slot": {
  "start_at": "2026-08-21T11:00:00",
  "end_at":   "2026-08-21T11:30:00",
  "timezone": "Asia/Hong_Kong",
  "unit_id": "8326307481849856",
  "unit_label": "Poplar 2B"
}
```

Same convention as the rest of the payload, but the zone travels with the value, so nothing has to be
inferred and no offset arithmetic is required at either end. If you would still prefer true offsets we
will do it — but as a versioned change across **every** timestamp at once, with notice, rather than one
field at a time.

### Two more things

- **`AUTO_CONFIRMED` is a separate state and also means committed.** It is what happens when the
  occupant does not reply in time. If you branch on `CONFIRMED` alone you will treat a real viewing as
  "none exists" and refuse a true statement — the opposite of the failure you are guarding against.
  Branch on both.
- **On the end time:** the negotiation itself holds only a start, but once a viewing is confirmed we
  create a booking that does carry a duration — currently 30 minutes, from a column default rather than
  a setting anyone has chosen. So we can give you `end_at` for a confirmed slot, which is the state you
  care about. Just know it is a default rather than a considered policy; if the length of a viewing
  starts mattering to you, say so and we will make it a real configurable value first.

---

## B2. Renewal-decision deadline — our concern with sending a date

Your instinct about the 45 days was reasonable, and the date *is* arithmetically derivable as lease end
minus notice period. We checked the live data before answering, and it does not support the field:

- **101** units are currently undecided (may-renew or unconfirmed) with a future lease end.
- **43 of them have a real notice period recorded** — 42 at 45 days, one at 30. The other **58 have
  none**, so any date for those would be a house default rather than anything from the lease.

So the answer splits, and we would rather split it than pick one blanket policy:

**Where the lease records a notice period, we will send you the date.** It is real — lease end minus
notice — and you can use it as you intended: *"we should know by 5 September."*

**Where it does not, we will send nothing rather than a default.** The tempting alternative is to send
a guessed date with a flag such as `basis: "default_30_days"` and let you hedge the wording. We would
rather not, for one specific reason: a draft on 18 August presented a may-renew unit as firmly available
even though `availability.certain` was `false` in the same response, and your own pre-send check caught
it. That is not a criticism — it is evidence that a qualifier sitting one hop from the text is easy for
a drafting model to drop, and a date carries far more weight with a prospect than a flag does. An absent
field cannot be misread; a flagged guess can.

So `renewal_decision_by` will be present and true, or absent. Never present and invented.

**And for the units with no date, we are going after the actual answer instead.** When a prospect asks about a unit whose tenant has not decided, and we are inside the
decision window, we will ask that tenant directly whether they intend to renew — through you, so it
still comes from the one number. Their answer updates the renewal intent you already read, which means
you stop getting "the tenant may renew" on that unit and start getting a real
`availability.certain: true` or the unit dropping off the roster honestly.

That is a better answer to the question you actually asked — *"does this resolve in days or months?"* —
because it resolves it rather than estimating it.

Two notes on scope so you can plan:

- This is a workflow on our side, not a field, so it will take longer than asks 1 and 3. We will come
  back to you with the design before anything reaches a tenant, since the messages would go through
  your channel.
- It is demand-triggered by design. Of those 101 units, only **4** are both undecided and past their
  decision window today — and two of them are units your prospects have asked about this week. We are
  not going to chase 101 tenants; we are going to chase the ones someone actually wants.

If you would still rather have an estimated date in the meantime, we can send one clearly marked as an
estimate so you can hedge the wording. Tell us and we will add it — we just do not want to hand you a
guess that reads like a fact.

---

## B3. Read-back on propose/counter — this is already built, and it already names the unit

Good news, and possibly a live bug worth chasing together.

The read-back exists, it is switched on for this org (`read_back: 1`), and it fires exactly where you
asked — on a fresh time proposal, before we touch the calendar and before the occupant hears anything.
The message we generate is:

> "Just to confirm — a viewing of **{unit}** at **{property}** on **{proposed time}**? Reply YES to
> confirm, or send a different day and time."

So it already carries the unit, the property and the time. Nothing to add.

**Which raises the more useful question: why are you not seeing it?** Two possibilities, and the second
would matter a great deal:

1. This org runs `relay_mode: manual`, so that message is **queued as a draft for staff rather than
   auto-sent**. You would receive it through the drafts flow rather than as an automatic outbound. If
   your integration only watches auto-sent traffic, it would look absent.
2. If your drafting layer composes its own message for these turns instead of sending the draft we
   produce, our read-back never reaches the prospect — you would be generating replacement text at
   precisely the moment we had already written the safe version.

The second is worth checking properly, because it is the same shape as last week's incident: a
model-authored sentence standing in for a system-authored one. If that is what is happening, the fix on
your side is smaller and more valuable than any field we could add — send our draft for these turns
rather than composing over it.

Happy to trace a specific negotiation with you if that helps.

---

## B4. NEW, and the one thing we need you to build: relaying renewal answers

This is the "we will get the actual answer instead" from Part B §2, now built and deployed. It is switched
**off**, so nothing is queued and nothing has been sent to any tenant.

When it is enabled, we will ask a tenant — through your number — whether they intend to extend, up to
three times, and then hand the lease to a human if there is no reply. We need the answer back.

### What we need from you

```
POST /api/public/renewal-ask/:id/reply
{ "intent": "extend" }          // or "leaving" or "unsure"
```

or, if you would rather we classify free text:

```
{ "text": "yeah we're staying thanks" }
```

Either is fine. `intent` is the safer of the two — we parse text conservatively and anything ambiguous
becomes `unsure`, which changes nothing.

### The send loop

```
GET  /api/public/renewal-asks/pending          → asks queued for dispatch, with the message to send
POST /api/public/renewal-ask/:id/sent          → confirm it went
```

⚠️ **An ask is handed out once and is never re-offered.** We deliberately removed the ten-minute
re-queue: if you sent the message and only the confirmation was lost, re-offering it would put the
same message in front of the tenant twice. An unconfirmed ask is treated as spent rather than repeated
— so please do call `/sent` on success, or that tenant simply moves to the next ask in the sequence.

### Why the reply matters more than it looks

Without it, a tenant who answers you gets asked again, and again, and is then flagged to our staff as
unresponsive. That is worse than never asking. We have built a manual fallback so our team can record
an answer they see in your inbox, but that only works if someone is watching it.

### What you do NOT need to build

Sending. We already post to your `/send` endpoint ourselves. And no interactive buttons — the operator
chose plain text, so there is no template approval for you to chase.

---

# One pattern worth naming

You flagged that the Mong Kok miss was not our data — our API returned the unit and your side filtered
it out. Thank you for checking that rather than reporting it as a gap; it saved us looking.

It is worth putting three things side by side, because separately they look like three unrelated bugs
and together they look like one:

| | What we sent | What reached the customer |
|---|---|---|
| Mong Kok | the unit, correctly | filtered out on your side |
| Gilman's Bazaar 2A, 18 Aug | `certain: false` plus `phrasing.uncertain` | presented as firmly available |
| Viewing read-back | a draft naming unit, property and time | possibly replaced by generated text |

In each case our payload was right and something downstream dropped or replaced it. We are not raising
this as a complaint — the first one you found yourselves, and the second your own pre-send check
caught. But if there is a single place in your pipeline where our structured fields give way to
model-generated prose, fixing that one place is worth more than any field we could add, including the
three you have asked for.

The third row is the one to check first, because it is the same shape as the incident you reported: a
system-authored sentence replaced by a model-authored one.

## On the fourth ask

You mentioned holding back a tenancy-stage and checklist request so these three are not crowded out.
That is the right call and we would rather you did. Send it as its own conversation whenever you are
ready — it is a bigger piece of work on our side and it deserves its own thread rather than being
item four on a list.

---

# What to change on your side

Ordered by what it recovers, not by the order the items were raised.

| # | Change | Why it matters |
|---|---|---|
| 1 | **Send `free_on`, not `target_date`**, for a firm move-in date — and never both | Part A §2. On one real enquiry `target_date` hid the only unit that answered the customer's objection |
| 2 | **Branch on `gap_within_band`**; when false send `phrasing.gap_ask` with `suggested_move_in_date` | Part A §8. Turns a silently-dropped unit into a negotiation |
| 3 | **Relay renewal replies** to `/renewal-ask/:id/reply` | Part B §4. Without it a tenant who answers keeps being asked, then is flagged unresponsive |
| 4 | **Confirm your new server is not converting our timestamps** | Part B §1. Ours are already Hong Kong with no offset; a server move is how this bug returns |
| 5 | **Make the hedge mandatory when `availability.certain` is `false`**, using `phrasing.uncertain` | Part A §9. Presenting a may-renew unit as firm costs trust, not just a lead |
| 6 | **Send plain text, not markdown** — WhatsApp uses single asterisks | Part A §9 |
| 7 | **Handle `no_match_reason: "too_far_out"` as its own outcome** — send the operator's text, never your own partner referral | Part A §8 |
| 8 | **Send `move_out`** when the customer states their stay length | Part A §8. Applies the right gap band |
| 9 | **Stop hardcoding gap and cap numbers** — read them from the response | The ceiling moved 20 → 10 → 15 in one week |
| 10 | **Read `rent_basis`** and stop suppressing prices; **read timestamps as Hong Kong** | Part A §3 and §5 |
| 11 | **Show `candidates`** on `property_only` / `ambiguous`; **call `/cancel`** rather than sending a message you do not want sent | Part A §4 and §6 |
| 12 | **Move off `phrasing.earlier`** to `phrasing.gap_ask` | Part A §8 |

## What we owe you

- `confirmed_slot` on `/viewing-negotiation/active`, as Hong Kong wall clock with an explicit
  `timezone` field (Part B §1).
- The unit name added to the read-back message, if it turns out you are not receiving ours at all
  (Part B §3).
- `renewal_decision_by` where a lease records a real notice period, absent where it would be a guess
  (Part B §2).

Happy to take a call on any of it — given how much of Part A §8 changed, a call may be quicker than a
thread. Items 1, 2 and 3 above are the ones we would most like confirmation you are handling.
