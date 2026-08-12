# Handoff: TaneChat availability answers

**For:** the TaneChat team.
**Status:** move availability answers from `/units/available` to `/vacancies`.

---

## 1. What changed

TaneChat should answer "what's available?" from:

```
GET https://platform.tenafy.com/api/public/vacancies
Header: X-API-Key: <key>
```

Read-only API keys work. `/units/search` is unchanged and remains the right tool
for resolving a named unit like "mongkok 6a". Only availability questions move.

---

## 2. Why `/units/available` is being retired

The old endpoint only checked whether a unit had a lease covering one date. That
made it wrong in both directions.

1. It over-reported. On August 12, 2026, it returned `6A Test` because the unit
   was vacant that day, even though a tenant was moving in three days later on
   August 15, 2026. There was no minimum-gap rule, so a unit that was effectively
   already taken could still be offered.
2. It under-reported. On August 12, 2026, a unit with a lease ending September
   15, 2026 was invisible, even though someone looking for October should hear
   about it. The old endpoint could not answer "what's coming up?"

It also had no renewal intent, so it could not tell the difference between a
tenant who has confirmed they are leaving and one who may renew.

---

## 3. The three tiers

`/vacancies` returns all tiers by default. Use `availability.certain` to decide
wording. Do not branch directly on `tier`; if Tenafy adds another tier later,
`certain` keeps the chatbot behavior stable.

| Tier | Meaning | What TaneChat should say |
|---:|---|---|
| 1 | Vacant now and passes the minimum-gap rule | "available now" |
| 2 | NR: tenant has confirmed they are not renewing | "available from {date}" |
| 3 | MR / MTM / UC: tenant may renew | Use `phrasing.uncertain`; never state it as firm availability |

`available_from` is already the first free day. It is lease end + 1. Do not add
another day.

---

## 4. Migration

1. Replace `/units/available` with `/vacancies`.
2. Read `availability.certain`.
3. Say certain tier-1 units are available now.
4. Say certain tier-2 units are available from `availability.available_from`.
5. Group uncertain units into one caveated sentence using `phrasing.uncertain`.
   Do not repeat the caveat once per unit.

---

## 5. Using `target_date`

When the prospect gives a move-in date, pass it through:

```
GET https://platform.tenafy.com/api/public/vacancies?target_date=2026-10-15
Header: X-API-Key: <key>
```

`target_date` must be `YYYY-MM-DD`. With it, `/vacancies` adds:

| Field | Meaning |
|---|---|
| `gap_days` | `target_date - available date`, in days |
| `gap_warning` | Advisory warning when the positive gap is above `max_gap_days` |
| `available_after_target` | The unit is not free until after the prospect wants to move in |

Positive `gap_days` means lost rent: the unit is free before the prospect
arrives. Negative `gap_days` means the prospect waits; it is not a lost-rent
warning. `gap_warning` is advisory only. Do not omit a warned unit. Use
`phrasing.earlier` to ask whether the prospect can start earlier instead of
hiding the option.

---

## 6. Worked example

Response:

```json
{
  "code": 200,
  "data": {
    "vacancies": [
      {
        "unit_id": "101",
        "unit_name": "4A",
        "property_id": "10",
        "property_name": "Central House",
        "label": "Central House 4A",
        "unit_type": "apartment",
        "beds": 1,
        "baths": 1,
        "size": 280,
        "rent": "9800.00",
        "tier": 1,
        "tier_name": "VACANT",
        "intent": "Unset",
        "availability": {
          "status": "from_date",
          "available_from": "2026-10-15",
          "days_until": 64,
          "certain": true
        },
        "gap_days": 0,
        "gap_warning": false,
        "available_after_target": false
      },
      {
        "unit_id": "202",
        "unit_name": "8B",
        "property_id": "20",
        "property_name": "Harbour Court",
        "label": "Harbour Court 8B",
        "unit_type": "apartment",
        "beds": 1,
        "baths": 1,
        "size": 320,
        "rent": "12000.00",
        "tier": 2,
        "tier_name": "NR",
        "intent": "NR",
        "availability": {
          "status": "from_date",
          "available_from": "2026-09-15",
          "days_until": 34,
          "certain": true
        },
        "gap_days": 30,
        "gap_warning": true,
        "available_after_target": false
      },
      {
        "unit_id": "303",
        "unit_name": "2C",
        "property_id": "30",
        "property_name": "Kowloon Loft",
        "label": "Kowloon Loft 2C",
        "unit_type": "apartment",
        "beds": 2,
        "baths": 1,
        "size": 430,
        "rent": "18000.00",
        "tier": 3,
        "tier_name": "MR/other",
        "intent": "MR",
        "availability": {
          "status": "from_date",
          "available_from": "2026-11-01",
          "days_until": 81,
          "certain": true
        },
        "gap_days": -17,
        "gap_warning": false,
        "available_after_target": true
      }
    ],
    "count": 3,
    "phrasing": {
      "certain": "{units} available from {date}",
      "uncertain": "We may also have {units} available, however the tenant may renew, they're not sure",
      "earlier": "{units} is free from {date} — would you be able to start a little earlier?"
    },
    "target_date": "2026-10-15",
    "max_gap_days": 14
  }
}
```

Message TaneChat should produce:

> Central House 4A is available from 2026-10-15. Harbour Court 8B is free from
> 2026-09-15 — would you be able to start a little earlier? Kowloon Loft 2C is
> available from 2026-11-01 if you can wait until then.

---

## 8. Verified live on production — 2026-08-12

Not illustrative. This is the real response, so you can compare your own call
against it.

`GET /vacancies?target_date=2026-10-15` → `count: 6`, `max_gap_days: 14`

| tier | intent | available_from | gap_days | flags | unit |
|---:|---|---|---:|---|---|
| 2 | NR | 2026-10-12 | 3 | — | Hollywood 5B |
| 2 | NR | 2026-09-27 | 18 | `gap_warning` | Jardine 2B |
| 3 | MR | 2026-09-26 | 19 | `gap_warning`, `certain:false` | Hollywood 1B |
| 3 | MR | 2026-09-21 | 24 | `gap_warning`, `certain:false` | Mong Kok 1C |
| 3 | MR | 2026-09-21 | 24 | `gap_warning`, `certain:false` | Mong Kok 5D |
| 2 | NR | 2026-09-17 | 28 | `gap_warning` | Gilman's Bazaar 5B |

Three things to notice:

- **Best fit is first.** Hollywood 5B (3-day gap) leads; the 28-day gap is last.
  Sorting is done for you — do not re-sort by price or name before answering.
- **Nothing was removed.** Five of six carry `gap_warning` and all six are still
  returned. The warning is advice, not exclusion.
- **`certain:false` appears only on the tier-3 MR rows.** Those are the ones that
  need `phrasing.uncertain`.

A good answer from that payload:

> Hollywood 5B is available from 12 October, which lines up well with your date.
> Jardine 2B and Gilman's Bazaar 5B are free a bit earlier, from 27 September and
> 17 September — would you be able to start a little earlier?
> We may also have Hollywood 1B, Mong Kok 1C and Mong Kok 5D available, however
> the tenant may renew, they're not sure.

Note the uncertain units are grouped into **one** caveated sentence rather than
repeating the caveat three times.

### What `/units/available` now returns

Same day, the deprecated endpoint returned **1 unit, down from 6**. That is the
over-reporting being corrected, not units disappearing: the other five are re-let
within 40 days, so they are not genuinely available now. They still appear in
`/vacancies` with an `available_from` date. If your current chatbot answers feel
suddenly thinner, this is why — and it is the reason to migrate rather than a
reason to worry.

`?date=` still works and every original field (`amenity_type`, `city`, …) is still
returned, so nothing breaks while you migrate. Responses now carry a
`Deprecation: true` header and `meta.replacement: "/vacancies"`.
