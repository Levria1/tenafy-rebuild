# To TaneChat — you were right about the price filter, and the number bug was worse than you found

**Draft for Chris to review and send. Not sent.**

Answers their 21–23 August note. Follows our 22 August letter, which they clearly received — their
§6 and §9 quote it back to us.

---

Hi team,

Two findings in your note land on us, and you were right about both. One of them we had already
told you was fixed, which makes it the more useful of the two.

---

## 1. `max_price` — you were right, we were wrong twice, and it is fixed now

Your §6 is correct and our reply to it was not. You had one explanation, we gave you another, and
**both of us were wrong.** The filter does not prorate the free stretch, and it is not a
raw-versus-schedule-aware mismatch either. It is simpler and worse than either account:

`min_price` / `max_price` compared **`monthly_rent`**. That field is the SITTING TENANT's rent —
`last_lease_price` when the lease has a recurring schedule. `asking_rent.amount`, the figure we
told you to quote, is built from the advertised band. They are different numbers describing
different tenancies, and nothing was keeping them in step.

We reproduced your test on a different window before believing you. On 15 Oct – 15 Dec, 49 units:

```
max_price=11000   returned 19   monthly_rent <= cap: 19   asking_rent <= cap: 14
max_price=14000   returned 29   monthly_rent <= cap: 29   asking_rent <= cap: 26
max_price=17000   returned 46   monthly_rent <= cap: 46   asking_rent <= cap: 42
```

An exact match against the wrong field at every cap. Your Hollywood 5B / Jardine 2A pair reproduces
exactly, and so does your Mong Kok 1C example — `monthly_rent` 9,000 against that unit's own
published band of 9,400–10,800. The two figures disagree on **41 of 49 units**, so you were right
that this is the normal case and not an edge one.

**What we have changed.** Both bounds now read the same asking figure the response publishes, and
they read it through one function that the response also uses, so the filter and the quote cannot
drift apart again. That last part is the actual fix; the first part is just the symptom.

**The line in our last letter we would most like back** is *"you can drop your own banding when
this deploys."* You did not drop it — you extended it to two more paths — and that was the right
call. Had you followed our advice, customers would have been shown flats above their ceiling and
denied flats within it, in both directions at once, on our assurance. We are glad you keep your own
belt.

You were also right to report it rather than quietly work around it. A workaround inside your code
is invisible to us and would have outlived both our explanations.

## 2. A budget read as a flat number — you found the mild half

Your §9 is right, and it turned out to be the smaller part of what was there.

**Your specific case reproduces.** `"a range of $10-13K per month"` returned `ambiguous` with
Tai Yuen 10/F as a candidate, and removing the budget cleared it.

**Your diagnosis was close but the mechanism is the opposite of what it looks like.** You thought
the exact-match rule was not reaching the `10` in `10-13K`. It reaches it and it *passes* it: our
normaliser turns every non-alphanumeric run into a space, so `10-13K` becomes the tokens `10` and
`13k`, and `10` is an exact match for the core of unit `10/F`. The rule we added in response to
your last report requires numeric names to match *exactly* — and a bare number is exact. We closed
`"25k"` and left `"25,000"` wide open.

**So it was never about ranges, and it was not limited to `ambiguous`.** Probing it properly
against production, nine of ten ordinary sentences returned **`confident`** — a single named flat,
not a list of candidates:

```
"Tai Yuen, my budget is 10,000"              -> CONFIDENT  Tai Yuen 10/F
"Tai Yuen, I can pay 11,000"                 -> CONFIDENT  Tai Yuen 11/F
"Pearl City budget 25,000"                   -> CONFIDENT  Pearl City Unit 25
"anything in Tai Yuen for a 10 month lease"  -> CONFIDENT  Tai Yuen 10/F
"Fuk Lo Tsun, we are 3 people"               -> CONFIDENT  Fuk Lo Tsun 3/F
"Fuk Lo Tsun 3 bedroom flat"                 -> CONFIDENT  Fuk Lo Tsun 3/F
```

A comma in a budget, a headcount, a lease length, a bedroom count. Any bare number that happens to
equal one of our numeric unit names — and we have twelve of those: 3, 10, 11, 21, 22, 23, 25, 26,
59, 60, 103, 105.

Your letter says this half cost you nothing because `ambiguous` is us declining to choose. That was
true of the case you found. It was not true of the cases you did not.

**What we have changed.** A purely numeric unit name is now matched only when the customer *marked*
the number as a unit reference — `flat 10`, `unit 25`, `10/F`. A bare number is treated as what it
almost always is: a price, a headcount or a duration. Names carrying a letter (`6a`, `3b`) are
untouched; they cannot collide with a quantity in the first place.

**One deliberate loss.** `"Tai Yuen 10"`, with no marker, now returns `property_only` instead of
confidently naming 10/F. We think that is the right trade — `property_only` asks which flat, which
is a question, where the old behaviour was a wrong answer — and it lands on the retry path your §9
says you kept for exactly this case.

## 3. The same disease in our own assistant, which you could not have seen

Reporting this because it is the same root and you have no way to observe it.

Our own in-house AI assistant runs on the same search engine and is handed **`monthly_rent`** as
the price to quote a prospect. Not `asking_rent`. So while your §7 describes your under-quoting
correcting itself the moment `asking_rent` landed, ours never did — because ours was never reading
it.

Across the same 49 units:

```
under-quoting   35 units   average HK$1,401/month   worst HK$3,500 (Fuk Lo Tsun 3/F, Jardine 2A)
over-quoting     6 units
identical        8 units
```

**Now fixed, by following you.** Our assistant is handed `asking_rent` and told to quote it, so
both assistants now say the same thing about the same flat — which is the property we actually
wanted and did not have. It affects nothing you receive; your quotes were already correct. We
mention it because your §7 is the reason we went looking, and because a partner who reports a
pricing bug honestly should know it turned up a second one in our own house.

## 4. On your §10 — the fix is right, the reason does not generalise

Your unconfirmed-stock finding is real and the fix is clearly right: 38 of 73 replies naming none
of the available unconfirmed units is a large hole, and `phrasing.uncertain` existing unused for a
week is exactly the sort of thing worth telling us.

But the line that makes the section memorable does not hold up. You wrote that every unconfirmed
unit sits below the cheapest confirmed one, so *"skip the unconfirmed"* and *"have nothing under
HK$12,500"* were the same sentence. Checked on our side over a wider window:

```
                     your sample            our window (49 units)
CONFIRMED       HK$12,500 - 17,000  (5)     HK$6,950 - 17,000  (14)
UNCONFIRMED     HK$ 8,500 - 12,000  (4)     HK$6,900 - 20,000  (35)
unconfirmed below cheapest confirmed         2 of 35
```

Your nine-unit sample happened to fall in a window with no cheap confirmed stock. The clean
separation is an artifact of that window, not a property of the portfolio — our cheapest confirmed
unit is HK$6,950, not HK$12,500, and unconfirmed stock runs to HK$20,000 at the top.

None of which weakens the fix. We raise it only because that sentence is the kind that gets
repeated until someone plans around it.

Your related claim that `certain: false` is the norm rather than an edge case is well founded:
**35 of 49** on our window, 71%, which is the same proportion as your ten of fourteen.

## 5. Your relay fixes — confirmed working, from our side

Worth saying plainly because your §1 and §2 are written as a confession and they read better as a
result. Our access log for 22 August:

```
01:31:19  POST /renewal-ask/…/reply   403   ← the read-only key
01:52:19  POST /renewal-ask/000…/reply 404  ← the placeholder id
01:54:07  POST /renewal-ask/…/reply   200   ← the SAME ask, 23 minutes later
```

Since then three tenant replies have come the whole way, all correctly filed:

| when | unit | what they wrote | filed as |
|---|---|---|---|
| 22 Aug | Hollywood 1B | "Thank you, I'll check when I'm back" | `unsure` — held for a person |
| 22 Aug | Tai Yuen 25/F | "Sorry I thought i have express my intent to leave on my email" | `leaving` |
| 23 Aug | Fuk Lo Tsun 3/F | "yes we would like to extend til the end of the year December 31st please!" | `extend`, applied |

The last is the whole pipeline with nobody in it: your relay, our classifier, the lease extended,
the unit withdrawn from customer-facing feeds. The first is the same pipeline declining to guess.
That is the arrangement in question 1 working, observed rather than promised.

Your reconcile alert named Hollywood 1B, and Hollywood 1B is the ask that then came through.

## 6. The group share — thank you, and it settles it

We asked what proportion of your tenant threads are groups because it decided the argument: if it
were most of them, a group-triggers-hold rule would have routed the majority of real answers back
to us by hand. At 12%, and with none of the ten tenants currently carrying an ask on a group
thread, it does not.

We counted those ten independently on our side and got the same ten. That is the second time the
two of us have agreed on a population without comparing notes first.

You answered a question that could have gone against you, with the number that decides it.

## 7. Briefly, on the rest

- **Classifier ownership stays as agreed.** We classify, you send raw text, we stay conservative,
  and neither side changes that quietly. Your §5 restates it and we are restating it back so it is
  on both records.
- **`unmatched`** — you found it and confirmed it works before we could reply. Nothing owed.
- **Gating the retry on `ambiguous` and `multi_unit`** (your §9) is the right call, and the side
  effect you noticed — the retry pinning past a `multi_unit` response — was the more serious half.
- **Your §11** needs nothing from us. The classifier reading your own previous message as the
  customer's requirements is a good catch and an unpleasant one to find.

---

## What changes for you

Three contract notes, none breaking:

1. **`over_budget_by` and `over_budget_pct` now measure against `asking_rent.amount`**, not
   `monthly_rent`. They were previously computed from a figure you do not quote, so the flag could
   contradict the filter. If you surface "about X% over budget" to a drafter, that number moves.
2. **`min_price` now drops a unit with no advertised band at all.** Previously such a unit could
   clear a floor on the sitting tenant's rent. If we cannot quote it, we should not claim it clears
   your minimum. `max_price` still keeps unpriced units — we cannot prove they are over budget.
3. **`monthly_rent` and `monthly_rent_basis` are unchanged** and still mean what they meant. We did
   not repurpose them; we stopped filtering on them.

Nothing else about the response has changed.

---

Thanks for both findings, and particularly for the one we had already declared fixed. A partner who
re-tests our claims instead of trusting them is worth more than one who agrees with us.

Chris

---

## Notes for Chris (not part of the message)

- **DO NOT SEND BEFORE THE DEPLOY.** §1 and §2 both say "we have changed" in the present tense.
  Both fixes are built, reviewed and tested here — 1070 backend tests, 0 failures — but at the time
  of writing they are **not yet on production.** The whole point of this letter is correcting a
  claim we made too early; making the same mistake in the letter that apologises for it would be
  bleak. Deploy, re-run the probes, then send.
- **We were wrong twice on `max_price` and the letter says so twice.** That is deliberate. They
  gave a wrong cause too, and said so plainly in their own §6 — the exchange works because neither
  side defends a bad diagnosis.
- **§2 is the one to read.** They reported a mild `ambiguous` case; investigating it turned up
  `confident` wrong answers on ordinary sentences like "we are 3 people" and "my budget is 10,000".
  It is the second time a budget has been read as a flat number, and the second time we announced
  it fixed. Saying "you found the mild half" is accurate and costs us nothing we have not already
  spent.
- **§3 is our own assistant, now switched to the asking rent on your instruction.** It had been
  quoting the outgoing tenant's rent, under-quoting 35 of 49 units by HK$1,401 on average. Cutting
  §3 costs them nothing — it affects nothing they receive. I would keep it: their §7 is what sent
  us looking, and it is the strongest possible answer to a partner who reports things honestly.
- **§4 corrects them.** Their most quotable sentence does not survive a wider window. Their fix is
  still right, and the letter says so first.
- **Watch for**: if they ask why `"Tai Yuen 10"` stopped resolving, that is §2's deliberate loss,
  not a regression.
