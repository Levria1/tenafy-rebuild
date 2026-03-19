# Tenafy Rebuild — Completed Work Log

Track all changes made per session. Update at the end of each session.

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
