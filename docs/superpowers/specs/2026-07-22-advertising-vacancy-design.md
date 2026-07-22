# Advertising → Vacancy — design

## Purpose
A new **Advertising** section whose first page, **Vacancy**, is the shared worklist of
units whose lease is expiring soon and that will need advertising. A second page,
**Advertisement** (per-building ad templates + webpage link), comes later — the user is
sending more detail; it is intentionally out of scope here.

## Approach (chosen: A — live computed list)
No new table. Vacancy is computed on the fly from `leasing`/`unit`/`property`. Always
accurate, nothing to maintain. Keys off **date-computed** lease status, NOT the stored
`leasing.status` column (which is not maintained on expiry).

## What appears in Vacancy
A unit's **current** lease appears once it enters its renewal-intent lead window:

| contract_type | intent | lead time (days before end_date) |
|---|---|---|
| 3 | NR (Not Renewing) | 45 |
| 4 | UC (Unconfirmed) | 30 |
| 1 | MR (May Renew) | 20 |
| 2 | MTM (month-to-month) | 20 |
| 0 / null | intent unset | 20 (per user: market it anyway) |

Rules:
- Lease must be **currently active by date**: `start_date <= today AND end_date >= today`
  (excludes upcoming and already-expired leases — the latter are stale `status=1` noise).
- Within the lead window: `DATEDIFF(end_date, today) <= leadDays(contract_type)`.
- **Exclude units already re-let**: `NOT EXISTS` a lease on the same unit that starts after
  this lease's end_date. This filters the re-occupied stale-lease units so the list only
  shows genuine upcoming gaps.
- Sorted by **days-left ascending** (soonest first).
- Only active units (`unit.active_status = 1`).

Current live count with these rules: ~37 units.

## API
`GET /api/advertising/vacancies` (auth, org-scoped via `req.pool` + `p.org_id`).
Returns `{ code, data: { as_of, lead_days: {NR,UC,default}, count, vacancies: [...] } }`.
Each row: property, unit (+ beds/baths/size/type for ad prep), tenant, contract_type,
rent, deposit, end_date, days_left.

## Frontend
`/advertising/vacancy` — Ant Design table, server-sorted by days-left, renewal-intent tag,
a coloured days-left tag (red <=7, orange <=20, default otherwise), rent, end date. Nav:
new parent **Advertising** → child **Vacancy**, gated on `LANDLORD/LEASING_LIST`.

## Explicitly out of scope (this iteration)
- The **Advertisement** page (per-building templates + webpage link) — awaiting user detail.
- Any write/tracking state ("mark advertised", assignee) — Approach B, deferred.
- The stale `leasing.status` cleanup — separately determined unnecessary.
