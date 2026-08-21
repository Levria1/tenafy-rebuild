# To TaneChat — test units, listing_url, and the Tai Yuen range

**Draft for Chris to review and send. Not sent.**

All three are BUILT and tested. **NOT YET DEPLOYED** — the note reads as though they are
live, so deploy before sending.

---

Hi team,

Three useful ones. Two are ours, and one of the two is worse than you found it.

## 1. The test property — you found half of it

Confirmed, and thank you. But it is not what we told you it was, and the bigger
exposure is on an endpoint you did not check.

`Test Property 2` is not a deactivated building. It is **active**, and the property-status
filter we shipped yesterday is working correctly by letting it through. It is live test data
in a live portfolio, which is our housekeeping problem, not a bug in the filter.

The real gap is that our vacancy feed excludes anything with "test" in the unit or property
name and `/units/search` never did. Two endpoints, same portfolio, different idea of what is
public.

**The resolver is worse.** We checked it after reading your note:

```
"mong kok 6a"             ->  confident   Mong Kok 6A Test
"test property 2 unit 1"  ->  confident   Test Property 2 Unit 1
```

`confident` means you would say that label to a prospect. Search listing a test unit among
alternatives is untidy; the resolver naming one back to a customer is the one that would have
embarrassed us. You would not have found this from the search response alone.

We have lifted the name filter into one shared predicate and applied it to the vacancy feed,
search, and the resolver together, so the three cannot disagree about what is public again.

**One consequence worth flagging, because it touches your example.** Mong Kok's real units run
1A–5D; there is no 6A. Part of why `"mong kok 6a 5a"` escalated as `multi_unit` was that
`6A Test` matched "6a". With test units filtered, that query now resolves confidently to 5A
alone — it answers half a two-unit question instead of asking a human. We think naming a test
unit to a customer is the worse failure and have filtered anyway, but you should know the
behaviour of that specific case has changed.

### Your "5 of 6"

The one unit without `asking_rent` is `Test Property 2 Unit 1`. It has no prices because it is
a test record, which is why it quotes nothing — the same root cause as above, not a separate
gap in `asking_rent`. Every real unit carries it.

## 2. `listing_url` on `/vacancies` — ours, and a silly one

Confirmed: 0 of 15 for you, 0 of 12 for us.

Every query behind that endpoint already `SELECT`ed `u.listing_url`, and the shared shaping
function already read it. It was being fetched from the database and then dropped by the
row-mapping functions in between, on every path — travelling most of the way and falling over at
the last step.

It is now populated. One correction to our own diagnosis, in case you rely on the count: we
first found three affected paths and it was actually **four**. The fourth serves the
beyond-horizon case — when a requested date is past the booking horizon and we answer with
NR units instead — which has its own query and its own mapping, and would have been left
behind. A test that asserted the number, rather than checking the three we already knew about,
is what caught it.

You were right not to want to fire a detail call per unit to rebuild something we already hold.

## 3. Tai Yuen 26/F — you were right, and it was us

Your reading was correct and the cause was a typo at data entry. The floor and ceiling were
entered the wrong way round on our side. It has since been corrected and now reads
18,000–20,000.

Worth being precise about what you saw, because it says something about the ladder. With the
bounds reversed, the ladder does not invert — it takes the lower of the two as the floor and
the higher as the ceiling, so the step-down still steps the right way. But "top of range" then
resolved to 19,000, which is exactly the number you reported, and it sat above the 18,000 that
was meant to be the ceiling. So the ladder protected the shape of the pricing and published a
wrong number anyway. Order-safety is not the same as correctness.

Which makes your `min <= max` suggestion better than it looked. We had no inverted rows when we
went to check, because the record had already been fixed — so on the evidence in front of us the
validation had nothing to catch. It plainly did have something to catch: it would have caught
this one at the keyboard, before it reached you. It now rejects on write, on both the create and
the edit path.

Thanks for all three. The resolver one in particular we would not have gone looking for.

Chris

---

## Notes for Chris (not part of the message)

- **All three are built and tested; NOT deployed at time of writing.** 954 backend tests pass. Eight deliberate
  mutations were replayed against the new tests, including removing the guard from only one of
  the two write paths; all eight were caught.
- **The `listing_url` fix was four paths, not the three quoted to you earlier.** The
  beyond-horizon path was found by a count assertion, and the note now says so rather than
  quietly reporting the round number.
- **`rent_price_min` change tracking is still promised and still not built.** It was in the
  note you sent yesterday. TaneChat has not chased it. It does not appear in this draft, so
  sending this does not renew the promise — but it also does not retire it.
- **The behaviour change to `"mong kok 6a 5a"` is real and is called out.** Do not trim that
  paragraph; it is their flagship example from the previous exchange and it stops escalating.
- **`Test Property 2` is staying** per your instruction, so the name filter is now the only
  thing keeping it off the public surface — not a belt-and-braces alongside retiring it. If a
  test unit is ever named without "test" in it, nothing catches it.
- Not mentioned to them: `computeVacancies` still does not filter `p.status` or `deleted_at`.
  Not leaking today, but only because your two inactive properties are a test one (caught by
  name) and one with no active units.
