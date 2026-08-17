# Vacancy Booking Horizon Design - 2026-08-17

## Final Operator Decisions

For inquiry answers, normal availability is only offerable through the booking horizon. The default inquiry-only horizon is **60 days from `orgToday()` in Hong Kong**. Exactly 60 days out is still inside the horizon; 61 days out is beyond it.

Beyond the horizon, the API withholds tier-1 vacant units and tier-3 may-renew/other units. Only certain NR units can be offered, and only when the unit's `available_from` is close enough to the requested move-in date.

Searching/browsing keeps a flat **10-day** acceptable gap when the intended lease length is unknown. Accepting a booking uses the operator's lease-length band:

| Requested lease length | Maximum accepted gap |
|---|---:|
| 1 month | 3 days |
| 2 months | 6 days |
| 3 months | 10 days |
| More than 3 months | 10 days |
| Unknown length | `null` for band metadata; flat 10-day search threshold where a threshold is required |

This replaces the existing unsourced helper in `unitSearch.js`. Behavior changes are intentional and run in **both** directions — the loosenings matter more than the tightenings, because a looser band accepts a longer paid-for void:

| Requested length | Old band | New band | Direction |
|---|---:|---:|---|
| 1 month | 5 | 3 | tighter |
| 2 months | 5 | 6 | **looser** |
| 3–5 months | 7 | 10 | **looser** |
| 6–11 months | 10 | 10 | unchanged |
| 12+ months | 20 | 10 | tighter | The shared helper is exported from `advertisingPlan.js` and used by public unit search and the internal chatbot tool through `unitSearch`, so `gap_band_days` and `gap_within_tolerance` cannot drift between surfaces. `gapBandDays(null)` remains `null`. `needs_manager_approval` for 12+ months is unchanged.

## Request Parameters

`GET /api/public/vacancies` already accepts date-shaped parameters (`free_on`, `target_date`). The horizon date is `free_on` first, else `target_date`, so `target_date` cannot bypass the horizon.

The optional intended-length parameter is **`move_out=YYYY-MM-DD`**. This matches the existing unit-search convention (`moveIn`/`moveOut`) better than `lease_months`, and it avoids calendar-month ambiguity at the API boundary. Like `free_on`, malformed values return `400`; they are not silently ignored.

When `move_out` is absent, `/vacancies` applies the flat 10-day search threshold for beyond-horizon NR matching. When present, it derives lease duration from requested move-in to `move_out` and applies the band.

## Response Contract

Too-far-out with no NR exception match returns:

```json
{
  "vacancies": [],
  "count": 0,
  "no_match_reason": "too_far_out",
  "booking_horizon_days": 60,
  "booking_gap_days": 10,
  "check_back_in_days": 51,
  "check_back_on": "2026-10-07",
  "partner_forward": { "applies": false, "message": null },
  "phrasing": {
    "certain": "{units} available from {date}",
    "uncertain": "We may also have {units} available, however the tenant may renew, they're not sure",
    "too_far_out": null
  }
}
```

Rules:

| Outcome | Behavior |
|---|---|
| Inside horizon | Existing tier-1 exemption, `next_available`, partner-forward behavior, and target-date ranking stay unchanged. |
| Beyond horizon with NR matches | Return NR rows only, shaped through `vacancyToPublicShape`; omit `check_back_*` and `next_available`; `partner_forward.applies=false`. |
| Beyond horizon with no NR match | Return `no_match_reason:'too_far_out'`, `check_back_in_days = days_out - booking_horizon_days`, `check_back_on = orgToday() + check_back_in_days`, suppress `next_available`, and suppress partner forwarding. |

`phrasing.*` values are operator-authored templates returned unsubstituted and nullable. The server must not invent outward-facing copy. The operator may manually refer far-out leads later; automatic `partner_forward` remains suppressed on too-far-out. Leave a clean route-level suppression point for a future explicit opt-in, but do not build referral flow or copy now.

## Settings And Migration

Migration `backend/migrations-org/064_inquiry_booking_horizon.sql` adds:

| Column | Default | Null? | Purpose |
|---|---:|---|---|
| `inquiry_booking_horizon_days` | 60 | NOT NULL | Inquiry-only normal booking horizon. |
| `inquiry_too_far_out_phrase` | NULL | NULL | Optional operator-authored template returned as `phrasing.too_far_out`. |

No separate beyond-horizon gap column is added. The flat 10 search threshold plus the shared lease-length band table fully cover the current rule; a database column would be redundant and could drift from the booking helper.

Advertising and inquiry settings remain fully separate. New settings never fall back to advertising values. Direct database junk falls back to inquiry defaults; `0` is a real value. Any resolved setting interpolated into SQL must be finite.

Settings write path accepts and validates the new fields with the existing gap/window settings. Frontend UI is out of scope and remains a follow-up.

## Data Grounding

Verified live against 2026-08-17: only **3 NR leases** exist beyond the 60-day horizon, ending 2026-10-17, 2026-10-28, and 2027-01-18. Of 97 beyond-horizon units, 87 are may-renew. Therefore `too_far_out` remains the dominant far-future outcome, but on-demand NR lookup is real and is implemented now.

`available_from` is the lease `end_date` with same-day turnover. All business dates use `orgToday()` in Hong Kong, never the server clock.

## Implementation Plan

| File | Change |
|---|---|
| `backend/migrations-org/064_inquiry_booking_horizon.sql` | Add inquiry-only horizon and nullable phrase idempotently. |
| `backend/src/utils/advertisingPlan.js` | Add shared band, horizon arithmetic, and NR exception fit helpers. |
| `backend/src/services/unitSearch.js` | Replace local unsourced `gapBandDays` with the shared helper. |
| `backend/src/routes/advertising.js` | Extend `loadSettings`, settings write validation, and add on-demand NR lookup outside the normal roster window. |
| `backend/src/routes/public.js` | Validate `move_out`; apply horizon; withhold tier 1 and tier 3 beyond horizon; run NR-only lookup; return too-far-out contract. |
| Tests | Cover horizon edges, check-back math, band boundaries, NR exception, tier suppression, `target_date`, partner-forward, `next_available`, and settings fallback. |

Do not update partner-facing docs, deploy, push, or commit in this step.
