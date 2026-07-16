# Multi-invoice allocation in Xero reconcile

**Date:** 2026-07-16
**Status:** Approved (design)
**Area:** Accounting → Reconcile (Xero) + shared invoice-status recompute

## Problem

When a bank payment comes in through Xero reconciliation, staff sometimes need to
apply that single payment to **two (or more) invoices** — e.g. one bank transfer
settling both a rent invoice and a deposit invoice. Today the reconcile "approve"
flow links a payment to **one** invoice only: `commitPendingRow` stamps a single
`invoice_code` on the accounting header and on **all** lines. The existing "Split
into categories…" editor splits by *category*, not by *invoice*.

The data model already supports the goal — `accounting_line.invoice_code` is a
per-line column, and invoice paid/outstanding is computed by summing
`accounting_line.amount` grouped by `invoice_code`. The gap is purely in the
reconcile commit logic and UI.

## Goals

- Allocate one reconciled payment across multiple invoices, from the reconcile
  screen, with per-line amounts.
- Each affected invoice's paid/outstanding and status update correctly
  (including partial payments).
- Reuse the existing split editor and schema; minimal new surface.

## Non-goals

- No change to how Xero transactions are pulled/classified.
- No new invoice-matching heuristics that guess multi-invoice *combinations* —
  the user picks the invoices; the system only pre-filters candidates.
- Outflow (SPEND) transactions do not get invoice allocation (they don't pay
  invoices), matching today's `invoice_payment` behaviour.

## Key decisions (from brainstorming)

1. **Invoice surfacing:** pre-load the **payer's open invoices** (resolved from
   the pending row's contact name / proposed tenant), but each line's picker can
   also **search the full invoice list** (override) for payments made under a
   different name.
2. **Line amounts:** picking an invoice **auto-fills** the line with that
   invoice's outstanding balance, **editable** (supports partial payments). A
   running total shows allocated vs remaining; **Approve is disabled until the
   line amounts sum to the payment total** (±0.01).
3. **Line category:** stays a **manual, required** picker on every line (matches
   today's category-split). Category is NOT auto-derived from the invoice.
4. **Approach:** **extend the existing split editor** — one editor handles both
   category-split and multi-invoice allocation. (Rejected: separate mode;
   manual-workaround-only.)
5. **Over-allocation:** a line amount exceeding the invoice's outstanding is
   **allowed with a warning** (overpayment/credit is a real case), not blocked.

## Data model (no schema change)

A split payment is stored as:

- **One `accounting` header:** `amount` = bank total; `invoice_code` = the shared
  code if every line points at the same invoice, else **`null`** ("Multiple",
  matching how manual multi-line entries store it); `type` = inflow.
- **One `accounting_line` per allocation:** `amount`, `category` (manual),
  `invoice_code` (nullable — set from the line's chosen invoice, or null for an
  uninvoiced/category-only portion).

Invoice paid/outstanding already derives from `SUM(accounting_line.amount)`
grouped by `invoice_code`, so allocations require no new read path.

## Backend changes

### `commitPendingRow` (`backend/src/routes/xero.js`)

- Extend the `overrides.lines` shape from `{amount, category_id}` to
  `{amount, category_id, invoice_id?}`.
- When building `accounting_line` rows, resolve **each line's own** `invoice_code`
  from its `invoice_id` (look up `invoice.invoice_code` by id + org_id). A line
  with no `invoice_id` gets `invoice_code = null`.
- Header `invoice_code`: the common code if all invoice-linked lines share one
  invoice; otherwise `null`.
- Remove the single blanket `UPDATE accounting_line SET invoice_code = ? WHERE
  accounting_id = ?` (xero.js current ~847) — invoice_code is now set per line at
  insert time.
- Keep the existing split sum-to-total validation (±0.01) and the
  single-line/no-split path unchanged.
- **Backwards compatible:** an approve with no `overrides.lines` (or lines
  without `invoice_id`) behaves exactly as today.

### Invoice status recompute (shared util) — also a bug fix

- **Extract** `recalcInvoiceStatuses` (currently a private function in
  `backend/src/routes/accounting.js`, lines ~13–75) into a shared module
  `backend/src/utils/invoiceStatus.js` exporting `recalcInvoiceStatuses(conn, accountingId, orgId)`.
  `accounting.js` imports it (behaviour unchanged there).
- **Call it at the end of `commitPendingRow`**, inside the approve transaction on
  `conn`, after the lines are inserted and invoice_codes set. This makes reconcile
  correctly flip each affected invoice to Paid / Open / Overdue.
- This fixes a **pre-existing gap**: today's single-invoice reconcile approve
  never recomputes invoice status, so a reconciled invoice can stay "Open" even
  though it's been paid. Wiring the recompute in fixes both the new split path and
  the existing single path.

### Candidate-invoices endpoint

- `GET /api/xero/pending/:id/invoice-candidates?search=` (auth + `RECONCILE_PERM`).
- Without `search`: resolve the payer from the pending row (`proposed_tenant_id`
  if set, else fuzzy-match `contact_name` to a tenant) and return that tenant's
  **open invoices** (status Open/Overdue, `deleted_at IS NULL`).
- With `search`: full-list lookup across the org's open invoices by invoice code /
  tenant name / amount (the override path).
- Each row: `{ invoice_id, invoice_code, tenant_name, amount, outstanding,
  due_on, category_id, category_name }`, where `outstanding = amount −
  SUM(paid lines)`.
- Empty result (payer unresolved) is a valid response — the UI falls back to
  search.

## Frontend changes (`frontend/src/app/accounting/reconcile/page.js`)

- Extend the existing "Split into categories…" editor (rename to **"Split across
  invoices / categories"**). Per line, alongside the existing amount + category:
  - **Invoice picker** (AntD `Select`, `showSearch`): pre-loaded from the
    candidate endpoint (payer's open invoices); typing triggers the `?search=`
    lookup for the full-list override. Optional — a line can stay category-only.
  - Selecting an invoice **auto-fills the line amount** with its outstanding
    (still editable).
- **Running total** indicator: "Allocated HK$X of HK$Y — HK$Z left". **Approve
  disabled** until the lines sum to the payment total (±0.01).
- **Warnings (non-blocking):** line amount > invoice outstanding
  (over-allocation); same invoice chosen on two lines.
- Invoice allocation is only offered for **inflow** rows.
- API client: add `xero.getInvoiceCandidates(pendingId, search)` in
  `frontend/src/lib/api.js`; approve payload sends `lines: [{amount, category_id,
  invoice_id?}]`.

## Edge cases

- **Partial payment:** line amount < outstanding → invoice stays Open, outstanding
  reduced. Handled by `recalcInvoiceStatuses`.
- **Over-allocation:** allowed with warning (overpayment/credit).
- **Same invoice twice:** allowed with warning.
- **Payer not resolvable:** empty candidate list → search override; no breakage.
- **Cross-org safety:** candidate endpoint and invoice lookups filter
  `org_id = req.user.orgId`; `recalcInvoiceStatuses` already filters by org.
- **Idempotent approve / bulk approve:** unchanged; split payload flows through
  the same commit path.

## Testing

- `commitPendingRow` (multi-invoice `lines`): per-line `invoice_code` set
  correctly; header nulled when invoices differ, set when they match; sum
  validation enforced; `recalcInvoiceStatuses` flips both invoices; single-invoice
  and no-split regressions unchanged.
- `recalcInvoiceStatuses` util: partial (Open), exact (Paid), over (Paid),
  past-due unpaid (Overdue), $0 (Paid).
- Candidate endpoint: payer-resolved list, search override, org isolation, empty
  result when payer unresolved.

## Files touched

- `backend/src/routes/xero.js` — `commitPendingRow`, new candidate route.
- `backend/src/routes/accounting.js` — import shared `recalcInvoiceStatuses`.
- `backend/src/utils/invoiceStatus.js` — **new**, extracted util.
- `frontend/src/app/accounting/reconcile/page.js` — split editor extension.
- `frontend/src/lib/api.js` — candidate endpoint client + approve payload.
- Tests as above.

---

## Revision 2026-07-16 — edge-case changes (post-review)

User changed three edge cases after Tasks 1–5 were built:

1. **Over-allocation → BLOCKED** (was: allowed-with-warning). A split line may not exceed
   its invoice's current outstanding. Blocked in the UI with an explanatory popup, and
   rejected server-side (400) as defense-in-depth on the money path.
2. **Same invoice on two lines → BLOCKED** (was: allowed-with-warning). Duplicate invoice
   across split lines is blocked in the UI with a popup, and rejected server-side (400).
3. **Outflow allocation → SUPPORTED** (was: non-goal / inflow-only). The user allocates
   outgoing payments (e.g. several deposit refunds in one bank transfer). This is safe:
   `recalcInvoiceStatuses` and the invoice-list paid/outstanding are direction-agnostic
   (sum all lines by invoice_code). Two additions make it fully consistent:
   - **Direction guard on candidates:** the candidate endpoint filters `inv.type` to match
     the payment's direction (incoming → inflow invoices `type=0`; outgoing → outflow
     invoices `type=1`), so you can't cross-pay a rent invoice with an outgoing payment.
     Direction comes from a `direction` query param (UI's effective direction), falling
     back to the pending row's amount sign.
   - **Invoice PDF fix:** `backend/src/routes/pdf.js` invoice paid-sum hardcodes
     `AND a.type = 0` (inflow-only), so an outflow invoice's PDF would show $0 paid. Drop
     that filter so the PDF matches `recalcInvoiceStatuses` and the invoice list.

These are implemented as follow-up Tasks 7–9 (see the plan). Task 6 (original inflow-only,
warning-based frontend) is superseded by Task 9.
