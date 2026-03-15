# Email Send UI — Implementation Plan

## Overview
Upgrade the Send Email page and add "Send Email" buttons across the app, matching the original Tenafy system.

---

## Step 1: Rebuild `/contacts/email/send` page

The current page is a basic form. Rebuild it to match the original:

**Frontend** (`frontend/src/app/contacts/email/send/page.js`):
- **Template dropdown** (searchable Select) — loads all active templates via `emailTemplate.getAll()`
  - On template select: auto-fills Subject, Body (HTML), CC, BCC, Reply To
- **To field** — pre-filled based on URL `?category=` param:
  - `?category=tenant&id=123` → single tenant email
  - `?category=tenants` → all tenant emails (bulk)
  - `?category=tenantLeases&id=123` → single tenant (from lease context)
  - `?category=group&id=456` → group member emails
  - `?category=invoice&invoiceId=789&leaseId=111` → tenant from invoice's lease
- **From field** — pre-filled from logged-in user's email (disabled)
- **Reply To, CC, BCC** — from template, editable
- **Subject** — from template, editable
- **Body** — Rich text editor (ReactQuill), from template, editable with variable placeholders visible
- **Send button** — calls backend `/api/email-template/send` with `{ templateId, leaseId, toOverride, category, dueDate, invoiceCode }`

**Backend** (`backend/src/routes/emailTemplate.js`):
- Update `POST /send` to accept `toOverride` as comma/semicolon-separated emails and send to each
- For each recipient: resolve variables from the lease context, substitute, send
- The existing `sendTemplateEmail()` already handles single sends — we'll loop for multiple recipients

**API client** (`frontend/src/lib/api.js`):
- Already has `emailTemplate.send()` — no changes needed
- Add `emailTemplate.getAll()` if not already there (for template dropdown)

---

## Step 2: Add "Send Email" / "Resend" buttons

### 2a. Invoice detail drawer (invoices/page.js)
- Add a **"Send"** or **"Resend"** button in the invoice detail drawer footer (next to Print/Edit/Delete)
- On click: navigate to `/contacts/email/send?category=invoice&invoiceId={id}&leaseId={leaseId}`
- The send page will pre-fill the tenant email and use the Invoice-Tenant template

### 2b. Tenant list (contacts/tenants/page.js)
- Add an **"Email"** icon/button on each tenant row
- On click: navigate to `/contacts/email/send?category=tenant&id={tenantId}`

### 2c. Tenant detail — Leases tab (contacts/tenant/[id]/detail/page.js)
- Add **"Send Email"** button in the lease section
- On click: navigate to `/contacts/email/send?category=tenantLeases&id={tenantId}&leaseId={leaseId}`

### 2d. Template edit page (settings/email-templates/[id]/edit/page.js)
- Add **"Send Test"** button
- On click: calls `emailTemplate.send({ templateId, toOverride: userEmail })` to send a test with sample variables
- Shows success/failure toast

---

## Step 3: Install ReactQuill for rich text editing

```bash
cd frontend && npm install react-quill-new
```

Use `react-quill-new` (Next.js 14 compatible fork) with dynamic import to avoid SSR issues.

---

## Files to modify:
1. `frontend/src/app/contacts/email/send/page.js` — Complete rewrite
2. `frontend/src/app/invoices/page.js` — Add Send button to invoice drawer
3. `frontend/src/app/contacts/tenants/page.js` — Add Email button per row
4. `frontend/src/app/contacts/tenant/[id]/detail/page.js` — Add Send Email to leases
5. `frontend/src/app/settings/email-templates/[id]/edit/page.js` — Add Send Test button
6. `frontend/src/lib/api.js` — Add any missing API methods
7. `backend/src/routes/emailTemplate.js` — Update send endpoint for multi-recipient + invoice context
