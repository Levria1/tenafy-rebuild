# Gap Bands and Earlier Move-In Counter-Offers

Date: 2026-08-18

## Goal

Apply stay-length gap bands inside the 60-day booking horizon without repeating the Hollywood 1B failure. Beyond the horizon the band remains a hard refusal. Inside the horizon the same band is a counter-offer trigger: the unit stays visible and the bot asks whether the customer can move in earlier.

Current live settings for the org are `max_gap_days=3`, `hard_max_gap_days=10`, `inquiry_booking_horizon_days=60`, inquiry bands `3/6/10`, search bands `3/6/10`.

## Current Code Baseline

- `GET /vacancies` uses `bookingHorizonDecision()` near the top. If the requested date is beyond 60 days, it calls `bookingGapLimitForLease()` and filters to tier-2 rows through `matchesBeyondHorizonNrException()`.
- Near-term `target_date` maps rows through `vacancyFit()`, sets `gap_days`, `gap_warning`, and `available_after_target`, then hides rows through `exceedsHardGapCap()`.
- Near-term `free_on` does not run `vacancyFit()` at all. It only uses `classifyFreeOn()` to keep rows free on or before the requested date and put later rows in `next_available`.
- `/units/search` already computes `gap_band_days` and `gap_within_tolerance` using search bands. It is advisory only and does not filter on the band.
- Settings live in `advertising_setting`; `loadSettings()` already reads inquiry bands, search bands, `max_gap_days`, `hard_max_gap_days`, `inquiry_booking_horizon_days`, and `inquiry_too_far_out_phrase`.

## 1. Near-Term Rule

Recommendation: inside the booking horizon, compute the inquiry band for every requested move-in date and return every otherwise matching unit.

Rule:

| Case | Result |
|---|---|
| `gap_days <= gap_band_days` | Clean offer. |
| `gap_days > gap_band_days` | Still returned, with an earlier move-in counter-offer. |
| `gap_days < 0` | Still returned as available after the requested date; no earlier counter-offer because waiting costs no vacancy. |
| `gap_days = null` or `gap_band_days = null` | Still returned; no precise counter-offer. |

Counter-offer date:

```text
gap_counter_offer_date = effective_available_from + gap_band_days
```

`effective_available_from` is the same date basis used for `gap_days`:

- For `availability.status === "from_date"`, use `availability.available_from`.
- For `availability.status === "now"` with `available_from: null`, use `orgToday()` because the unit is already available.

Special cases:

- If `gap_counter_offer_date < orgToday()`, return `gap_counter_offer_date: orgToday()`. Do not ask a customer to move into the past.
- If `availability.status === "now"`, compute from `orgToday()`. Example: on 2026-08-18, a 3+ month enquiry for 2026-10-09 has `gap_days=52`, `gap_band_days=10`, and `gap_counter_offer_date="2026-08-28"`.
- If the customer's stay length is unknown, use the existing fallback of the 3+ month band, currently 10 days, but mark it as assumed in the response.

Hollywood 1B example: `available_from=2026-09-25`, requested `2026-10-09`, stay unknown, band 10. `gap_days=14`, so the row is returned with `gap_within_tolerance=false` and `gap_counter_offer_date="2026-10-05"`.

## 2. `hard_max_gap_days` Near-Term

Recommendation: stop applying `hard_max_gap_days` inside the booking horizon once counter-offers exist. Keep the column for legacy display and compatibility, but it must not hide near-term inquiry rows.

Options:

| Option | Consequence | Hollywood 1B |
|---|---|---|
| Remove near-term hard ceiling | Maximizes lead recovery; every otherwise matching unit can be negotiated. `hidden_by_gap_cap` becomes `0` near-term. | Returned with counter-offer `2026-10-05`. |
| Keep current hard ceiling at 10 | Recreates the failure. Counter-offer fields only help rows with gap 4-10; rows above 10 still disappear. | Hidden, same as today. |
| Move ceiling higher, e.g. 21 or 30 | Reduces failures but keeps a second commercial rule that can still suppress a perfect objection match. | Returned at 14 if ceiling >= 14, but Mong Kok 1C at 19 depends on the chosen number. |
| Make ceiling operator-configurable by horizon mode | More flexible, but the UI and partner contract become harder to reason about. | Depends on configuration. |

**OPERATOR DECISION:** whether there is any near-term gap so commercially bad it should still hide the unit. The technical recommendation is no near-term hard hide. If the operator wants an absolute ceiling, it should be a new explicitly named setting such as `inquiry_near_term_hard_gap_days`, nullable by default, not a reuse of `hard_max_gap_days`.

Beyond the horizon, keep the hard band refusal unchanged.

## 3. `free_on`, `target_date`, or Both

Recommendation: apply the near-term band/counter-offer rule to both `free_on` and `target_date`.

Reasoning: we are actively telling TaneChat to send `free_on` for a firm move-in date. If bands only apply to `target_date`, the new operator policy will not run on the partner's recommended integration path.

Request handling:

- Determine `request_date` exactly as today: `free_on` first, else `target_date`.
- Run the band/counter-offer enrichment whenever `request_date` is present and inside the horizon.
- Keep `free_on` as a hard availability filter: rows not free by `free_on` still move to `next_available` or disappear if re-let. Rows free before `free_on` remain in `vacancies` and can carry a counter-offer asking for an earlier start.
- Keep `target_date` as the ranking input. With no near-term hard cap, it ranks and enriches, but does not hide.

Partner change: continue sending `free_on` for a firm future date, and also send `move_out` when known. Read the new gap fields on rows returned from `free_on`; do not switch back to `target_date`.

## 4. Stay Length

Band selection needs `move_out`.

Recommendation:

- If `move_out` is supplied, compute `lease_duration_days = max(0, move_out - request_date)` and use `gapBandDays()`.
- If `move_out` is absent, fall back to the 3+ month inquiry band, currently 10 days, matching current `bookingGapLimitForLease()` behavior.
- Make the assumption visible with `gap_band_assumed: true` and `lease_duration_days: null`.

This prevents the bot from presenting a precise counter-offer as though the customer stated a stay length. It can say the operator will accept up to 10 empty days "assuming a longer stay" only if the operator-authored template includes that language.

## 5. Response Fields

Existing fields keep their meaning:

| Field | Meaning retained |
|---|---|
| `gap_days` | Signed `request_date - effective_available_from`, positive means vacancy before move-in. |
| `gap_warning` | Advisory flag for `gap_days > max_gap_days`; keep for compatibility. |
| `available_after_target` | `true` when the unit frees after the requested date. |
| `gap_band_days` | Maximum empty days allowed by the stay-length band. |
| `gap_within_tolerance` | Whether `gap_days <= gap_band_days`; advisory near-term, hard only beyond horizon filtering. |

Add fields to `/vacancies` rows when `request_date` is present:

| Field | Type | Null/absence | Meaning |
|---|---|---|---|
| `request_date` | string `YYYY-MM-DD` | present when `free_on` or `target_date` was supplied | Date used for gap calculation. |
| `lease_duration_days` | integer | `null` when `move_out` absent | Requested stay length. |
| `gap_band_days` | integer | `null` only if no request date or invalid internal input | Applied inquiry band. |
| `gap_band_assumed` | boolean | present with band fields | `true` when `move_out` was absent and 3+ month band was used. |
| `gap_within_tolerance` | boolean | `null` when `gap_days` or band is null | `true` if the row is a clean offer. |
| `gap_counter_offer_date` | string `YYYY-MM-DD` | `null` unless `gap_days > gap_band_days` | Suggested earlier move-in date. |
| `gap_counter_offer_applies` | boolean | present with band fields | Convenience boolean for bot branching. |

Top-level additions when `request_date` is present:

| Field | Type | Meaning |
|---|---|---|
| `booking_gap_days` | integer | Band used for this request, already present beyond horizon; add near-term too. |
| `booking_gap_assumed` | boolean | Mirrors row `gap_band_assumed` for the request. |
| `lease_duration_days` | integer or null | Request-level stay length. |
| `phrasing.counter_offer` | string or null | Operator-authored counter-offer template. |

Example, `GET /vacancies?free_on=2026-10-09` on 2026-08-18, unknown stay:

```json
{
  "code": 200,
  "data": {
    "free_on": "2026-10-09",
    "move_out": null,
    "booking_horizon_days": 60,
    "booking_gap_days": 10,
    "booking_gap_assumed": true,
    "lease_duration_days": null,
    "hidden_by_gap_cap": 0,
    "phrasing": {
      "certain": "{units} available from {date}",
      "uncertain": "We may also have {units} available, however the tenant may renew, they're not sure",
      "counter_offer": "{units} is free from {available_from}. For this stay, could you start by {suggested_move_in_date}?"
    },
    "vacancies": [
      {
        "label": "Hollywood 1B",
        "availability": {
          "status": "from_date",
          "available_from": "2026-09-25",
          "next_move_in_date": null,
          "days_until": 38,
          "certain": true
        },
        "request_date": "2026-10-09",
        "gap_days": 14,
        "gap_warning": true,
        "available_after_target": false,
        "lease_duration_days": null,
        "gap_band_days": 10,
        "gap_band_assumed": true,
        "gap_within_tolerance": false,
        "gap_counter_offer_applies": true,
        "gap_counter_offer_date": "2026-10-05"
      }
    ]
  }
}
```

## 6. Operator Phrasing

Add nullable setting:

```text
inquiry_counter_offer_phrase TEXT NULL
```

Return it as `phrasing.counter_offer` when at least one returned row has `gap_counter_offer_applies=true`. If the setting is null, return `null`; TaneChat must not use hardcoded Tenafy prose.

Required placeholders:

| Placeholder | Meaning |
|---|---|
| `{units}` | Grouped unit labels. |
| `{available_from}` | The unit's actual available date, or "now" for vacant units. |
| `{requested_move_in_date}` | Customer's requested move-in date. |
| `{suggested_move_in_date}` | `gap_counter_offer_date`. |
| `{gap_days}` | Empty days before requested move-in. |
| `{gap_band_days}` | Applied tolerance. |

Optional placeholder:

| Placeholder | Meaning |
|---|---|
| `{move_out}` | Customer's move-out date; blank if unknown. |

If `phrasing.counter_offer` is null and a row needs a counter-offer, the partner should still return the unit but avoid making up Tenafy-specific commercial wording. It can ask a neutral clarification such as whether the customer has flexibility only if that wording is owned by TaneChat, not presented as the operator's policy.

Keep `phrasing.earlier` for backward compatibility during rollout, but mark it deprecated for this purpose. New callers should branch on `gap_counter_offer_applies` and use `phrasing.counter_offer`.

## 7. Settings UI

Update the four Leasing setting groups:

| Group | New copy |
|---|---|
| Initial "Leasing" description | "Availability settings for inquiry answers. Near-term gap bands create earlier move-in counter-offers; far-future gap bands decide what can be offered." |
| Existing soft/hard gap boxes | Replace with a legacy/advanced block. "Suggest an earlier move-in after" is superseded by stay-length bands for `/vacancies`; keep visible as "Legacy warning threshold" only while `gap_warning` remains. "Stop offering the unit after" should say "Legacy near-term hard cap" and be disabled or hidden if near-term hiding is removed. |
| Availability for inquiries | Keep as-is conceptually: these are lead windows for which units enter the inquiry pool, independent of Facebook advertising. |
| Booking horizon | Keep the 60-day explanation, but add: "Inside this horizon, out-of-band units stay visible with an earlier move-in suggestion. Beyond it, only confirmed-leaving units inside the band are offered." |
| Booking acceptance | Replace the wrong sentence with: "Inside the booking horizon, these bands decide when to ask for an earlier move-in. Beyond the horizon, a confirmed-leaving unit outside the band is not offered." |
| Search results | Keep: "These only flag whether a result is within tolerance so the wording can reflect it. Nothing is hidden." |
| Too far out message | Keep, but clarify it is only for beyond-horizon refusal. |

`max_gap_days` is superseded for the commercial "ask earlier after N days" rule because that threshold is now stay-length dependent. Keep the stored column and continue returning `gap_warning` for existing organisations and callers. Do not migrate or delete it now. Organisations relying on it still get the old advisory `gap_warning`; they also get the new band fields and should move to them.

## 8. Migration and Compatibility

New column recommended:

```sql
ALTER TABLE advertising_setting
  ADD COLUMN inquiry_counter_offer_phrase TEXT NULL;
```

Defaults:

- Database default: `NULL`.
- `loadSettings()` fallback: `inquiry_counter_offer_phrase: null`.
- `PUT /advertising/settings`: validate as text, max 2000 chars, same as `inquiry_too_far_out_phrase`.

Compatibility recommendation:

- Additive response fields only.
- Existing fields retain meaning.
- `hard_max_gap_days` remains returned, but near-term hiding stops. This is a behavior change for organisations that never open settings, and that is intentional because the current default behavior can lose leads.
- Keep beyond-horizon behavior unchanged for existing organisations.
- Keep `phrasing.earlier` during rollout; add `phrasing.counter_offer` rather than renaming in place.
- Consider setting a default phrase for the live org before enabling the feature. For orgs with null phrase, the API still returns counter-offer dates but no operator-authored sentence.

## 9. Test Plan

Use fixed dates for pure helper tests and dates derived from `orgToday()` for route tests whose assertions depend on distance from today, following the header comment in `backend/test/vacancyFit.test.js`.

Cases:

- `gap_days === gap_band_days`: clean offer, `gap_within_tolerance=true`, `gap_counter_offer_applies=false`, no counter-offer date.
- `gap_days === gap_band_days + 1`: row returned, `gap_within_tolerance=false`, `gap_counter_offer_date=effective_available_from + band`.
- Hollywood 1B: 2026-09-25 to 2026-10-09, unknown stay, band 10, row returned with `gap_counter_offer_date=2026-10-05`; `hidden_by_gap_cap=0`.
- Jardine 2B confirmed row with 13-day gap: returned despite `certain:true` and gap over 10.
- Already vacant unit: `availability.status="now"`, `available_from=null`; compute from `orgToday()`, return `gap_counter_offer_date=orgToday()+band` when requested date exceeds band.
- Counter-offer date in past: clamp to `orgToday()`.
- Unknown stay length: `move_out` absent, `lease_duration_days=null`, `gap_band_days=10`, `gap_band_assumed=true`.
- One-month stay: `move_out` within 31 days, band 3.
- Two-month stay: duration 32-62 days, band 6.
- Three-plus-month stay: duration 63+ days, band 10.
- `free_on` near-term: rows free before requested date remain in `vacancies` and include band fields; rows free after requested date still use `next_available` with `phrasing.later`.
- `target_date` near-term: rows over `hard_max_gap_days` are no longer hidden; sort order still follows `compareVacancyFit()`.
- Horizon boundary: exactly 60 days out is near-term counter-offer mode; 61 days out is beyond-horizon hard-refusal mode.
- Beyond horizon: tier 2 within band returned; tier 2 over band hidden; tier 1, tier 3, and manual overrides hidden.
- `phrasing.counter_offer`: returned only when a counter-offer row exists; null when setting is null; no hardcoded fallback phrase.
- `/units/search`: unchanged advisory behavior; `gap_band_days` and `gap_within_tolerance` still present and no filtering added.

## 10. Stale Documentation and Partner Follow-Up

`docs/public-api.md` becomes stale where it says:

- `target_date` hides units past `hard_max_gap_days` near-term.
- `free_on` never applies gap logic.
- `move_out` is only used beyond the 60-day booking horizon.
- Inside the horizon nothing changes.
- `hard_max_gap_days` describes positive gaps that are hidden from inquiry answers.
- `all_beyond_hard_cap` can be a near-term no-match reason.
- `gap_band_days` / `gap_within_tolerance` are only tied to `/units/search` and beyond-horizon `/vacancies`.

`docs/tanechat-integration-guide.md` becomes stale where it says:

- Send `free_on` to avoid the gap cap.
- `target_date` hides units past `hard_max_gap_days`.
- Without `target_date`, `gap_days`, `gap_warning`, and `available_after_target` are absent.
- `move_out` is only used beyond the horizon.
- `phrasing.earlier` is the current template for gap warnings.
- A short list caused by `hidden_by_gap_cap` is normal.
- The migration checklist tells the partner to send `target_date` only when willing to accept hard-cap hiding.

`docs/tanechat-reply-2026-08-18.md` was already sent and needs a follow-up because these sections become out of date:

- §2: the advice that `free_on` avoids all gap logic remains directionally right for avoiding hiding, but will be incomplete because `free_on` will now include advisory band/counter-offer fields.
- §2: the warning that `target_date` hides Hollywood 1B becomes historical, not future behavior.
- §8: "Within 60 days (inclusive) unchanged" becomes false.
- §8: `move_out` described as beyond-horizon-only becomes false.
- §8: `/vacancies` beyond the horizon hard refusal remains true, but the same numbers now have the opposite near-term consequence.
- §9 summary item 1 should still say "send `free_on` for firm dates", but must add "read counter-offer fields".
- §9 summary item 9 should say `move_out` affects near-term counter-offers as well as beyond-horizon acceptance.
- §9 summary item 10 should stop centering `hard_max_gap_days` as the number to read for near-term decisions; partners should read `gap_band_days`, `gap_within_tolerance`, and `gap_counter_offer_date`.

Partner follow-up message should say, concretely: keep sending `free_on` for firm dates; start sending `move_out` when known; do not suppress rows where `gap_within_tolerance=false`; if `gap_counter_offer_applies=true`, use `phrasing.counter_offer` and `{suggested_move_in_date}`; beyond 60 days the band is still a hard refusal.
