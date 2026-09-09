# Tenafy Rebuild - Project Guide

## Project Overview
Rebuilding Tenafy, an 8+ year old property management SaaS, from Java/Spring Boot microservices to a modern Node.js/Express + Next.js 14 stack. The goal is feature parity with the original system.

### Source Directories
- **Rebuild**: `D:\Tane\Tenafy Rebuild` (this repo — Next.js 14 + Node.js/Express)
- **Original backup**: `D:\Tane\AWS Backup` (production MySQL dump + file storage at `D:/Tane/AWS Backup/frontend/tane/storage/`)
- **Original source**: `D:\Tane\Tenafy Source Code` (Java/Spring Boot microservices source)

### Running Locally
- Backend: `cd backend && npm start` → port 3001
- Frontend: `cd frontend && npm run dev` → port 3000
- MySQL: `tena_prod` database, password `000000`, default port
- Test login: `acjairbnb@gmail.com` / `Test1234` (uses `username` field, not `email`)
- Org ID: `8300127259922432`

## Tech Stack
- **Backend**: Node.js + Express, MySQL2 (promise pool), JWT in HTTP-only cookie `__s_t`
- **Frontend**: Next.js 14 (App Router), Ant Design 5, Axios, dayjs
- **Auth**: JWT stored in HTTP-only cookie `__s_t`, multi-tenant via `req.user.orgId`
- **Email**: Nodemailer (Ethereal in dev, SMTP in prod)
- **IDs**: Snowflake pattern — `BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000))`

## Architecture

### Backend Structure
```
backend/src/
  index.js          — Express app, route mounts
  middleware/auth.js — JWT verification middleware
  config/database.js — MySQL connection pool
  config/mailer.js   — Nodemailer setup
  routes/            — All API route files
```

### Route Mounts (index.js)
```
/api/auth           → auth.js
/api/user           → user.js + settings.js
/api/property       → property.js
/api/tenant         → tenant.js
/api/leasing        → leasing.js
/api/accounting     → accounting.js
/api/invoice        → invoice.js
/api/service        → service.js
/api/contact        → contact.js
/api/payee          → payee.js
/api/property-owner → propertyOwner.js
/api/service-vendor → serviceVendor.js
/api/role           → role.js
/api/file           → file.js
/api/amenity        → amenity.js
/api/email-template → emailTemplate.js
```

### Frontend Structure
```
frontend/src/
  app/               — Next.js App Router pages
  components/        — Shared components (Layout.jsx, etc.)
  lib/api.js         — Axios API client with all endpoint methods
```

## Critical Conventions

### Express Routing — NO Double Prefixes
Route files are mounted with a prefix in index.js. Routes INSIDE the file must NOT repeat it:
- CORRECT: `router.get('/:id', ...)` → `/api/invoice/:id`
- WRONG: `router.get('/invoice/:id', ...)` → `/api/invoice/invoice/:id`

### Express Routing — Static Before Dynamic
Static routes MUST be defined BEFORE dynamic param routes (`/:id`):
```javascript
// These must come BEFORE router.get('/:id', ...)
router.get('/code', ...);
router.get('/list', ...);
// Then the dynamic route
router.get('/:id', ...);
```

### Database Column Conventions
- Property address: `street_address` (not `address`)
- Unit type: `type` (varchar, e.g. "apartment")
- Invoice due date: `due_on` in DB, sent as `due_date` from frontend
- No `invoice_line` table — invoice has `category` column directly (bigint FK to `category_setting.id`)

### Data Type Mappings
| Field | Values |
|-------|--------|
| Invoice status | 0=Open, 1=Paid, 2=Overdue |
| Accounting type | 0=Inflow(CR), 1=Outflow(DR) |
| Property type | 1=Residential, 2=Commercial |
| Tenant category | 1=tenant, 2=payee (same `tenant` table) |
| Leasing type | 0=fixed, 1=month-to-month |
| Tenant sex | 0=null, 1=male, 2=female |
| Contract type (Tenant Status) | 1=MR (May Renew), 2=MTM (Month To Month), 3=NR (Not Renewing), 4=UC (Unconfirmed) |
| Tenant status | 0=Pending, 1=Active, 2=Inactive |
| Unit status | 0=vacant, 1=occupied |
| Unit active_status | 0=inactive, 1=active |
| Unit amenity_type | 1=Residential, 2=Commercial |

### Invoice Schedules
Values in `leasing.invoicing`: `weekly`/`7`, `bi-weekly`/`14`, `monthly`/`30`, `quarterly`/`90`, `bi-annually`/`180`, or numeric day counts.

### Sequence Table (Auto-generated Codes)
Invoice codes use the `sequence` table with pattern like `TRIV{#,10}`. Uses `seq_next` with `FOR UPDATE` lock for concurrency safety.

### Deposit Refunds
Deposit refunds are regular invoices with `type=1` (Outflow) and the Deposit category. No special table or endpoint needed. Deposit category ID for org 8300127259922432: `8491399213092111`.

## Frontend Styling
- **Component library**: Ant Design 5 (`antd@^5.12.0`)
- **Icons**: `@ant-design/icons@^5.2.6`
- **CSS approach**: Inline styles on Ant Design components (no Tailwind)
- **Font**: System font stack (`-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, ...`)
- **Sidebar**: Dark navy `#001529`, collapsible (200px → 80px)
- **Content padding**: 24px
- **Colors**: Primary blue `#1677ff`, Success green `#52c41a`, Error red `#ff4d4f`, Warning orange `#faad14`
- **Borders**: `#f0f0f0` (light gray), `#e8e8e8` (card borders)

## Database Schema (Key Tables)

### property
`id`, `display_name`, `street_address`, `city`, `state`, `country`, `zip_code`, `type`, `status`

### unit
`id`, `name`, `type` (varchar), `amenity_type`, `status`, `active_status`, `property_id`

### tenant
`id`, `first_name`, `middle_name`, `last_name`, `company_name`, `type` (0=personal, 1=company), `birth_date`, `sex`, `email`, `secondary_email`, `phone`, `id_card`, `profession`, `budget`, `employer`, `salary`, `emergency_contact`, `referral`, `notes`, `photo`, `status`, `category` (1=tenant, 2=payee)

### leasing
`id`, `lease_no`, `unit_id`, `tenant_id`, `start_date`, `end_date`, `status`, `type`, `amount`, `price`, `deposit`, `due_date` (int, day of month), `invoicing`, `contract_type`, `first_invoice_date`, `credits`, `note`

### invoice
`id`, `invoice_code`, `property_id`, `unit_id`, `leasing_id`, `tenant_id`, `currency_id`, `due_on`, `category` (bigint FK to category_setting), `amount`, `note`, `type`, `status`, `file`, `tag_id`, `deleted_at`

## Current Status
See `docs/completed-work.md` for detailed progress tracking.

### What's Working
- Dashboard with 9-widget layout
- Properties with card layout + expandable units
- Unit Detail with 4-tab layout
- Contacts section with tenant list + profile detail
- Tenant Detail with two-column layout (Profile/Leases/Accounting tabs)
- Invoices with filters, 3M default, 50/page
- Accounting with sortable columns, multi-select accounts, 3M default
- Lease creation with deposit invoice auto-generation
- Deposit refund creation from tenant profile
- Next Invoice Publish Date calculation
- Email system (Nodemailer with Ethereal dev/SMTP prod)
- In-app notifications
- Tenant portal (LIVE): own auth domain (cookie `__t_p`, `TENANT_JWT_SECRET`), registration,
  leases, invoices, and repairs with photos, follow-up notes and withdrawal.
  Staff invite via the Tenants list; confirming a lease invites automatically.
  The email is the editable template `Portal-Invite-Tenant`; the link lasts 7 days
- Payment receipts: files attached on Create Payment are linked and previewable in the
  transaction drawer (via `object_file`, marked private)
- Meter readings can be corrected from Settings, logged as a dated Correction

### Known Missing
- Public listings module (entire tenafy-listing microservice)
- PDF generation for leases/invoices
- Admin storage/email usage monitoring
- `unit_maintenance` table migration
- `unit_inventory_history` table migration
- `property_owner_tag` / `property_owner_tag_map` table migrations
- Additional tenant display on lease details (`leasing_additional_tenant` join)

## Known Gotchas
1. **Login field**: Auth endpoint uses `username` field, not `email`, even though it's an email value
2. **Snowflake IDs**: All entity IDs are bigint Snowflake IDs, not auto-increment. Generate them explicitly
3. **invoice.category**: Direct bigint FK to `category_setting.id` — there is no `invoice_line` table
4. **due_on vs due_date**: DB column is `due_on`, frontend sends `due_date` — keep both working
5. **Deleted invoices**: Always filter `WHERE deleted_at IS NULL` on invoice queries
6. **February overdue bug**: Invoices past due aren't auto-updated to Overdue status (scheduler gap)
7. **backend/nul file**: Artifact file, can be ignored/deleted
8. **Phantom orgs**: `tena_prod_v2` holds rows for 11 organisations that are NOT in master
   `organizations`. Any diagnostic query must be scoped by `org_id` or the answer is wrong
9. **DATETIME means two things**: appointment columns hold a HONG KONG wall clock; the 24
   `NOW()`-written audit columns hold UTC. Pools set `dateStrings: ['DATE']` only, and
   wall-clock columns are pulled with `DATE_FORMAT` where their meaning is known
10. **Confirming a lease emails the tenant** check-in details, and separately a tenant
    portal invitation. It also creates the invoices
11. **`activity_log.action` is an ENUM.** A value not in it is rejected and `logActivity`
    swallows the error, so the row vanishes silently. Add to BOTH the enum (migration 081)
    and `ACTIONS` in `utils/activityLog.js` — a test enforces the pair. Everything logged
    before 2026-09-09 is CREATE/UPDATE/DELETE only, because the enum refused the rest
12. **A per-org SQL migration is never told which org its database belongs to**, and
    `email_template` holds a dozen legacy org_ids. Seed DATA belongs in a script that
    reads `organizations` from master; schema changes are fine as per-org SQL
13. **`file.is_private` is the only thing keeping a document off an anonymous URL**
    (`/api/file/preview` serves non-private images to anyone, so listing photos load).
    It is global to the file row, so never privatise a file attached elsewhere
14. **`of` is a reserved word in MySQL 8** — alias `object_file` as `objf`, never `of`
15. **Google Vision OCR is DOWN**: billing disabled on GCP project 610536915782, so
    Smart Extract extracts nothing. Needs re-enabling in the console, not a code fix

## Reference Docs
- `docs/migration-plan.md` — Page-by-page migration status from original
- `docs/completed-work.md` — Detailed log of all completed work per session
- `docs/style-guide.md` — UI patterns, colors, component conventions
- Auto memory: `C:\Users\alext\.claude\projects\D--Tane\memory\MEMORY.md`

## Session Routines

### Session Start
1. Read this CLAUDE.md for project context
2. Read `docs/completed-work.md` for latest progress
3. Check `docs/migration-plan.md` for what's next
4. Run `git log --oneline -5` in `D:\Tane\Tenafy Rebuild` to see recent commits
5. Run `git status` to check for uncommitted work

### Session End
1. Update `docs/completed-work.md` with changes made this session
2. Update `docs/migration-plan.md` if migration status changed
3. Update CLAUDE.md "Current Status" if major features were completed
4. Update auto memory MEMORY.md with any new patterns/conventions discovered
5. Commit all changes with a descriptive message
