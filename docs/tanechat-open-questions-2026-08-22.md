# To TaneChat — everything open from our side

**Draft for Chris to review and send. Not sent.**

Consolidates the outstanding drafts into one message. Supersedes
`tanechat-ask-relay-2026-08-22.md`, `tanechat-reply-renewals-2026-08-22.md`,
`tanechat-reply-search-2026-08-21c.md` and `tanechat-reply-window-2026-08-21d.md`.

⚠️ **One item is not deployed** — the classifier fix in §2. Deploy before sending, or cut
that section. Everything else described here is live and verified.

---

Hi team,

One message rather than four. Four questions at the top, then what has changed on our side
since we last wrote.

---

# Questions

## 1. Five renewal replies never reached us — we cannot tell why

We sent nine renewal asks on 21 August, eight of them at 10:00. Five tenants replied on
WhatsApp. **None reached us** — `POST /renewal-ask/:id/reply` was not called for any of
them, so all five sat here as unanswered.

```
21 Aug 02:04   Gilman's Bazaar 2A   "please extend my stay"
21 Aug 03:57   Poplar 3D            "Yes please another month"
21 Aug 02:14   Poplar 4A            "Yes please" ... "3 months please"
21 Aug 05:16   Mong Kok 1C          "yes we will continue"
21 Aug 04:48   Hollywood 1B         "possible to pause the lease ... continue until December?"
```

Nothing was lost — we read the threads and recorded them by hand. The failure mode is what
concerns us: those asks stayed open, so the sequence had queued the same question to go out
again to tenants who had **already answered**. Andrea confirmed at 02:04 and was in line to
be asked a second time.

Three possibilities, and we cannot distinguish them from here:

1. **The relay is not built or not deployed.** Entirely possible — say so and we stop
   looking for a fault.
2. **It runs and errors.** Please send the response you get. The endpoint returns a body on
   every path including refusals, and it will say why.
3. **We never agreed the trigger.** Then it is ours, and the fix is the contract rather than
   anyone's code.

For reference: `POST /api/public/renewal-ask/:id/reply` with
`{"intent": "extend" | "leaving" | "unsure"}`, or `{"text": "<what they wrote>"}` and we
classify. `GET /renewal-asks/open` supplies the id. A 200 with `recorded: true` is success;
anything else we would like to see.

## 2. Will you send `intent` rather than raw `text` where you can?

Related to a real defect we have just fixed on our side (§5). If your side has already
understood the tenant, telling us the intent directly is better than us re-deriving it from
the words. Our classifier is a fallback for raw relay and is deliberately conservative
rather than clever.

Either is supported and neither is wrong — we would just like to know which to expect.

## 3. `"mong kok 6a 5a"` no longer escalates. Do you want that back?

Filtering test units out of the resolver changed the behaviour of your own flagship example.
It escalated as `multi_unit` partly because `6A Test` matched "6a"; now that the test unit is
gone it resolves confidently to `Mong Kok 5A` alone — answering half a two-unit question
instead of asking a human.

We think naming a test unit to a customer was the worse failure, so we filtered anyway. But
if you would rather it kept escalating, we can escalate on the **number of unit-like tokens
in the message** rather than on how many happened to match — arguably the better rule, since
"6a 5a" names two units whether or not both exist. Your call; we did not want to change
escalation twice in a week without asking.

## 4. Does the window search shape work for you?

Described in §6. It is live and we would rather hear now than after you have built against
it — particularly whether `availability_certain` is enough for you to phrase an offer, or
whether you need something more explicit.

---

# What has changed since we last wrote

## 5. A question is no longer read as a confirmation

Prompted by the fifth message above. Hollywood 1B wrote:

> "Would it be possible to pause the lease for 25th Sep to 7th Oct and then continue it
> until December?"

Our classifier read that as **extend**, because "continue" is on the yes list. It is not a
confirmation — it is a question about restructuring, from a tenant who was separately asking
about a different studio.

Affirmative signals are now counted only outside interrogative clauses:

```
before        after
extend    ->  unsure     "can I extend?"
extend    ->  unsure     "how much to extend?"
extend    ->  unsure     "Any chance of another month?"
extend    ->  unsure     "is it possible to extend"     (no question mark — chat often omits it)
```

Plain answers are unchanged, including with a question attached: "Yes please. How much is
it?" is still `extend`. Only the case where the enquiry IS the whole message moves.

It matters because `extend` is the only intent that acts automatically — it withdraws the
unit from customer-facing feeds. Acting on a question would have taken a home off the market
because someone asked the price of staying.

## 6. Window search — asking "who is free between two dates"

You were right that `move_in_date` did not do what you needed, and right about why.

`move_in_date` is a **single day**: we return units free on exactly that date, and
`available_from` defaults to the date you sent. It describes your question, not the flat.
Sending today + 18 months did not widen anything; it asked "who is free in February 2028".

That is also why you could not see `Poplar 2B`. It is occupied on 21 August and frees on 17
October, so a single-day query for 21 August correctly excludes it. `move_out_date` would not
have rescued it either — that is a strict whole-window filter, so it would still have dropped
the flat covering half the stay.

So there is now a window mode:

```
GET /units/search
  ?available_between_start=2026-08-21
  &available_between_end=2026-12-31
  &district=Sheung Wan
```

Each result reports the **longest single unbroken stretch** it is free inside that window:

```json
{
  "property_name": "Poplar", "unit_name": "2B",
  "available_from": "2026-10-17", "available_until": "2026-12-31",
  "coverage_days": 76, "availability_certain": true, "area_match": "district"
}
```

- **Quote the dates, not the coverage.** `coverage_days` exists so we can sort by it. Say
  "available 17 October to 31 December", never "covers 57%".
- **Only one stretch, never two.** Free 21 Aug–3 Sep and again 5 Nov–31 Dec reports only
  November. Fragments are never summed — two stretches is not an offer anyone can accept for
  a continuous stay.
- **`availability_certain`.** Single-day search only offers an occupied unit when the tenant
  has confirmed they are leaving. Window search cannot apply that rule without discarding the
  units it exists to find, so it returns them and flags them. `false` means the opening
  depends on a tenant who has not said they are going — offer as *possible*, not available.
- **`district` is a preference here, not a filter.** Units elsewhere come back in
  `alternatives_outside_area`, ranked district → same side of the harbour → anywhere, so you
  can ask "nothing in Sheung Wan covers your dates, but we have one in Mong Kok free 17
  October to 31 December — would you consider it?" That array is always present in window
  mode, empty when there is nothing. `city` still filters strictly: naming a city is a
  constraint, and a flat across the harbour is not an alternative to it.

Fields measured against a move-in date (`forward_gap_days`, `gap_within_tolerance` and the
rest) are `null` in window mode — there is no single move-in date to measure from, and we
would rather return nothing than a number computed against a date that had no bearing on the
result.

## 7. `available_until` on every search result

Window mode or not. `Poplar 4D` reading "available from 21 Aug" on search and "2027-01-01"
on `/units/{id}` was the missing half: vacant now, booked before January. We were already
fetching the next booking's start date and discarding it. The answer is now "free now, but
only until 31 December" rather than a silence you had to interpret.

## 8. Test units are off every customer-facing surface

Fixed, though not for the reason we first gave you. `Test Property 2` is **active**, not
deactivated — the property-status filter was working correctly by letting it through. The
real gap was that our vacancy feed excluded records named "test" and `/units/search` never
did.

The resolver was worse, and you would not have seen it from the search response:

```
before                                          after
"mong kok 6a"             confident  6A Test    property_only
"test property 2 unit 1"  confident  Unit 1     none
```

`confident` means you say that label to a prospect. One shared rule now covers the vacancy
feed, search and the resolver. The one unit missing `asking_rent` in your sample was that
same test record.

## 9. `listing_url` on `/vacancies`

Done. Every query already selected it and the shaping function already read it; the mapping
in between dropped it on every path. One correction to our own diagnosis: we said three
paths, it was **four** — the fourth serves the beyond-horizon case and would have been left
behind.

Separately, 32 of our 115 active units have no listing URL at all. That is a content gap on
our side and we are working through it; three of them are currently vacant, so you may see a
unit offered with no link to send.

## 10. Tai Yuen 26/F — our data-entry error

You read it correctly. The floor and ceiling were entered the wrong way round by us, and it
now reads 18,000–20,000.

Worth being exact about what you saw: with the bounds reversed the ladder does not invert —
it takes the lower as floor and the higher as ceiling — but "top of range" then resolved to
19,000, above the 18,000 meant as the ceiling. The ladder protected the shape of the pricing
and published a wrong number anyway.

Which makes your `min <= max` suggestion better than it first looked to us. When we checked
we found no inverted rows, because it had already been fixed — so on the evidence in front of
us the validation had nothing to catch. It plainly did. It now rejects on write, on both the
create and the edit path.

## 11. `rent_price_min` — we are not building the change tracking

We said we would add tracking so "when was this last reviewed" became answerable. We are not
going to, and you should have the real answer instead of a promise.

Tracking records when a number *changed*, not when someone *looked at it and decided it was
still right* — and nothing backfills, so it would have shown you nothing for months.

From the edit history we already keep: **85 of our 115 priced units were last touched on a
single day, 18 April 2026** — a bulk operation, not 85 reviews. Eleven more in the last
30–90 days, eighteen within 30 days. So for roughly three quarters of the portfolio the floor
is at least four months old, and our records do not reach far enough back to say how much
older.

A worse answer than the one we promised, and a more useful one. Treat `rent_price_min` as
operator-set and unaudited. If a quote looks wrong for a unit, name it and we will check by
hand.

## 12. One thing about what "confirmed" means

Recording `extend` does **not** extend the lease. It records the intention and takes the unit
off the market. The end date is unchanged and the paperwork is a separate, human step.

So please do not tell a tenant their lease is extended. "I have let the team know — they will
be in touch with the new agreement" is accurate. A tenant who believes it is done when nothing
is signed is the version of this that ends badly.

---

Thanks — question 1 is the one that needs an answer either way, so we know whether to expect
replies to arrive on their own next cycle or to keep reading the inbox by hand.

Chris

---

## Notes for Chris (not part of the message)

- **§5 IS NOT DEPLOYED.** Commit `d5d15ca`, not pushed. Deploy before sending or cut that
  section. Everything else is live and was verified against production.
- **Question 1 makes no accusation** — three possibilities, one of them ours. If it turns out
  the relay was never built, nothing here needs walking back.
- **Question 3 hands them a real decision.** Do not trim it: it is their own flagship example
  and its behaviour changed.
- **§10 is written as your data-entry error**, per your instruction.
- **§11 retires a promise made in the note sent on 21 August.** It does not renew it.
- Corrections to our own earlier claims are stated in §8 (the test property is active, not
  deactivated) and §9 (four paths, not three), rather than quietly fixed.
- Hollywood 1B is still open and needs you, not the relay. Lukas wants a two-week gap
  mid-tenancy and has asked about a different studio — a conversation, not an intent.
- Four tenants have still not replied at all: Fuk Lo Tsun 3/F Unit 1, Hillier 2A, Nam Pak Hong
  7D, Tai Yuen 25/F. The normal sequence will ask them again.
