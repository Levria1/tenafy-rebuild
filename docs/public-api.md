# Tenafy Public API Reference

Read-only HTTP API for external integrations (e.g. your own AI assistant).

## Base URL

| Environment | URL |
|---|---|
| Production droplet | `http://YOUR_DROPLET_IP:3001` (or your reverse-proxy URL) |
| Local dev | `http://localhost:3001` |

All endpoints in this reference are prefixed with `/api/public/`.

⚠️ **One route deliberately sits outside it and takes no key at all:**
`GET /api/website/:org_slug/faqs`, the marketing-site FAQ feed — see
[The website FAQ feed](#the-website-faq-feed) at the end of this document. It is separate
precisely because a key that opened it would also open everything below.

## Authentication

Every request to `/api/public/` requires an `X-API-Key` header:

```
X-API-Key: pk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

### Setup

1. Master admin logs in at `/master/login`
2. Go to `/master/dashboard` → toggle **Public API** ON for the org
3. Go to `/master/api-keys` → **+ New API Key** → select org → save
4. Copy the key immediately (shown once only)

### Auth errors

| Code | Reason |
|---|---|
| 401 | Missing or invalid `X-API-Key` |
| 403 | Public API not enabled on the org, OR key is disabled |

## Response Format

All endpoints return JSON in this shape:

```json
{
  "code": 200,
  "data": ...,
  "meta": { "total": N, "date": "..." }
}
```

- List endpoints return `data` as an array, with `meta.total` = array length
- Detail endpoints return `data` as an object
- Errors return `{ "code": 4xx|5xx, "message": "..." }`

## Rate Limits & Pagination

- No pagination — every list endpoint returns ALL rows
- No rate limiting currently applied — use responsibly

---

## Endpoints

### Meta

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Confirm auth works; returns `{ ok, org_id, key_name, timestamp }` |

### Properties

| Method | Path | Query | Description |
|---|---|---|---|
| GET | `/properties` | `?date=YYYY-MM-DD` | All active properties + vacancy counts |
| GET | `/properties/:id` | | Property detail + amenities + gallery |

### Units

| Method | Path | Query | Description |
|---|---|---|---|
| GET | `/units` | `?property_id=&status=0\|1&active_status=0\|1` | All units (filtered) |
| GET | `/units/:id` | | Unit detail + current lease + tenant + amenities + gallery |
| GET | `/units/search` | `?move_in_date=&move_out_date=&bedrooms=&bathrooms=&min_price=&max_price=&budget=&property_id=&city=&district=&amenities=&sort_by=&limit=` | Smart available-unit search for alternative offers |
| POST | `/units/resolve` | | Read-only unit lookup from id, listing URL, or free text |
| GET | `/vacancies` | `?max_tier=3&property_id=&limit=50&free_on=YYYY-MM-DD&target_date=YYYY-MM-DD&move_out=YYYY-MM-DD` | Chatbot availability using advertising vacancy logic. Beyond the 60-day booking horizon only confirmed-leaving units are offered — see Booking horizon below |
| GET | `/units/available` | `?date=YYYY-MM-DD&property_id=` | Deprecated; use `/vacancies` |

### Tenants & Contacts

`GET /tenants/lookup` phone matching requires at least **8 digits** and compares exactly the last eight digits after removing formatting. Seven-digit queries now return `400`; partners must send an eight-digit-or-longer number (or use email lookup).

| Method | Path | Query | Description |
|---|---|---|---|
| GET | `/tenants` | `?status=&category=1\|2` | All tenants (category 1 = tenant, 2 = payee) |
| GET | `/tenants/:id` | | Single tenant |
| GET | `/tenants/:id/leases` | | All leases for a tenant |
| GET | `/tenants/:id/invoices` | | All invoices for a tenant |
| GET | `/payees` | | Payees (tenants with category=2) |
| GET | `/payees/:id` | | Single payee |
| GET | `/property-owners` | | All property owners |
| GET | `/property-owners/:id` | | Single owner |
| GET | `/service-vendors` | | All service vendors |
| GET | `/service-vendors/:id` | | Single vendor |

### Leases

| Method | Path | Query | Description |
|---|---|---|---|
| GET | `/leases` | `?status=active\|upcoming\|inactive&unit_id=&tenant_id=` | All leases |
| GET | `/leases/expiring` | `?days=30` | Leases ending within N days |
| GET | `/leases/:id` | | Lease detail + additional tenants |

### Invoices & Payments

| Method | Path | Query | Description |
|---|---|---|---|
| GET | `/invoices` | `?status=0\|1\|2&tenant_id=&property_id=&unit_id=&from=&to=` | All invoices |
| GET | `/invoices/:id` | | Invoice detail + payment history + outstanding balance |
| GET | `/payments` | `?tenant_id=&from=&to=` | All payment/accounting records |

### Accounting

| Method | Path | Query | Description |
|---|---|---|---|
| GET | `/accounting` | `?type=0\|1&category=&tenant_id=&property_id=&from=&to=` | All entries (0=inflow, 1=outflow) |
| GET | `/accounting/:id` | | Entry detail + line items |

### Services

| Method | Path | Query | Description |
|---|---|---|---|
| GET | `/services` | `?status=&unit_id=&property_id=` | All service requests |
| GET | `/services/:id` | | Service detail + activity timeline |

### Utilities

| Method | Path | Query | Description |
|---|---|---|---|
| GET | `/utility/groups` | | All utility groups |
| GET | `/utility/bills` | `?group_id=` | All utility bills |
| GET | `/utility/bills/:id` | | Bill detail + all lines |
| GET | `/utility/meters` | `?group_id=&unit_id=` | All meters |
| GET | `/utility/meters/:id/readings` | | Reading history for a meter |
| GET | `/utility/settlements` | `?tenant_id=` | All checkout settlements |
| GET | `/chat/knowledge` | `?property_id=` | Public chat rules and FAQs |

### Cleaning

| Method | Path | Query | Description |
|---|---|---|---|
| GET | `/cleaning/cleaners` | | All cleaners |
| GET | `/cleaning/schedule` | `?week_of=YYYY-MM-DD` (required) | Cleaning schedule for week |

### Units

#### What counts as a public unit

`GET /vacancies`, `GET /units/search` and `POST /units/resolve` share one
definition of which units may be shown to a prospect
(`backend/src/utils/publicUnitScope.js`). A unit is excluded when either its own
name or its property's display name contains "test" (case-insensitive
substring) — so `Test Property 2 · Unit 1` and `Mong Kok · 6A Test` are both
withheld.

The exclusion happens in the SQL, not after scoring. That matters for
`/units/resolve` in particular: a candidate that never enters the set cannot win
a confident match, whereas filtering afterwards would mean the decision had
already been made against it.

Two consequences worth knowing:

- **A real property whose name contains "test" would be withheld.** The rule is a
  substring match, so a building on a street like "Testbourne Road" is caught.
  The pattern is deliberately not widened further; the intended remedy is to keep
  placeholder records out of the production portfolio.
- **It only catches the word "test".** A placeholder named "Demo" or "Spare" is
  published like any other unit.

Note this is separate from — and not covered by — the `property.status` filter: a
test property left *active* passes the status check and is caught only by name.

#### `POST /units/resolve`

Requires `X-API-Key`. **Read-only keys are allowed**, despite the `POST` — this
is one of a small allowlist of POSTs that write nothing (see
`READ_ONLY_SAFE_POSTS`). It is `POST` rather than `GET` so a customer's raw
message travels in a body instead of a query string, which would put it in every
access log.

Safe to call on every inbound message: it resolves a unit reference without
starting a viewing negotiation, sending messages, or writing any records.

Request body:

```json
{
  "unit_id": "123",
  "listing_url": "https://taneresidence.com/product/mong-kok-5a/",
  "unit_text": "Mong Kok Flat 5A"
}
```

All fields are optional, but at least one of `unit_id`, `listing_url`, or
`unit_text` is required. `listing_link` is accepted as an alias for
`listing_url`. Empty or whitespace-only `unit_text` is treated as absent, and
`unit_text` is limited to 500 characters.

Precedence is fixed and matches `/viewing-negotiation/start`:

| Order | Field | Behavior |
|---:|---|---|
| 1 | `unit_id` | Active unit in the caller's org only |
| 2 | `listing_url` / `listing_link` | Exact listing URL match after URL normalization |
| 3 | `unit_text` | Shared fuzzy unit resolver |

If `listing_url` is not found and `unit_text` is also present, the endpoint
falls through and resolves by text. If `unit_id` is present, it always wins.

Response:

```json
{
  "code": 200,
  "data": {
    "status": "confident",
    "resolved_by": "unit_text",
    "match": {
      "unit_id": "123",
      "unit_name": "5A",
      "property_id": "456",
      "property_name": "Mong Kok",
      "label": "Mong Kok 5A",
      "marketable": true
    },
    "candidates": [],
    "unmatched": [],
    "query": "mong kok flat 5a"
  }
}
```

`query` is returned only when resolution used `unit_text`. `match` is non-null
only when `status` is `confident`; otherwise inspect `candidates`.
`unmatched` is always present. For `unit_text` resolutions, it reports unit-like
tokens that were not found at the matched property, for example:

```json
[
  {
    "text": "5e",
    "reason": "unit_like_not_found",
    "floor": "5",
    "floor_units": ["Poplar 5A", "Poplar 5B", "Poplar 5C", "Poplar 5D"],
    "floor_unit_count": 4
  }
]
```

Every entry includes `text`, `reason`, `floor`, `floor_units`, and
`floor_unit_count`. `floor` is populated only for a digit-run followed by exactly
one letter, such as `5e`, and only when the resolver has narrowed the request to
exactly one property. Otherwise `floor` is `null`, `floor_units` is `[]`, and
`floor_unit_count` is `0`. `floor_units` lists existing unit labels on that floor
at the resolved property, sorted by unit name and capped at 8 labels;
`floor_unit_count` is the uncapped total. An empty `floor_units` list with a
non-null `floor` is meaningful: the identified building has no units on that
floor. `unmatched` is `[]` when there is nothing useful to report and is always
`[]` for `status: "none"`.

Status vocabulary:

| Status | Meaning |
|---|---|
| `confident` | Exactly one unit was resolved |
| `ambiguous` | More than one unit could match; use `candidates` to disambiguate |
| `property_only` | The text identifies a property but not a specific unit |
| `multi_unit` | The text appears to name more than one distinct unit; use `candidates` so the customer can choose |
| `none` | No active unit in this org matched |

An unrecognised `unit_id` returns `status: "none"`, not `404`, so a typo and a
real unit belonging to another org are indistinguishable from outside. Unlike a
stale `listing_url`, it does **not** fall through to `unit_text`: a listing URL
goes stale on its own, whereas a `unit_id` is one we issued, so a miss means a
caller bug worth surfacing rather than papering over with a fuzzy match.

Only `confident` is safe to act on without confirming with the customer. Treat
`ambiguous`, `property_only`, and `multi_unit` as "ask which one" — the resolver
deliberately declines to guess between equally-good matches rather than picking
the first.

#### `GET /units/:id`

Requires `X-API-Key`; read-only keys are allowed. Returns the unit record with
its current lease, amenities, gallery, booking token, photo URLs, and
availability block.

`data.asking_rent` is the rate to quote today. It has the same shape and meaning
as on `GET /vacancies`: `amount`, `tier`, `min`, and `max`, or `null` when the
unit has no usable price bounds. The tier is driven by the latest lease move-out
date relative to `orgToday()`; an already-ended lease produces a negative day
count and can return `discount`. Do not use `data.rent` or a current lease price
as the asking price.

```json
{
  "code": 200,
  "data": {
    "id": "123",
    "name": "5B",
    "rent_price_min": "14000.00",
    "rent_price_max": "16500.00",
    "availability": {
      "available_from": "2026-09-16",
      "current_move_out": "2026-09-15",
      "status": "occupied_until_move_out"
    },
    "asking_rent": {
      "amount": "15250.00",
      "tier": "mid",
      "min": "14000.00",
      "max": "16500.00"
    }
  }
}
```

`asking_rent.tier` values are `high`, `mid`, `low`, and `discount`, using the
same timing ladder described under `GET /vacancies`.

#### `GET /units/search`

Requires `X-API-Key`; read-only keys are allowed. Returns available alternative
units ranked by the shared search engine used by the public API and internal
chatbot tools.

Each result includes the existing numeric price fields (`monthly_rent`,
`rent_price_min`, `rent_price_max`) and now also:

- `asking_rent`: `{ amount, tier, min, max }` with two-decimal money strings, or
  `null` when the unit has no usable price bounds. **`asking_rent.amount` is the
  rate to quote to a prospect.**
- `monthly_rent_basis`: `"lease"`, `"advertised"`, or `null`. `"lease"` means
  `monthly_rent` came from a lease with a recurring invoice schedule.
  `"advertised"` means it came from the unit's own advertised minimum
  (`rent_price_min`). `null` means no monthly rent could be published.

`monthly_rent` is retained for compatibility and sorting metadata only. It is
not the rate to quote; use `asking_rent.amount` instead. A lease without an
invoice schedule can store a whole-stay total, so search falls back to
`rent_price_min` for `monthly_rent` in that case.

##### `available_until`

Every result carries `available_until`: the last day the unit can be occupied
before its next booking begins, or `null` when nothing follows. Without it a unit
that is free today but let from 1 January reads as open-ended, which is why this
endpoint and `GET /units/:id` appeared to disagree about the same unit.

##### Window search — "free at any point between two dates"

`move_in_date` is a **single day**: the search returns units free on exactly that
date, and `available_from` defaults to the date you sent. It is therefore not a
property of the unit, and sending a far-future date does not widen the result —
it answers for a tenant moving in on that far-future day.

To ask "who could take someone from 21 Aug to 31 Dec", send both:

```
GET /units/search?available_between_start=2026-08-21&available_between_end=2026-12-31&district=Sheung%20Wan
```

Window mode takes precedence over `move_in_date` / `move_out_date` for filtering.
Both bounds are required together; either alone, a malformed date, or an end
before the start is a `400`.

Each result reports the **longest single unbroken stretch** it is free within
that window:

| Field | Meaning |
|---|---|
| `available_from` | first day of that stretch |
| `available_until` | last day of that stretch |
| `coverage_days` | length of the stretch, inclusive — **for sorting; quote the dates** |
| `availability_certain` | `false` when the opening depends on a tenant who has not confirmed departure |
| `area_match` | `"district"`, `"same_side"`, or `"other"` |

A unit free in two separate stretches reports only the longer one (ties resolve
to the earlier). Fragments are never summed: "free 21 Aug–3 Sep and 5 Nov–31 Dec"
is not an offer anyone can accept for a continuous stay.

**`availability_certain`.** Single-day mode only offers an occupied unit when its
tenant is Not Renewing. Window mode cannot apply that rule — it would discard the
units window search exists to find — so it returns them and flags the
uncertainty instead. `false` means a tenant who has not confirmed they are
leaving is due out the day before the stretch begins. Quote those as *possible*,
not as available.

**`district` becomes a preference, `city` stays a constraint.** In window mode
only, units outside the requested district still come back — in a sibling
`alternatives_outside_area` array — so you can ask "nothing in Sheung Wan covers
your dates, would you consider Mong Kok?" rather than reporting nothing. Ranking
is district → same side of the harbour (`property.city`) → anywhere, then longest
coverage. `city` remains a hard filter: naming a city states a constraint, and an
option across the harbour is not an alternative.

`alternatives_outside_area` is **always present in window mode**, as an empty
array when there are none, so "no alternatives" is distinguishable from a
deployment that predates the feature.

Fields measured against a move-in date — `forward_gap_days`, `vacancy_gap_days`,
`gap_within_tolerance`, `lease_duration_days`, `gap_band_days` — are `null` in
window mode, because window mode has no single move-in date to measure from.
`days_until_available` is measured from the start of the reported stretch.

### Advertising posting plan

#### `GET /vacancies`

Requires `X-API-Key`; read-only keys are allowed. This is the public chatbot
availability endpoint and uses the same vacancy engine as Advertising -> Vacancy
and the posting plan. It applies customer-facing lead-time windows and priority
sorting (`page=false` internally).

Query parameters:

| Param | Default | Clamp | Description |
|---|---:|---:|---|
| `max_tier` | `3` | `1`-`3` | `1` vacant only, `2` vacant + NR, `3` all tiers |
| `property_id` | | | Optional property filter |
| `limit` | `50` | `1`-`200` | Maximum rows returned |
| `target_date` | | | Ranks by move-in fit and applies the same gap fields as `free_on`. Positive gaps beyond the band are still offered with an earlier move-in ask; positive gaps beyond the ceiling are hidden. Must be `YYYY-MM-DD`; malformed values return `400` |
| `free_on` | | | Hard availability filter for the requested date. Rows free on or before the date stay in `vacancies` and now carry gap fields and earlier move-in asks. Must be `YYYY-MM-DD`; malformed values return `400` |

All tiers are included by default. Tier 3 rows are deliberately returned with
`availability.certain=false` so TaneChat can offer them with the configured
caveat instead of stating them as firm availability.

```json
{
  "code": 200,
  "data": {
    "vacancies": [{
      "unit_id": "123",
      "unit_name": "5B",
      "property_id": "456",
      "property_name": "Gilman's Bazaar",
      "label": "Gilman's Bazaar 5B",
      "unit_type": "apartment",
      "beds": 1,
      "baths": 1,
      "size": 320,
      "rent": "12000.00",
      "rent_price_min": "14000.00",
      "rent_price_max": "16500.00",
      "rent_basis": "lease",
      "asking_rent": {
        "amount": "15250.00",
        "tier": "mid",
        "min": "14000.00",
        "max": "16500.00"
      },
      "listing_url": "https://taneresidence.com/product/gilmans-bazaar-5b/",
      "tier": 2,
      "tier_name": "NR",
      "intent": "NR",
      "availability": {
        "status": "from_date",
        "available_from": "2026-09-16",
        "days_until": 35,
        "certain": true
      },
      "gap_days": 29,
      "gap_warning": true,
      "available_after_target": false,
      "gap_band_days": 10,
      "gap_band_assumed": true,
      "gap_within_band": false,
      "suggested_move_in_date": "2026-09-26"
    }],
    "count": 1,
    "phrasing": {
      "certain": "{units} available from {date}",
      "uncertain": "We may also have {units} available, however the tenant may renew, they're not sure",
      "earlier": "{units} is free from {date} — would you be able to start a little earlier? We try not to leave a flat empty too long.",
      "gap_ask": "We're unable to accept a booking that would leave {units} empty for {gap_days} days. Would you be able to move in by {suggested_move_in_date}?"
    },
    "target_date": "2026-10-15",
    "booking_gap_days": 10,
    "lease_duration_days": null,
    "max_gap_days": 10,
    "hard_max_gap_days": 15,
    "hidden_by_gap_cap": 0,
    "no_match_reason": null,
    "partner_forward": {
      "applies": false,
      "message": null
    }
  }
}
```

`listing_url` is the unit's public listing page on taneresidence.com, or `null`
when none is recorded. It is the same value `GET /units/:id` returns for that
unit, so there is no need to make a detail call per row to obtain it. Not every
unit has one.

Availability rules:

| Tier | `tier_name` | Meaning | `availability` |
|---:|---|---|---|
| 1 | `VACANT` | Empty now and passes the minimum gap rule | `status="now"`, `available_from=null`, `days_until=0`, `certain=true` |
| 2 | `NR` | Tenant has confirmed they are not renewing | `status="from_date"`, `available_from=end_date`, `certain=true` |
| 3 | `MR/other` | May renew / month-to-month / unconfirmed | `status="from_date"`, `available_from=end_date`, `certain=false` |

Turnover is same-day, so `available_from` is the lease end date — the unit is
free on that day. If a non-vacant row has no `end_date`, `available_from` is
`null` and `certain` is `false`.

`asking_rent` is the rate to quote today. It is computed from
`rent_price_min`, `rent_price_max`, and the unit's availability timing. The
money fields (`amount`, `min`, `max`) use the same two-decimal string format as
the existing rent fields. If the unit has no usable price bounds,
`asking_rent` is `null`.

`asking_rent.tier` explains where the quote came from:

| Tier | Meaning |
|---|---|
| `high` | Unit is at least 56 days from availability; quote the top of the range |
| `mid` | Unit is 42-55 days from availability; quote the midpoint |
| `low` | Unit is available in 0-41 days, has just become vacant, or availability is unknown; quote the bottom of the range |
| `discount` | Unit has already been vacant for more than one day; quote the discounted bottom rung |

`rent` is accompanied by `rent_price_min`, `rent_price_max` and `rent_basis`
(`"lease"` | `"advertised"` | `null`) for compatibility. **`rent` is not an
asking price and must not be treated as the rate to quote today.**

- **`rent_basis: "lease"`** — the unit's current or last lease has a recurring
  invoice schedule, so `rent` is the rent actually invoiced (`leasing.price`,
  falling back to the legacy `amount` only when `price` is unset). This is the
  sitting tenant's contracted figure and must never be quoted to a prospect.
- **`rent_basis: "advertised"`** — that lease has **no** invoice schedule, so
  `rent` is the unit's own advertised price (`rent_price_min`). A lease with no
  schedule stores a figure that is sometimes a whole-stay total and sometimes an
  already-monthly rent, with no reliable way to tell them apart, so it is never
  published. Manual vacancy overrides always report this basis.
- **`rent_basis: null`** — no schedule and no advertised price. `rent` is `null`;
  present the unit without a price rather than inventing one.

When `target_date` or `free_on` is supplied, each returned row includes move-in
fit fields. `target_date` also re-ranks by best fit; `free_on` remains a hard
availability filter. `max_gap_days` is compatibility-only and no longer drives
offers or asks. `gap_warning` now means the row is outside the stay-length band
(`gap_within_band=false`). The hard ceiling is separate: occupied units whose
positive gap exceeds `hard_max_gap_days` are hidden, while vacant units use
`vacant_max_move_in_days` from today to the requested move-in date.

### Booking horizon — beyond 60 days the answer narrows

A requested date more than `inquiry_booking_horizon_days` (default **60**) from
`orgToday()` is beyond the **booking horizon**. The horizon date is `free_on`
first, else `target_date`, so `target_date` cannot bypass it.

Beyond the horizon the endpoint answers from a separate, narrower query:

| Beyond the horizon | Offered? |
|---|---|
| Tier 2 (`NR`, tenant confirmed leaving) within the occupied-unit ceiling | **Yes** |
| Tier 1 (vacant now) | No |
| Tier 3 (`MR/other`) | No |
| Manual vacancy overrides | No |

Nothing qualifying returns `no_match_reason: "too_far_out"` with
`check_back_in_days` and `check_back_on` — the date the request comes inside the
horizon, which is the earliest the answer could change, **not** a promise of
availability. `booking_horizon_days` and `booking_gap_days` echo the applied
policy.

On that outcome, and deliberately: `partner_forward.applies` is `false` even
though `count` is `0` (it is a lead to keep, not to hand on), `next_available` is
absent, and `phrasing.too_far_out` carries the operator-authored template — `null`
until they write one, in which case the caller must supply its own wording.

Inside the horizon nothing changes, `next_available` included.

**`move_out=YYYY-MM-DD`** (optional) states the intended stay so the gap band can
be applied. Malformed values return `400`. Bands apply to every requested date,
near-term and beyond-horizon. Outside the band, the unit is still offered with
`suggested_move_in_date` and `phrasing.gap_ask`; only the separate ceiling hides
it.

| Requested stay | Maximum gap |
|---|---:|
| 1 month | 3 |
| 2 months | 6 |
| 3 months or longer | 10 |
| Not stated | 10 |

The same inquiry bands drive `gap_band_days` / `gap_within_tolerance` in
`/units/search`, but search remains advisory-only and filters nothing by band.
The legacy `search_gap_band_*` database columns remain for compatibility but are
no longer read.

Fit fields:

| Field | Meaning |
|---|---|
| `gap_days` | `request_date - effectiveAvailableFrom`, in days. For vacant-now units, `effectiveAvailableFrom` is `orgToday()` |
| `gap_warning` | Compatibility field; `true` when `gap_within_band=false` |
| `available_after_target` | `true` when `gap_days` is negative and the prospect would need to wait |
| `gap_band_days` | Stay-length band applied to this row |
| `gap_band_assumed` | `true` when `move_out` was absent and the 3+ month band was assumed |
| `gap_within_band` | `true` when `gap_days <= gap_band_days` |
| `suggested_move_in_date` | `effectiveAvailableFrom + gap_band_days`, clamped to today; `null` unless the earlier move-in ask applies |

Positive `gap_days` means the unit would sit empty before the prospect arrives,
so it is the lost-rent case. `0` is an exact fit. Negative `gap_days` means the
unit is not free until after the requested date; that is not a lost-rent warning,
but callers should explain the wait.

When `free_on` is supplied, it is a hard filter for `vacancies`. Rows free on or
before that date stay in `vacancies` and carry the gap fields above; rows that
are already re-let by that date, or have no known availability date, are hidden.

If the hard `free_on` filter removes a row only because it frees up later,
`next_available` appears with those rows, sorted by `availability.available_from`
ascending and limited independently using the same `limit`. `phrasing.later`
appears only in the same case. Units already re-let by the requested date appear
in neither `vacancies` nor `next_available`, deliberately.

`next_available` is absent when `free_on` was not sent or when nothing offerable
frees up later. It is not returned as an empty array.

Free-on fields:

| Field | Meaning |
|---|---|
| `free_on` | Echo of the requested hard availability date |
| `hidden_by_free_on` | Count of rows removed by `free_on`, including later rows and unavailable rows |
| `next_available` | Rows that fail `free_on` only because they free up after the requested date |
| `phrasing.later` | Template for asking whether the later available date would still work |

Hard gap cap fields:

| Field | Meaning |
|---|---|
| `hard_max_gap_days` | Occupied-unit positive gaps greater than this are hidden from inquiry answers |
| `hidden_by_gap_cap` | Count of rows removed by the occupied ceiling or vacant cutoff |
| `no_match_reason` | `null` when at least one unit is returned; otherwise one of the values below |
| `partner_forward.applies` | `true` when both `vacancies` and `next_available` are empty, regardless of `no_match_reason` |
| `partner_forward.message` | Operator-authored text to send to partner agencies, or `null` when unset |

`no_match_reason` values:

| Value | Meaning |
|---|---|
| `all_beyond_hard_cap` | The endpoint had candidate vacancies, but the hard cap removed them all |
| `none_free_on_date` | The endpoint had candidate vacancies, but `free_on` removed them all from `vacancies` |
| `no_vacancies` | There were no candidate vacancies to offer |

Use `partner_forward.applies`, not `no_match_reason`, as the caller branch for
forwarding an inquiry to partner agencies. Both `all_beyond_hard_cap` and
`no_vacancies` are internally distinct reports but trigger the same partner
forwarding decision. `partner_forward` is always present, with or without
`target_date`; `message` is still returned when `applies=false` so callers can
pre-load it, but it must not be sent unless `applies=true`.

When `next_available` is non-empty, `partner_forward.applies=false`, so a lead
is not handed to a partner agency while Tenafy still has something later to
offer.

`partner_forward.message` has no default. The stored setting is nullable and
ships empty because this is outward-facing content sent to real partner agencies;
the operator must author it deliberately. If `partner_forward.applies=true` and
`partner_forward.message=null`, the caller must not send a partner-forward
message.

The message is returned verbatim and unsubstituted. Tenafy substitutes none of
these placeholders; the caller must fill them from chat context before sending:

| Placeholder | Meaning |
|---|---|
| `{customer_name}` | the enquirer's name |
| `{target_date}` | requested move-in date |
| `{budget}` | stated budget |
| `{requirements}` | free-text summary of what they asked for |
| `{area}` | area or district requested |

Tenafy only knows `{target_date}` at this point. The other values live in the
chat/inquiry layer, so server-side partial substitution is intentionally avoided.

Tier 1 (`VACANT`) rows are not hidden by `hard_max_gap_days`; they use
`vacant_max_move_in_days` instead. Default: if the requested move-in is more than
30 days from today, the vacant unit is not offered. Within 30 days it is offered,
and if it is outside the band it carries the same earlier move-in ask as an
occupied unit. Rows with negative `gap_days` and rows with `gap_days=null` are
not hidden by the occupied ceiling.

Advertising settings expose `min_gap_days`, `max_gap_days`, `hard_max_gap_days`,
`vacant_max_move_in_days`, `lead_days_nr`, `lead_days_other`, inquiry
availability fields, the booking horizon, the three `inquiry_gap_band_*` fields,
`inquiry_too_far_out_phrase`, and `inquiry_gap_ask_phrase`. `max_gap_days` is
kept in payloads for compatibility but is no longer used by `/vacancies`.

Precedence is: explicit backend argument > audience override > advertising
value. `GET /advertising/settings` returns the raw overrides as `null` when
unset, plus an `effective` block showing what is actually in force:

```json
{
  "min_gap_days": 40,
  "lead_days_nr": 60,
  "lead_days_other": 45,
  "inquiry_min_gap_days": null,
  "inquiry_lead_days_nr": 30,
  "inquiry_lead_days_other": null,
  "effective": {
    "advertising": {
      "min_gap_days": 40,
      "lead_days_nr": 60,
      "lead_days_other": 45
    },
    "inquiry": {
      "min_gap_days": 40,
      "lead_days_nr": 30,
      "lead_days_other": 45,
      "source": {
        "min_gap_days": "advertising",
        "lead_days_nr": "inquiry",
        "lead_days_other": "advertising"
      }
    }
  }
}
```

`PUT /advertising/settings` validates each numeric gap/lead/horizon/band field
as an integer from `0` to `365` and treats absent fields as unchanged. Text
settings, including `inquiry_too_far_out_phrase` and `inquiry_gap_ask_phrase`,
are capped at 2000 characters.

#### `GET /units/available` (deprecated)

Requires `X-API-Key`; read-only keys are allowed. This endpoint remains for
existing TaneChat callers but now returns only tier-1 vacancies that pass the
advertising minimum-gap rule. New callers should use `GET /vacancies`.

Response headers include `Deprecation: true`. The JSON response keeps `data` as
the legacy unit array and adds top-level deprecation metadata:

```json
{
  "code": 200,
  "data": [{
    "unit_id": "123",
    "unit_name": "5B",
    "unit_type": "apartment",
    "amenity_type": null,
    "property_id": "456",
    "property_name": "Gilman's Bazaar",
    "street_address": "1 Gilman Street",
    "city": null,
    "state": null,
    "district": null,
    "country": null,
    "zip_code": null,
    "property_type": null,
    "last_lease_price": "12000.00",
    "last_lease_end_date": "2026-08-31"
  }],
  "meta": { "total": 1, "date": "2026-08-12" },
  "deprecated": true,
  "replacement": "/vacancies"
}
```

`date` is still accepted only for compatibility. If supplied and not today's
date, the endpoint returns `400` because the replacement vacancy engine does not
support arbitrary as-of dates. `property_id` and the legacy `propertyId` alias
are both accepted.

#### `GET /posting-plan`

Requires `X-API-Key`; read-only keys are allowed. The optional `date=YYYY-MM-DD`
query parameter selects the schedule date (today by default). The response `data`
matches the Advertising Scheduler plan and includes `date`, `weekday`, `day_name`,
`photo_root`, `min_gap_days`, `lead_days_nr`, `lead_days_other`, `tier_counts`,
`slot_count`, `extra_count`, `unfilled_slots`, and `posts`. Each post includes its
property and units, `tier`, `intent`, status, assigned forum/account, rendered post
text when ready, and `image_hint`. Each `image_hint` entry is `Property/Unit`
relative to `photo_root`, so local automation can locate the photo folder.

```json
{
  "code": 200,
  "data": {
    "date": "2026-08-11",
    "weekday": 2,
    "day_name": "Tuesday",
    "photo_root": "/photos",
    "min_gap_days": 40,
    "lead_days_nr": 60,
    "lead_days_other": 45,
    "tier_counts": { "vacant": 2, "nr": 1, "other": 3 },
    "slot_count": 7,
    "extra_count": 1,
    "unfilled_slots": [],
    "posts": [{ "tier": 1, "intent": "Unset", "image_hint": ["Property/Unit"] }]
  }
}
```

#### `POST /posting-plan/mark`

Requires a write-enabled `X-API-Key`; read-only keys receive `403`. Send the IDs
from a plan post (`property_id`, `template_id`, `forum_id`, `account_id`, and
`unit_ids`) plus optional `post_date` (`YYYY-MM-DD`), `source` (`roster` or
`urgent`), and `status` (`posted` or `skipped`). The response is
`{ "code": 200, "data": { "id": "POST_LOG_ID" } }`. Recording the result builds
the rotation history used by later plans. Call this endpoint after every posting;
otherwise rotation history never accumulates and the seven-day rotation cannot
work.

### Viewing negotiations

#### `GET /viewing-negotiations`

Requires `X-API-Key`; read-only keys are allowed. This is the board endpoint for
viewing relay rows. It does not replace `GET /viewing-negotiation/active`, whose
response shape is reserved for per-message phone routing.

Query parameters:

| Param | Description |
|---|---|
| `status` | `active`, `terminal`, or `all` (`active` default). `NEEDS_STAFF` is active because staff still need to act. |
| `state` | Optional comma-separated state filter, e.g. `AWAIT_TENANT,NEEDS_STAFF`. |
| `updated_since` | Optional ISO-ish timestamp lower bound on `updated_at`. |
| `limit` | Page size, default `50`, max `200`. |
| `cursor` | Opaque cursor from `meta.next_cursor`; uses keyset pagination, not offset. |

Each row contains stable keys for TaneChat rendering:

```json
{
  "negotiation_id": "123",
  "status": "active",
  "state": "AWAIT_TENANT",
  "needs_staff_reason": null,
  "awaiting": "tenant",
  "unit": { "id": "45", "label": "Gilman's Bazaar 5B", "address": "..." },
  "customer": { "name": "Alex", "phone": "+852..." },
  "tenant": { "id": "67", "name": "Tenant Name", "phone": "+852..." },
  "viewing": { "proposed_start_at": "2026-08-13T15:00:00", "timezone": "Asia/Hong_Kong" },
  "policy": { "opt_out_window_hours": 4, "require_explicit_confirmation": false, "source": "setting" },
  "timestamps": {
    "created_at": "...",
    "customer_asked_at": "...",
    "tenant_notified_at": "...",
    "auto_confirmed_at": "...",
    "updated_at": "..."
  },
  "next_deadline": { "kind": "opt_out_expiry", "due_at": "...", "overdue": false },
  "risk_flags": ["implicit_consent_pending"],
  "last_event": { "event_type": "tenant_opt_out_notice", "party": "tenant", "send_mode": "approve", "status": "draft", "created_at": "..." }
}
```

`meta.next_cursor` is present when another page is available. `next_deadline` is
computed from the same decision helpers used by the scheduler, so the board and
the hourly sweep should agree.

All times in viewing-negotiation payloads are **Asia/Hong_Kong wall clock**,
with no timezone suffix. Do not convert. That includes appointment times
(`viewing.proposed_start_at` — always were Hong Kong) and system-stamped times
(`timestamps.*`, `last_event.created_at`, `next_deadline.due_at`, and on drafts
`created_at` / `expires_at` / `deadline_at`). Drafts expire in 30 minutes, so
treating a stamp as UTC misses the window.

`needs_staff_reason` is `null` unless `state` is `NEEDS_STAFF`. Current reason
values are: `off_window`, `not_marketing`, `no_host`, `multi_unit`, `stale`,
`tenant_no_phone`, `window_no_phone`, `auto_confirm_no_staff`,
`slot_taken_at_confirm`, `slot_taken_at_reconfirm`, `max_rounds`,
`tenant_reply_after_confirm`, `reschedule_declined_after_commit`, `no_roster`,
and `confirm_no_staff`.

#### `GET /viewing-negotiation/active`

Requires `X-API-Key`; read-only keys are allowed. Given a WhatsApp phone number,
returns open negotiations that TaneChat can route replies into. The response is
purely for phone routing and is ordered routable-first, then newest-first, with
the negotiation awaiting that party first within each group. Each negotiation
entry includes `negotiation_id`, `party`, `state`, `needs_staff_reason`,
`awaiting`, and `routable`.

#### `POST /viewing-negotiation/:id/prospect-reply`
#### `POST /viewing-negotiation/:id/tenant-reply`

Requires a write-enabled `X-API-Key`. These endpoints accept parsed reply intent
from TaneChat and return the post-transition `state`, `needs_staff_reason`,
`awaiting`, routing phones, and generated outbound events. If the negotiation is
already closed to that sender, the `closed: true` response also includes
`needs_staff_reason`.

#### `POST /viewing-negotiation/:id/cancel`

Requires a write-enabled `X-API-Key`; read-only keys receive `403`. Optional
body `{ "reason": "..." }` (`reason` max 500 characters). The field is accepted
and ignored — there is no column to store it. A non-string or over-length
`reason` is `400`.

Open negotiation:

```json
{ "code": 200, "data": { "cancelled": true, "already_cancelled": false, "state": "CANCELLED" } }
```

Already cancelled (safe to retry):

```json
{ "code": 200, "data": { "cancelled": true, "already_cancelled": true } }
```

`CONFIRMED` / `AUTO_CONFIRMED` — cancelling a committed viewing stays a staff
action so the tenant is told a human is not coming:

```json
{ "code": 409, "reason": "already_confirmed", "message": "This viewing is already confirmed. Cancelling it is a staff action so the tenant can be notified." }
```

Unknown id, or a negotiation that belongs to another org: `404`
`{ "code": 404, "message": "Negotiation not found" }`.

#### `GET /viewing-negotiation/drafts`

Requires `X-API-Key`; read-only keys are allowed. TaneChat polls this endpoint
for pending outbound drafts created by the viewing relay scheduler. This endpoint
does not send messages and does not mutate state.

Query parameters:

| Param | Description |
|---|---|
| `limit` | Page size, default `50`, clamped to `1`-`200`. |
| `max_age_hours` | Draft age window, default `168` hours, clamped to `1`-`8760`. |
| `party` | Optional `prospect` or `tenant` filter. Other values are ignored. |

Response:

```json
{
  "code": 200,
  "data": {
    "drafts": [{
      "event_id": "123",
      "negotiation_id": "456",
      "negotiation_state": "AWAIT_TENANT",
      "awaiting": "tenant",
      "party": "tenant",
      "to_phone": "+85255551234",
      "body": "Hi ...",
      "template_type": "Viewing-Tenant-OptOut",
      "event_type": "tenant_opt_out_notice",
      "send_mode": "approve",
      "idempotency_key": "456:tenant_opt_out_notice:1",
      "deadline_at": "2026-08-13T15:00:00",
      "created_at": "2026-08-13T11:00:00",
      "age_hours": 4,
      "unit": { "id": "789", "label": "Gilman's Bazaar 5B" },
      "customer": { "name": "Alex", "phone": "+852..." }
    }],
    "count": 1,
    "max_age_hours": 168
  }
}
```

TaneChat must send `body` verbatim to `to_phone` in that party's own thread, then
call `POST /viewing-negotiation/:id/draft-sent` with `event_id`. A draft
reappears until `draft-sent` is called. This is intentional at-least-once
behaviour: `draft-sent` is idempotent, and seeing a duplicate pending draft is
safer than silently missing an outbound message.

Viewing relay v2 adds three states: `AUTO_CONFIRMED` means the tenant opt-out
deadline elapsed and the viewing was booked automatically;
`TENANT_CANCELS_AFTER_X` means the occupant replied after confirmation and can no
longer make the time; `RESCHEDULE_AFTER_COMMIT` means the occupant replied after
confirmation with a new proposed time. A tenant reply is accepted on an
`AUTO_CONFIRMED` negotiation so the reversal path can run. Prospect replies on
terminal states are still refused as no longer active.

#### `confirmed_slot`, and how long a booked viewing stays listed

Once a negotiation reaches `CONFIRMED` or `AUTO_CONFIRMED`, each entry carries the agreed
slot. It is `null` in every other state — a time still being negotiated is not an
agreement, and publishing it as one is how a viewing gets asserted that nobody booked.

```json
{ "negotiation_id": "...", "party": "prospect", "state": "CONFIRMED", "routable": false,
  "confirmed_slot": { "start": "2026-08-21T11:00:00",
                      "end":   "2026-08-21T11:30:00",
                      "timezone": "Asia/Hong_Kong",
                      "unit_id": "8326307481849856",
                      "unit_label": "Poplar 2B" } }
```

Hong Kong wall clock with an explicit `timezone`, consistent with the rest of the payload —
no offset suffix on one field beside zone-less ones. Viewings are a fixed 30 minutes, which
is also the length of the calendar event we create.

**A booked viewing stays listed for 12 hours past its start — for the occupant only.** They
may still withdraw or report that nobody came, and that has to reach us. For the prospect
the entry disappears the moment the viewing starts, because a prospect cannot reopen a
booked viewing by messaging and their post-viewing "we'll take it" should reach your normal
handling rather than sit against a negotiation with nothing left to do.

⚠️ **`routable: false` means "do not relay this to us" — not "do not handle it".** A
non-routable entry is context, not a claim on the conversation. Standing your own handling
down on one leaves the customer with nothing, because we will not be acting on it either.

---

### Renewal asks — "is the sitting tenant staying?"

A unit whose tenant has not decided can only be offered hedged. Rather than guess a
decision date, Tenafy asks the tenant: up to three times, spaced by a configurable gap,
then hands the lease to staff. Off by default per organisation.

**Tenafy is the only sender.** Every ask is dispatched by Tenafy — the scheduled ones and
the demand-triggered ones alike — over WhatsApp via your `/send` endpoint, or by email if
the tenant has no phone. The channel is fixed for the whole sequence.

```
POST /api/public/renewal-ask                   { unit_id }        → trigger an ask (we send it)
GET  /api/public/renewal-asks/open                                → sent, awaiting an answer
POST /api/public/renewal-ask/:id/reply         { intent } | { text }
GET  /api/public/renewal-asks/pending                             → observational; see below
POST /api/public/renewal-ask/:id/sent                             → retained, writes nothing
```

**`GET /renewal-asks/open` is how you attribute a reply.** One row per outstanding question —
id, unit, tenant name and phone, which ask in the sequence, and when it went out — so an
inbound message can be matched to what it answers. No message text, no claim, no state
change: reading it can neither cause nor prevent a message.

One row per *cycle*, not per message: it is always the latest ask, because that is the only
one a reply can be about. A cycle leaves the list on a **definite** answer only. An ask with
a vague answer already on record stays, flagged `vague_reply_on_record: true` — otherwise the
id would disappear the moment "ok thanks" was filed and the real answer would have nothing
to attach to.

⚠️ **Do not key this list on phone number alone.** An ask handed to staff after three
unanswered attempts carries `escalated: true` and stays listed, because a late reply must
still be attributable — but it no longer holds the conversation, so the tenant's other lease
becomes askable. Two rows can therefore share a phone. The guarantee is narrower and exact:
**at most one row per conversation has `escalated: false`.**

We also tag the outbound message itself, once your `/send` accepts it:

```json
{ "phone": "85212345678", "message": "...",
  "origin": { "type": "renewal_ask", "id": "..." } }
```

That is off until you confirm, because an unrecognised key at a live gateway would put
working traffic at risk. `/renewal-asks/open` needs nothing from you and works today.

⚠️ **One open ask per conversation.** A tenant renting two units is never asked about both at
once — the second lease waits until the first is answered or its sequence ends (either a
definite reply, or escalation to staff after three unanswered asks). Their reply
arrives on one thread referring to neither message, so an ambiguous "yes" could otherwise be
written to the wrong lease. `POST /renewal-ask` returns `reason: "conversation_busy"` with
`blocked_by` when this defers an ask.

`POST /renewal-ask` decides whether an ask is due, sends it, and returns the audit row. It
is idempotent per decision cycle: a second call returns `created: false` with
`reason: "already_asked_this_cycle"` rather than messaging the tenant twice. Other reasons are
`disabled`, `tenant_unreachable`, `no_wording` (the operator has not written that ask yet),
`conversation_busy`, and the eligibility reasons (`already_decided`, `already_replied`,
`too_early`, `lease_already_ended`, `no_start_date`, and `too_soon_after_move_in` — a tenant
is never asked about renewing within a configured number of days of moving in, which for a
short lease would otherwise land in their first week; that one also returns `eligible_from`). Every one of those is refused **before** a row exists, so
none of them spends one of the three asks.

`reason: "send_failed"` with `created: true` is the exception: the ask exists and has spent
its slot but the tenant was not reached. We never retry a send, because a timed-out send is
indistinguishable from a delivered one.

⚠️ **The rendered message is deliberately not in any response.** There is nothing here for
a caller to transmit, by design: two senders is how a tenant gets asked the same question
twice, or — if each side assumes the other sent it — never gets asked at all while the ask
is counted as spent. `GET /renewal-asks/pending` is therefore purely observational: it
reads, never claims, and normally returns nothing (rows appear only when a send failed).
`POST /:id/sent` is retained so an existing caller gets a truthful 200, but it no longer
records anything.

#### Relaying a reply

```
POST /api/public/renewal-ask/:id/reply
{ "intent": "extend" | "leaving" | "unsure" }     ← preferred
{ "text":   "yeah we're staying thanks" }          ← we classify, conservatively
```

Anything ambiguous becomes `unsure`, which is recorded and changes nothing customer-facing.

**A vague answer may be corrected; a real one is final.** You cannot tell a tenant's answer
from an unrelated message, and should not try — so an ask landing mid-conversation may get
"ok thanks" relayed against it. Post again when the real answer arrives: an `unsure` on
record is replaced by `extend` or `leaving`, and the response carries
`superseded: "unsure"`. A definite answer can never be overwritten, in either direction,
because the dangerous move is the one that puts a home back on the market.

`unsure` also does **not** end the sequence — the remaining asks still go out, and three
vague answers still escalate to staff.

Only `extend` acts automatically: the unit leaves customer-facing feeds
(`withdrawn_from_offers: true`). `leaving` and `unsure` are recorded for a human. Evidence
good enough to stop us selling is not good enough to let us sell.

`applied: false` with a `stale_reason` means the lease changed after we asked, so the reply
was recorded but not acted on. It is always recorded — a tenant who took the trouble to
answer is never dropped silently.

#### When you cannot be sure it was an answer

```
POST /api/public/renewal-ask/:id/reply
{ "text": "please extend my stay", "verified": false }
```

For a message you believe is the tenant's answer but cannot attribute safely — it arrived
in a group thread, it was forwarded, or it only reads as an answer if you saw the message
before it. This is **not** `unsure`: `unsure` means the tenant has not decided, and the
sequence rightly keeps asking. `verified: false` means *we* are not certain the message is
an answer at all.

It records the words, **holds the ask sequence for 7 days**, changes nothing about the
lease, and raises it on the operator's Vacancy page and in their weekly renewal email.
Response carries `acted: false`, `held: true`, `hold_days`, `needs_staff: true`.

The hold **expires** on purpose. If it were indefinite, a message misread as a possible
answer would drop a tenant out of the sequence permanently. When the week lapses with no
decision, asking resumes.

Anything other than an explicit `false` takes the normal path, so an absent or malformed
flag can never silently stop a real answer taking effect. A definite answer already on
record wins: an uncertain message arriving afterwards returns `already_replied` and does
not hold anything.

---

### Stamping — pull what IRD eTAX needs for a signed tenancy (added 2026-10-09)

Read-only; a read-only key is enough. Spec: `docs/superpowers/specs/2026-10-09-stamping-api-design.md`.
The eTAX filing itself stays manual — see `docs/etax-stamping-handoff.md`.

| Endpoint | Returns |
|---|---|
| `GET /stamping/queue?signed_since=YYYY-MM-DD` | Signed contract periods, newest first. The same rows the Signing & Stamp Tracking page marks signed (same loader, same rules), so the two cannot disagree. `signed_since` is clamped to 2026-09-01. OTA bookings never appear. |
| `GET /stamping/:request_id` | The eTAX payload for one signed document. 404 unless it is signed, in your org, on a live lease. |
| `GET /stamping/:request_id/document` | The signed PDF (binary). 404 for a paper signing recorded without a scan. |

Queue row: `request_id, lease_id, lease_no, property_name, unit_name, tenant_name, period_start,
period_end, period_recorded, signed_method ('esign'|'paper'), signed_at`. Track which `request_id`s
you have filed yourself — nothing in Tenafy records "stamped" yet.

Payload:

```json
{
  "request_id": "…", "lease_id": "…", "lease_no": "LEA…", "signature_method": "esign",
  "signed_on": "2026-10-08",
  "duplicates": 0, "applicant_capacity": "landlord", "payment_method": "offline",
  "term": { "start": "2026-10-17", "end": "2027-10-16", "months": 12, "exceeds_one_year": false, "period_recorded": true },
  "rent": { "field": "total", "amount": 228000, "monthly_rent": 19000, "total_rent": 228000 },
  "address": { "flat": null, "floor": "25", "block": null, "building": null, "estate": null,
               "street": "15 Tai Yuen St", "district": "Wan Chai",
               "unit_name": "25/F", "street_address": "15 Tai Yuen St", "confident": true },
  "tenants": [{ "role": "primary", "english_name": "…", "id_no": "…", "id_type": "passport", "id_type_source": "recorded" }],
  "landlord": { "english_name": "Parcelle Limited", "br_no": "…" },
  "duty_estimate": { "duty": 570, "tenant_share": 285, "rate": 0.0025, "basis": "total_rent" },
  "signed_pdf_url": "/api/public/stamping/…/document",
  "warnings": []
}
```

- **`signed_on`** is the Date of Signing eTAX asks for — the Hong Kong date the document was
  completed, NOT the lease start.
- **`term.end`** is the stamped Term of Tenancy (`term_stamp_end`, else `term_end`, else the lease's
  stamped/real end) — what the contract prints.
- **`rent.field`** is `monthly` only when the term EXCEEDS a year (exactly 12 months does not), the
  rent is fixed throughout and there are no credits; otherwise `total`. `amount` is the figure to
  type into that field. `null` when it cannot be computed (a warning says why).
- **`duty_estimate`** is a cross-check. 0.25% of total rent up to a year; 0.5% / 1% of average yearly
  rent for 1–3 / over 3 years; rounded up to the dollar; no duplicate fee. **The IRD notice is the
  real figure**; the tenant pays half of the notice total.
- **`id_type_source`**: `recorded` (staff set it), `inferred` (`hkid` only, from a valid check
  digit — passports are never inferred), `unknown`.
- **`landlord`** follows the unit's account name when one is set, else the property's Landlord /
  Legal Entity. The BR number is property-level, so it is withheld (`null` +
  `landlord_entity_mismatch`) whenever the two name different companies.

**Warnings — any warning means a person checks that field before filing:**
`period_not_recorded`, `partial_month_term`, `stay_total_lease`, `unsupported_invoicing`,
`rent_changes_during_term`, `lease_has_credits`, `address_unparsed`, `missing_district`,
`missing_tenant`, `missing_id_no`, `id_type_inferred`, `id_type_unknown`, `missing_landlord`,
`missing_br_no`, `landlord_entity_mismatch`, `no_signed_file`. Warnings are de-duplicated by code.

---

## Field Reference (commonly-needed enums)

| Field | Values |
|---|---|
| `invoice.status` | 0 = Open, 1 = Paid, 2 = Overdue |
| `accounting.type` | 0 = Inflow (CR), 1 = Outflow (DR) |
| `property.type` | 1 = Residential, 2 = Commercial |
| `tenant.category` | 1 = Tenant, 2 = Payee |
| `tenant.type` | 0 = Personal, 1 = Company |
| `tenant.status` | 0 = Pending, 1 = Active, 2 = Inactive |
| `tenant.sex` | 0 = null, 1 = Male, 2 = Female |
| `tenant.contract_type` | 1 = MR (May Renew), 2 = MTM, 3 = NR (Not Renewing), 4 = UC (Unconfirmed) |
| `leasing.type` | 0 = Fixed, 1 = Month-to-month |
| `unit.status` | 0 = Vacant, 1 = Occupied |
| `unit.active_status` | 0 = Inactive, 1 = Active |
| `unit.amenity_type` | 1 = Residential, 2 = Commercial |
| `service.status` | Numeric — see service module |
| `utility_meter.meter_type` | 0 = Electric, 1 = Water, 2 = Gas |
| `utility_meter.meter_category` | 0 = Master, 1 = Sub-meter |
| `utility_meter_reading.reading_type` | 0 = Move-In, 1 = Move-Out, 2 = Billing, 3 = Monthly |

---

## Example Requests

### Health check
```bash
curl -H "X-API-Key: pk_..." \
  http://YOUR_DROPLET:3001/api/public/health
```

### List all properties
```bash
curl -H "X-API-Key: pk_..." \
  http://YOUR_DROPLET:3001/api/public/properties
```

### Vacancies for chatbot availability
```bash
curl -H "X-API-Key: pk_..." \
  "http://YOUR_DROPLET:3001/api/public/vacancies?max_tier=3&limit=50"
```

### Deprecated available-units compatibility endpoint
```bash
curl -H "X-API-Key: pk_..." \
  "http://YOUR_DROPLET:3001/api/public/units/available"
```

### Tenants with outstanding invoices
```bash
# Step 1: get all open invoices grouped by tenant
curl -H "X-API-Key: pk_..." \
  "http://YOUR_DROPLET:3001/api/public/invoices?status=0"
```

### Leases expiring in next 60 days
```bash
curl -H "X-API-Key: pk_..." \
  "http://YOUR_DROPLET:3001/api/public/leases/expiring?days=60"
```

### Rent paid by tenant in date range
```bash
curl -H "X-API-Key: pk_..." \
  "http://YOUR_DROPLET:3001/api/public/payments?tenant_id=83001272599&from=2026-01-01&to=2026-03-31"
```

### Utility consumption for a unit
```bash
# Step 1: find the unit's meter
curl -H "X-API-Key: pk_..." \
  "http://YOUR_DROPLET:3001/api/public/utility/meters?unit_id=UNIT_ID"
# Step 2: pull that meter's readings
curl -H "X-API-Key: pk_..." \
  "http://YOUR_DROPLET:3001/api/public/utility/meters/METER_ID/readings"
```

---

## Security Notes

- **Every request is scoped to the org that owns the API key.** You cannot accidentally see another org's data — the DB pool itself is per-org.
- **All endpoints are GET-only.** Writes (create/update/delete) are intentionally not exposed via the public API.
- **Soft-deleted records are filtered out.** You'll never see records with `deleted_at IS NOT NULL`.
- **Key rotation**: generate a new key, then delete the old one via `/master/api-keys`. Last-used timestamp is visible on the admin page for audit.

---

## Hooking up an AI

For an LLM-based assistant (ChatGPT, Claude, etc.), provide as the system prompt / tool definitions:

1. This file as the schema reference
2. The API key as a configured secret
3. The base URL (droplet)
4. Instructions like: "Use the Tenafy Public API to answer questions about the property portfolio. Fetch data via GET requests with the X-API-Key header. Never attempt POST/PUT/DELETE."

If using function-calling / tools, declare one tool per endpoint (or a single generic `tenafy_get(path, query)` tool that the AI can invoke with the path and query params.)

---

## Chat Knowledge

#### `GET /chat/knowledge`

Requires `X-API-Key`; read-only keys are allowed. Returns public team rules and
FAQs for external chat channels, plus a ready-to-append `prompt_block`.
Optional `property_id` scopes the response to entries that apply to that
property.

The response includes `version`, also sent as the ETag. `version` is computed
over the whole response, including `property_context`, so a scoped and an
unscoped call return different versions even when the FAQ bodies are
byte-identical. Clients must key their cache per property. Otherwise the cache
will thrash, and a scoped response can overwrite an unscoped one. This is
deliberate: a version that covered only the bodies could collide across scopes.

Use `If-None-Match` with the ETag to receive `304` when that exact scoped
variant has not changed.

---

## The website FAQ feed

```
GET /api/website/:org_slug/faqs[?property_id=<id>]
```

**No API key.** This route is mounted outside the `/api/public/` router and cannot reach anything
else. That isolation is the design, not an oversight: keys here are either read-only or
read-write across the whole surface, with no per-endpoint scoping, so a key stored on a public
website in order to fetch FAQs would also read tenants, leases, invoices and payments. The content
this route serves is published to the open internet by definition, so there is nothing for a
credential to protect — and a great deal for one to endanger.

It returns only entries that are **all four of**: `kind = 'faq'`, active, flagged
**Publish on website**, and either global or linked to the property asked for. Team rules can
never appear, whatever else is set.

```json
{ "code": 200,
  "data": {
    "version": "<etag>",
    "property_context": null,
    "faqs": [ { "id": "...", "category": "payments", "title": "Where do I pay rent?",
                "body": "...", "updated_at": "..." } ],
    "available_properties": [ { "id": "...", "display_name": "Nam Pak Hong" } ] } }
```

`available_properties` lists buildings that have at least one published building-specific FAQ, so
the site can offer a selector. **Their answers are not in the response until one is chosen** —
absent, not filtered out client-side.

- Unknown slug → `404`. An organisation without a slug is unreachable, which is the default.
- Unknown, malformed or deleted `property_id` → `400 INVALID_PROPERTY`. It never falls back to the
  global set.
- `ETag` per variant, `If-None-Match` gives `304`. `Cache-Control: public, max-age=60,
  stale-while-revalidate=300` — so an edit is normally visible within a minute, and a caller that
  chooses to serve stale content may show the previous copy for up to five more.
- Rate limited per IP and slug. Browser access requires the origin to be configured server-side;
  server-to-server callers send no `Origin` and are unaffected.
