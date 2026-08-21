# Reply to TaneChat — asking price, resolver, property_resolution

**Draft for Chris to review and send. Not sent.**

---

Hi team,

Answers to all three, and on the first one you are half right in a way that matters: your reading of
`rent_basis` is correct, but the number you have switched to is also wrong. Please stop quoting it
today.

## 1. Neither `rent` nor `rent_price_max` is the asking price

**Your reading of `rent_basis: 'lease'` is right.** It is the sitting tenant's invoiced figure, not
an asking price. In `utils/advertisingPlan.js`:

```js
const hasSchedule    = row.invoicing != null && String(row.invoicing).trim() !== '';
const publishedRent  = hasSchedule ? row.rent : row.rent_price_min;
const rent_basis     = hasSchedule ? 'lease' : 'advertised';
```

So `'lease'` is the current lease's periodic amount, and `'advertised'` is the unit's
**`rent_price_min`** — the bottom of the range, not the top.

**But `rent_price_max` is not the asking price either.** Our own advertising has never quoted it
alone. There are two distinct notions on our side and we had exposed neither to you:

- **The range.** Where `rent_price_min` and `rent_price_max` differ, our ad templates render
  `"min - max"`. A range, never the top figure.
- **The posting rent.** A single figure that steps *down* as the unit gets closer to being empty:

  | Days until available | What we advertise |
  |---|---|
  | 56 or more (≥ 8 weeks) | top of range (`rent_price_max`) |
  | 42–55 (6–8 weeks) | midpoint |
  | 0–41 (< 6 weeks) | bottom of range (`rent_price_min`) |
  | already vacant > 1 day | bottom − 10% |
  | unknown | bottom (deliberately conservative) |

  (`services/advertisingTemplate.js`, `computePostingRent`.)

So quoting `rent_price_max` is our correct number only for a unit at least eight weeks from being
free. In every other case it over-quotes, and by the time a unit is actually empty it over-quotes by
the full spread plus 10%.

**The spread is much wider than the HK$400–1,100 you have seen.** Across our live portfolio:

- **115 of our 118 active units** have `rent_price_max` ≠ `rent_price_min`
- average spread **HK$1,512/month**
- widest **HK$5,000/month** (Fuk Lo Tsun, 3/F Unit 1: 15,000–20,000)

So this is not an edge case affecting a few flats. Almost every unit we have carries a spread, and
the HK$400–1,100 you have seen is the narrow end of it.

**What we are doing:** exposing the posting rent on the public API, as an `asking_rent` object on
`/vacancies` and `/units/{id}` — the resolved figure, the tier that produced it, and the range —
so there is one number that is unambiguously "the rate to quote today" and you never have to derive
it. We would rather ship that than have you reimplement a ladder we change from time to time.

**Until it lands**, quote **`rent_price_min`**, or the range if you would rather show both bounds.
It is the conservative end, it is what our own ads fall back to, and under-quoting by a known amount
is a far cheaper error than honouring an over-quote.

**Your second question — should the lease figure ever be quoted to a prospect?** No. It is one
tenant's negotiated rate, and it can sit either side of the current asking range. It is useful to
you as context, never as a price. If it would help, we can drop `rent` from the payload entirely
once `asking_rent` is live, so there is no ambiguous number left to pick up.

## 2. `/units/resolve` and floor+unit — yes, we will own it

We reproduced both of your cases exactly against our live unit list:

```
"Mong Kok 1/F Studio C"  ->  property_only   (candidates: 1A, 1B, 1C, 1D)
"Mong Kok 1C"            ->  confident       Mong Kok 1C
```

The cause is on our side. Our scorer takes the meaningful unit token from the query and requires a
token of two characters or more, so `1`, `F` and `C` are all discarded individually and `Studio` is
noise. The flat is genuinely named `1C`; nothing in the query ever forms that token.

Please drop your fallback — and we would ask you to, rather than merely permit it. This is not a
normalisation you can do safely from outside, and we can show you why. Our first attempt simply
appended the derived token, which looks obviously correct:

```
"Mong Kok 1/F Studio C"  +  "1c"   ->  multi_unit
```

It came back as a request to view *two* flats. The bare `1` from `1/F` exact-matches a unit at
another property literally named `Unit 1`, so the query then names two distinct units and we escalate
it to staff as a multi-viewing request. The floor number has to be **consumed**, not kept alongside
the derived token — and knowing that requires our full unit list, which you do not have.

Consuming it resolves all the forms and changes nothing else:

```
"Mong Kok 1/F Studio C"  ->  confident   Mong Kok 1C
"Mong Kok 5/F D"         ->  confident   Mong Kok 5D
"Mong Kok 2/F B"         ->  confident   Mong Kok 2B
"Sheung Wan 5/F Flat B"  ->  ambiguous   Hollywood 5B, Mercer 5B
```

That last one is the correct answer, not a miss: the prospect named a district and a flat, and we
have two. You get a real disambiguation list instead of four unrelated candidates.

We swept every property/unit name in the portfolio — 354 queries — and **nothing that resolves today
resolves differently**. We will ship it with that sweep as a regression test.

## 3. `property_resolution`

Three values:

| Value | Meaning |
|---|---|
| `unique` | exactly one active property |
| `ambiguous` | more than one |
| `none` | no active property |

One caveat worth having, since it is the branch that will surprise you: **`none` arises two
different ways** — no tenant matched the phone number at all, and a tenant matched but has no active
property. `matched` distinguishes them (`false` in the first case), so branch on `matched` first and
`property_resolution` second.

You are right not to infer from `active_properties.length`. It happens to be derived from exactly
that today, but it is the field we will keep truthful if the rule gains a case.

## On the `version` note — correct, deliberate, and we are not changing it

You are right, and thank you for spelling it out. The hash covers the whole response including
`property_context`, so a scoped and an unscoped call differ even when the FAQ bodies are byte-identical.

We are keeping it that way. The version identifies *the response*, not the content of the FAQ list;
if it covered only the bodies, two different scopes could produce the same tag, and a cache keyed on
it could serve one building's answers under another building's request. That is a much worse failure
than a redundant refetch.

Your fix is the right one, and it applies to `/api/website/:slug/faqs` too, which has the same
property. **Key per property.** We will state it in the docs so the next integrator does not have to
find it the way you did.

Thanks — the first of these was worth catching quickly.

Chris

---

## Notes for Chris (not part of the message)

- **Send today.** They are quoting `rent_price_max` live. Every day this sits, someone is quoted a
  rate we then have to honour, potentially HK$10,500/month over on the worst unit.
- We were the cause of both directions of this error: `rent` was never documented as the sitting
  tenant's figure, and the posting-rent ladder was never exposed at all. Neither is their misreading.
- `asking_rent` on `/vacancies` + `/units/{id}` is a small, contained job — `computePostingRent` is
  already pure and tested; it just needs `days_until` and the two bounds, which the vacancy row
  already carries.
- ⚠️ The resolver fix is NOT built. It exists only as a scratch prototype run against a dump of the
  live unit list; nothing in `backend/` has changed. The message promises it in future tense, which
  is accurate — but do not send this believing it is ready to merge. Build = the normaliser in
  `services/unitResolver.js` + the 354-query sweep as a real test in `backend/test/`.
- Not raised: `1C` exists at both **Mong Kok** and **Poplar**, so a query naming only a district or
  only the flat stays `ambiguous` there. Correct behaviour, but worth knowing if they report it.
- Figures above are scoped to org 8300127259922432. An earlier unscoped count (196/612, max
  HK$10,500) spanned every org in the database, including test data — do not use it.
