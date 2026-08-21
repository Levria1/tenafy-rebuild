# To TaneChat — /units/search, the resolver, and where rent_price_min comes from

**Draft for Chris to review and send. Not sent.**

---

Hi team,

All three of yours are fixed, and one of them turned out to be a different bug than either of us
thought. The pricing question is the one with an uncomfortable answer, so it is last and it is
honest.

## 1. `asking_rent` is on `/units/search`

You were right, and you should not have had to find it. I added the field to `/vacancies` and
`/units/{id}` and did not carry it to the endpoint you use for alternatives — the same mistake as
yesterday, one endpoint over, and this time under-quoting rather than over-quoting. Nothing changes
on your side: same object, same rule, `amount` is the number.

It reuses the same function the other two endpoints call, so the three cannot drift.

### `monthly_rent` — you were right to distrust it, and we have changed it

Your instinct to ignore it when a range is present was correct, and the reason is worse than a
stray value. It read the stored lease figure directly, and that figure is *sometimes a whole-stay
total rather than a monthly amount*. That is the same contamination `rent_basis` exists to flag on
`/vacancies`; on `/units/search` there was no flag at all, just a number that quietly changed
meaning. Your 19,829.90 is that, and so was Mong Kok 5D.

Two changes:

- `monthly_rent` now follows the same rule as `/vacancies`. Where a lease has no recurring invoice
  schedule, its figure is not published as a monthly rent — the unit's advertised price is used
  instead. **This changes the value you receive for affected units.** It is a correction, but it is
  a change, so we would rather flag it than let you discover it.
- New `monthly_rent_basis`: `"lease" | "advertised" | null`, so the number's meaning is readable
  rather than inferred.

`asking_rent.amount` remains the rate to quote. `monthly_rent` is context.

## 2. Your normaliser — thank you, and nothing needed

Nothing for us to do, and we would never have seen it. It is the clearest argument yet for the
position, better than the one we made: our refusal was correct and was being answered one layer
above it, so from our side the rule looked like it was working.

## 3. `"Fuk Lo Tsun 3/F Unit 1"` — not deliberate, and not really about that unit

It was a **deactivated test building answering live customers**.

`Test Property` is switched off in Tenafy. It contains a unit named `Unit 1`. Our resolver filtered
on the unit's own active flag and on deletion — but never on the *property's* status, so a building
we had taken out of service kept matching prospect messages. Its `Unit 1` collided with the real
`3/F Unit 1 (Room A and Room B)`, two distinct units matched, and the multi-unit branch escalated
your booking to staff.

So the answer to "is this deliberate?" is no, twice over. Two fixes:

- The unit load now requires the property to be active. Deactivating a building in Tenafy now
  actually takes it out of matching, which is what an operator would reasonably assume it already did.
- The multi-unit branch now requires the property to have matched as well. Naming two flats at a
  building you named still escalates; a stray token colliding with a unit at a building nobody
  mentioned no longer can.

```
"Fuk Lo Tsun 3/F Unit 1"  ->  confident   Fuk Lo Tsun 3/F Unit 1 (Room A and Room B)
"Mong Kok 6a 5a"          ->  multi_unit  (unchanged — a real two-flat request)
```

We swept every property and unit name in the portfolio: spurious `multi_unit` went from four to
none, and nothing that resolved before resolves differently.

You were right that this was the expensive one to miss. It is also the one that would have kept
quietly costing us, because from our side it looked like a correct escalation.

## 4. `rent_price_min` — hand-entered, and we cannot tell you when it was last looked at

It is typed per unit on the unit edit screen in Tenafy. There is no derivation from the lease, no
market feed, no automation. Your reading of the data is exactly right: it sits above the sitting
tenant's rent sometimes and below it others because the two are unrelated.

As for how often it is revisited — **we do not know, and we cannot find out.** The `unit` table has
no `updated_at`. It records deletion and nothing else. There is an activity log with unit updates in
it, but it does not record which field changed.

So the number that now sets the bottom of every ladder tier and the floor of every negotiation has
no review date, and no way to identify which ones are stale. That is not an acceptable place for it
to sit now that you are quoting from it, and it is ours to fix rather than yours to work around. We
are adding change tracking on those two columns so "when was this last reviewed" becomes answerable,
and we will come back to you with what it shows.

Until then, treat the floor as operator-set and unaudited. If a quote ever looks wrong for a unit,
tell us the unit and we will check the number by hand.

## On your two corrections

Noted on the website FAQ endpoint — you are right that you do not call it, and the version caveat
matters to you only on `/chat/knowledge`. Keying that per property is the right move.

Thanks for all three. Two of them were ours and neither was visible from our side.

Chris

---

## Notes for Chris (not part of the message)

- **`monthly_rent` changing value is the one thing in here that could surprise them.** It is called
  out explicitly; do not trim that paragraph.
- The deactivated-property bug is worth a look beyond the resolver: anywhere else that loads units
  without checking `p.status` has the same exposure. Not audited yet.
- `rent_price_min` change tracking is promised in this note and NOT built. Either build it or soften
  the wording before sending.
- Not mentioned: `Test Property 2` is still active in production. The code fix means it no longer
  breaks their case, but it is live data in a live portfolio and should be retired.
