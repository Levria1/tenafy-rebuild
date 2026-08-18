# Tenafy → TaneChat — answers to your 16 August questions

**Everything below is live on production and verified against the live feed after deploying, on
18 August.** This supersedes any earlier draft of this note: the availability rules changed during the
day, so if you have an earlier version, work from this one.

Three of your items were bugs on our side and are fixed. Item 2 is about which parameter you send.
Item 7 we are not doing yet.

**§8 is the one that needs code from you**, and it has changed substantially — it is no longer just a
60-day cut-off. There is now a third outcome besides "here you go" and "too far out": *"we can do it,
but could you move in earlier?"*

**Docs updated:** `public-api.md` and the integration guide.

---

## 1. `available_from` was a day late — fixed

You were right, and it was systematic. `available_from` is now **the lease end date**.

**a) Which was authoritative?** `days_until`. It always counted to the lease end date, so the two
fields contradicted each other inside one response. That was our bug, not an ambiguity.

**b) Was the +1 deliberate?** It was, and it was wrong for this operator — turnover here is same-day,
so a lease ending 26 Sep means the unit is free **on** 26 Sep. It is not a per-organisation setting
and now does not need to be.

**c) They now agree.** Re-checked this morning across every unit in the live feed: `today +
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
ceiling and carries the gap fields — see §8 — but it never hides on the band.

A live example from this morning — `free_on=2026-09-16` returns `count: 0` with
`no_match_reason: "none_free_on_date"`, and **16 rows in `next_available`**: Mong Kok 1C from 20 Sep,
Hollywood 1B from 25 Sep, Jardine 2B from 26 Sep, and so on. That is a productive answer, not an
empty one.

### A live example, from this morning — this one cost a lead

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

**d) Your December probe will now behave differently — please read §8.** Your test that returned all
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

In this morning's feed that is **14 `"lease"` and 2 `"advertised"` out of 16, with no `null`** — so
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
empty right now, which is the case this morning: the live feed is 3 tier-2 and 13 tier-3, with no
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

## 9. Two things we noticed in your drafts this morning

Both are in draft generation, not in the data we send you.

### a) Uncertain units are being presented as firm

A draft this morning offered *"Gilman's Bazaar 2A is a 250 sqft studio in Central, available from
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

## Summary of what to change on your side

1. **Send `free_on` for a firm future move-in date**, `target_date` only for ranking, and never both.
2. **Branch on `gap_within_band`.** When it is `false`, send `phrasing.gap_ask` with
   `suggested_move_in_date`. This is the main new work, and the one that recovers leads we were
   previously dropping.
3. **Send `move_out`** whenever the customer states their stay length, so the right band applies and
   the suggested date is real rather than assumed.
4. **Handle `no_match_reason: "too_far_out"` as its own outcome** — offer the check-back date, send the
   operator's text verbatim, and do **not** run your own partner referral.
5. **Make the hedge mandatory when `availability.certain` is `false`**, using `phrasing.uncertain`.
   Presenting a may-renew unit as firm is the error that costs trust rather than just a lead.
6. **Send plain text, not markdown.** No `**bold**` — WhatsApp uses single asterisks — and chat length,
   not letter length.
7. **Stop hardcoding the gap numbers.** The ceiling moved 20 → 10 → 15 in a week, and the bands are
   operator-editable. Read `gap_band_days` and `hard_max_gap_days` from the response.
8. **Read timestamps as Hong Kong**, no conversion.
9. **Stop compensating for the `available_from` off-by-one** if you added any, and **read `rent_basis`**
   so you can stop suppressing prices.
10. **Show `candidates`** on `property_only` / `ambiguous`, and **call `/cancel`** rather than sending a
    message you do not want to send.
11. **Move off `phrasing.earlier`** to `phrasing.gap_ask`.

Happy to take a call — given §8 now has three outcomes rather than two, a call may be quicker than a
thread. Items 2, 4 and 5 are the ones we would most like confirmation you are handling.
