# To TaneChat — move_in_date, window search, and the rest

**Draft for Chris to review and send. Not sent.**

Answers their note that supersedes the earlier one (the version that drops the
"your endpoints disagree" framing and leads with the `move_in_date` question).

**Status: built and tested, 970 backend tests passing. NOT YET DEPLOYED at time
of writing — deploy before sending, since the note reads as though it is live.**

Supersedes `tanechat-reply-search-2026-08-21c.md`, which answered their previous
message. Items 1 and 2 here were never addressed by that draft; items 3 and 4 are
carried over from it because they are still the answers.

---

Hi team,

Your first question is the right one and the answer is that you were reading the
endpoint correctly — it just does not do what you needed, and could not be asked to.

## 1. `move_in_date` is a single day, and `available_from` is not a property of the unit

Both of your observations are exactly right, and the second one is our fault.

`move_in_date` means "free on this specific day". `available_from` in the response
defaults to whatever date you sent, and only differs when the unit's last lease ended
earlier. So it echoes your question back at you rather than describing the flat. Sending
today + 18 months did not widen anything — it asked "who is free in February 2028", and
answered honestly for a tenant moving in then.

**Send the customer's real move-in date. Never a synthetic far-future one.** That alone
fixes the "December flats for an August enquiry" result.

But it would not have found `Poplar 2B` for you, and that is the part worth fixing
properly.

### Why you could not see Poplar 2B

It is occupied on 21 August and frees up on 17 October. A single-day query for 21 August
correctly excludes it. There was no way to ask "who is free at *some point* between
August and December" — which is the actual question. `move_out_date` would not have
rescued it either: that is a strict whole-window filter, so it would still have dropped
the flat that covers half her stay.

### What we built: window search

```
GET /units/search
  ?available_between_start=2026-08-21
  &available_between_end=2026-12-31
  &district=Sheung Wan
```

Each result reports the **longest single unbroken stretch** it is free inside that
window:

```json
{
  "property_name": "Poplar",
  "unit_name": "2B",
  "available_from": "2026-10-17",
  "available_until": "2026-12-31",
  "coverage_days": 76,
  "availability_certain": true,
  "area_match": "district"
}
```

Four things about it, in the order they will matter to you:

**Quote the dates, not the coverage.** `coverage_days` is there so we can sort by it.
Say "Poplar 2B is available 17 October to 31 December" — never "covers 57%". A customer
thinks in dates, and we would rather not give you a percentage to accidentally send.

**Only one stretch, never two.** A unit free 21 Aug–3 Sep and again 5 Nov–31 Dec reports
only the November one. Fragments are never summed. Two stretches is not an offer anyone
can accept for a continuous stay, and a summed total would overstate what we can actually
give someone.

**`availability_certain` — please read this one.** Single-day search only offers an
occupied unit when the sitting tenant has confirmed they are not renewing. Window search
cannot apply that rule, because it would throw away precisely the units it exists to find.
So it returns them and flags them instead: `false` means the opening depends on a tenant
who has not said they are going. Offer those as *possible*, not as available. This is the
same distinction `/vacancies` draws with tier 3.

**Districts became a preference.** In window mode only, `district` no longer excludes —
units elsewhere come back in a sibling `alternatives_outside_area` array, ranked district
→ same side of the harbour → anywhere. So you can say "nothing in Sheung Wan covers your
dates, but we have one in Mong Kok free 17 October to 31 December — would you consider
it?" instead of reporting nothing. That array is always present in window mode, empty
when there is nothing, so an empty result is distinguishable from an old deployment.

`city` still filters strictly. Naming a city is a constraint; a flat across the harbour is
not an alternative to it.

Fields measured against a move-in date — `forward_gap_days`, `gap_within_tolerance` and
the rest — are `null` in window mode, because there is no single move-in date to measure
from. We would rather return nothing than a plausible number computed against a date that
had no bearing on the result.

## 2. `Poplar 4D` — your reading is right, and the field was missing

Vacant now, something booked before January, so 1 January is the next date it can take a
normal let. Not a bug, but you were right that the two fields cannot both be read as "when
can someone move in".

The missing half is now there: **`available_until`** on every search result, window mode
or not. We were already fetching the next booking's start date and discarding it. So the
answer becomes "free now, but only until 31 December" instead of a silence you had to
interpret.

## 3. The test property — you found half of it

Fixed, but not for the reason we gave you. `Test Property 2` is **active**, not
deactivated — the property-status filter we shipped yesterday was working correctly by
letting it through. The real gap was that our vacancy feed excluded records named "test"
and `/units/search` never did.

The resolver was worse, and you would not have seen it from the search response:

```
before                                          after
"mong kok 6a"             confident  6A Test    property_only
"test property 2 unit 1"  confident  Unit 1     none
```

`confident` means you say that label to a prospect. One shared rule now covers the vacancy
feed, search and the resolver.

**This changes your `"mong kok 6a 5a"` example.** Part of why it escalated was that
`6A Test` matched "6a"; it now resolves confidently to `Mong Kok 5A` alone, answering half
a two-unit question instead of asking a human. If you would rather it kept escalating,
say so — we can escalate on the number of unit-like tokens in the message rather than on
how many happened to match.

The one unit missing `asking_rent` in your sample was that same test record. Every real
unit carries it.

## 4. Tai Yuen 26/F — our typo, and our wrong answer about it

You read it correctly. The floor and ceiling were entered the wrong way round by us. It has
been corrected to 18,000–20,000.

Worth being exact, because it explains what you saw: with the bounds reversed the ladder
does not invert — it takes the lower as the floor and the higher as the ceiling — but "top
of range" then resolved to 19,000, above the 18,000 that was meant to be the ceiling. The
ladder protected the shape of the pricing and published a wrong number anyway.

Which makes your `min <= max` suggestion better than it first looked to us. When we went to
check we found no inverted rows — because it had already been fixed — so on the evidence in
front of us the validation had nothing to catch. It plainly did. It now rejects on write, on
both the create and the edit path.

## 5. `listing_url` on `/vacancies`

Done. Every query behind that endpoint already selected it and the shaping function already
read it; the mapping in between dropped it on every path. One correction to our own
diagnosis: we said three paths, it was **four**. The fourth serves the beyond-horizon case
and would have been left behind — a test that asserted the count, rather than checking the
three we knew about, is what caught it.

## On `rent_price_min` — we are not building the change tracking

We said we would add tracking so "when was this last reviewed" became answerable. We are
not going to, and you should have the real answer instead of a promise.

Two reasons. Tracking records when a number *changed*, not when someone *looked at it and
decided it was still right* — a floor unchanged since April might be deliberate or
forgotten, and only an explicit confirmation step distinguishes those. And nothing
backfills: it would have shown you nothing for months.

Here is what we can tell you now, from the edit history we already keep. **85 of our 115
priced units were last touched on a single day, 18 April 2026** — a bulk operation, not 85
individual reviews. A further 11 in the last 30–90 days, 18 within 30 days. So for roughly
three quarters of the portfolio the floor is at least four months old, and our records do
not reach back far enough to say how much older.

That is a worse answer than the one we promised, and a more useful one. Treat
`rent_price_min` as operator-set and unaudited. If a quote looks wrong for a unit, name it
and we will check by hand.

Thanks — question 1 was worth more than everything else in this exchange put together.

Chris

---

## Notes for Chris (not part of the message)

- **Deploy before sending.** Committed as `66f15b3`; the message describes window search
  and `available_until` as available.
- **Codex built the window search; two things it decided silently were caught in review**
  and are worth knowing because they would have been invisible from the outside:
  it switched OFF the "don't advertise May-Renew units" rule in window mode rather than
  flagging them, and it left `forward_gap_days` and friends computed from a move-in date
  window mode ignores. Both fixed before commit.
- **Backwards compatibility was verified, not assumed** — the generated SQL and parameters
  for a caller that sends no new fields are byte-for-byte identical to before.
- **The `"mong kok 6a 5a"` change is offered back to them.** If they want escalation
  restored, that is a small change to escalate on token count. Do not trim that offer.
- **`Test Property 2` stays** per your instruction, so the name filter is the only thing
  keeping it off the public surface. A placeholder named "Demo" or "Spare" would be
  published like any real unit.
- Not mentioned to them: `computeVacancies` still does not filter `p.status` or
  `deleted_at`. Not leaking today, and only because the two inactive properties are a test
  one (caught by name) and one with no active units.
- **Unanswered from their note:** they say `/units/{id}` returned `listing_url` for 5 of 8
  sampled vacancies. We have not audited how many real units are missing a listing URL
  altogether — that is a content gap on our side, not an API one, and may be worth a look.
