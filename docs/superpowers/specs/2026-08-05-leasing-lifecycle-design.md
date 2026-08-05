# Leasing lifecycle: stamped terms, early move-outs, write-offs, calendar states

Date: 2026-08-05
Status: Draft — for review

## Problem

Four real-world leasing situations aren't representable today:

1. **Government-stamped 2-year term vs actual short stay.** For certain contracts the government requires a 2-year tenancy agreement to be stamped, even though the tenant only stays ~2 months. Putting the 2-year date in the lease breaks vacancy/invoicing/expiry; putting the short date breaks the paperwork.
2. **Early move-out requests.** A tenant asks to leave before their end date; there's no way to track the request or execute the move-out cleanly.
3. **Uncollectable invoices.** A tenant has moved out owing money that's impossible to chase — the invoice should still be visible/owed but must not inflate "outstanding due".
4. **Re-lease on actual move-out.** When a tenant actually leaves, the unit should free up for re-leasing even if the paper term runs longer.

## Locked decisions (from brainstorming)

- The **operational** dates (`leasing.start_date`/`end_date`) always drive vacancy, invoicing, expiry, and calendar. The stamped 2-year term is **document-only**.
- The stamped term is **paperwork only** (agreed early exit) — invoicing follows the actual stay. Not binding for rent.
- Only the **legal term** is tracked for now — no stamp-duty/stamp-certificate data yet.
- Uncollectable invoices get a **new status "Written off"** but stay **visible** (tagged) and are **excluded from outstanding-due totals + aging**.
- Early move-out = a **full request log** (history), and the **execute/move-out** step reconciles the ledger and lets staff choose how to close out the money **per situation**.
- #4 needs no dedicated work — it falls out of `end_date` being the real move-out date.

---

## Project A — Stamped contract term (document-only override)

Nothing operational changes. Only the **signed contract PDF** shows a different (longer) term. The override lives at the e-signature step, not on the lease.

**Data**
- `signature_request.contract_end_date DATE NULL` (per-org migration). (`contract_start_date DATE NULL` optional — end-only for v1.)

**UI**
- On the **review-and-send page** (`frontend/src/app/leasing/[id]/review-and-send/page.js`): an optional field **"Contract end date — document only"**, defaulting to the lease's real `end_date`. Helper text: "Only set this when the government requires a longer stamped term than the actual stay."

**Render**
- `leasePdfRenderer.renderFromTemplate({ ..., contractDates })` merges the override into `ctx.lease` before variable resolution, so `{{LEASE_END}}`, `{{LEASE_END_SHORT}}`, `{{LEASE_TERM_MONTHS}}` reflect the stamped term. The e-sign render path reads the override from `signature_request`; every other render (View Lease, previews) uses the real dates.

**Untouched:** vacancy, invoicing, expiry alerts, calendar — all keep reading `leasing.end_date`.

---

## Project C — Uncollectable / Written-off invoices

(Built before B, because B reuses it.)

**Data**
- `invoice.status` gains value **`3 = Written off`** (existing: 0 Open, 1 Paid, 2 Overdue).
- `invoice.written_off_at TIMESTAMP NULL`, `invoice.written_off_reason VARCHAR(255) NULL` (per-org migration).

**Behavior**
- **Excluded from every "outstanding due" total + aging.** Audit and update each call site that sums/filters outstanding (dashboard widgets, tenant profile balance, invoice-list "outstanding" totals, overdue scheduler, reports). Written-off = not Open, not Overdue, not Paid.
- **Still visible** in invoice lists and the tenant ledger, rendered with a grey **"Written off"** tag and the reason on hover.
- The overdue auto-updater must **skip** written-off invoices.

**Actions**
- **Single**: "Mark uncollectable / Write off" on an invoice row / detail drawer (optional reason). Reversible ("Restore" → recompute Open/Overdue from `due_on`).
- **Bulk**: the invoice list gains **row selection** (`rowSelection`) + a **"Write off"** button shown when rows are selected → confirm dialog (optional shared reason) → bulk endpoint sets `status=3` on all selected Open/Overdue invoices in the org.
- Also invokable from a **tenant's profile** invoice list and from the **move-out reconciliation** (Project B).
- Endpoints: `POST /api/invoice/:id/write-off {reason}`, `POST /api/invoice/:id/restore`, `POST /api/invoice/write-off-bulk {ids[], reason}`. Permission-gated like other invoice writes; org-scoped; `deleted_at IS NULL`.

---

## Project B — Early move-out (request log + execute)

Two distinct actions: **log a request** (intent, pending) and **execute the move-out** (reconcile + set date).

**Data**
- New per-org table **`lease_moveout_request`**:
  `id, org_id, leasing_id, requested_date DATE, reason TEXT, status ENUM('requested','approved','declined','cancelled'), original_end_date DATE (snapshot of end_date at request time — makes "early" detectable/auditable), requested_by, created_at, decided_by, decided_at, decision_note`.

**Request (pending)**
- "Request early move-out" action on the lease detail → captures requested_date + reason → row with `status='requested'`, snapshots `original_end_date`. No date/invoice change yet.
- A **pending-requests filter/badge** on the Leases list, and the calendar marker (Project D).

**Execute / Move out (the reconciliation flow)**
Triggered by approving a request, or a direct "Move out" action. Opens a dialog:
1. **Move-out date** (default: requested date, or today).
2. **Ledger reconciliation at that date** (read-only summary):
   - Paid-through date vs move-out date → **paid ahead** (overpaid amount) or **owes** (gap + unpaid invoices ≤ move-out).
   - **Future invoices** dated > move-out (already issued).
3. **Decisions** (per situation):
   - If owed a partial final period → optional **"Generate final prorated invoice"** (move-out date).
   - **Outstanding invoices** (unpaid ≤ move-out) → Keep outstanding / **Write off** (Project C) / Void.
   - **Future invoices** (> move-out) → Void / Keep.
   - **Overpayment** (paid past move-out) → Refund / Convert to credit / Keep (no action). *(Refund = existing deposit-refund-style outflow invoice; credit = `leasing.credits`/`utility_credit` — TBD which, see Open Questions.)*
4. **Apply** → set `leasing.end_date = move-out date`; mark the request `approved` with `decided_by/at`; perform the chosen invoice actions in one transaction.

**Worked example (today Aug 5; paid through Aug 31; end_date Aug 31; move out Aug 5):**
- Reconciliation shows: paid ahead ~26 days (HK$X); no outstanding; no future invoices.
- Only decision offered: overpayment → Refund / Credit / Keep.
- Apply → `end_date = Aug 5`, unit frees up, invoicing stops. Nothing auto-issued.

**Contrast (paid only through Jul 31; move out Aug 5):** reconciliation shows an Aug 1–5 gap + any unpaid invoices → offers a final prorated invoice (Aug 1–5) and keep/write-off/void for the rest.

---

## Project D — Calendar status badges

On the leasing calendar (`frontend/src/app/leasing/calendar/`), decorate each lease block + a legend:

- **Unconfirmed** — `lease_state='pending'` or `signature_status IN ('none','pending')`.
- **Deposit pending** — the lease's deposit invoice is unpaid (derive: deposit-category invoice for the lease not `status=1`).
- **Early move-out requested** — an open `lease_moveout_request` (status='requested'); amber marker + tooltip with requested date.
- **Moved out early** — an `approved` move-out request whose `requested_date < original_end_date`; distinct end-cap/colour + tooltip (original → actual).

Backend: the calendar leases endpoint returns these four flags per lease so the frontend renders markers without extra calls.

---

## Migrations (per-org, `npm run migrate:orgs`)

1. `signature_request.contract_end_date` (Project A).
2. `invoice.written_off_at`, `invoice.written_off_reason`; document `status=3` (Project C).
3. `lease_moveout_request` table (Project B).

No master-schema changes.

## Build order

**D → C → A → B** (easy → hard; C is reused by B). Each project: migration + backend + frontend, Kimi-reviewed, deployed and verified before the next.

## Open questions

1. **Overpayment "credit"** — refund is clear (deposit-refund-style outflow). For "convert to credit", do we use `leasing.credits`/`utility_credit`, or just leave the paid invoices as-is and note it? (Lean: Keep/Refund for v1; credit later.)
2. **Prorated final invoice** — day-based proration of the monthly rent, or a manual amount staff type? (Lean: prefill day-based, staff can edit.)
3. **Permissions** — reuse `LANDLORD/ACCOUNTING_CREATE` for write-offs and `LANDLORD/LEASING_*` for move-outs? (Lean: yes.)
