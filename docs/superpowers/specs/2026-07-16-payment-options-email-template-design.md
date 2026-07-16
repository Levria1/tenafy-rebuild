# Payment Options email templates (per-building)

**Date:** 2026-07-16
**Status:** Approved (design)
**Area:** Email templates + per-building allowlist + lease create/edit trigger

## Problem / goal
Staff need to email tenants their building's payment instructions ("Payment Options"),
and different buildings have different payment content. Today email templates are picked
by `template_type` with a single default per type — there's no way to have a different
Payment Options email per building, and no way to send one from the lease flow.

Add a new **Payment-Options** email template type that can be **linked to buildings**
(mirroring the existing lease-template→property allowlist), and a **"Send Payment
Options" checkbox on the lease create/edit forms** that emails the right building's
template to the tenant on save.

## Decisions (from brainstorming)
1. **Multiple templates, linked to buildings** (not one template with per-building
   variables). Full flexibility — a distinct Payment Options email per building.
2. **Trigger:** a "Send Payment Options" checkbox on the create-lease form (and
   edit-lease), styled like the other lease checkboxes. Sends **once on save** when
   ticked — not an ongoing auto-send/scheduler toggle.
3. **Recipient:** the lease's tenant. Fire-and-forget (never blocks the lease save).
4. **Fallback order** at send time: building-specific template → catch-all
   (empty property list) → skip quietly + log.
5. Reuse the existing `emailService` (so it sends via Mailgun automatically) and the
   existing variable engine — no new variables.

## Data model
- **New template type:** `Payment-Options` added to `TEMPLATE_TYPES` in
  `backend/src/services/emailService.js` (label e.g. "Payment Options (Tenant)").
  No `email_template` schema change — it reuses all existing columns
  (`template_name`, `subject`, `template_content`, `is_default_template`, etc.).
- **New allowlist table** (org DB), mirroring `property_lease_template`:
  ```sql
  CREATE TABLE property_email_template (
    id BIGINT PRIMARY KEY,           -- snowflake
    org_id BIGINT NOT NULL,
    property_id BIGINT NOT NULL,
    template_id BIGINT NOT NULL,     -- FK-ish to email_template.id
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    KEY idx_org_template (org_id, template_id),
    KEY idx_org_property (org_id, property_id)
  );
  ```
  Generic (any email_template id), but only the Payment-Options type populates/consumes it.
  Idempotent migration in `backend/migrations/` (auto-runner) with `IF NOT EXISTS`.

## Backend
### `backend/src/routes/emailTemplate.js`
- Add `applyEmailPropertyAllowlist(pool, orgId, templateId, propertyIds)` and
  `getEmailAllowedProperties(pool, orgId, templateId)` — direct mirrors of the lease
  template helpers (`DELETE` then `INSERT` per property; `SELECT property_id`).
- **Create** (`POST /`) and **update** (`PUT /:id`): accept optional `property_ids`
  in the body; call `applyEmailPropertyAllowlist` after the insert/update.
- **Get** (`GET /:id`): include `property_ids` via `getEmailAllowedProperties`.
- **Delete**: clean up `property_email_template` rows for that template.

### `backend/src/services/emailService.js`
- Register `Payment-Options` in `TEMPLATE_TYPES`.
- Add a resolver `resolvePaymentOptionsTemplate(pool, orgId, propertyId)`:
  1. `SELECT et.* FROM email_template et JOIN property_email_template pet
      ON pet.template_id = et.id WHERE pet.org_id=? AND pet.property_id=?
      AND et.template_type='Payment-Options' AND et.status=1
      ORDER BY et.is_default_template DESC, et.created_time DESC LIMIT 1`
     → building-specific.
  2. Else a catch-all: a `Payment-Options` template (status=1) with **no**
     `property_email_template` rows, preferring `is_default_template=1`.
  3. Else `null` (caller skips).

### `backend/src/routes/leasing.js`
- On lease **create** (POST) and **edit** (PUT): read `send_payment_options` from the
  body. When truthy, after the lease is saved, resolve the lease's `property_id`
  (via unit→property), call `resolvePaymentOptionsTemplate`, and if found send it to
  the tenant via `sendTemplateEmail('Payment-Options', { leaseId, templateId })`
  (fire-and-forget; on no-template or no-tenant-email, log and continue).

## Frontend
### Email template editor (`frontend/src/app/settings/email-templates/{create,[id]/edit}/page.js`)
- Add an **"Available for these properties"** multi-select (property list), shown
  **only when the selected template type is `Payment-Options`**. Bind to `property_ids`
  in the create/update payload, same as the lease-template editor.

### Lease forms (`frontend/src/app/leasing/create/page.js` + `.../[id]/edit/page.js`)
- Add a **"Send Payment Options"** checkbox (a `Form.Item name="send_payment_options"
  valuePropName="checked"`), placed with the existing lease checkboxes (e.g. in/near
  the Email Notifications or E-Signature area). Its value is included in the
  create/update lease payload. It is a transient action flag (not persisted as an
  ongoing toggle).

### API client (`frontend/src/lib/api.js`)
- Email-template create/update already exist; ensure `property_ids` flows through.
- Lease create/update already send the form values; `send_payment_options` rides along.

## Edge cases
- **No Payment-Options template for the building and no catch-all:** skip send, log a
  line, lease still saves. No error surfaced to the user (matches other lease emails).
- **Tenant has no email:** skip + log (same as check-in email behavior).
- **Multiple templates linked to one building:** resolver picks
  `is_default_template=1` first, else newest — deterministic.
- **Cross-org:** every query filters `org_id`. Snowflake ids for new rows.
- **Editing a non-Payment-Options template:** the property field is hidden and
  `property_ids` is ignored, so no allowlist rows are written.

## Files touched
- `backend/migrations/NNN_property_email_template.sql` — **new** table.
- `backend/src/routes/emailTemplate.js` — allowlist helpers + wire into CRUD.
- `backend/src/services/emailService.js` — register type + `resolvePaymentOptionsTemplate`.
- `backend/src/routes/leasing.js` — send on create/edit when checkbox set.
- `frontend/src/app/settings/email-templates/{create,[id]/edit}/page.js` — property multi-select (Payment-Options only).
- `frontend/src/app/leasing/create/page.js` + `[id]/edit/page.js` — "Send Payment Options" checkbox.
- `frontend/src/lib/api.js` — ensure `property_ids` in email-template calls.

## Testing
- Pure resolver unit tests (`node --test`) where feasible: the fallback ordering logic
  (building-specific → catch-all → null) extracted as a pure function over rows.
- Manual DB smoke: create a Payment-Options template linked to a building, create a
  lease in that building with the checkbox ticked → confirm the email logs/sends to the
  tenant with the right template; a lease in an unlinked building → catch-all or skip.
