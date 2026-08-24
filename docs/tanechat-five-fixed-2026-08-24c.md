# To TaneChat — the hole in the comma fix, both leaks, the cap, and `min_price`

**Draft for Chris to review and send. Not sent.**

Answers their 24 August reply. All four items are done, plus a fifth we found while confirming
theirs.

**DEPLOYED and re-verified** (`fb21c43`). Every figure below was measured after the restart.

---

Hi team,

Four things in your note, all four correct, all four live. You were right about the hole in
yesterday's fix and right that `min_price` needed changing before it had anything to act on.

---

## 1. `"unit 103,105"` — you found the hole and you quoted our own letter back at us

Fair. We wrote that we rejected the obvious rule because it would swallow a genuine
`"unit 103 105"`, and shipped a rule that swallows it whenever the space is left out. Reproduced
before touching anything:

```
"unit 103, 105"   confident Unit 103, unmatched ["105"]     correct
"unit 103,105"    property_only, no match, unmatched []      both flats gone
```

**Your proposed signal is the one we used**, and you were right that it was already sitting there:
a digit run introduced by `unit` / `flat` / `no.` / `#` is a unit reference, so its comma is not a
thousands separator. That is the same marker the bare-number rule uses, so this reuses a decision
rather than adding one. Live now:

```
"lai yuen unit 103,105"    confident  Unit 103, unmatched ["105"]
"lai yuen unit 103, 105"   confident  Unit 103, unmatched ["105"]
```

Both forms now agree, which is what should have been true yesterday.

Your blast-radius read was also right — three-digit unit numbers only, so 13B Lai Yuen alone, and
`"pearl city unit 22,23"` was never affected.

## 2. Both leaks closed

```
"tai yuen 12,500.50 per month"   unmatched: ["50"]   ->  []
"tai yuen budget 10 000"         unmatched: ["000"]  ->  []
```

The space-grouped one uses the same marker test, so `"unit 103 105"` still reports `105` — we
checked that specifically, because it is the case that makes the rule dangerous. The decimal is
dropped before normalisation, where the dot is still visible.

You offered to let these go. We would rather not leave a rule that is right for the two spellings
we thought of and wrong for the third; that is how the first one got shipped.

## 3. The cap — you were right that it was selecting stock, and we were wrong twice

Your framing was correct and ours was not. We called it presentation; it was selection.

We were also wrong in the other direction, and this one is worth correcting explicitly: our letter
said the within-building order was "not deterministic". **It was.** The query that loads units ends
`ORDER BY p.display_name, u.name`, so it was fixed and repeatable — unit name ascending, which is
the fallback you named as your distant second. You said you could not make it vary in practice and
you were right; we contradicted you on a point where you had checked and we had not.

What was actually wrong is what you said: the cap was 8 while Poplar has 20 flats and Mong Kok 19,
so the ordering decided which flats a prospect could be offered at all.

Three changes:

- **The cap is 40.** No building has more than 20 units, so it no longer binds on anything real.
  It stays as a bound against a pathological org rather than a silent filter.
- **Order is soonest-available**, within building relevance — a flat cannot jump above a
  better-named building on availability, because that was the bug we fixed two days ago.
- **`candidate_count` is on every response**, always the true total before any cap. If a list is
  ever trimmed you can see it, the way `floor_unit_count` already works.

Live now, where each of these used to return exactly 8:

```
poplar        14 candidates   (candidate_count 14)
mong kok      13
fuk lo tsun   11
hollywood      9
```

`vacant now` sorts first, then by the date the sitting tenant leaves, then a flat whose lease has
no end date — which is not "free today", it is "no known free date", and those should not collapse
into each other.

## 4. `min_price` — you are right, and we are changing it while it still costs nothing

Both bounds now keep an unpriced unit. You get it with `asking_rent: null` and decide.

Your argument beat ours on the point that matters: **keeping is recoverable and dropping is not.**
Ours was that the two bounds were symmetric. They are not, because the two mistakes are not the
same size — you can hide a unit we send, and nobody can recover a unit we delete.

The part we had not thought about carefully enough is that an unpriced unit is **a blank field, not
a fact about the flat.** A data-entry gap silently deleting lettable stock, with no error and no
count, is exactly the failure we have both spent the week chasing in other clothes.

**One correction to your evidence, and it goes against your case, so it should come from us.** You
cited our figure that 85 of 115 priced units were last touched on 18 April. We cannot reproduce
that — the `unit` table has no `updated_at` column at all, so whatever that number was, it did not
come from there. Treat it as unsupported. Your argument does not need it.

**And you were right that nothing currently depends on it.** Every unit in a 24-month window
carries an `asking_rent`, and `min_price=1` returns all 100. We looked for real unpriced stock and
found three units — all of them test records, already excluded from everything customer-facing by
name. So: zero real flats affected, now or imminently. We are making the change precisely because
it is free today, which was your point.

---

## What we found while confirming yours

**A confident answer naming a building the customer never typed.**

```
"tai yuen unit 103"  ->  CONFIDENT  "13B Lai Yuen Apartments Unit 103"
```

Tai Yuen has no 103. Lai Yuen does. `yuen` is in both names, so Lai Yuen was the only full match,
and "only one fits" was being treated as "certain".

This is the third wrong-building confident answer this week and the same family as the Fuk Lo Tsun
one — a confident answer resting on one shared word. A full match at a building the customer named
*less* well than another is a guess, not a certainty. Live now:

```
"tai yuen unit 103"  ->  property_only, unmatched ["103"]     "Tai Yuen has no 103"
"lai yuen unit 103"  ->  confident  Unit 103
```

Worth noting because it interacts with §1: `"tai yuen unit 103,105"` now answers "Tai Yuen has
neither", rather than resolving a Lai Yuen flat. That is the right answer to the question asked,
but it is a different answer from the one your §1 example predicted.

---

## Nothing regressed

```
"mong kok 5a"                 confident
"mong kok 6a 5a"              confident 5A, 6a unmatched
"poplar 5e"                   5e unmatched, floor 5 lists 5A-5D
"tai yuen unit 25" / "10/F"   confident
"pearl city unit 22 and 23"   multi_unit
"tai yuen 10"                 property_only
"tai yuen, my budget is 25k"  property_only
max_price 11k / 14k / 17k     matches asking_rent exactly, monthly_rent never
```

---

Four for four again. The §3 correction is ours twice over — wrong about what it was, and wrong
about what it already did.

Chris

---

## Notes for Chris (not part of the message)

- **Everything is deployed and re-measured** (`fb21c43`, 1084 backend tests). The before/after
  numbers are two real measurements.
- **§3 admits two errors in one section.** We told them the order was not deterministic when it
  was, and they had actually checked. That is the second time this week we have contradicted them
  on something they verified and we assumed — worth conceding plainly rather than quietly fixing.
- **§4 corrects a number in THEIR favour's opposite direction.** They cited a figure of ours to
  support their case; it does not hold up. Saying so ourselves, while still making the change they
  asked for, is the version of this exchange that keeps working.
- **The "what we found" section is the third wrong-building bug this week.** Worth stating as a
  pattern rather than an incident — it is the same shape each time: a confident answer resting on
  one shared word.
- **Watch for**: their §1 example (`"tai yuen unit 103,105"`) now behaves differently from what
  they predicted, because our own find changed it. The letter flags that so they do not read it as
  the comma fix failing.
- Nothing here needs a decision from you.
