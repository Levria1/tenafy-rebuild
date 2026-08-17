# Tenafy → TaneChat — answers to your 16 August questions

**Everything below is LIVE on production now.** Thank you for the detail in that list — the tables
and the 18-of-18 check made items 1 and 5 quick to confirm, and you were right on both.

Three of your items were bugs on our side and are fixed. Item 2 is about which parameter you send —
that is the one costing you the most leads — and it now comes with a behaviour change of ours, in §8.
Item 7 we are not doing yet.

**Read §8 before you change anything.** It is new, it is live, and it is the only part of this note
that needs code from you.

**Docs updated:** `public-api.md` and the integration guide. Two entries in them were actively wrong
and told you to do the wrong thing — details under items 1 and 2.

---

## 1. `available_from` was a day late — fixed

You were right, and it was systematic. `available_from` is now **the lease end date**.

Jardine 2B now returns `2026-09-26` and Hollywood 5B `2026-10-11`, matching both your `days_until`
arithmetic and our own Vacancy screen.

**a) Which was authoritative?** `days_until`. It always counted to the lease end date, so the two
fields contradicted each other inside one response. That was our bug, not an ambiguity.

**b) Was the +1 deliberate?** It was, and it was wrong for this operator — turnover here is same-day,
so a lease ending 26 Sep means the unit is free **on** 26 Sep. It is not a per-organisation setting
and now does not need to be.

**c)** They now agree. We verified across every unit in the live feed: `today + days_until` equals
`available_from` on all of them.

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

`free_on` does not apply the `hard_max_gap_days` cap. Within 60 days of today, units that free up
after the requested date come back under `next_available` with `phrasing.later`, so you can say
*"nothing on that date, but here is what frees up sooner"* instead of *"no availability"*.

⚠️ **Do not send both for a future date.** The `target_date` gap cap is applied **first**, so `free_on`
can only filter what already survived the cap — you get the worst of both. Our guide said the two
"can be combined"; that advice was wrong and has been removed.

**c) Yes, `hard_max_gap_days` is configurable per organisation** (currently 20, must be ≥
`max_gap_days`).

**d) But your December probe will now behave differently — please read §8.** Your test that returned
all 18 units for `free_on=2026-12-06` was the behaviour we were fixing, not the behaviour we wanted.
Offering a flat that empties in September to a December enquiry means the operator carries a
seventy-day void. §8 explains what happens instead.

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

Across the current live feed this changes exactly one unit of seventeen, and no scheduled lease moves
at all — so you should see stable prices, not a wholesale shift.

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
empty right now. Firm availability starts at tier 1, not tier 2.

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

## 8. NEW — we no longer take bookings more than 60 days out (unless the unit is confirmed)

**This is a behaviour change, live now, and it affects the advice in §2.** It is deliberate and it is
the operator's commercial policy, not a bug.

### Why

Your December probe returned all 18 units. Every one of them frees up in September or October. Taking
that booking means the operator holds an empty flat for seventy-plus days. We would rather tell the
customer honestly to come back than quote them something that loses money.

### What happens now

We compare the requested date against a **60-day booking horizon**.

| Requested date | Behaviour |
|---|---|
| Within 60 days | **Unchanged.** Exactly as §2 describes, `next_available` and all. |
| Beyond 60 days | Only units whose tenant has **confirmed they are leaving** (`tier: 2`, `certain: true`) and who free up close enough to the date. Nothing else — no may-renew units, and no already-empty units. |
| Beyond 60 days, nothing qualifies | `no_match_reason: "too_far_out"` plus **when to come back**. |

### The too-far-out response

```json
{
  "vacancies": [], "count": 0,
  "free_on": "2026-12-06",
  "no_match_reason": "too_far_out",
  "booking_horizon_days": 60,
  "booking_gap_days": 10,
  "check_back_in_days": 51,
  "check_back_on": "2026-10-07",
  "partner_forward": { "applies": false, "message": null },
  "phrasing": { "too_far_out": null }
}
```

- **`check_back_on`** is the date the request comes inside the horizon — the earliest the answer could
  change. It is not a promise that something will be free, and please do not present it as one.
- **`check_back_in_days`** is the same thing as a count of days, for phrasing like *"do check back with
  us in about seven weeks"*.
- **`phrasing.too_far_out`** is an operator-authored template, `null` until they write one. **If it is
  `null`, use your own wording or escalate — do not invent ours.**

### Three things not to get wrong

1. **`too_far_out` is not `no_vacancies`.** Branch on it separately. It means *"ask them to come
   back"*, never *"we have nothing"*.
2. **`partner_forward.applies` is always `false` on this outcome**, even though `count` is 0. This is a
   lead the operator wants to keep, not one to hand to an agency. Do not forward it. (The operator may
   later choose to offer a partner referral for these — if so it will arrive as their own authored
   message, and we will tell you.)
3. **`next_available` is absent beyond the horizon.** Inside the horizon it behaves exactly as before.

### Optional: tell us the lease length and we can be more precise

New optional parameter **`move_out=YYYY-MM-DD`**. Beyond the horizon, how much empty time we will
accept before a move-in depends on how long the customer is staying:

| Requested stay | Maximum gap we accept |
|---|---:|
| 1 month | 3 days |
| 2 months | 6 days |
| 3 months or longer | 10 days |
| Not stated | 10 days |

So a short stay has to line up much more tightly than a long one. Send `move_out` when the customer
has told you, and we will apply the right band; leave it off and we use 10. Malformed values are a
`400`, like `free_on`.

`/units/search` has its **own** bands, set separately from the booking ones above. They currently hold
the same values, so `gap_band_days` and `gap_within_tolerance` behave as the table shows — but the
operator can tighten booking without touching search, or the reverse, so **do not assume the two
agree**. Read `gap_band_days` from the response rather than hardcoding the table.

Those numbers have shifted against what you saw before today: one-month stays tightened from 5 days to
3 and twelve-month stays from 20 to 10, while two-month and three-to-five-month stays loosened
slightly. If you were reading `gap_within_tolerance`, it is still correct — just calibrated to the
operator's actual policy now.

Worth knowing the two carry different weight. On `/vacancies` beyond the horizon, a band is a **hard
refusal** — outside it, you do not see the unit. On `/units/search` it is **advisory only**: nothing is
filtered, and `gap_within_tolerance` simply tells you whether to caveat the result.

### Worked examples, from today

| Customer asks for | Days out | What you get |
|---|---:|---|
| 16 Sep | 30 | Normal answer, all tiers |
| 16 Oct | 60 | Normal answer, all tiers |
| 17 Oct | 61 | 2 confirmed units only |
| 28 Oct | 72 | 1 confirmed unit |
| 6 Dec | 111 | `too_far_out`, check back 7 Oct |
| 6 Dec, 1-month stay | 111 | `too_far_out` (gap band tightens to 3) |

### Why December is usually empty

Not a system limit — the operator genuinely does not know yet. Of the 97 units whose leases end beyond
60 days, **87 are may-renew**: the tenant has not said whether they are staying. Only 3 are confirmed
leaving. So "check back nearer the time" is the honest answer, and worth saying to the customer in
those terms rather than implying we are fully booked.

---

## Summary of what to change on your side

1. **Send `free_on` instead of `target_date`** for firm future move-in dates, and never both. This
   fixes the empty-response problem on its own.
2. **Stop compensating for the `available_from` off-by-one** if you added any.
3. **Read timestamps as Hong Kong**, no conversion.
4. **Use `/units/search?move_in_date=&move_out_date=`** to validate a whole stay.
5. **Show `candidates`** on `property_only` / `ambiguous` to ask which unit they meant.
6. **Call `/cancel`** instead of sending a message you do not want to send.
7. **Read `rent_basis`** and you can stop suppressing prices — quote `rent`, show the range where it
   helps, and show no price at all when `rent_basis` is `null`.
8. **Handle `no_match_reason: "too_far_out"` as its own outcome** — offer the check-back date, never
   the partner referral, and never treat it as "no availability". This is the one item in this note
   that needs code from you before it behaves well.
9. **Send `move_out` when you know the intended stay length**, so we apply the right gap band.

Happy to take a call on any of this — and given §8 changes what a far-future date returns, a call may
be quicker than a thread. Items 1, 5 and 8 are the ones we would most like confirmation you are
handling correctly at your end.
