# To TaneChat — all three stand, two are fixed, one was a sentence we should not have written

**Draft for Chris to review and send. Not sent.**

Answers their three push-backs on our 24 August letter. Short on purpose: they are right three
times and there is nothing to argue about.

**DEPLOYED and re-verified** (`2840f13`; production at `a4b1ad0`). Every figure below was measured
after the restart.

---

Hi team,

Three findings, all three correct. Two were ours and are live now. The third was a claim we made
about your system that we had no business making.

---

## 1. The `unmatched` list was reporting budgets as missing flats — you are right, and it is the same bug

This is the one you said was worth writing back about, and you were right to rank it first.

Reproduced before touching anything:

```
"tai yuen my budget is 25k"             unmatched: []        <- suppressed, as promised
"tai yuen my budget is 10,000"          unmatched: ["000"]
"tai yuen my budget is 25,000"          unmatched: ["000"]
"tai yuen around HK$12,000 per month"   unmatched: ["12", "000"]
```

Your diagnosis is exact, including the part that stings: **it is the same normaliser and the same
split as the bug we fixed yesterday.** Our normaliser turns every non-alphanumeric run into a
space, so `25,000` arrives as two tokens, `25` and `000`. Neither half is money-shaped, so the
money rule never fires. We closed the resolve half of that and never asked whether the same split
was still leaking into `unmatched`.

You are also right that it costs you nothing today only because you do not read the field yet, and
that it would have cost you the moment you built the reply it was designed for. Comma-separated
thousands is how people write a budget.

**The fix, and why it is not the obvious one.** We did not add a rule suppressing a three-digit
token that follows a number — that would also have swallowed a genuine `"unit 103 105"`. The comma
is real evidence and we were destroying it before anyone could use it, so we now collapse
comma-grouped digits back into one token *before* normalising. `25,000` becomes `25000`, whose
shape matches no unit name we own, and the suppression rule that already existed does the rest.

Live now:

```
"tai yuen my budget is 25,000"          unmatched: []
"tai yuen around HK$12,000 per month"   unmatched: []
"tai yuen my budget is 25k"             unmatched: []      (unchanged)
"tai yuen unit 103 105"                 unmatched: ["105"] (a real second unit, still reported)
```

Ten money, size, time and duration phrasings, zero leaks.

**One limit worth stating rather than letting you find.** This works because no unit we own has a
five-digit name, so `25000` fails the shape test. If a building ever gets five-digit unit names,
a five-digit budget becomes unit-like again. We are not pre-solving it, but you should know the
guarantee has that shape.

## 2. The retry path — you are right, and we should not have written that sentence

We wrote that the `property_only` loss "lands on the retry path you kept for exactly this case."

Your §9 said the retry **runs** on `property_only`. We turned that into **recovers**. That is a
claim about the inside of your system that we had no way to verify and made anyway, and if your
retry re-resolves the same extracted string then `"Tai Yuen 10"` returns `property_only` twice and
nothing catches it.

The sentence is gone. The loss stands on its own merits — a question beats a wrong answer — and it
does not need a safety net that is not there. Thank you for correcting it rather than building
against it.

We have spent two letters asking you to verify our claims before trusting them. It is only fair
that it runs in this direction too.

## 3. `property_only` candidates crossed buildings — right, and worse than you described

You found that `"Tai Yuen"` offered Lai Yuen 103 and 105 first. It is worse than that: **`"tai
yuen"` and `"lai yuen"` returned the identical list in the identical order.** The ranking was not
responding to the query at all. Reversing the row order flipped the answer for both.

The cause is ours and it is small. Our property score gives 2 for *any* single matching name word,
so `"tai yuen"` scored Tai Yuen Apartments on `tai` and 13B Lai Yuen Apartments on `yuen` —
identically. A stable sort then handed the tie to whatever order the database returned, so one of
the two queries always led with the wrong building.

We now count how many of a property's name words the customer actually typed and use it as a
tie-break only. Score tiers are untouched, so nothing moves between `confident`, `ambiguous` and
`property_only` — this changes the order, not the decision.

Live now:

```
"tai yuen"  ->  Tai Yuen 10/F, Tai Yuen 25/F, Lai Yuen 103, Lai Yuen 105
"lai yuen"  ->  Lai Yuen 103, Lai Yuen 105, Tai Yuen 10/F, Tai Yuen 25/F
```

Same result whichever order the rows arrive in.

**You were right to check before blaming us, and right that it predates the change.** You were also
right that our change routes far more traffic into that path, which is what turned a latent
ordering flaw into a live one. Your offer to rank candidates by the property name the customer
typed is welcome and would make the two of us agree twice — but the tie was ours and it should not
have reached you in the first place.

**One residual we are leaving alone for now**: *within* a building, unit order still follows row
order. `"tai yuen"` leads with Tai Yuen either way, but which Tai Yuen flat comes first is not
deterministic. Nobody named a flat, so there is no signal to rank on. Tell us if a stable order
would help on your side and we will sort it.

---

## Nothing regressed

Everything the last two letters claimed, re-measured after this deploy:

```
"mong kok 5a"                  confident, Mong Kok 5A
"mong kok 6a 5a"               confident 5A, 6a reported unmatched, floor 6 empty
"poplar 5e"                    5e unmatched, floor 5 lists 5A-5D
"tai yuen unit 25" / "10/F"    confident
"pearl city unit 22 and 23"    multi_unit
"tai yuen, my budget is 25k"   property_only
ten budget/headcount phrases   0 confident wrong flats
max_price 11k / 14k / 17k      matches asking_rent exactly, monthly_rent never
```

---

Three for three. Keep doing this.

Chris

---

## Notes for Chris (not part of the message)

- **This assumes they have read the 24 August letter** — they quote its retry sentence back to us
  verbatim, so they have. If it has NOT gone out, send that one first or fold these three sections
  into it; this letter reads as a follow-up and will not stand alone.
- **§2 is us being corrected and saying so without hedging.** Worth keeping exactly as written. We
  have twice told them to verify our claims before trusting them; the first time it runs the other
  way is the moment that principle is either real or it is not.
- **§1 concedes that we half-fixed a bug and shipped it.** That is the second time this week a fix
  of ours closed one half of something. It is better said by us than noticed by them again.
- **§3 gives them credit twice** — for checking before blaming us, and for the observation that our
  change made a latent flaw live. Both are true and both are the kind of thing that keeps a partner
  reporting rather than working around.
- **The residual in §3 is disclosed, not hidden.** Within-building order is still row order. If
  they say it matters, it is a small sort.
- Nothing here needs a decision from you.
