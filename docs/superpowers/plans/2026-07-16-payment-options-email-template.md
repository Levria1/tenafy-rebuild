# Payment Options Email Templates (per-building) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `Payment-Options` email template type that can be linked to buildings (like lease templates), plus a "Send Payment Options" checkbox on lease create/edit that emails the building's template to the tenant on save.

**Architecture:** Mirror the existing lease-template→property allowlist (`property_lease_template` / `applyPropertyAllowlist`). A new `property_email_template` table links email templates to properties. A resolver picks the right Payment-Options template for a lease's building (building-specific → catch-all → none). Sending reuses `emailService.sendTemplateEmail` (already on Mailgun).

**Tech Stack:** Node 18 / Express / mysql2 (backend), Next.js 14 / Ant Design 5 (frontend). Tests use Node's built-in runner (`node --test`) — no new deps.

## Global Constraints

- `org_id` is a string end-to-end; every query filters `WHERE org_id = ?`. Active org `8300127259922432`.
- All BIGINT come back as strings from mysql2 — use `String()`/`Number()`; never `undefined` in a param (`|| null`).
- Snowflake IDs: `(BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000))).toString()`.
- Migrations go in `backend/migrations/` (auto-runner via `npm run migrate` / `migrate:orgs`); make them idempotent (`IF NOT EXISTS`).
- Routes must not repeat their mount prefix; static routes before `/:id`.
- Email templates use column `created_time` (NOT `created_at`); `template_type`, `template_content`, `is_default_template`, `status` (1=active).
- Do NOT remove existing fields/options. The property field on the email editor shows ONLY for the `Payment-Options` type.

---

### Task 1: Migration — `property_email_template` table

**Files:**
- Create: `backend/migrations/044_property_email_template.sql`

**Interfaces:**
- Produces: table `property_email_template(id, org_id, property_id, template_id, created_at)`.

- [ ] **Step 1: Create the migration file**

```sql
-- 044_property_email_template.sql
-- Links email templates to properties (building allowlist), mirroring
-- property_lease_template. Only the Payment-Options template type uses it.
CREATE TABLE IF NOT EXISTS `property_email_template` (
  `id` bigint NOT NULL,
  `org_id` bigint NOT NULL,
  `property_id` bigint NOT NULL,
  `template_id` bigint NOT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_pet_org_template` (`org_id`, `template_id`),
  KEY `idx_pet_org_property` (`org_id`, `property_id`)
);
```

- [ ] **Step 2: Apply it locally and verify**

Run: `cd backend && npm run migrate`
Expected: runs without error; migration `044_property_email_template.sql` recorded.

Run: `cd backend && node -e "require('dotenv').config(); const m=require('mysql2/promise'); m.createConnection({host:process.env.DB_HOST,user:process.env.DB_USER,password:process.env.DB_PASSWORD,database:process.env.DB_DATABASE}).then(async c=>{const [r]=await c.query('SHOW TABLES LIKE \"property_email_template\"'); console.log('table exists:', r.length===1); await c.end();})"`
Expected: `table exists: true`

- [ ] **Step 3: Commit**

```bash
git add backend/migrations/044_property_email_template.sql
git commit -m "feat(email): property_email_template table (per-building allowlist)"
```

---

### Task 2: Pure template-picker helper + unit tests (TDD)

The one piece of non-trivial logic: given candidate rows, pick the winner (default first, then newest). Extract it pure so it's testable and reused by the resolver.

**Files:**
- Create: `backend/src/utils/pickTemplate.js`
- Test: `backend/test/pickTemplate.test.js`

**Interfaces:**
- Produces: `pickTemplate(rows)` — `rows: Array<{id, is_default_template, created_time}>`. Returns the row with `is_default_template === 1` (or `'1'`/truthy) if any, else the newest by `created_time`, else `null` for an empty/nullish array.

- [ ] **Step 1: Write the failing test**

```javascript
// backend/test/pickTemplate.test.js
const test = require('node:test');
const assert = require('node:assert');
const { pickTemplate } = require('../src/utils/pickTemplate');

test('pickTemplate: null/empty -> null', () => {
  assert.strictEqual(pickTemplate(null), null);
  assert.strictEqual(pickTemplate([]), null);
});

test('pickTemplate: prefers is_default_template', () => {
  const rows = [
    { id: '1', is_default_template: 0, created_time: '2026-02-01' },
    { id: '2', is_default_template: 1, created_time: '2026-01-01' },
  ];
  assert.strictEqual(pickTemplate(rows).id, '2');
});

test('pickTemplate: no default -> newest by created_time', () => {
  const rows = [
    { id: '1', is_default_template: 0, created_time: '2026-01-01' },
    { id: '2', is_default_template: 0, created_time: '2026-03-01' },
  ];
  assert.strictEqual(pickTemplate(rows).id, '2');
});

test('pickTemplate: handles string/buffer-ish default flag', () => {
  const rows = [
    { id: '1', is_default_template: '0', created_time: '2026-01-01' },
    { id: '2', is_default_template: '1', created_time: '2026-01-01' },
  ];
  assert.strictEqual(pickTemplate(rows).id, '2');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && node --test test/pickTemplate.test.js`
Expected: FAIL — `Cannot find module '../src/utils/pickTemplate'`.

- [ ] **Step 3: Write the implementation**

```javascript
// backend/src/utils/pickTemplate.js
// Pick the winning template from candidate rows: an explicit default first,
// otherwise the newest by created_time. Pure — no DB.
function isDefault(v) {
  if (Buffer.isBuffer(v)) return v[0] === 1;
  return v === 1 || v === '1' || v === true;
}

function pickTemplate(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const def = rows.find(r => isDefault(r.is_default_template));
  if (def) return def;
  return rows.slice().sort((a, b) =>
    String(b.created_time || '').localeCompare(String(a.created_time || '')))[0];
}

module.exports = { pickTemplate };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && node --test test/pickTemplate.test.js`
Expected: PASS — `# pass 4`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add backend/src/utils/pickTemplate.js backend/test/pickTemplate.test.js
git commit -m "feat(email): pure pickTemplate helper (default-first, else newest)"
```

---

### Task 3: Register `Payment-Options` type + `resolvePaymentOptionsTemplate` (emailService)

**Files:**
- Modify: `backend/src/services/emailService.js` — `TEMPLATE_TYPES` array (~line 47) and add a resolver + export it.

**Interfaces:**
- Consumes: `pickTemplate` (Task 2).
- Produces: `resolvePaymentOptionsTemplate(pool, orgId, propertyId)` → resolved `email_template` row (or `null`). Also `Payment-Options` present in `TEMPLATE_TYPES`.

- [ ] **Step 1: Register the type.** In `TEMPLATE_TYPES` (the array starting ~line 47), add after the `Receipt-Tenant` line:

```javascript
  { value: 'Payment-Options', label: 'Payment Options (Tenant)' },
```

- [ ] **Step 2: Add the resolver + require.** Near the top of `emailService.js` add the require (with the other requires):

```javascript
const { pickTemplate } = require('../utils/pickTemplate');
```

Then add this function above `module.exports` (and add `resolvePaymentOptionsTemplate` to the exports object):

```javascript
// Resolve the Payment-Options email template for a building:
//   1) a template explicitly linked to this property (via property_email_template)
//   2) else a catch-all Payment-Options template (no property_email_template rows)
//   3) else null (caller skips sending)
async function resolvePaymentOptionsTemplate(pool, orgId, propertyId) {
  // 1) building-specific
  const [linked] = await pool.execute(
    `SELECT et.id, et.is_default_template, et.created_time
       FROM email_template et
       JOIN property_email_template pet ON pet.template_id = et.id AND pet.org_id = et.org_id
      WHERE et.org_id = ? AND pet.property_id = ?
        AND et.template_type = 'Payment-Options' AND et.status = 1`,
    [orgId, propertyId]
  );
  const specific = pickTemplate(linked);
  if (specific) return specific;

  // 2) catch-all: Payment-Options templates with NO property links
  const [catchAll] = await pool.execute(
    `SELECT et.id, et.is_default_template, et.created_time
       FROM email_template et
      WHERE et.org_id = ? AND et.template_type = 'Payment-Options' AND et.status = 1
        AND NOT EXISTS (
          SELECT 1 FROM property_email_template pet
           WHERE pet.template_id = et.id AND pet.org_id = et.org_id
        )`,
    [orgId]
  );
  return pickTemplate(catchAll);
}
```

Add to the `module.exports = { ... }` object: `resolvePaymentOptionsTemplate,`

- [ ] **Step 3: Sanity-check the module loads**

Run: `cd backend && node -e "const e=require('./src/services/emailService'); console.log('resolver:', typeof e.resolvePaymentOptionsTemplate); console.log('type registered:', e.TEMPLATE_TYPES ? e.TEMPLATE_TYPES.some(t=>t.value==='Payment-Options') : 'TEMPLATE_TYPES not exported')"`
Expected: `resolver: function` and `type registered: true` (if `TEMPLATE_TYPES` is exported; if it isn't exported, instead grep to confirm the line was added: `grep -c "Payment-Options" src/services/emailService.js` → ≥1).

- [ ] **Step 4: Commit**

```bash
git add backend/src/services/emailService.js
git commit -m "feat(email): Payment-Options type + resolvePaymentOptionsTemplate (per-building)"
```

---

### Task 4: Email-template CRUD carries the property allowlist (`emailTemplate.js`)

**Files:**
- Modify: `backend/src/routes/emailTemplate.js` — add allowlist helpers; wire into create (POST), update (PUT `/:id`), get (GET `/:id`), delete.

**Interfaces:**
- Consumes: nothing new.
- Produces: create/update accept `property_ids` (array of property id strings, optional); GET `/:id` returns `property_ids`.

- [ ] **Step 1: Add the allowlist helpers** near the top of `emailTemplate.js` (after the requires), mirroring the lease-template ones but against `property_email_template`:

```javascript
// Email-template → property allowlist (property_email_template). Only the
// Payment-Options type uses this. undefined = leave untouched; [] = clear.
async function applyEmailPropertyAllowlist(pool, orgId, templateId, propertyIds) {
  if (!Array.isArray(propertyIds)) return;
  const ids = [...new Set(propertyIds.map(String).filter(Boolean))];
  await pool.execute(
    `DELETE FROM property_email_template WHERE org_id = ? AND template_id = ?`,
    [orgId, templateId]
  );
  for (const pid of ids) {
    const rid = (BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000))).toString();
    await pool.execute(
      `INSERT INTO property_email_template (id, org_id, property_id, template_id) VALUES (?, ?, ?, ?)`,
      [rid, orgId, pid, templateId]
    );
  }
}

async function getEmailAllowedProperties(pool, orgId, templateId) {
  const [rows] = await pool.execute(
    `SELECT property_id FROM property_email_template WHERE org_id = ? AND template_id = ?`,
    [orgId, templateId]
  );
  return rows.map(r => String(r.property_id));
}
```

- [ ] **Step 2: Wire into create + update + get + delete.**
  - In the **POST /** (create) handler: read `property_ids` from `req.body`; after the template row is inserted (you have its new id), call `await applyEmailPropertyAllowlist(req.pool, orgId, <newId>, property_ids);`
  - In the **PUT /:id** (update) handler: after the `UPDATE`, call `await applyEmailPropertyAllowlist(req.pool, orgId, req.params.id, req.body.property_ids);`
  - In the **GET /:id** handler: after loading the row, add `row.property_ids = await getEmailAllowedProperties(req.pool, orgId, req.params.id);`
  - In the **DELETE /:id** handler: before/after deleting the template, `await req.pool.execute('DELETE FROM property_email_template WHERE org_id = ? AND template_id = ?', [orgId, req.params.id]);`

(Locate each handler by its route method; the create insert already generates a template id — reuse that variable. If the create uses `INSERT ... ` with a generated snowflake id in a variable, pass that variable.)

- [ ] **Step 3: Sanity-check parse**

Run: `cd backend && node -e "require('./src/routes/emailTemplate.js'); console.log('ok')"`
Expected: `ok`.

- [ ] **Step 4: Manual smoke (local backend running).** Create a Payment-Options template with `property_ids`, then GET it back:
```bash
# create
curl -s -X POST http://localhost:3001/api/email-template -H 'Content-Type: application/json' -b "__s_t=<JWT>" \
  -d '{"name":"PayOpt Bldg A","type":"Payment-Options","subject":"How to pay","body":"<p>Bank: X</p>","status":1,"property_ids":["<propId>"]}'
# get it back (use the returned id) — expect property_ids: ["<propId>"]
curl -s -b "__s_t=<JWT>" http://localhost:3001/api/email-template/<id> | grep -o '"property_ids":\[[^]]*\]'
```
Expected: the GET returns `property_ids` containing `<propId>`. Clean up the test template after.

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/emailTemplate.js
git commit -m "feat(email): email templates carry per-building property allowlist"
```

---

### Task 5: Send Payment Options on lease create/edit (`leasing.js`)

**Files:**
- Modify: `backend/src/routes/leasing.js` — the create (POST `/`) and edit (PUT `/:id`) handlers.

**Interfaces:**
- Consumes: `resolvePaymentOptionsTemplate` + `sendTemplateEmail` from emailService.
- Reads `send_payment_options` (boolean) from the request body.

- [ ] **Step 1: Ensure the resolver is imported.** In the `require('../services/emailService')` destructure at the top of `leasing.js`, add `resolvePaymentOptionsTemplate` alongside `sendTemplateEmail`:

```javascript
const {
  sendTemplateEmail,
  resolvePaymentOptionsTemplate,
  // ...existing imports...
} = require('../services/emailService');
```

- [ ] **Step 2: Add a fire-and-forget helper** (top-level in `leasing.js`, after the requires):

```javascript
// Send the building's Payment-Options email to the lease's tenant. Never throws.
async function maybeSendPaymentOptions(pool, orgId, leaseId) {
  try {
    const [[row]] = await pool.execute(
      `SELECT u.property_id AS property_id
         FROM leasing l JOIN unit u ON l.unit_id = u.id
        WHERE l.id = ? AND l.org_id = ? LIMIT 1`,
      [leaseId, orgId]
    );
    if (!row || !row.property_id) return;
    const tpl = await resolvePaymentOptionsTemplate(pool, orgId, String(row.property_id));
    if (!tpl) { console.warn(`[PaymentOptions] no template for property ${row.property_id} — skipped`); return; }
    await sendTemplateEmail(pool, orgId, { templateType: 'Payment-Options', templateId: String(tpl.id), leaseId: String(leaseId) });
  } catch (err) {
    console.error('[PaymentOptions] send failed:', err.message);
  }
}
```

(Note: `leasing.id`/`unit.property_id` — if `leasing` has no `org_id` column, drop `AND l.org_id = ?` and instead filter the property via the unit/join as the surrounding code does; match the existing create handler's own org scoping.)

- [ ] **Step 3: Call it from create + edit.**
  - In the **POST /** create handler, after the lease is successfully inserted and its id known (where the response is built / where `send_for_esignature` is handled), add:
    ```javascript
    if (req.body.send_payment_options) { maybeSendPaymentOptions(req.pool, req.user.orgId, String(<newLeaseId>)); }
    ```
    (fire-and-forget — do NOT `await` in a way that blocks the response; matching how other post-save emails fire.)
  - In the **PUT /:id** edit handler, after the update succeeds, add:
    ```javascript
    if (req.body.send_payment_options) { maybeSendPaymentOptions(req.pool, req.user.orgId, String(req.params.id)); }
    ```

- [ ] **Step 4: Sanity-check parse**

Run: `cd backend && node -e "require('./src/routes/leasing.js'); console.log('ok')"`
Expected: `ok`.

- [ ] **Step 5: Manual smoke (local backend + a Payment-Options template linked to a building).** Create a lease in that building with `send_payment_options: true` in the payload, then check the backend log for `[EmailService] Sending type=Payment-Options ...` (or `[PaymentOptions] no template ... skipped` if unlinked). Confirm no error and the lease still creates.

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/leasing.js
git commit -m "feat(lease): send Payment Options email to tenant on create/edit when checkbox set"
```

---

### Task 6: Frontend — property multi-select on email editor (Payment-Options only)

**Files:**
- Modify: `frontend/src/app/settings/email-templates/create/page.js` and `frontend/src/app/settings/email-templates/[id]/edit/page.js`.

**Interfaces:**
- Consumes: property list (there's already a property fetch pattern used elsewhere, e.g. `property.all()` in api.js — reuse it). Sends `property_ids` in the create/update payload.

- [ ] **Step 1: Load properties + track the selected type.** In each page, add state for the property list and fetch it on mount (mirror how other pages load properties — `const res = await property.all(); setProperties(res.data.data || [])`). Track the currently-selected template type (the form already has a type field).

- [ ] **Step 2: Render the multi-select, conditional on type.** Where the form fields are, add — rendered only when the selected type is `Payment-Options`:

```jsx
{selectedType === 'Payment-Options' && (
  <Form.Item name="property_ids" label="Available for these properties"
    tooltip="Which buildings this Payment Options email applies to. Leave empty = applies to any building without a specific one.">
    <Select mode="multiple" allowClear showSearch optionFilterProp="label"
      placeholder="All buildings (leave empty for catch-all)"
      options={properties.map(p => ({ label: p.display_name, value: String(p.id) }))} />
  </Form.Item>
)}
```

- [ ] **Step 3: Include `property_ids` in submit + initial load.**
  - On submit, ensure the payload includes `property_ids: values.property_ids || []` (create + update).
  - On the edit page, when loading the template, set the form's `property_ids` from the GET response (`form.setFieldsValue({ property_ids: (data.property_ids || []).map(String) })`).

- [ ] **Step 4: Verify build**

Run: `cd frontend && npx next build 2>&1 | tail -20`
Expected: builds cleanly for `settings/email-templates/*`. (Fallback: the build validates syntax; a pre-existing unrelated error elsewhere should be distinguished and reported.)

- [ ] **Step 5: Commit**

```bash
git add "frontend/src/app/settings/email-templates/create/page.js" "frontend/src/app/settings/email-templates/[id]/edit/page.js"
git commit -m "feat(email): per-building property multi-select on Payment-Options templates"
```

---

### Task 7: Frontend — "Send Payment Options" checkbox on lease forms

**Files:**
- Modify: `frontend/src/app/leasing/create/page.js` and `frontend/src/app/leasing/[id]/edit/page.js`.

**Interfaces:**
- Adds a `send_payment_options` boolean to the lease create/update payload (the form already submits all values).

- [ ] **Step 1: Add the checkbox** to the create-lease form, placed with the other lease checkboxes (e.g. in the E-Signature card or near the Email Notifications section). Use the same `Form.Item`/`Checkbox` pattern already in the file:

```jsx
<Form.Item name="send_payment_options" valuePropName="checked" style={{ marginBottom: 0 }}>
  <Checkbox>Send Payment Options email to tenant on save</Checkbox>
</Form.Item>
```

- [ ] **Step 2: Same checkbox on the edit-lease form**, placed with its lease checkboxes. Same `Form.Item name="send_payment_options" valuePropName="checked"` markup.

- [ ] **Step 3: Confirm it rides along in submit.** The lease create/edit submit sends the whole form values object, so `send_payment_options` is included automatically. If the page maps specific fields into the payload (rather than spreading `values`), add `send_payment_options: values.send_payment_options || false` to that payload for both create and edit.

- [ ] **Step 4: Verify build**

Run: `cd frontend && npx next build 2>&1 | tail -20`
Expected: builds cleanly for `leasing/create` and `leasing/[id]/edit`.

- [ ] **Step 5: Commit**

```bash
git add "frontend/src/app/leasing/create/page.js" "frontend/src/app/leasing/[id]/edit/page.js"
git commit -m "feat(lease): Send Payment Options checkbox on create/edit lease forms"
```

---

## Self-Review

**Spec coverage:**
- New `Payment-Options` type → Task 3. ✓
- `property_email_template` table → Task 1. ✓
- Allowlist helpers + CRUD carries `property_ids` → Task 4. ✓
- Resolver (building-specific → catch-all → null) → Task 3 (+ pure picker Task 2). ✓
- "Send Payment Options" checkbox on create/edit → Task 7; send wiring → Task 5. ✓
- Property multi-select on editor, Payment-Options only → Task 6. ✓
- Reuse emailService/Mailgun, no new variables → Task 5 uses `sendTemplateEmail`. ✓
- Fallback skip + never block lease save → Task 5 `maybeSendPaymentOptions` try/catch + fire-and-forget. ✓
- Cross-org filtering + snowflake ids → Tasks 1/4 (ids), all queries filter org. ✓

**Placeholder scan:** No TBD/TODO. Two "locate the handler / match existing org scoping" notes (Tasks 4, 5) are precise navigation instructions, not placeholders — the code to add is fully given.

**Type consistency:** `pickTemplate(rows)` (Task 2) consumed in Task 3; `resolvePaymentOptionsTemplate(pool,orgId,propertyId)` (Task 3) consumed in Task 5; `property_ids` string[] consistent across Tasks 4/6; `send_payment_options` boolean consistent across Tasks 5/7. ✓

**Flagged for implementers:** In Task 5, confirm `sendTemplateEmail` with `templateType:'Payment-Options'` resolves the recipient to the **tenant** (role-based resolution keys off the `-Landlord` suffix; a non-`-Landlord` type defaults to tenant). If it does not, pass `toOverride` = the tenant's email (fetch via the lease→tenant join). Note this in the Task 5 report.
