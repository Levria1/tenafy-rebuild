# Utility + Lease Integration Plan

## 1. Database Changes

### Add columns to `leasing` table:
```sql
ALTER TABLE leasing ADD COLUMN check_in_meter decimal(12,2) DEFAULT NULL;
ALTER TABLE leasing ADD COLUMN check_out_meter decimal(12,2) DEFAULT NULL;
ALTER TABLE leasing ADD COLUMN check_in_meter_updated_at timestamp NULL;
ALTER TABLE leasing ADD COLUMN check_out_meter_updated_at timestamp NULL;
```

## 2. Lease Creation Form (`/leasing/create`)

- Rename section title from "UTILITY CREDIT" → "UTILITY"
- Fields inside:
  - **Monthly Utility Credit** (existing, no change)
  - **Check In Meter** (new InputNumber field)
  - **Check Out Meter** (new InputNumber field)
- Keep section above Deposit (current position)

## 3. Lease Edit Form (`/leasing/[id]/edit`)

- Same structure as create: rename section to "UTILITY", add Check In Meter + Check Out Meter fields
- When Check In Meter or Check Out Meter is saved, update `check_in_meter_updated_at` / `check_out_meter_updated_at` to track which value was most recently edited

## 4. Lease View Details (`/leasing/[id]/detail`)

### Details tab:
- Add "Monthly Utility Credit" row to the Descriptions

### New "Meter Readings" tab:
- Pulls all readings from `utility_meter_reading` where the meter is associated with this lease's unit
- Shows: Date, Reading Value, Type (Move-In/Move-Out/Monthly/Billing), Notes
- Also shows the check_in_meter and check_out_meter from the lease itself at the top as summary

## 5. Lease Backend (`/api/leasing`)

### POST (create) + PUT (update):
- Accept `check_in_meter` and `check_out_meter` fields
- On save, set `check_in_meter_updated_at` / `check_out_meter_updated_at` to NOW() for whichever field changed

### GET /:id:
- Already returns `l.*` so these columns come through automatically

## 6. Check In Meter Default Logic

- When creating a lease, if a previous tenant existed on that unit, auto-fill Check In Meter from:
  - The **previous tenant's Check Out Meter** value on their lease
- The "most recent update wins" rule: tracked via `check_in_meter_updated_at` vs previous tenant's `check_out_meter_updated_at`. Whichever is newer is the authoritative value.

## 7. Meters Tab — Log Modal Enhancement

- Update modal title from `Log Reading — MTR-001` to `Log Reading — MTR-001 — John Smith` (include tenant name)
- Also show tenant name + unit in the info box inside the modal

## 8. Log Move-Out → Update Lease

- When logging a **Move-Out** reading in Utilities → Meters → Log:
  - Backend also updates `leasing.check_out_meter` and `check_out_meter_updated_at` for the active lease on that unit
  - This keeps the lease and meter readings in sync

## Files Changed

- `backend/src/routes/leasing.js` — add check_in/out_meter to create/update
- `backend/src/routes/utility.js` — update log reading to sync move-out to lease
- `frontend/src/app/leasing/create/page.js` — rename section, add meter fields
- `frontend/src/app/leasing/[id]/edit/page.js` — rename section, add meter fields
- `frontend/src/app/leasing/[id]/detail/page.js` — add utility credit to details, add Meter Readings tab
- `frontend/src/app/utilities/page.js` — show tenant name in Log modal title
- Migration SQL for new leasing columns
