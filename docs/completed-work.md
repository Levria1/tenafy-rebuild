# Tenafy Rebuild — Completed Work Log

Track all changes made per session. Update at the end of each session.

---

## Session: Inquiries Module + Public Viewing Cutover (2026-05-04)

### New Inquiry table — leads separated from contacts
- **Why**: Public viewing form was upserting every web submission into `tenant` with `category=3`, polluting the Contacts page with strangers.
- **Migration** ([backend/src/migrations/inquiry.sql](backend/src/migrations/inquiry.sql)): new `inquiry` table + `viewing_booking.inquiry_id` column. Idempotent. Runs per org DB.

### Backend
- **New routes** ([backend/src/routes/inquiry.js](backend/src/routes/inquiry.js)) — list/get/create/update/delete + `POST /:id/convert-to-contact`.
- **New endpoint** ([backend/src/routes/viewing.js](backend/src/routes/viewing.js)): `POST /bookings/manual` — staff-side confirmed booking, stamps `inquiry_id`, skips approval flow.
- **Cutover** ([backend/src/routes/viewingPublic.js](backend/src/routes/viewingPublic.js)): public booking + `/lead/:token` no longer write `tenant` cat=3 prospects. Now create `inquiry` rows; `viewing_booking.inquiry_id` ties bookings back to leads.

### Frontend
- **List/create/detail** under [frontend/src/app/inquiries/](frontend/src/app/inquiries/) — table with Date, Lead Source, First/Last Name, Email, Phone, User, Status, Actions. Mobile card list. Search + filters.
- **CreateViewingModal** ([frontend/src/app/inquiries/CreateViewingModal.jsx](frontend/src/app/inquiries/CreateViewingModal.jsx)) — pick property/unit/employee/datetime, pre-fills viewer info from inquiry. Used on both list and detail pages.
- **Sidebar** ([frontend/src/components/Layout.jsx](frontend/src/components/Layout.jsx)): Contacts → Inquiries (gated on `LANDLORD/TENANT_LIST`).
- **api.js**: new `inquiry` namespace + `viewingApi.createManualBooking()`.

### Lead source reuses `lead_source_setting` (Settings → Lead Sources). No new permission seeded — uses TENANT_LIST.

### Open follow-ups
- Old prospects in tenant cat=3 from before cutover: not migrated. Backfill script available on request.
- "Send Email" on `/contacts/groups` passes `?group=<id>` but `/contacts/email/send` ignores it.

---

## Session: Checkout Credit Fix, React Hooks Bug, Public API Expansion (2026-04-16)

### Utility Checkout Settlement Credit Calculation Fix
- **Bug**: Checkout settlement was using the most recent meter reading's `reading_date` as the credit period start, even when that reading was an arbitrary monthly/manual reading. For a tenant checking out Mar 28 with last bill period ending Mar 10, credit was being calculated as only 4 days instead of 18.
- **Fix** ([backend/src/routes/utility.js:1261-1272](backend/src/routes/utility.js:1261)): Credit period now starts the day AFTER the last finalized bill's `period_end` (each day belongs to exactly one billing period). If no prior bill, falls back to `lease.start_date`. If lease started after last bill end, uses lease start.
- Example: Bill ends Mar 10, checkout Mar 28 → credit = Mar 11 through Mar 28 = 18 days = $236.71 (at $400/mo credit).

### React Error #300 on Bill Detail View
- **Bug**: Clicking View on any utility bill caused "Minified React error #300" (Rendered fewer hooks than expected) — entire page crashed.
- **Root cause** ([frontend/src/app/utilities/page.js:1524](frontend/src/app/utilities/page.js:1524)): `useState(selectedCheckoutMeter)` was declared AFTER the early return at line 1293 `if (selectedBill && billDetail) { return ... }`. When viewing bill list, all hooks ran. When clicking View, early return triggered before reaching that hook — React saw a hook count mismatch between renders → crash.
- **Fix**: Moved the useState declaration up to line 1138 with the other state hooks.

### Public API Expansion (2 → 34 endpoints)
- **Why**: User wants to hook their own AI assistant up to the production droplet for read-only data queries.
- **Added** to [backend/src/routes/public.js](backend/src/routes/public.js):
  - Meta: `/health`
  - Properties/Units: `/properties/:id`, `/units`, `/units/:id` (in addition to existing `/properties`, `/units/available`)
  - Tenants & Contacts: `/tenants`, `/tenants/:id`, `/tenants/:id/leases`, `/tenants/:id/invoices`, `/payees`, `/payees/:id`, `/property-owners`, `/property-owners/:id`, `/service-vendors`, `/service-vendors/:id`
  - Leases: `/leases`, `/leases/:id`, `/leases/expiring`
  - Invoices/Payments: `/invoices`, `/invoices/:id`, `/payments`
  - Accounting: `/accounting`, `/accounting/:id`
  - Services: `/services`, `/services/:id`
  - Utilities: `/utility/groups`, `/utility/bills`, `/utility/bills/:id`, `/utility/meters`, `/utility/meters/:id/readings`, `/utility/settlements`
  - Cleaning: `/cleaning/cleaners`, `/cleaning/schedule`
- **Security properties**: All 34 routes are GET-only (verified via router introspection), all filter by `req.apiKey.orgId`, all honor `deleted_at IS NULL`. Multi-tenant isolation is enforced twice: at the DB pool level (per-org pool via `getOrgPool`) AND at the query level (explicit `WHERE org_id = ?`).
- **Authentication**: Uses existing `authenticateApiKey` middleware — no new infra. Gates: `organizations.public_api_enabled=1` + `api_keys.status=1`.
- **No pagination, no rate limiting** — returns full result sets, per user preference.
- **New docs**: [docs/public-api.md](docs/public-api.md) — reference with all endpoints, enum field values, curl examples, AI-hookup notes.

---

## Session: Utility Checkout Fixes, Settings ID Fix, Property/Unit Active Status

### Utility Checkout Settlement Fixes
- **Editable last reading**: Added `last_reading_override` field to checkout modal — pre-fills from meter's `current_reading`, user can override. Backend uses it instead of Math.max calculation when provided.
- **Orphan reading prevention**: Reordered backend operations — settlement record INSERT now happens first (step 2), meter reading after (step 3). If settlement insert fails, no orphan reading is created.
- **Exclude settled tenants**: Checkout meter dropdown now LEFT JOINs `utility_checkout_settlement` and filters `ucs.id IS NULL` — tenants with completed settlements no longer appear.

### Settings Category/Payment/Lead Source Fix
- **Root cause**: `category_setting`, `payment_method_setting`, and `lead_source_setting` tables have bigint PKs without AUTO_INCREMENT, but INSERT statements weren't providing an ID.
- Added `genId()` to `settings.js` and all three INSERT endpoints now generate Snowflake IDs explicitly.

### Property & Unit Active Status
- **Unit active_status toggle**: Added Active/Inactive dropdown to unit edit form (`active_status` field). Backend PUT now accepts and saves it.
- **Lease guard**: Cannot deactivate a unit if it has active or upcoming leases (returns 400 error). Same guard on property — cannot set `status=0` if any unit has active/upcoming leases.
- **Unit detail page fix**: Status tag was reading `unit.status` (occupancy: 0=vacant/1=occupied) instead of `unit.active_status`. Fixed to show correct Active/Inactive state.
- **Property detail units list**: Now shows ALL units (including inactive) with inactive ones sorted to bottom, greyed out (60% opacity), and showing "Inactive" tag instead of Occupied/Vacant.
- **Missing column fix**: Removed `account_name` and `bank_details` from unit INSERT/UPDATE queries — columns don't exist in DB, causing all unit updates to fail.
- **Frontend error surfacing**: Unit edit now shows backend error message (e.g. "Cannot deactivate: unit has active or upcoming leases") instead of generic "Failed to update unit".

---

## Session: Complete Stored Status Removal, Unit Occupied/Vacant Fix, Tenant Edit Fix

### Stored Status Column Removal (leasing.status & unit.status)
- **Root cause**: The old Java system stored `leasing.status` (0/1) and `unit.status` (0/1) columns that were never updated by the new Node.js system. Many leases had stored `status=0` despite being date-active, causing them to be invisible to queries.
- Removed `l.status != 0` from **all** lease queries across 10 backend files (property.js, leasing.js, user.js, invoice.js, public.js, storage.js, tenantPortal.js, tenant.js, pdf.js, master.js)
- Removed stored status check from `computeLeaseStatus()` and `COMPUTED_STATUS_SQL` in leasing.js — now purely date-based
- Removed `WHEN status = 0` from tenant lease summary SQL
- Lease filtering now uses only `deleted_at IS NULL` (termination) + date checks (active/inactive/upcoming)

### Unit Occupied/Vacant on Property Page
- Replaced `u.status = 0/1` (stored) with `EXISTS (SELECT 1 FROM leasing...)` date-based subqueries for occupied counts across property.js, leasing.js, user.js
- Frontend: Unit badge now uses `!!unit.tenant_id` (from lease JOIN) instead of stored `unit.status`
- Colors fixed: **Occupied = green**, **Vacant = red** (was backwards)
- Header count colors: Occupied = green `#52c41a`, Vacant = red `#ff4d4f`

### Tenant & Lead Source Fix
- **Tenant edit failing**: `lead_source_id` column was missing from tenant table — migration `lead_source_setting.sql` had never been run
- Ran migration to create `lead_source_setting` table and add `lead_source_id` column to `tenant`
- Restored `lead_source_id` in tenant INSERT/UPDATE queries after migration
- Edit page already had Lead Source field next to ID/Passport (same as create page)

### Other Fixes
- **Click-to-copy on HTTP**: Added `document.execCommand('copy')` fallback for droplet (navigator.clipboard only works on HTTPS/localhost)
- **Lease detail payments**: Notes column now shows `payment_note` from payment transactions instead of invoice note
- **Memory.md**: Updated server management rule — just tell user in bold caps, don't attempt server operations

---

## Session: Permission Guards, SQL Fixes, File Preview, Master Dashboard, UI Fixes

- **Permission guards**: Added `hasPermission()` checks across 12+ pages to hide/show Edit/Delete buttons based on role permissions
- **Role edit/create page**: Replaced broken `Checkbox.Group` with custom `PermissionCheckboxes` component fixing group header toggle behavior
- **Tenant list SQL fix** (`tenant.js`): Fixed `ONLY_FULL_GROUP_BY` error — wrapped non-grouped columns with `MAX()`/`ANY_VALUE()`, fixed count query to `COUNT(DISTINCT t.id)`
- **Unit list SQL fix** (`property.js`): Fixed same error using `ROW_NUMBER()` subquery for tenant info
- **File preview/download fix** (`file.js`): Fixed 500 error on unauthenticated routes — added `getPoolFromRequest()` helper with JWT cookie + master DB fallback
- **Accounting delete**: Added Delete button with confirmation modal to accounting detail page, gated by `ACCOUNTING_DELETE` permission
- **Master dashboard**: Added `admin_username` column to `organizations` table and Admin column to dashboard UI. Updated org provisioner to save admin username during creation
- **Service edit**: Removed required validation from preferred date Option 1 field
- **Profile link**: Fixed Profile button in user dropdown menu to link to `/settings?tab=personal`
- **Master dashboard droplet fix**: `public_api_enabled` column missing on droplet `organizations` table causing 500

---

## Session: Permission Guards, Role Checkbox Fix, SQL Fixes, File Preview Fix (superseded by above)

- **Frontend permission guards**: Added `hasPermission()` checks to hide/show Edit and Delete buttons across 12+ pages based on role permissions. Pattern: `const canEdit = hasPermission ? hasPermission('LANDLORD/ENTITY_EDIT') : false` → `{canEdit && <Button>}`. Applied to: leasing, services, contacts (tenant, payee, service-vendor), property, unit, maintenance, invoices, email groups, settings (roles, users).
- **Role edit/create page**: Refactored broken `Checkbox.Group` implementation to custom `PermissionCheckboxes` component with fully controlled checkboxes. Fixed group header checkboxes that were toggling all groups instead of just their own children. Uses `checked`/`onChange` per checkbox instead of `Checkbox.Group`.
- **Tenant list SQL fix** (`tenant.js`): Fixed `ONLY_FULL_GROUP_BY` error on `POST /api/tenant/contacts`. Wrapped non-grouped joined columns with `MAX()`/`ANY_VALUE()`. Fixed count query from `COUNT(*) ... GROUP BY t.id` (returned one row per tenant) to `COUNT(DISTINCT t.id)` (single total). Added `deleted_at IS NULL` to invoice outstanding subquery.
- **Unit list SQL fix** (`property.js`): Fixed same `ONLY_FULL_GROUP_BY` error on `GET /api/property/:id/unit`. Replaced `LEFT JOIN leasing + LEFT JOIN tenant + GROUP BY` with a `ROW_NUMBER()` subquery to get the most recent active tenant per unit without GROUP BY issues.
- **File preview/download fix** (`file.js`): Preview and download routes were crashing with 500 because `req.pool` is undefined on unauthenticated routes (set by auth middleware). Added `getPoolFromRequest()` helper that tries JWT cookie first, then falls back to first active org from master DB.

---

## Session: Invoice Delete + Admin Seed Script
**Commit**: `834acd6` — Add invoice delete with cascade soft delete and admin seed script

- **Backend**: Fixed DELETE `/api/invoice/:id` — was incorrectly setting `status=-1`, now does proper cascade soft delete (`deleted_at` on invoice + accounting + accounting_line by invoice_code)
- **Frontend**: Added Delete button to invoice detail drawer footer, gated by `LANDLORD/INVOICE_DELETE` permission, with confirmation modal matching original Tenafy
- **Tooling**: Added `backend/scripts/seedAdmin.js` for creating super admin users on deploy (Snowflake ID, bcrypt password, Landlord System Manager role assignment)
- **Production**: Set up `alextn@gmail.com` as super admin on Digital Ocean droplet (activated user, reset password, assigned role `230000000001`)

---

## Session: Initial Commit
**Commit**: `5a2cc40` — Initial commit - Tenafy Rebuild current working state

Core project setup: Express backend with JWT auth, Next.js 14 frontend, MySQL database connection, basic CRUD for all entities.

---

## Session: Payment Methods, Categories, Scheduler Fixes
**Commit**: `59f73a9` — Fix payment methods, categories, and scheduler column bugs

- Fixed SQL column name mismatches in scheduler
- Fixed payment method and category settings

---

## Session: Notification System
**Commit**: `78040aa` — Add in-app notification system with bell icon and email alerts

- In-app notification bell with dropdown
- Email notification sending via Nodemailer
- Notification list page

---

## Session: Properties Page Rebuild
**Commit**: `5361bb0` — Rebuild Properties page with card layout + expandable units

- Property card layout matching original Tenafy
- Expandable unit list per property

---

## Session: Contacts Section Rebuild
**Commit**: `4ec8c97` — Rebuild Contacts section with expandable sidebar and tenant cards

- Contacts hub page with sidebar navigation
- Tenant list with search and filters

---

## Session: Unit Detail Rebuild
**Commit**: `f201649` — Rebuild Unit Detail page with 4-tab layout matching original Tenafy

- General, Furnishing, Service Cost, Service History tabs
- Quick access buttons to sub-pages

---

## Session: Dashboard Rebuild
**Commit**: `42621e3` — Rebuild Dashboard with 9-widget layout matching original Tenafy

- 9-widget grid layout
- Property overview, occupancy, financial widgets

---

## Session: Dashboard SQL Fixes
**Commit**: `2122450` — Fix dashboard and service cost SQL column name mismatches

- Fixed column name references in SQL queries

---

## Session: Dashboard Widgets & Filters
**Commit**: `2e2b179` — Fix dashboard widgets, add filters to Tenants/Properties, fix Property Detail

- Dashboard widget data accuracy
- Tenant/property list filtering
- Property detail page fixes

---

## Session: Property Detail & Payees
**Commit**: `fd1ac25` — Rebuild Property Detail, fix Payees, add file preview endpoint

- Property detail page rebuild
- Payee route fixes (double-prefix bug)
- File preview endpoint

---

## Session: 2026-03-04
**Commit**: `23cfeb3` — Rebuild Tenant Detail, deposit refunds, invoice upgrades, and project memory system

*(See prior entry for full details)*

---

## Session: 2026-03-04 (continued)
**Changes made:**

### Accounting Page (`accounting/page.js`)
- All columns now server-side sortable
- Default 50 items per page (was 20)
- Default 3-month date filter with bold+underline indicator
- Multi-select account dropdown filter
- Removed LAST Q quick date button

### Invoices Page (`invoices/page.js`)
- Added "Apply Filters" button (was missing)
- Default 50 items per page
- Default 3-month date filter with bold+underline indicator
- Removed LAST Q quick date button
- Backend: Added `AND i.deleted_at IS NULL` to queries, default limit 50

### Lease Creation (`leasing/create/page.js`)
- Deposit check: if deposit <= 0, shows Modal.confirm before creating
- Deposit invoice only created when deposit > 0

### Backend Lease Deposit (`leasing.js`)
- Auto-creates deposit invoice at lease creation (when deposit > 0)
- Generates invoice code from sequence table
- Looks up deposit category from category_setting

### Tenant List (`contacts/tenants/page.js`)
- Person icon label "RENT" → "TENANT"
- Active lease = green icon, no active lease = grey icon

### Tenant Detail Page (`contacts/tenant/[id]/detail/page.js`)
- Complete rewrite: two-column layout (380px sidebar + content area)
- Profile tab: General Info, Additional Info, Notes, Attachments in field/value grid
- Leases tab: Unit Info, Lease Details, Lease Transactions per active lease
- Sidebar: avatar, name, status, financial summary (varies per tab)
- "Create Deposit Refund" button wired to navigate to invoice create with pre-filled params
- Next Invoice Publish Date displayed from backend calculation

### Backend Tenant Routes (`tenant.js`)
- Lease query now includes `u.type as unit_type`, `p.id as property_id`, `p.street_address as property_address`
- Profile sum returns deposits (from deposit-category invoices) and credits (from leasing.credits)
- Added `calcNextInvoiceDate()` helper for all schedule types

### Invoice Creation Page (`invoices/create/page.js`)
- Reads URL params for pre-fill (tenantId, category, propertyId, unitId, leasingId)
- Loads real categories from DB via `settings.getCategories()`
- Fixed Type dropdown: Inflow (CR) / Outflow (DR)
- Deposit-refund mode: pre-fills category, type, due date; locks type selector
- Navigates back to tenant detail on success when coming from there

### Backend Invoice Routes (`invoice.js`)
- POST `/` now auto-generates Snowflake ID and invoice_code from sequence table
- Default category lookup when category not provided

### Backend Accounting Routes (`accounting.js`)
- Server-side sorting with `sortFieldMap` whitelist
- Multi-account filter with IN clause
- Default limit 50
- Filters on inflow-outflow summary

### Project Memory System
- Created `CLAUDE.md` at project root
- Created `docs/migration-plan.md`
- Created `docs/completed-work.md` (this file)
- Created `docs/style-guide.md`

---

## Session: 2026-03-04 (session 3)
**Commit**: `ec6e5d8` — Add additional tenants to leasing — save, display, and edit co-tenants

### Backend — `leasing.js`
- `GET /:id`: fetches `additional_tenants` array (id, names) via join on `leasing_additional_tenant`
- `POST /`: accepts `additionalTenantIds[]`, inserts rows into `leasing_additional_tenant` after lease creation
- `PUT /:id`: accepts `additionalTenantIds[]`, does full replace (delete all + re-insert)
- `DELETE /:id`: now also deletes from `leasing_additional_tenant` before soft-deleting lease

### Backend — `tenant.js`
- `GET /:id/leases`: for each lease, fetches `additional_tenants` and attaches to response

### Frontend — `leasing/create/page.js`
- Added multi-select "Additional Tenants" field in Step 1 Tenant card
- `additionalTenantIds` included in `buildPayload()`

### Frontend — `leasing/[id]/edit/page.js`
- Added multi-select "Additional Tenants" field
- Pre-fills from `lease.additional_tenants` on load
- Sends `additionalTenantIds` on save

### Frontend — `leasing/[id]/detail/page.js`
- Details tab now shows "Primary Tenant" and "Additional Tenants" as separate rows

### Frontend — `contacts/tenant/[id]/detail/page.js`
- Leases tab: "Additional Tenants" field now shows real co-tenant names (was hardcoded "—")

---

## Session: 2026-03-04 (session 4)

### Migration Runner (`backend/migrate.js` + `backend/migrations/`)
- Created `backend/migrate.js` — standalone migration runner using `mysql2`, reads `migrations/*.sql` in alphabetical order, tracks applied files in `schema_migrations` table, runs each in a transaction (rolls back on error)
- Added `"migrate": "node migrate.js"` to `backend/package.json` scripts
- Created `backend/migrations/001_create_unit_maintenance.sql` — `unit_maintenance` table with org_id, unit_id, title, description, cost, category, vendor_name, maintenance_date, status, created_at, updated_at
- Created `backend/migrations/002_create_unit_inventory_history.sql` — `unit_inventory_history` table with unit_id, org_id, inventory_id, action (ADD/REMOVE/UPDATE/ADJUST), quantity_before, quantity_after, note, created_at

### Bug Fixes — `backend/src/routes/property.js`
- Inventory `POST` was missing `org_id` (sum query filtered by it but it was never saved) — fixed
- Inventory sum query used `status = 1` but table uses `active_status` — fixed to `active_status = 1`

### Migration 003 (`backend/migrations/003_create_property_owner_tags.sql`)
- Created `property_owner_tag` — org_id, name, color, status, created_at
- Created `property_owner_tag_map` — composite PK on (property_owner_id, tag_id), supports ON DUPLICATE KEY for safe re-assignment

---

## Session: 2026-03-04 (session 5)

### Migration 004 (`backend/migrations/004_add_payment_instructions_to_property.sql`)
- `ALTER TABLE property ADD COLUMN payment_instructions TEXT DEFAULT NULL AFTER notes`

### Backend — `property.js` (amenity duplicate fix)
- `GET /:id/amenities`: fixed query to `JOIN property p ON p.id = ? AND p.org_id = ?` and filter `AND a.type = p.type` — was returning 2–4× duplicates because amenity table has one row per type (Residential=1, Commercial=2)
- `POST /`: added `payment_instructions` to INSERT column list and params
- `PUT /:id`: added `payment_instructions` to UPDATE SET clause and params

### API Client — `lib/api.js`
- `getOrgPropertyAmenities(type)`: now accepts and passes `type` as a query param to `GET /api/property/amenities/list?type=`

### Property Detail Page — `property/[id]/detail/page.js`
- Amenities section: now filters to only show selected amenities (hides unselected — no ✗ shown)
- Added **Payment Instructions** section above Attachments, pulls from `propertyData.payment_instructions`

### Property Edit Page — `property/[id]/edit/page.js`
- Added `payment_instructions` to `form.setFieldsValue` pre-fill on load
- Added **Payment Instructions** `Input.TextArea` field above Notes

### Property Create Page — `property/create/page.js`
- Added `payment_instructions` `Input.TextArea` field above Notes
- `onValuesChange` now watches the `type` radio group: when property type changes, calls `loadAmenities(newType)` to reload type-filtered amenities and clears previous selections

---

## Session: 2026-03-05 (session 6)
**Commit**: `9c0974f` — Payment add line and invoice fixed.

---

## Session: 2026-03-19

### Account Settings CRUD (`settings/page.js` + `settings.js`)
- Added "Accounts" tab to Accounting Settings for managing bank/payment accounts
- Full CRUD: inline add form, inline edit (click Edit → input replaces name), delete with Popconfirm
- Backend DELETE endpoint checks for linked accounting transactions before allowing soft-delete
- Returns descriptive error message with transaction count if in use

### Accounting Delete Confirmation (`accounting/page.js`)
- Wrapped Delete button in Popconfirm for delete confirmation before removing inflow/outflow transactions

### Leasing Filter — Unit Dropdown (`leasing/page.js` + `leasing.js`)
- Added cascading property→unit filter: selecting a property loads its units in a second dropdown
- Backend: added `unitId` WHERE clause to lease list query
- Fixed duplicate units in `GET /:property_id/unit` by adding `GROUP BY u.id` (`property.js`)

### Lease Detail Page Fix (`leasing/[id]/detail/page.js`)
- Rewrote to use correct field names: `lease_no` (not snowflake `id`), `amount || price` (not `monthly_rent`), `unit_name` (not `unit_number`)
- Added proper type/status mappings (LEASE_TYPE_MAP, CONTRACT_TYPE_MAP, INVOICING_MAP)
- Added payments tab and PDF view button

### Lease Create — End Date Validation (`leasing/create/page.js`)
- Added validation: if end date is before start date, displays error and blocks creation

### Contact Deletion (`contacts/tenants/page.js` + `tenant.js`)
- Added delete button with Popconfirm to tenant list, gated by `LANDLORD/TENANT_DELETE` permission
- Backend DELETE checks for linked invoices, leases, and accounting transactions before soft-deleting
- Returns descriptive 400 error with count if any linked records exist

### Other Changes
- Master dashboard, layout, and API keys pages updates
- Service create page updates
- API client additions for account settings endpoints
- Layout sidebar link for Accounts tab under Accounting Settings

### Known Bug (Not Yet Fixed)
- Recurring lease invoice generation fails when `first_invoice_date` > `end_date` — the loop breaks before creating any rent invoices

---

## Session: 2026-03-19 (continued)

### Contact Delete — Move to Profile & Fix Soft-Delete
- Removed delete button from tenant list page (`contacts/tenants/page.js`) — cleaned up unused imports (Popconfirm, DeleteOutlined, useAuth, canDelete, handleDelete)
- Added "Delete" option to Actions dropdown on tenant profile page (`contacts/tenant/[id]/detail/page.js`) — gated by `LANDLORD/TENANT_DELETE` permission, shows Modal.confirm, redirects to tenant list on success
- Fixed tenant soft-delete not hiding deleted contacts: backend `POST /contacts` now excludes `status = 0` tenants by default (`tenant.js` — added `AND t.status != 0` fallback when no tenantStatus filter is applied)

---

## Session: 2026-05-13 to 2026-05-18 — Booking Platform / Sales Agent on Invoices + Commission Tracker + LLM bot wiring

### Email — `%Outstandings%` lease-wide query fixed + new `%Invoice Outstanding%` variable
- **Bug**: `%Outstandings%` summed invoiced amounts only for currently-Open/Overdue invoices but summed ALL accounting-line payments for the lease, producing huge negative numbers for tenants with historical payments. Reproed at $8,200 outstanding rendering as −$99,169 in an invoice-reminder email.
- **Fix** (`backend/src/services/emailService.js:269-296`): query now sums invoiced and paid over the SAME set of invoices (all non-deleted in the lease). Paid invoices net to zero, open invoices net to remainder.
- **New variable `%Invoice Outstanding%`** — computed from `invoiceId` (or `invoiceCode`) param, returns `invoice.amount − sum(payments for that invoice_code)`. Use this in invoice-reminder templates instead of `%Outstandings%` when you only want the one invoice's balance. Empty string when no invoice is in scope.
- No DB migration.

### Master admin login was kicking back to login (`backend/src/routes/master.js:44`)
- Cookie was set with `httpOnly: true` but `frontend/src/app/master/layout.js` reads `__s_t` via `js-cookie` to gate access — invisible to JS by design.
- Same "quirk" as org-admin auth — flipped to `httpOnly: false`. **Pattern to remember:** every auth cookie this app relies on must be JS-readable because the frontend reads it directly. Clear stale cookie before testing.

### Invoice booking_platform / sales_agent — full per-invoice snapshot pattern
**The bigger picture:** invoices historically inherited platform/agent only via their parent lease. Now each invoice carries its own snapshot (with the lease as a one-time source on create), so per-invoice overrides work and historic reporting is robust to lease edits.

- **Schema**: `invoice.booking_platform_id` and `invoice.sales_agent_id` already existed (from `booking_commission_tables.sql`) but were never wired into the form, the create handler, or the public API.
- **Backend create path snapshots from lease when caller doesn't supply** (`backend/src/routes/invoice.js:240-282, 402-410` and `backend/src/services/scheduler.js:80-180`):
  - `POST /api/invoice` accepts `booking_platform_id` / `sales_agent_id` in body. If missing and `leasing_id` is set, looks up the lease's values and INSERTs them.
  - `POST /api/invoice/publish` always snapshots from lease.
  - Recurring scheduler — same snapshot. `generateRecurringInvoicesForOrg` SELECT now includes `l.booking_platform_id, l.sales_agent_id`, INSERT writes them.
  - Lease-creation invoices (`leasing.js:676,770`) already passed values through.
- **Invoice list filter `salesAgentId`** (`backend/src/routes/invoice.js:58, 151-158`) — mirrors existing `bookingPlatformId` pattern (matches via lease, EXISTS subquery).
- **Internal `/api/invoice` list query** (`backend/src/routes/invoice.js:165-188`) returns `booking_platform_name`, `sales_agent_name`, `lease_booking_platform_name`, `lease_sales_agent_name` (lease ones for legacy invoices that pre-date the backfill).
- **Public API** (`backend/src/routes/public.js` — both `/invoices` list and `/invoices/:id` detail) — same four name fields exposed for external integrations.

### Invoice frontend — dropdowns + drawer rows + filter
- **Create + Edit pages** (`frontend/src/app/invoices/create/page.js`, `[id]/edit/page.js`): added BOOKING PLATFORM and SALES AGENT dropdowns under the Tag row. Defaults to "None" placeholder. `onLeaseChange` auto-fills both from the lease's values (only when not already set). Payload includes both fields.
- **Invoices list filter panel** (`frontend/src/app/invoices/page.js`): added "Sales Agent" dropdown directly below "Booking Platform" — wired to `applyFilters`, `resetFilters`, `activeFilterCount`. Backend supports `salesAgentId` query.
- **View Invoice drawer** (`invoices/page.js:899-911`): added Booking Platform + Sales Agent as a two-column row above Notes, falling back to lease values when invoice's own value is null.

### Lease create + detail fixes
- **Create-lease bug**: `buildPayload()` in `leasing/create/page.js:266` stripped `booking_platform_id` and `sales_agent_id` despite the form fields existing. Added both to the returned payload — the backend already accepted them.
- **Lease detail rows always show** (`leasing/[id]/detail/page.js:465`): removed the `(lease?.booking_platform_name || lease?.sales_agent_name) && (...)` conditional. Both rows now render with "-" when blank, matching Check In/Out Meter style.

### Lease edit was missing entire "Email & Settings" step (step 3 of Create Lease)
- **Backend `PUT /api/leasing/:id`** (`backend/src/routes/leasing.js:871-940`): now destructures + conditionally writes `tenant_posted, landlord_posted, tenant_due, landlord_due, tenant_overdue, landlord_overdue, tenant_deposit_posted, tenant_checkin, tenant_checkout, landlord_expired, landlord_expired_days, tenant_renewal, tenant_renewal_days, access_setting, share_lease, all_past`. All gated by `!== undefined` so partial updates remain safe. Columns all already exist on `leasing`.
- **Lease edit page** (`leasing/[id]/edit/page.js`): added populated load values + payload entries for all 16 fields, and two new sections — Email Notifications (9 checkboxes + landlord_expired/tenant_renewal with day-counter inputs) and Access & Sharing (access_setting select + share_lease + all_past).

### Invoice booking_platform/sales_agent backfill (one-shot SQL)
Run when leases get a sales agent or booking platform filled in retroactively. Two independent UPDATEs so a row with one already set still gets the other backfilled:
```sql
UPDATE invoice i JOIN leasing l ON i.leasing_id = l.id
  SET i.sales_agent_id = l.sales_agent_id
  WHERE i.sales_agent_id IS NULL AND l.sales_agent_id IS NOT NULL
    AND i.leasing_id IS NOT NULL AND i.deleted_at IS NULL;

UPDATE invoice i JOIN leasing l ON i.leasing_id = l.id
  SET i.booking_platform_id = l.booking_platform_id
  WHERE i.booking_platform_id IS NULL AND l.booking_platform_id IS NOT NULL
    AND i.leasing_id IS NOT NULL AND i.deleted_at IS NULL;
```
Safe to re-run.

### Commission Tracker report (Reports → Commission Tracker)
- **New endpoint** `GET /api/reports/commission?from=&to=` (`backend/src/routes/reports.js`) — gated by `requirePermission('LANDLORD/REPORT/COMMISSION_VIEW')`. Aggregates by sales agent AND by booking platform. Per-row counts: `new_leases` (lease starts in range), `active_leases` (tenancy overlaps range), prorated `revenue`.
- **Prorating rule** (the key design decision):
  - Recurring invoice (`leasing.invoicing` set): covered window = `[due_on, due_on + intervalDays(invoicing) - 1]`. Revenue contribution = `amount × (overlap_days_with_filter / covered_days)`.
  - Bulk / Airbnb invoice (`leasing.invoicing` null): covered window = full lease span `[start_date, end_date]`. Same proration formula. So a $6,000 Airbnb lease Jan 1→Jun 30 filtered Jan 1→Mar 31 yields ~$2,983 (90/181 days).
  - Filters: only `category` matching `LIKE '%rental%'`, only `type = 0` (Inflow), only non-deleted.
  - Outflows ignored (this is a gross-revenue report).
- **New permission**: `LANDLORD/REPORT/COMMISSION_VIEW`.
  - Registered in catalog: `backend/src/routes/role.js:115-116` (group "Reports").
  - Auto-granted to new orgs: `backend/src/services/orgProvisioner.js:88`.
  - **Migration `035_commission_view_permission.sql`** grants to `role_id = 230000000001` for existing orgs.
- **Frontend page** (`frontend/src/app/reports/commission/page.js`): RangePicker (defaults to current year), header totals, two tabs (By Sales Agent / By Booking Platform), each row expandable to drill-down lease list with "Bulk" tag on rows with null `invoicing`, CSV export per tab, permission-gated empty-state fallback.
- **Sidebar entry** (`Layout.jsx:149-160`): Reports → Commission Tracker, hidden for users without the permission.

### LLM/Telegram bot integration (separate D:/Tane/tenafy-mcp-server/ repo)
Decision: integrate via MCP server registered with Claude Code on Linux box that runs the user's existing Telegram-to-Claude-Code wrapper. Two tools exposed: `tenafy_list_endpoints` (returns the endpoint reference and enum map on demand) and `tenafy_get(path, query)` (generic GET against `/api/public`). Credentials passed as `--env` at MCP registration, not in a .env file.

Key gotcha for nvm users: when registering, use absolute path to `node` (e.g. `/home/tanereceipts/.nvm/versions/node/v24.15.0/bin/node`), not bare `node` — Claude Code spawns subprocesses without sourcing `.bashrc`, so PATH is stripped.

Repo: <https://github.com/christophertsun7-gif/tenafy-mcp-server>. Public-API endpoint list duplicated in `tenafy-mcp-server/server.js` ENDPOINT_REFERENCE — update both when adding new public endpoints.

### Migration order (this session)
- `035_commission_view_permission.sql` — committed to repo, run on droplet + local with `mysql -u <user> -p<pass> tena_prod_v2 < .../035_commission_view_permission.sql`
