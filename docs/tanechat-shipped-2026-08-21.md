# To TaneChat — both changes are live

**Short follow-up to today's reply. Ready to send.**

---

Hi team,

Both of the things we owed you from this morning are deployed and live on production. Two changes
on your side, one of which we would do today.

## 1. `asking_rent` — please stop quoting `rent_price_max` now

`/vacancies` and `/units/{id}` now return the rate to quote today:

```json
"asking_rent": {
  "amount": "16000.00",
  "tier": "low",
  "min": "16000.00",
  "max": "17500.00"
}
```

Quote **`asking_rent.amount`**. `tier` is there so you can see where the number came from
(`high` / `mid` / `low` / `discount`); you never need to compute it. It is `null` — not an object of
nulls — when a unit has no price bounds, so `if (asking_rent)` is a safe check.

Here is what is actually on your feed right now, and what `rent_price_max` would have had you say:

| Unit | Days out | You'd quote (`rent_price_max`) | Correct (`asking_rent`) | Over by |
|---|---:|---:|---:|---:|
| Tai Yuen 25/F | 39 | 19,000 | **17,000** | 2,000 |
| Mercer 5A | 40 | 17,500 | **16,000** | 1,500 |
| Mong Kok 1C | 30 | 10,800 | **9,400** | 1,400 |
| Hollywood 5B | 51 | 15,000 | **14,000** | 1,000 |
| Poplar 2B | 57 | 13,000 | **13,000** | — |

Poplar is the only one that matches, because it is 57 days out and the top of the range is genuinely
right that far ahead. That is the whole shape of the problem: `rent_price_max` is our correct number
only beyond eight weeks, and every unit closer in was being over-quoted.

`rent` and `rent_basis` are unchanged and still there, but do not quote either. When `rent_basis` is
`"lease"` that figure is the sitting tenant's own contracted rate.

## 2. The resolver takes floor+flat notation — please drop your fallback

Live now, verified against production:

```
"Mong Kok 1/F Studio C"   ->  confident   Mong Kok 1C
"Mong Kok 5/F D"          ->  confident   Mong Kok 5D
"Sheung Wan 5/F Flat B"   ->  ambiguous   Hollywood 5B, Mercer 5B
```

That last one is the right answer rather than a miss — the prospect named a district and a flat, and
there really are two. You get a proper disambiguation list where you previously got four unrelated
candidates.

One deliberate limit: a bare letter only joins to the floor when it is unambiguous, so
`"1/F a nice flat"` stays a sentence and does not resolve to unit `1A`. If you see a legitimate
phrasing we refuse, send it over and we will widen the rule rather than have you pattern-match
around it.

`query` still echoes the customer's original words, not our rewrite, so your logs are unaffected.

## 3. Nothing to do

`property_resolution` is `unique` | `ambiguous` | `none`, as sent this morning — branch on `matched`
first, since `none` covers both "no tenant" and "tenant with no active property".

Your `version` observation is now written into our public API docs, so the next integrator does not
have to discover it the way you did.

Thanks again for the `rent_price_max` question. It is the one that was costing real money, and you
found it.

Chris

---

## Notes for Chris (not part of the message)

- The figures in the table are live from the production feed and will drift as units approach
  availability. Fine to send today; re-check if this sits unsent for more than a few days.
- Deployed at commit `1ef2e27`. Rollback point is `113b74d` — backend-only, `pm2 restart
  tenafy-backend`, no migrations ran.
