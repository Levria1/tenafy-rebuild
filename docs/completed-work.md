# Tenafy Rebuild — Completed Work Log

Track all changes made per session. Update at the end of each session.

---

## Session: Unit resolver addresses + door codes (2026-09-11)

### Unit resolver — an address and a bare letter name a unit (`643a47b`)
- **Why** — a prospect wrote "Bonham Strand West Studio A" and got all seven Nam Pak Hong units read back. The address matched (three qualifying tokens); the unit did not, because NPH flats are named `7A` whose core token is `7a`, and the query token `a` is one character, under the two-character floor on the partial-match rule.
- **Bare unit letter** (`backend/src/services/unitResolver.js`) — a letter names the unit once the BUILDING is known. NPH is single-floor so "A" resolves confidently to 7A; Mong Kok has an A on every floor so all five score and the existing `ambiguous` path asks which, with the building's other 14 units dropped from the list. No new status and no floor counting: "only one unit carries that letter" already means what single-floor means.
- **Three guards, each earned by a case that broke in build** — (1) requires a matched property, or "unit A" matches an A on every floor of all 17 buildings; (2) a FALLBACK, consulted only when nothing at a matched building was named by its own token, because the unit literally called `3/F Unit 1 (Room A and Room B)` was matching flats 3A and 3B off its own name (this broke an existing test); (3) floor markers stripped first, so the F of "3/F unit" is not unit F — it was answering with 7F.
- **The article "a"** — capitalisation decides, except where it carries no signal: sentence-initial, or an all-caps message. Rejection falls through to the old behaviour.
- **`viaLetter` flag** — excluded from the `multi_unit` rule. One letter matching five A-units was escalating a plain enquiry to staff as a five-flat viewing request.
- **One distinctive street name** — a lone address word now identifies a building at 6+ chars, when it is not a district/city anywhere in the portfolio, and the customer wrote Street/Road beside it. Rescues "Russell Street" and "Possession Street"; the street-word clause keeps "I need possession by 1 Oct" away from Po Thai.
- **A hyphen joins, a space separates** (`joinHyphens`) — `unitCore` keeps the first token, which tolerates a stray suffix (`6A Test` → `6a`), but `norm()` made every punctuation run a space so Po Thai's `3D-A` and `3D-B` both collapsed to `3d`; a customer typing either name exactly was still asked to choose. Only a hyphen between two alphanumerics joins, so `mong kok - 6a` keeps separating.
- **Tests** — 14 new cases in `backend/test/unitResolver.test.js`. Verified read-only against the live portfolio (116 marketable units, 16 buildings).

### Door code on the lease and the schedule (`20bc750`)
- **Source is `leasing.unit_information`, NOT `unit.key_code`** — key_code is the obvious-looking column and is set on 2 of 118 units, one of them the word "Test". `unit_information` carries the code on 102 of 137 current/upcoming leases, as a single line like "Poplar 1C door code: 984197#". `backend/test/doorCodeWiring.test.js` pins which field is read.
- **Two surfaces** — a "Door Code" row under Unit in Leasing Details (`frontend/src/app/leasing/[id]/detail/page.js`), and a line under "Cleverly · 8B" on the Check In / Check Out card (`frontend/src/app/leasing/check-in-out/page.js`). One column added to the `/check-in-out` query; the detail endpoint is `SELECT l.*` and already returned the field.
- **`formatDoorCode`** (`frontend/src/lib/format.js`) — shared so the surfaces cannot drift. Long Salto instructions (~900 chars of app links and a video tutorial, written for the arriving tenant) collapse to the single word "Salto" with the full text one click away; collapsing requires BOTH the word and length > 60, so "Salto, gate code 8362" survives. `short` takes the first line for one-line slots, because two leases write the code on line 1 then continue.
- **Empty is omitted, not blank** — 35 of 137 leases record nothing; an empty row reads as "no code needed", which is not "nobody wrote it down".

### Unit page door code follows the current lease (`6eaae2b`)
- **The KEY CODES card was wrong where it mattered** — it printed `unit.key_code`, showing `664851#` for Cleverly 8B while the tenant in residence had `439012#`. Across the portfolio it showed something on two units and was wrong on both (the other said "Test").
- **Replaced with DOOR CODE** reading `currentLease.unit_information` (`frontend/src/app/property/[id]/unit/[unitid]/page.js`). Populated on 81 of 118 units, up from 2, and it re-dates itself on every turnover with nobody editing the unit. Blank between tenancies.
- **No backend change** — `/api/property/unit/:id/current-lease` already selects `start_date <= today AND end_date >= today` via `orgTodaySql()` and returns `unit_information` through `SELECT l.*`. A test pins that date bounding: the day it loosens, the card silently starts showing a past tenant's code.
- **`unit.key_code` keeps its column and its unit-edit-form field**; only the read-only display changed. The form field is now write-only in practice — worth removing.

### Marketing site
- `© 2026` → `© 2018` in the footer of all five pages at `/var/www/tenafy-site` (tenafy.com). Edited in place: the site is not a git repo, and the local copy at `D:\Tane\tenafy-website` was STALE — it still had `href="#"` placeholders where live has real Sign in links to the tenant portal, so deploying it would have broken Sign in on every page. Local copy has since been synced from live. Backup: `/var/www/tenafy-site.bak-20260911-121049`.

### Known follow-ups
- 35 of 137 current/upcoming leases have no door code recorded; Nam Pak Hong 7F says "Door access details will be sent to you via WhatsApp on your move-in date" instead of a code.
- Po Thai `3D-A` / `3D-B` resolve correctly now, but the unit-page CURRENT LEASE card still duplicates the door code in its "Unit Information" row.
- `platform.tenafy.com` is the real domain for the app; `tenafy.com` is the marketing site.

---

## Session: Booking-horizon + gap-band settings UI (2026-08-17)

- **UI** (`frontend/src/app/chatbot/settings/page.js` `LeasingAvailabilitySettings`) — booking horizon days, three stay-length gap bands, and the optional "too far out" phrase. Empty phrase stays empty (no default wording). Same Card / InputNumber / TextArea / save-reload pattern as the existing inquiry windows.
- **Migration** (`backend/migrations-org/065_inquiry_gap_bands.sql`) — `inquiry_gap_band_1m_days` (3), `inquiry_gap_band_2m_days` (6), `inquiry_gap_band_3m_plus_days` (10). Idempotent, same style as 064.
- **Engine** — `gapBandDays(leaseDurationDays, bands)` and `bookingGapLimitForLease(..., bands)` take optional operator bands. Junk values fall back to 3/6/10 via `availabilityNumber` (never looser than the default). `0` is a real setting. Unknown stay length still uses the flat 10.
- **Wiring** — `searchUnits` accepts `gapBands`; both call sites (`GET /units/search` and `search_available_units`) load settings and pass them. `GET /vacancies` uses settings bands for the beyond-horizon gap check.
- **Settings API** — `loadSettings` reads the three columns with defaults and a new fallback step for schemas that have 064 but not 065. `PUT /settings` validates 0–365 and extends the `includeX` ladder so a missing column does not block the rest of the save.

---

## Session: E-Signature System + WhatsApp Auto-Inquiry + Chatbot Settings Refactor (2026-06-09)

### Phase 1 — Lease Template System
- **Migration** ([backend/migrations-org/003_lease_templates_and_state.sql](backend/migrations-org/003_lease_templates_and_state.sql)) — new `lease_template` + `lease_template_revision` tables; new columns on `leasing` (`template_id`, `template_version_used`, `lease_state`, `signature_status`, `signed_file_id`, `signed_at`); new column on `booking_platform` (`requires_signature`). All idempotent.
- **Engine** ([backend/src/services/leasePdfRenderer.js](backend/src/services/leasePdfRenderer.js)) — HTML→PDF via Puppeteer with warm-browser singleton, A4 default, separate header/footer rendering. Three entry points: `renderFromTemplate` (real lease), `renderTemplatePreview` (sample data), `renderInlinePreview` (unsaved editor HTML).
- **Variables** ([backend/src/services/leaseTemplateVariables.js](backend/src/services/leaseTemplateVariables.js)) — central registry of ~30 `{{VARIABLES}}` (TENANT_NAME, RENT_AMOUNT, DEPOSIT, etc.) with `resolve(ctx)` functions + `sample` values for preview. `substitute(html, ctx)` does literal `{{KEY}}` replacement. `publicList()` strips functions for the frontend "Insert Variable" dropdown.
- **Routes** ([backend/src/routes/leaseTemplate.js](backend/src/routes/leaseTemplate.js)) — CRUD + `/variables` + `/preview` (inline) + `/:id/preview` (saved) + `/:id/duplicate` + `/:id/set-default`. Mounted at `/api/lease-template`.
- **Frontend** — list page ([frontend/src/app/settings/lease-templates/page.js](frontend/src/app/settings/lease-templates/page.js)), shared editor ([frontend/src/components/LeaseTemplateEditor.jsx](frontend/src/components/LeaseTemplateEditor.jsx)) with Quill toolbar, "Insert Variable" dropdown grouped by Tenant/Landlord/Property/Lease/Misc, live PDF preview pane. Create + edit pages are thin wrappers.

### Phase 2 — E-Signature System
- **Migration** ([backend/migrations-org/004_signatures.sql](backend/migrations-org/004_signatures.sql)) — `signature_request`, `signature_party`, `signature_event`, `landlord_signature` tables + `property.default_landlord_signature_id` column.
- **Stamping** ([backend/src/services/signatureStamper.js](backend/src/services/signatureStamper.js)) — pdf-lib adds Signatures page (tenant PNGs + auto-stamped landlord) + Certificate of Completion (signer names, emails, IPs, UAs, timestamps, SHA-256 of original PDF).
- **Routes** ([backend/src/routes/signature.js](backend/src/routes/signature.js)) — admin CRUD + `/landlord-signatures/*` + public token endpoints `/public/:token` (load + view event), `/public/:token/pdf` (stream), `/public/:token/sign`, `/public/:token/decline`. Public routes resolve token by scanning all active orgs in master DB (`resolveTokenContext`).
- **Public signer page** ([frontend/src/app/sign/[token]/page.js](frontend/src/app/sign/[token]/page.js)) — standalone (no MainLayout). Three signature methods in Tabs: **Draw** (`signature_pad`), **Type** (cursive fonts: Caveat, Dancing Script, Great Vibes rendered to canvas), **Upload** (PNG/JPG, max 2MB). All three output base64 PNG data URL.
- **Review-and-send page** ([frontend/src/app/leasing/[id]/review-and-send/page.js](frontend/src/app/leasing/[id]/review-and-send/page.js)) — two-column layout: template picker + signer list + landlord-sig picker + message + expiry-days form on left; live PDF preview iframe on right. "Send for E-Signature" creates request + emails signers; "Skip — go to lease" navigates to detail without creating one.
- **Landlord Signatures Settings** ([frontend/src/app/settings/landlord-signatures/page.js](frontend/src/app/settings/landlord-signatures/page.js)) — list page with Draw + Upload tabs for creating signatures, set-default, soft delete.
- **E-Signature card on lease detail** ([frontend/src/app/leasing/[id]/detail/page.js](frontend/src/app/leasing/[id]/detail/page.js)) — visible when `signature_status != 'none'`. Shows status badge + "View Signed Lease" button (when `signed_file_id` set) + "Manage Request" / "Send Again" button.
- **Email send** — fire-and-forget per party in `signature.js` createRequest; signed PDF re-emailed as attachment to all parties + creator in `finalizeRequest`.

### Phase 1C — Lease State Machine
- **`lease_state` column** on `leasing` — ENUM('pending','active'), default 'active'. Pending leases reserve the unit (overlap check applies, `unit.status=1` set) but skip all invoicing + notifications.
- **Scheduler gating** ([backend/src/services/scheduler.js](backend/src/services/scheduler.js)) — 5 queries updated to add `AND l.lease_state = 'active'`: recurring invoices, lease expiry, check-in, check-out, renewal.
- **`POST /api/leasing/:id/confirm`** ([backend/src/routes/leasing.js](backend/src/routes/leasing.js)) — flips pending → active, re-runs overlap check, fires deferred rent + deposit invoices.
- **Wizard step 3 E-Signature card** ([frontend/src/app/leasing/create/page.js](frontend/src/app/leasing/create/page.js)) — 2 new checkboxes ("Send for e-signature" + "Save as Pending") that auto-tick from booking platform's `requires_signature`. Post-save redirect: e-sign ticked → `/leasing/:id/review-and-send`; else `/leasing`.
- **PENDING badge + filter** on lease list ([frontend/src/app/leasing/page.js](frontend/src/app/leasing/page.js)) — gold tag, overrides date-based status. 5th filter radio "Pending" routes to backend `leaseState='pending'` param.
- **Calendar yellow + `*PENDING*` prefix** ([frontend/src/app/leasing/calendar/page.js](frontend/src/app/leasing/calendar/page.js)) — pending cells render yellow (`#faad14`); `getCellLabel` + expanded view prepend `*PENDING* ` to tenant name. Also changed `Gap Between Leases` from yellow to orange (`#fa8c16`) since yellow is now reserved for Pending.
- **`requires_signature` toggle** in Booking Platforms Settings ([frontend/src/app/settings/page.js](frontend/src/app/settings/page.js)) — Switch column; saves immediately. Backend ([backend/src/routes/bookingPlatform.js](backend/src/routes/bookingPlatform.js)) accepts the field on POST + PUT.

### Inquiry Smart Extract (paste / screenshot OCR)
- **Vision client** ([backend/src/services/visionClient.js](backend/src/services/visionClient.js)) — Google Cloud Vision API call, `DOCUMENT_TEXT_DETECTION` feature, language hints `en/zh-Hant/zh-Hans`. New env var `GOOGLE_VISION_API_KEY` (separate from existing `GOOGLE_SERVICE_ACCOUNT_KEY` which is a different auth path).
- **Parse endpoint** ([backend/src/routes/inquiry.js](backend/src/routes/inquiry.js)) `POST /api/inquiry/parse` — multipart (text + optional image), routes screenshot through Vision OCR → combined text → MiniMax (`llmClient`) → JSON field extraction → saves screenshot to file table → returns `{ fields, screenshot_url, raw_text }`.
- **Migration** ([backend/migrations-org/001_inquiry_screenshot.sql](backend/migrations-org/001_inquiry_screenshot.sql)) — adds `inquiry.screenshot_url`.
- **Frontend** ([frontend/src/app/inquiries/create/page.js](frontend/src/app/inquiries/create/page.js)) — Smart Extract card at top with textarea + image upload + Extract button. On success, prefills form via `form.setFieldsValue` + holds `screenshot_url` for inclusion in the inquiry create payload.
- **Inquiry detail page** ([frontend/src/app/inquiries/[id]/page.js](frontend/src/app/inquiries/[id]/page.js)) — new Screenshot card when `screenshot_url` set.

### WhatsApp Auto-Inquiry from TaneChat
- **Migration** ([backend/migrations-org/002_chat_session_inquiry_link.sql](backend/migrations-org/002_chat_session_inquiry_link.sql)) — new columns on `chat_session`: `inquiry_id`, `last_extracted_at`, `extract_count`. Safe against orgs without `chat_session` table (early bailout via `@table_exists` check) — fixed an initial deploy failure on a legacy test org.
- **Extractor service** ([backend/src/services/inquiryExtractor.js](backend/src/services/inquiryExtractor.js)) — `extractInitial(transcript)` (classifies is_inquiry + extracts fields), `extractDiff(newMessages, existingInquiry)` (returns only new/changed facts), `appendDiffToNotes(notes, diff)` (Option A: one dated line per fact under `── Updates from chat ──` heading).
- **Auto-create hook** ([backend/src/routes/public.js](backend/src/routes/public.js)) — `POST /api/public/chat/log` now fires `setImmediate(autoCreateInquiryForSession)` for new WhatsApp turns with no existing inquiry_id and no linked tenant.
- **Daily re-extract cron** ([backend/src/services/scheduler.js](backend/src/services/scheduler.js)) — 23:00 Asia/Hong_Kong, runs `reExtractInquiriesForOrg` over sessions where inquiry.status=0 + no confirmed/completed viewing + new user messages since `last_extracted_at`. Appends to `inquiry.notes`; never touches structured fields.

### Chatbot search_inquiries Tool
- **New tool** ([backend/src/services/chatTools.js](backend/src/services/chatTools.js)) — `search_inquiries` with params `keyword`/`unit_id`/`property_id`/`status`/`source`/`limit`. Searches across name, email, phone, AND **notes** (so chat-diff log is visible). Capability: `can_search_inquiries`. Internal staff bot only — not added to TaneChat or any public surface (PII boundary).
- **Extended `/api/inquiry/list`** with `unitId`, `propertyId`, `searchNotes=true` for the same use case.

### Chatbot Settings Refactor
- **Removed** legacy "Custom instructions" free-text card + "Full system prompt override" card from [frontend/src/app/chatbot/settings/page.js](frontend/src/app/chatbot/settings/page.js). Save now actively clears `custom_instructions` and `system_prompt` DB columns to `null` so the bot stops appending stale text.
- **Split Rulebook into two cards**: `Rules` (kind='rule') + `FAQs` (kind='faq'). Both use a shared `useKnowledge(kind)` hook + `KnowledgeCard` component.
- **FAQ Bulk Import** modal — paste textarea with live-preview parser. Supports `Q:/A:` format with blank lines OR alternating-line style. Backend ([backend/src/routes/chat.js](backend/src/routes/chat.js)) new `POST /api/chat/knowledge/bulk` endpoint returns `{inserted, failures}` for partial-failure visibility.

### Bug Fixes
- **Publish Invoice button missing on tenant detail** ([frontend/src/app/contacts/tenant/[id]/detail/page.js](frontend/src/app/contacts/tenant/[id]/detail/page.js)) — 3 spots used `leases.find(l => l.status === 1)` (stored column, unreliable per `bd351ce`). Fixed to `l.lease_status === 1` (date-derived). Without the fix, `activeLease` was undefined → the entire Active Lease Details card collapsed, taking the Publish button with it.

### Ops / Deploy Notes
- **NodeSource Node 22 upgrade on droplet** — Puppeteer 25 requires Node ≥22.12. Path: `curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -; sudo apt install -y nodejs; pm2 kill; cd ~/tenafy-v2/backend; npm rebuild; pm2 resurrect`.
- **Chromium system libs on droplet (Ubuntu 24.04 noble)** — `apt install -y libnss3 libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2t64`. Note the `t64` suffix on several packages (time64 transition) — `libasound2` is now a virtual package; install `libasound2t64`.
- **dotenv gotcha discovered** — droplet's `.env` had `OPENROUTER_API_KEY:` and `OPENROUTER_MODEL:` (colon-space) instead of `=`. dotenv silently ignores those, so the LLM fallback never actually worked. Fix: change `: ` to `=`.

### Dependencies added
- Backend: `puppeteer@^25`, `pdf-lib@^1.17`
- Frontend: `signature_pad@^5`

### Open follow-ups
- Review-and-send PDF preview shows sample data (not real lease). Real data is used at send time, but a dedicated "render real lease + template" preview endpoint would close the gap.
- Public signer token resolution scans all orgs (fine to ~50 orgs; past that → master DB `token → org_id` index).
- No "Copy link" button on review-and-send — email is the only delivery channel.
- No auto-expiry / reminder cron for signature requests (14-day expiry checked at access time only).
- Signature-request emails are inline HTML strings in `signature.js`; could be promoted to `email_template` rows.
- "View Chat" drawer on inquiry detail for WhatsApp-sourced inquiries — discussed, not built.

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

---

## Session 2026-08-23 — check-in emails (window, confirm, follow-up) + FAQ categories

### Check-in emails

**The lead time is `email_template.date_first` on the org's default `Checkin-Tenant`
template — not a constant.** Org 8300127259922432 moved it 7 → 14 on 23 Aug, and added
`date_second = 3` for a follow-up. `before_date` is NOT read for check-in; both legs are
always "before".

**Reading the send log**: `email_log.sent_at` is a TIMESTAMP rendered in the connection's
timezone (UTC in production). The 07:00 Hong Kong sweep therefore writes rows stamped
`23:00` the previous day, and a naive `DATEDIFF(start_date, DATE(sent_at))` reports one day
MORE than the real lead. Anything measuring against `sent_at` must go through
`orgTimeSql()` first. The 07:00 → 23:00 jump visible in the log from 16 Aug is `dcaa2e4`
moving cron onto Hong Kong time; before that the job fired at 07:00 UTC, i.e. 3pm locally.

**New: `backend/src/utils/checkinWindow.js`** — the window comparison in one place, working
on calendar dates rather than instants.
- `toCalendarDate` uses LOCAL getters for a Date, because mysql2 builds DATE columns with
  `new Date(y, m, d)`. `getUTC*` would report the previous day everywhere east of Greenwich.
- `shouldSendCheckinNow({leaseState, tenantCheckin, startDate, today, leadDays})` — every
  gate, returning `{send, reason}`. **`leaseState` is required and fails CLOSED**: a caller
  that omits it sends nothing. Failing open would let a future refactor silently mail
  unconfirmed tenants, and the unit tests would all stay green.
- `shouldSendCheckinFollowUp({..., followUpDays, firstSentOn})` — leg two.

**Three defects fixed**:
1. `POST /:id/confirm` never sent a check-in email, so a lease confirmed inside the window
   waited for the next 07:00 sweep. It now calls `maybeSendCheckin` after the state flip.
2. The create route was not guarded by `lease_state`, so a *pending* lease got an instant
   check-in email the sweep would never have sent. Create now refuses pending; confirm sends.
3. The sweep and the create route computed the window separately and could drift.

**The follow-up (`date_second`)**: same template, two lead times — the arrangement
`Invoice-Tenant` already used. It logs under **`Checkin-Tenant-2`** via a new `logType`
option on `sendTemplateEmail`; both legs render `Checkin-Tenant`, so a shared log type would
leave the follow-up's dedup unable to tell the first email from its own. It refuses when the
first email went out within `date_second` days of the start date — a lease booked inside the
gap gets one email, not two near-identical ones a day apart.

**Tests**: `checkinWindow.test.js` (31) and `checkinWiring.test.js` (8). The wiring suite
reads the route source, in the manner of `noServerClockDates.test.js`, because the original
bug was the create endpoint knowing the lease was pending and simply not mentioning it — a
helper-only suite stays green through that. Every guard was mutation-tested; one assertion
("never send both legs in one sweep") passed against a broken implementation on the first
attempt because it matched the wrong `continue`, and was re-anchored.

### FAQ categories

- Added **`booking`** / "Booking". The list lives in THREE files and each fails differently
  and silently: `backend/src/utils/faqCategories.js` (validator — unknown values are rewritten
  to `other` on save), `frontend/src/components/chatbot/KnowledgeCard.jsx` (admin dropdown),
  `website/faq/index.html` (public page — a missing key renders the raw slug as a heading).
  `backend/test/faqCategorySync.test.js` is the only thing that notices; verified it catches
  a partial addition in both directions.
- The admin dropdown is now **sorted by label, with "Other" pinned last** — derived once as
  `FAQ_CATEGORY_OPTIONS`. The canonical array keeps its reading order, because that order is
  what the public FAQ page's section sequence depends on.

**`website/faq/index.html` is not served from this droplet.** It represents the live page
hosted with the public site, so the Booking heading does not appear there until that file is
published separately.

---

## Session 2026-09-02 — Leasing → Check In / Check Out

A single mobile-first list of every upcoming arrival and departure, added because there was
nowhere to see both together. Cleaning's "Checkout Schedule" tab is week-scoped and
cleaning-oriented, and the leasing calendar is a grid, not a list you can read on a phone.

**`GET /api/leasing/check-in-out`** (`backend/src/routes/leasing.js`, above `/:id` — the
static-before-dynamic rule, or Express reads the path as a lease id). Two SELECTs, one on
`start_date` and one on `end_date`, merged and sorted in JS.

- **Forward-only.** A `from` earlier than the org's today is clamped, not rejected: the page
  answers "what is coming", so a stale bookmark cannot resurrect last month.
- **Dates are formatted in SQL** (`DATE_FORMAT`), never in JS. The server runs UTC and a JS
  `Date` shifts a Hong Kong calendar day by one.
- **`end_date` is the departure**, with no special handling for early leavers, because
  recording a move-out shortens the lease row itself.
- **Same-day turnovers fall out of the sort order** rather than a render-time special case:
  date, then property, then unit, then `out` before `in`. A unit appearing twice on one day
  is therefore already adjacent, and only needs the `turnover` flag to say so.
- Company tenants fall back to `company_name`, so an arrival never renders nameless.

**`frontend/src/app/leasing/check-in-out/page.js`** — one date-grouped card list on both
desktop and mobile, rather than the table/`MobileCardList` split used elsewhere in Leasing.
The day grouping is what makes it readable, and a table cannot express it. Filters: property,
date range (default today → +30d), and an All / In / Out toggle applied client-side.

**No completion state exists.** Nothing in the schema records that a check-in actually
happened, so this is a derived list and nothing can be ticked off. Adding that needs a table.

**Verified** against production read-only: 19 check-ins, 22 check-outs and 8 correctly paired
same-day turnovers in the next 30 days, with 19-digit lease ids intact in the response.

---

## Session 2026-09-02 (continued) — advertising a flat on the day it is handed over

**The report.** A Facebook post listed Mong Kok 3D as "Available from 2026-09-30". A lease
starting 2026-09-30 already existed for that unit, created 26 Aug, six days before the post.
5C was the same shape. So the ad named the exact day the next tenant moved in.

**Root cause.** `%AvailableDate%` in `resolveUnitValues` (`services/advertisingTemplate.js`)
read only the lease covering today and reported its `end_date`. It never asked whether
anything ran past that lease. Normally masked, because the vacancy feed drops a re-let unit
before the renderer ever sees it, so the placeholder was wrong without being visibly wrong.

**Fix.** After resolving the current lease's end, look for any lease running past it. If that
tenancy starts on or before the end date, the handover is immediate and the token returns
blank rather than a date the unit does not have. A genuine gap keeps its date: that is a real
availability window, and `min_gap_days` upstream decides whether it is worth advertising. The
"running past this one" test deliberately mirrors the vacancy feed's own `NOT EXISTS` rule so
the renderer and the feed cannot disagree about what is free.

`__availability { date, relet_from, taken }` rides along on the values map. It is not a
placeholder token, and `applyPlaceholders` substitutes only `TOKEN_SET` keys, so it cannot
reach ad text. There is a test asserting exactly that.

**Guard in `buildPostingPlan`.** A blank date renders as "Available from , and price is…",
which reads as an oversight rather than as "taken". A bundle containing a re-let unit is now
held back with status `already_let` and a reason naming the units. It blocks the whole bundle
rather than dropping one unit's line: a bundle is one message, and trimming it silently would
hide the data problem. The Scheduler page already renders unknown statuses as an orange tag
with the reason, so no frontend change was needed. `scripts/tenafy_posting_plan.py` now prints
held-back posts; it already skipped anything not `ready`, so it was safe but silent.

**Verified.** 6 new tests, each mutation-tested. Disabling the fix fails 3; weakening `<=` to
`<` (the same-day case that caused this) fails the boundary test. Full suite 1090 pass. Run
against all 119 live units read-only: 11 units stop advertising a date they do not have, all
same-day handovers, 108 unchanged.

**Not fixed by this, on purpose.** The same post showed Mong Kok 2C at an old date and the
bottom-of-range price that only follows from that old date. 2C has no follow-on lease; its own
lease was edited on 26 Aug. That post was stale copy reposted, not a render fault. Nothing in
the code prevents pasting an old draft. Note also that `advertising_post_log` had no rows for
the five days around it: the `mark` step is what records a post, so there is currently no way
to tell a fresh post from a recycled one without reconstructing it from lease timestamps.

---

## 2026-09-02 — Tenant Status is required, never defaulted to 0

**Commit:** `879765d`. Deployed and verified on the droplet the same day.

### The bug

`leasing.contract_type` has four values (1 MR, 2 MTM, 3 NR, 4 UC). It also had a fifth
state nobody chose: `contract_type || 0` on create wrote a 0 whenever the field was
skipped. That is the worst state a lease can hold, because the two systems that read the
field disagree about what it means:

- `utils/advertisingPlan.js` special-cases only NR, so anything else including 0 becomes
  advertisable at `lead_days_other` (45 days) and the unit goes to market;
- `utils/renewalAsk.js` counts only `[1, 4]` as undecided, so a 0 returns
  `already_decided` and the tenant is never asked.

The home gets listed while nobody is chasing the answer.

### Why the existing "required" rule never fired

`frontend/src/app/leasing/create/page.js` is a 3-step wizard. Its only `validateFields`
call is in `nextStep()` at step 0 and passes an explicit field list that omitted
`contract_type`; `onSubmit` then builds the payload straight from `getFieldsValue(true)`.
The red asterisk rendered and nothing blocked. Commit `8df0562` (2026-04-21, "Make lease
Tenant Status required on create and edit") therefore closed nothing on the create path:
**7 of the 11 bad rows were created after it landed**, across three staff accounts at 4
to 14 percent each. That spread is what a silently accepting form looks like, not what
one person's habit looks like. The edit page was fine, because `<Form onFinish>` runs
full validation.

### The fix

- **`backend/src/utils/contractType.js`** (new) — one `parseContractType()`, 1-4 only.
  Stricter than `Number()` on purpose: `Number(true)` is 1 and `Number(['3'])` is 3, so a
  bare coercion would let a boolean or array through looking like a deliberate MR or NR.
  Mirrors `definedNumber()` in `renewalAsk.js`.
- **`POST /api/leasing`** — 400 before any query, pending drafts included, since a draft
  becomes a real lease without passing through creation again. The `contract_type || 0`
  in the INSERT is gone.
- **`PUT /api/leasing/:id`** — omitting the field still leaves the stored intent alone,
  but sending a 0, null or empty string is refused rather than written. An edit cannot
  put a lease back into the undecided state.
- **`create/page.js`** — `contract_type` joins `step1Fields`, so the rule fires on a
  field the user can see. Both create and edit drop the `?? 0` fallback.

Requiring a choice is safe because UC (Unconfirmed) already exists and is already treated
as undecided by the renewal ask. Nobody has to guess: "I do not know yet" is itself a
recordable answer, and one the automation acts on.

### Verified

12 new tests in `backend/test/contractTypeRequired.test.js`, mutation-checked: re-allowing
0 fails 2, dropping the non-string rejection fails 1. One test asserts the guard and the
renewal ask agree, so no accepted value can be both advertisable and unaskable. Full suite
**1102 pass** locally and on the droplet. Frontend builds clean.

### Data backfill

All 11 leases sitting at 0 were set to **UC**: 4 live, 2 upcoming, 5 already ended. Every
`UPDATE` was guarded on `contract_type = 0`. Org-wide count of 0 rows is now zero. The 5
ended ones are cosmetic (`renewalAskEligibility` returns `lease_already_ended` before it
reads the field, and the vacancy and posting queries filter `end_date >= today`) and were
included at the operator's explicit request for uniformity. **March 2026 ended leases
marked Unconfirmed are deliberate, not corruption.** The backfill was written by direct
SQL, so there is no `activity_log` attribution for it.

### Deliberately not done

`UNDECIDED_CONTRACT_TYPES` in `utils/renewalAsk.js` is still `[1, 4]`. Adding `0` was
recommended as a safety net but skipped, because `renewal_ask_enabled` is 1 in production
and the change would make real tenants messageable without a separate decision. With the
write guard in place no new 0 can be created, so it is belt-and-braces rather than urgent.

---

## 2026-09-06/07 — Tenant portal live, and the timezone drift behind a bug report

### Tenant portal switched on
`TENANT_JWT_SECRET` set; every portal endpoint had been answering 503. Built the parts
that made it usable: registration (`/tenant-portal/register`, `/set-password` — the path
the emailed link already pointed at, so that email had been a 404), the repairs screen,
follow-up notes and withdrawal, and staff notifications on submit/update/withdraw.

Three shipped-but-broken pieces were blocking sign-in entirely: the login page read a
token the rewritten endpoint no longer returns, the layout gated every page on an httpOnly
cookie JavaScript cannot read, and logout deleted a cookie client-side. See
`f460adf`, `4a90cc0`.

**No edit endpoint, deliberately.** Once a vendor is booked against a description,
rewriting it sends them to a job that no longer exists. Append-only thread instead, and
withdrawal only while still Received.

**Repair photos are stored `is_private = 1`.** `/api/file/preview` serves any image
anonymously by design (the listings site depends on it), so shipping the repairs screen
without that flag would have made every photo of the inside of a tenant's home fetchable
by guessing a Snowflake id.

### The timezone drift (`d12cd10`, `1661ebf`)
A question about a missing end time on the service edit form turned out to be a read-side
bug: DATETIME columns holding a Hong Kong wall clock were being read as UTC and drawn
eight hours later. The edit form loaded the inflated value and saved it back, so each
open-and-save pushed the window further, composing the end from the START date.
**141 of 1,702 requests already end before they begin.** Left unrepaired by decision.

First fix was half wrong — `dateStrings: ['DATE','DATETIME']` renders the 24 `NOW()`-written
audit columns eight hours EARLY. Now `['DATE']` only, with `DATE_FORMAT` on the six
wall-clock columns in the queries that know which kind they are.

### Check-in email investigation
A tenant received move-in instructions for a lease that fell through. The server log
settled it: **someone pressed Confirm Lease**, which sends the email — and the dialog said
only "generate invoices and mark active". The dialog now names the email and its
recipient first. The manual send button separately never checked lease state at all.

### Audit logging
Audited every write endpoint: 39 recorded who acted, **208 did not**, including confirming
a lease. Added to 18 where "who did this" is the first question. `move-out` was silent
while its own UNDO was logged.

### Phantom organisations
`tena_prod_v2` carries rows for eleven organisations absent from master. Deactivated
63 templates, 441 user rows and 17 roles (backed up, reversible); kept "Super Admin",
which the owner's account depends on. Found and fixed en route: **login matched on
username/email across every org with no ORDER BY**, so the owner's session worked by luck
of row order.

### Also
- Account and security email now sends from `no-reply@taneresidence.com`, not the billing
  address (`EMAIL_FROM_ACCOUNT`).
- The registration email rewritten with substance; org name read from master, never a
  literal.
- tenafy.com brought into version control at `website/tenafy-site` — it existed only on
  the droplet with no history. Sign in pointed at `href="#"`.
- Timeline entries: tenant-written ones are attributed and undeletable; deleting is now
  reversible with the full text copied to `activity_log`.

Suite 1315 → **1464**. Migrations 079, 080.

---

## Session 2026-09-07 → 09 — things that reported success and did nothing

A run of defects with one shape in common: the code ran, the UI said it worked, and
nothing was recorded. None of them threw, so none of them showed up as a bug.

### Receipt descriptions printed twice
Xero staging joined the bank transaction's `Reference` and its line-item `Description`
with an em dash. Tane's Xero data holds the same sentence in both, so **567 accounting
notes stored their text twice over** — and every one is a single-line payment, which is
exactly the case where the receipt falls back to the payment note. Multi-invoice receipts
were never affected, which is why the earlier per-line fix looked complete.

Collapsed on read and in `xeroSync`; **580 notes backfilled** (more than 567 because the
script deliberately includes soft-deleted payments — a restored one would come back
duplicated). `utils/paymentNote.js` owns the rule so the backfill writes exactly what the
renderer would show; a SQL-only version would have drifted, since MySQL `TRIM()` does not
strip the newlines four of those rows carry.

### Google Vision OCR had stopped, and the form blamed the user
Every Smart Extract call returned **403: billing not enabled on GCP project
610536915782**. OCR failure is non-fatal by design, so with no pasted text the endpoint
returned zero fields and the form said *"Try a clearer image"*. The screenshots were
fine. The key is unchanged since 16 July and `visionClient.js` since 9 June, so nothing
on our side moved.

Account failures (401/403/429, disabled API, missing key) are now distinguished from a
bad image. The tenant form shows a persistent amber panel naming the account instead of a
toast, chat OCR answers 503, and a result built only from pasted text says the screenshot
was not read. **Fixing it needs billing re-enabled in the GCP console** — two different
projects are in play, and the broken one is not the project the calendar service account
lives in.

### The audit log was refusing most of what it recorded
`activity_log.action` was `ENUM('CREATE','UPDATE','DELETE')` while the code passed
**eleven more** values. MySQL rejected each insert, `logActivity` swallowed it, and the
request succeeded. **All 4,020 rows are one of those three.** This landed on the previous
session's work: confirming a lease, emailing check-in details, moving a tenant out and
restoring a deleted timeline entry were all being written and all being dropped.

Separately, twelve call sites passed an options object the function never accepted, so
`entity_type` bound to `undefined` — **no INQUIRY, LEASE_TEMPLATE or SIGNATURE_REQUEST
row has ever existed.** Migration `081` widened the enum to fourteen values; `logActivity`
takes both call shapes; failures print `AUDIT ROW LOST` with the action and record.
Over-long descriptions are trimmed rather than costing the whole row.

### Meter readings could not be corrected
The Edit Meter form has always shown a reading field. `PUT /meter/:id` destructured
everything except `current_reading`, returned 200, and the UI said "Meter updated". A
no-op that announces success.

It now writes a dated **Correction** into the reading log rather than only moving the
column, because bills are built from that log. Second defect behind it: logging a reading
set `current_reading` unconditionally, so a **back-dated entry rewound the meter** while
the screen kept showing the newest reading. Mercer 4B, 2 Sep: August's 23,241 entered at
06:49, July's 23,134 at 07:44. **127 readings system-wide were entered after a
newer-dated one already existed**; three meters were still out of step and were realigned.

Worth a look: Jervois 4A and Mercer 5B each hold a bill closing reading **2 units higher
than a checkout reading taken the next day**. Same shape both times, and both bills were
entered 5–10 days after their period end, so the closing figure was most likely read on
the day of entry. Cost about HK$3.60 each, charged to the departing tenant.

### Receipts attached to a payment could not be seen
Three gaps, each fatal alone: the form posted the file and **threw the returned id away**;
`accounting` had no column for it; and the drawer rendered the literal string *"No files
attached"* behind a comment reading `{/* Files section placeholder */}`. **549 uploads sit
within five minutes of a payment being created, attached to nothing.**

Wired through `object_file`. Attaching marks the file private, but **only if it is attached
nowhere else** — `is_private` is global to the file, and a shared listing photo would 403
for logged-out visitors. An editing save ADDS receipts rather than replacing the set,
since the edit form does not know what is already attached.

### Nobody could get into the tenant portal
Three days after launch: **one account, against 114 tenants on a live lease.** The only
way in was to find the portal yourself and ask for a link; the Invite button said
"coming soon".

Confirming a lease now sends a separate invitation, and the Invite button sends the same
email on demand. All three paths — including self-service registration — share one
helper, because three routes issuing a credential link is three places for a fix to miss
one. Eligibility is unchanged: a tenant on a lease, not a payee (2,945 of 4,785 rows are
payees, 3,060 have no lease).

The email is now the editable template **`Portal-Invite-Tenant`**, seeded per org. The
render checks the finished html for the actual link and falls back to the built-in wording
if an edit lost it. **The link lasts 7 days**, up from 60 minutes — chosen for both
sign-up and reset, knowing one token serves both.

Removed: `POST /api/contact/tenant/{check,create}/user`, which mailed a code stored
against a **staff `user` row** that the portal cannot redeem. Dead rather than broken, but
a trap.

### Notes
- A seed written as migration `082` was **deleted after a rolled-back production dry run
  showed it creating twelve templates for eleven organisations that do not exist**.
  `migrate-orgs.js` never tells a file which org its database belongs to. Seed data now
  comes from `scripts/seedPortalInviteTemplate.js`, reading master.
- Codex needed three attempts on the receipts review: twice it spent its whole budget
  echoing the files it was asked to read and returned no analysis, which reads exactly
  like a clean review. Only inline code with nothing to read worked. It then found three
  real defects, including one in a test of mine.

Suite 1464 → **1621**. Migration 081. Scripts:
`backfillDuplicatePaymentNotes`, `repairMeterCurrentReading`, `seedPortalInviteTemplate`.

---

## Session 2026-09-09 — the portal gets the utilities tab, and its own receipts

Two requests: let the tenant portal see the electricity billing history staff see on a
tenant's Utilities tab, and let tenants download the invoice and receipt for anything
accounting-related.

### Utilities (read-only)

`GET /api/tenant-portal/utilities` is a scoped copy of the staff history query, with the
full breakdown: period, meter, start and end reading, kW, rate, gross, credit, net, and
the linked invoice. Header block carries the monthly utility credit, the lease dates and
the check-in/check-out meters. No edit, no undo — the staff settlement controls are not
on it.

Two scoping details that are not optional:
- **`utility_bill_line` has no `org_id`**, so `JOIN utility_bill b ... AND b.org_id = ?`
  IS the tenancy boundary. Drop the join and a line id reads straight through.
- The lease block uses `leaseIsTheirs`, not `tenant_id`, so a spouse listed only in
  `leasing_additional_tenant` sees the same figures as the named tenant.

The nav item appears only for tenants who have utility history, via `features.utilities`
on the `/profile` probe the layout already calls on every page. Most orgs do not bill
metered electricity, and a permanently empty tab is worse than no tab.

### Receipts — the Airbnb payout problem

The receipt PDF was keyed on the payment, and that is not safe here. **Tane receives
Airbnb payouts through Xero: one bank deposit covering several guests' stays, split into
one `accounting_line` per guest invoice, with the payment's own `tenant_id` left NULL.**
Seventeen such rows landed between 20 Jul and 4 Sep 2026; four of them span tenants:

| Transaction | Date | Amount | Guests |
|---|---|---|---|
| TANE41799 | 2026-07-24 | 22,829.11 | 2 |
| TANE41918 | 2026-08-03 | 31,399.56 | 3 |
| TANE42218 | 2026-08-24 | 27,248.70 | 3 |
| TANE42354 | 2026-09-02 | 16,455.02 | 2 |

Nine tenants are on those four, and seven invoices have no other payment row — so an
ownership check on `accounting.tenant_id` fails twice over. It refuses receipts those
nine are entitled to, and admitting them would hand over the others' invoice codes and
amounts. The `note` on those rows is worse than the line list: a transcript of every
stay on the deposit, with names, confirmation codes, nightly rates and Airbnb's service
fee — and the receipt printed it as the description.

So portal receipts are **tenant-scoped**: `buildVisibleLines` keeps the lines whose
invoice is theirs, and the raw `payment_note` is never printed — each line is described
by its own invoice note instead. Orphan lines (a Xero reference matching no surviving
invoice, which is 14,787 of them) carry no tenant to check, so they ride along only on a
payment that is unambiguously one tenant's and are dropped otherwise. Staff receipts are
unchanged.

Verified against the real rows read-only: each of the nine gets exactly their own line
and their own total, a stranger is refused, and staff still get all lines at the header
amount. That rehearsal caught one thing the fixtures did not — Luke Willis's own invoice
note contains `Host service fee (15.5%)`, which is his data on his invoice, already on
the invoice PDF he is emailed. Not a leak, but the detector had to learn the difference.

### The receipt renderer was written twice

`pdf.js` drew the receipt once inline in the route and again in
`generateReceiptPdfBuffer` for email, and the copies **had already drifted**: 16 currency
symbols against 8, so an INR receipt read `INR 500` by email and `₹500` on screen, and
the rule under the totals block sat 10pt out. Now one `loadReceiptPdfData` +
`renderReceiptPdf`, called by staff, email and the portal. The emailed receipt gains the
missing symbols and matches the downloaded one.

### Also fixed

The portal invoices table asked for `description` and `due_date`. The API sends `note`
and `due_on`, so **both columns had rendered `-` and `N/A` for every invoice since the
portal went live**.

`receipt_available` is computed by one subquery rather than by loading each receipt in
turn — one invoice in Tane's data carries 18 payments, which would have been 54 queries
to decide whether to draw a button.

### Follow-up: the list said nothing about what had been paid

The portal invoice list selected only `amount` and `status`, so an invoice being settled
in instalments read as though nothing had arrived. Two live cases, both Airbnb payouts:

```
TRIV34883  amount 83,317.01  paid 20,580.30  outstanding 62,736.71  Overdue
TRIV34543  amount 34,434.99  paid 24,825.22  outstanding  9,609.77  Overdue
```

The list now carries `amount_paid` and `outstanding`, computed from `accounting_line` the
way the staff invoice detail does, with outstanding as the emphasised figure. A correlated
subquery rather than a join, so an invoice with several payments stays one row;
`accounting_line.idx_invoice_code` makes it a lookup. The arithmetic is done server-side
because DECIMAL and SUM both arrive as strings under `bigNumberStrings`. Outstanding
follows the staff rule: a Paid invoice owes nothing whatever the lines total, and it never
goes negative, since an overpayment is a credit and not a negative bill.

### Noted, not actioned

**27 finalized utility bill lines with net above zero carry no invoice — HK$10,289.26**,
January to July 2026, none of them common-area. On several the sibling lines on the same
bill *were* invoiced (2 of 4, 5 of 7), so the run happened and these were not selected;
on others no line was ever invoiced. Huixian Zhang alone is HK$3,907.36 across four
periods. Whether that was deliberate is not knowable from the data, and those months now
appear on the tenant's Utilities tab with a dash where the invoice would be.

Confirmed while checking: a utility invoice is raised only when consumption exceeds the
credit — 296 lines sit at net 0.00 with no invoice, 159 at net above zero with one, and
102 checkout settlements at net ≤ 0 with none. The zero-net months still show on the
portal page, which is the proof the credit absorbed them.

Suite 1621 → **1653**. No migration.


---

## Session 2026-09-10 — the recurring flag nobody was setting, and a chasing floor

### Ziying Qu, NPH 7G — nothing was broken

Reported as "recurring was enabled but September never generated". It did generate.
`TRIV34956` was created at lease confirmation on 31 Jul, due **15 Sep**, emailed on
9 Sep, and paid the same day — the payment notes read *"Rental payment for Sept. 15 -
Oct.14, 2026"*. On **10 Sep at 06:37** that invoice's due date was changed to 15 Oct,
55 minutes after the two payments were recorded.

October would have generated by itself on **16 September**. The sweep's guard is
`daysDiff(today, lastDueDate) < 1`, so with the anchor at 15 Sep it correctly sat
still until the 16th, then advances one cycle. Moving the invoice to 15 Oct moved the
anchor with it, so the next run is 16 Oct and it will raise **15 Nov** — October
skipped. Putting the invoice back to 15 Sep restores both.

### `share_lease` had two owners

`share_lease` IS the recurring-invoice flag — the only two reads are the scheduler's
lease filter and `isRecurring` in leasing.js. Nothing shares a lease with anyone. But
both lease forms also carried a checkbox labelled **"Share lease with tenant"** bound
to the same column, and the two pages disagreed about which control won:

| | Recurring switch | Saved to `share_lease` |
|---|---|---|
| Create | default ON | the switch |
| Edit | initialised from `invoicing` | **the checkbox** |

So on the edit page you could switch Recurring Invoice on, save, see it saved, and
have the lease generate nothing. **Four active leases were in that state**, two of them
already missing September: LEA3266 (Hussnain Khalid, 9,000 due 19th) and LEA2705
(Manon Etard Anglade, 12,000 due 31st).

The switch now owns the flag on both pages, the duplicate checkbox is gone, and the
edit switch initialises from `share_lease && invoicing` so it shows what the scheduler
will actually do. New leases still default to recurring. `scripts/repairRecurringFlag.js`
clears the stranded four; the two ended leases generate nothing because the loop breaks
at `nextDueDate > end_date`.

No migration — the column already means what the UI now says it means.

### A floor below which chasing is not worth it

The sweep chased any invoice with a cent outstanding. Someone who paid HK$17,600 of
HK$18,000 got the same demand as someone who paid nothing, and the Overdue template
threatens *"5% of the monthly rent"* per week over what is usually a bank transfer fee.

`chase_setting` gains `min_outstanding_pct` and `min_outstanding_amount` (migration
082). Below **either** is enough to skip, so raising one can only ever chase fewer
people. Both default to 0, which is exactly today's behaviour — same stance as
`enabled` in 077, since a deploy must not change who gets emailed.

Applied in the sweep's own SQL rather than after the fact, like every other policy
test: the job looks at 50 rows and a backlog of ineligible invoices must not crowd out
genuinely late ones. Manual chasing from the invoice screen stays unrestricted.

`numOr` rather than the existing `clamp`, which truncates — a 2.5% threshold would
have become 2%. The percentage is capped at 100, since above that would skip every
invoice and silently disable the sweep without the enabled switch saying so.

Suite 1656 → **1675**. Migration 082. Script: `repairRecurringFlag`.
