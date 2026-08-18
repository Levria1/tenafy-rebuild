# TaneChat Follow-Up: Gap Ask Changes

Date: 2026-08-18

This note lists the statements from `docs/tanechat-reply-2026-08-18.md` that are now stale after the
operator's final gap-band decision.

## Stale Points To Correct

- `free_on` now carries `gap_days`, `gap_warning`, `available_after_target`, `gap_band_days`,
  `gap_band_assumed`, `gap_within_band`, and `suggested_move_in_date`. It is no longer true that
  near-term `free_on` has no gap logic.
- `target_date` no longer hides a unit just because it is outside the 10-day band. The band now
  triggers an earlier move-in ask. Only the separate ceiling hides units.
- Bands are no longer far-future-only. They apply to every requested move-in date, near or far.
- Beyond the 60-day horizon, a confirmed-leaving NR unit outside the band is now offered with
  `suggested_move_in_date` and `phrasing.gap_ask` instead of being dropped, provided it is still
  within the occupied-unit ceiling.
- Vacant units are no longer always offered regardless of date. A vacant unit is hidden when the
  requested move-in is more than `vacant_max_move_in_days` from today; within that cutoff it can still
  carry the same earlier move-in ask.
- `gap_warning` no longer means `gap_days > max_gap_days`. It now mirrors "outside the band":
  `gap_within_band === false`.
- `phrasing.earlier` is still returned for compatibility but is deprecated for this workflow. Use
  `phrasing.gap_ask` with `{units}`, `{gap_days}`, and `{suggested_move_in_date}`.
- `/units/search` still filters nothing by band, but its reported band numbers now come from
  `inquiry_gap_band_*`. The legacy `search_gap_band_*` columns remain in the database but are no
  longer read.

## Current Rule Summary

- Ceiling: occupied units over `hard_max_gap_days` are not offered; vacant units over
  `vacant_max_move_in_days` from today are not offered.
- Horizon: beyond `inquiry_booking_horizon_days`, only tier 2 / NR units are eligible.
- Band: outside `inquiry_gap_band_*`, the unit is still offered and Tenafy asks whether the customer
  can move in by `suggested_move_in_date`.
