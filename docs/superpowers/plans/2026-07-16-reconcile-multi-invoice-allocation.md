# Multi-invoice allocation in Xero reconcile — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one reconciled Xero payment be split across multiple invoices from the reconcile screen, with each invoice's status/outstanding updating correctly.

**Architecture:** Extend the existing category-split path. Each `accounting_line` already has an `invoice_code` column, so a split payment = one `accounting` header (amount = bank total, `invoice_code` = shared code or null) + one `accounting_line` per allocation (amount, category, optional invoice_code). Pure helpers decide the header code and validate totals; a shared `recalcInvoiceStatuses` recomputes each affected invoice's status inside the approve transaction.

**Tech Stack:** Node 18 / Express / mysql2 (backend), Next.js 14 / Ant Design 5 (frontend). Tests use Node's built-in runner (`node --test`, `node:test` + `node:assert`) — **no new dependencies**.

## Global Constraints

- `org_id` is a string end-to-end; every query filters `WHERE org_id = ?` (legacy dumps hold multiple tenants per DB). Copy verbatim: active org is `8300127259922432`.
- All BIGINT values come back as strings from mysql2 — compare with `String()`/`Number()` as appropriate; never `undefined` in a param (use `|| null` / `?? null`).
- Snowflake IDs: `(BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000))).toString()`.
- Routes are mounted at `/api/integrations/xero` (in `index.js`); route paths inside `xero.js` must NOT repeat the prefix. Static routes before dynamic `/:id`.
- All Xero write routes require `requirePermission('LANDLORD/ACCOUNTING_CREATE')` (the `RECONCILE_PERM` constant in `xero.js`).
- Currency display is HK$; amounts compared with a ±0.01 tolerance.
- Do NOT remove existing fields/options. Backwards compatibility: an approve with no `overrides.lines` must behave exactly as today.

---

### Task 1: Extract `recalcInvoiceStatuses` into a shared util

Refactor only — no behaviour change. Moves the private function out of `accounting.js` so `xero.js` can call it. It uses `.execute`, so it works with either a pool or a transaction connection.

**Files:**
- Create: `backend/src/utils/invoiceStatus.js`
- Modify: `backend/src/routes/accounting.js:13-75` (remove inline definition), and its `require` block near the top.

**Interfaces:**
- Produces: `recalcInvoiceStatuses(db, accountingId, orgId)` where `db` is a mysql2 pool **or** connection (both expose `.execute`). Recomputes status (0=Open, 1=Paid, 2=Overdue) for every invoice referenced by that accounting entry's lines/header. Returns `Promise<void>`.

- [ ] **Step 1: Create the util file** — copy the existing function body verbatim from `accounting.js:13-75`, renaming the first param `pool` → `db`.

```javascript
// backend/src/utils/invoiceStatus.js
// Recalculate invoice status after payment changes. Finds all invoices linked to
// accounting_lines (and the header) of the given transaction, then updates each
// invoice's status from total payments vs amount vs due date.
// `db` may be a pool or a transaction connection — both expose .execute().
async function recalcInvoiceStatuses(db, accountingId, orgId) {
  if (!orgId) {
    const [[acct]] = await db.execute('SELECT org_id FROM accounting WHERE id = ?', [accountingId]);
    if (!acct) return;
    orgId = acct.org_id;
  }

  const [lines] = await db.execute(
    `SELECT DISTINCT al.invoice_code
     FROM accounting_line al
     WHERE al.accounting_id = ? AND al.invoice_code IS NOT NULL AND al.invoice_code != ''`,
    [accountingId]
  );
  const [[header]] = await db.execute(
    'SELECT invoice_code FROM accounting WHERE id = ?',
    [accountingId]
  );
  const codes = new Set(lines.map(l => l.invoice_code));
  if (header && header.invoice_code) codes.add(header.invoice_code);

  for (const invoiceCode of codes) {
    const [invoices] = await db.execute(
      'SELECT id, amount, due_on, status FROM invoice WHERE invoice_code = ? AND org_id = ? AND deleted_at IS NULL LIMIT 1',
      [invoiceCode, orgId]
    );
    if (invoices.length === 0) continue;
    const invoice = invoices[0];

    const [[{ total_paid }]] = await db.execute(
      `SELECT COALESCE(SUM(al.amount), 0) as total_paid
       FROM accounting_line al
       JOIN accounting a ON al.accounting_id = a.id
       WHERE al.invoice_code = ? AND a.org_id = ? AND a.deleted_at IS NULL AND al.deleted_at IS NULL`,
      [invoiceCode, orgId]
    );

    const amount = parseFloat(invoice.amount) || 0;
    const paid = parseFloat(total_paid) || 0;
    const today = new Date().toISOString().split('T')[0];
    const dueOn = invoice.due_on ? new Date(invoice.due_on).toISOString().split('T')[0] : null;
    const isPastDue = dueOn && today > dueOn;

    let newStatus;
    if (amount <= 0 || paid >= amount) newStatus = 1;        // Paid
    else if (isPastDue) newStatus = 2;                        // Overdue
    else newStatus = 0;                                       // Open

    if (Number(invoice.status) !== newStatus) {
      await db.execute('UPDATE invoice SET status = ? WHERE id = ?', [newStatus, invoice.id]);
    }
  }
}

module.exports = { recalcInvoiceStatuses };
```

- [ ] **Step 2: Update `accounting.js`** — delete the inline `async function recalcInvoiceStatuses(...) { ... }` (lines ~13-75) and add the import near the other requires at the top of the file:

```javascript
const { recalcInvoiceStatuses } = require('../utils/invoiceStatus');
```

Leave the two existing call sites (`accounting.js:326` and `:535`) unchanged — they still call `recalcInvoiceStatuses(req.pool, ...)`.

- [ ] **Step 3: Verify the module loads and nothing else references the old symbol**

Run: `cd backend && node -e "require('./src/routes/accounting.js'); require('./src/utils/invoiceStatus.js'); console.log('ok')"`
Expected: prints `ok` (no "recalcInvoiceStatuses is not defined").

Run: `cd backend && grep -n "async function recalcInvoiceStatuses" src/routes/accounting.js || echo "inline def removed"`
Expected: `inline def removed`.

- [ ] **Step 4: Commit**

```bash
git add backend/src/utils/invoiceStatus.js backend/src/routes/accounting.js
git commit -m "refactor(accounting): extract recalcInvoiceStatuses to shared util"
```

---

### Task 2: Pure split helpers + unit tests (TDD)

Two pure functions that carry the split logic, unit-tested with `node --test`. No DB, no Express.

**Files:**
- Create: `backend/src/utils/reconcileSplit.js`
- Test: `backend/test/reconcileSplit.test.js`

**Interfaces:**
- Produces:
  - `resolveHeaderInvoiceCode(lines)` — `lines: Array<{invoice_code?: string|null}>`. Returns the single shared code as a string if **every** line has the **same** non-empty `invoice_code`; otherwise `null` (mixed, or any line uninvoiced).
  - `validateSplitTotal(lines, total)` — `lines: Array<{amount:number}>`, `total:number`. Returns `{ ok: boolean, sum: number }`; `ok` is true when `Math.abs(sum - total) < 0.01`.

- [ ] **Step 1: Write the failing test**

```javascript
// backend/test/reconcileSplit.test.js
const test = require('node:test');
const assert = require('node:assert');
const { resolveHeaderInvoiceCode, validateSplitTotal } = require('../src/utils/reconcileSplit');

test('resolveHeaderInvoiceCode: all lines same code -> that code', () => {
  assert.strictEqual(
    resolveHeaderInvoiceCode([{ invoice_code: 'TRIV1' }, { invoice_code: 'TRIV1' }]),
    'TRIV1'
  );
});

test('resolveHeaderInvoiceCode: mixed codes -> null', () => {
  assert.strictEqual(
    resolveHeaderInvoiceCode([{ invoice_code: 'TRIV1' }, { invoice_code: 'TRIV2' }]),
    null
  );
});

test('resolveHeaderInvoiceCode: any uninvoiced line -> null', () => {
  assert.strictEqual(
    resolveHeaderInvoiceCode([{ invoice_code: 'TRIV1' }, { invoice_code: null }]),
    null
  );
});

test('resolveHeaderInvoiceCode: no invoices at all -> null', () => {
  assert.strictEqual(resolveHeaderInvoiceCode([{ invoice_code: null }, {}]), null);
});

test('validateSplitTotal: exact match ok', () => {
  const r = validateSplitTotal([{ amount: 11000 }, { amount: 5000 }], 16000);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.sum, 16000);
});

test('validateSplitTotal: off by more than a cent -> not ok', () => {
  assert.strictEqual(validateSplitTotal([{ amount: 10999 }], 11000).ok, false);
});

test('validateSplitTotal: within a cent -> ok', () => {
  assert.strictEqual(validateSplitTotal([{ amount: 10999.995 }], 11000).ok, true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && node --test test/reconcileSplit.test.js`
Expected: FAIL — `Cannot find module '../src/utils/reconcileSplit'`.

- [ ] **Step 3: Write the minimal implementation**

```javascript
// backend/src/utils/reconcileSplit.js
// Pure helpers for multi-invoice reconcile allocation. No DB, no Express.

// Returns the single shared invoice_code if EVERY line has the same non-empty
// code; otherwise null (mixed invoices, or any uninvoiced/category-only line).
function resolveHeaderInvoiceCode(lines) {
  const codes = (lines || []).map(l => (l && l.invoice_code) ? String(l.invoice_code) : null);
  if (!codes.length) return null;
  if (codes.some(c => !c)) return null;
  const first = codes[0];
  return codes.every(c => c === first) ? first : null;
}

// Line amounts must sum to the transaction total (±0.01 tolerance).
function validateSplitTotal(lines, total) {
  const sum = (lines || []).reduce((s, l) => s + (Number(l && l.amount) || 0), 0);
  return { ok: Math.abs(sum - (Number(total) || 0)) < 0.01, sum };
}

module.exports = { resolveHeaderInvoiceCode, validateSplitTotal };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && node --test test/reconcileSplit.test.js`
Expected: PASS — `# pass 7`, `# fail 0`.

- [ ] **Step 5: Add a `test` script** so the runner is discoverable. In `backend/package.json` `scripts`, add:

```json
    "test": "node --test"
```

- [ ] **Step 6: Commit**

```bash
git add backend/src/utils/reconcileSplit.js backend/test/reconcileSplit.test.js backend/package.json
git commit -m "feat(reconcile): pure helpers for multi-invoice split (header code + total)"
```

---

### Task 3: Per-line invoice_code + invoice-status recompute in `commitPendingRow`

Wire the helpers and the shared recalc into the approve path. This is the core backend change.

**Files:**
- Modify: `backend/src/routes/xero.js` — the create-new-entry branch inside `commitPendingRow` (currently ~lines 792-849), plus the top-of-file requires.

**Interfaces:**
- Consumes: `resolveHeaderInvoiceCode`, `validateSplitTotal` (Task 2); `recalcInvoiceStatuses` (Task 1).
- Accepts (unchanged endpoint, extended body): `overrides.lines = [{ amount:number, category_id?:string, invoice_id?:string }]`. `invoice_id` is new and optional.

- [ ] **Step 1: Add requires** near the top of `xero.js` (with the other `require` lines):

```javascript
const { recalcInvoiceStatuses } = require('../utils/invoiceStatus');
const { resolveHeaderInvoiceCode, validateSplitTotal } = require('../utils/reconcileSplit');
```

- [ ] **Step 2: Replace the split-build + line-insert + invoice-link block.** Find the block in `commitPendingRow` that starts at `// Optional CATEGORY SPLIT` (~line 792) and ends at the close of the `if (p.match_kind === 'invoice_payment' && invoiceId) { ... }` block (~line 849). Replace the whole span with:

```javascript
      // Optional SPLIT: overrides.lines = [{ amount, category_id, invoice_id? }].
      // Each line is its own accounting_line (own amount, category, and invoice).
      // Lines must sum to the transaction total. Absent = single line.
      let splitLines = null;
      if (Array.isArray(overrides.lines) && overrides.lines.length) {
        splitLines = overrides.lines
          .map(l => ({
            amount: Math.abs(Number(l.amount) || 0),
            category_id: l.category_id ? String(l.category_id) : null,
            invoice_id: l.invoice_id ? String(l.invoice_id) : null,
          }))
          .filter(l => l.amount > 0);
        if (!splitLines.length) splitLines = null;
      }
      if (splitLines) {
        const { ok, sum } = validateSplitTotal(splitLines, amount);
        if (!ok) {
          await conn.rollback();
          const e = new Error(`Split lines must sum to the transaction total (HK$${amount.toFixed(2)}); got HK$${sum.toFixed(2)}.`);
          e.httpStatus = 400;
          throw e;
        }
      }

      // Resolve each line's invoice_code from its invoice_id (org-scoped). For the
      // non-split invoice_payment path, the single line inherits `invoiceId`.
      const rawLines = splitLines || [{
        amount, category_id: categoryId || null,
        invoice_id: (p.match_kind === 'invoice_payment' && invoiceId) ? String(invoiceId) : null,
      }];
      const codeByInvoiceId = new Map();
      for (const l of rawLines) {
        if (l.invoice_id && !codeByInvoiceId.has(l.invoice_id)) {
          const [[invRow]] = await conn.execute(
            'SELECT invoice_code FROM invoice WHERE id = ? AND org_id = ? AND deleted_at IS NULL LIMIT 1',
            [l.invoice_id, orgId]
          );
          codeByInvoiceId.set(l.invoice_id, invRow && invRow.invoice_code ? invRow.invoice_code : null);
        }
      }
      const lineRows = rawLines.map(l => ({
        amount: l.amount,
        category_id: l.category_id,
        invoice_code: l.invoice_id ? (codeByInvoiceId.get(l.invoice_id) || null) : null,
      }));

      // Header category: single category, or null ("Multiple") when split.
      const headerCategory = splitLines
        ? (splitLines.length === 1 ? splitLines[0].category_id : null)
        : (categoryId || null);
      // Header invoice_code: shared code if all lines point at one invoice, else null.
      const headerInvoiceCode = resolveHeaderInvoiceCode(lineRows);

      const transactionCode = await generateSequenceCode(conn, orgId, 'transaction_code');
      await conn.execute(
        `INSERT INTO accounting
            (id, org_id, tenant_id, lease_id, category, account_setting_id,
             currency_id, currency_type,
             amount, note, type, payment_date, invoice_code,
             transaction_code, xero_transaction_id, reconciliation_status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reconciled', NOW())`,
        [newAcctId, orgId, tenantId || null, null, headerCategory, accountId,
         currencyId, currencyType,
         amount, note, isOutflow, p.transaction_date, headerInvoiceCode, transactionCode, p.xero_transaction_id]
      );
      for (const l of lineRows) {
        const lineId = (BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000))).toString();
        await conn.execute(
          `INSERT INTO accounting_line (id, accounting_id, amount, category, invoice_code, created_at)
           VALUES (?, ?, ?, ?, ?, NOW())`,
          [lineId, newAcctId, l.amount, l.category_id, l.invoice_code]
        );
      }
      resultingId = newAcctId;

      // Recompute status for every invoice this entry now pays (partial→Open,
      // full→Paid, past-due→Overdue). Runs inside the approve transaction.
      await recalcInvoiceStatuses(conn, newAcctId, orgId);
```

Note: this replaces BOTH the old blanket `UPDATE accounting_line SET invoice_code` and the old header `UPDATE` — invoice_code is now set at insert time, per line, and the header via `headerInvoiceCode`.

- [ ] **Step 3: Sanity-check the file parses**

Run: `cd backend && node -e "require('./src/routes/xero.js'); console.log('xero.js loads ok')"`
Expected: `xero.js loads ok`.

- [ ] **Step 4: Manual integration smoke (local backend + DB).** This exercises the real SQL path. Requires the backend running locally against `tena_prod` with a known open invoice.

  1. Pick two open invoices for the org and note their `id`, `invoice_code`, `amount`:
     `SELECT id, invoice_code, amount, status FROM invoice WHERE org_id=8300127259922432 AND status IN (0,2) AND deleted_at IS NULL LIMIT 2;`
  2. Seed a pending inflow row summing to both invoices' amounts (replace `<A_amt>+<B_amt>` with the numeric total, and `<acct_setting_id>` with any `account_setting.id`):
     ```sql
     INSERT INTO xero_pending_reconciliation
       (id, org_id, xero_transaction_id, amount, transaction_date, description, contact_name,
        match_kind, proposed_account_id, status, created_at)
     VALUES (999000001, 8300127259922432, 'TEST-MULTI-1', <A_amt+B_amt>, CURDATE(),
        'TEST multi-invoice', 'Test Payer', 'new_entry', <acct_setting_id>, 'pending', NOW());
     ```
  3. Approve it with two invoice lines (replace ids/amounts). Use a valid JWT cookie for the org:
     ```bash
     curl -s -X POST http://localhost:3001/api/integrations/xero/pending/999000001/approve \
       -H 'Content-Type: application/json' -b "__s_t=<JWT>" \
       -d '{"account_id":"<acct_setting_id>","lines":[
             {"amount":<A_amt>,"category_id":"<catA>","invoice_id":"<A_id>"},
             {"amount":<B_amt>,"category_id":"<catB>","invoice_id":"<B_id>"}]}'
     ```
     Expected: `{"code":200,"data":{"resulting_accounting_id":"..."}}`.
  4. Verify per-line codes + header null + both invoices flipped:
     ```sql
     SELECT id, invoice_code FROM accounting WHERE id=<resulting_id>;                 -- invoice_code NULL
     SELECT amount, invoice_code FROM accounting_line WHERE accounting_id=<resulting_id>; -- two rows, two codes
     SELECT invoice_code, status FROM invoice WHERE id IN (<A_id>,<B_id>);            -- status=1 if fully paid
     ```
  5. Clean up: `DELETE FROM accounting_line WHERE accounting_id=<resulting_id>; DELETE FROM accounting WHERE id=<resulting_id>; DELETE FROM xero_pending_reconciliation WHERE id=999000001;` and reset the two invoices' `status` back if needed.

Record the observed values in the commit message or PR notes.

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/xero.js
git commit -m "feat(reconcile): allocate one payment across multiple invoices + recompute status"
```

---

### Task 4: Candidate-invoices endpoint

Supplies the payer's open invoices (with outstanding) for the picker, plus a full-list search override.

**Files:**
- Modify: `backend/src/routes/xero.js` — add a route. Place it with the other `/pending/...` routes and BEFORE any `/pending/:id`-style dynamic handler that could shadow it (it has a distinct suffix `/invoice-candidates`, so ordering after `/pending/:id/approve` is fine).

**Interfaces:**
- Produces: `GET /api/integrations/xero/pending/:id/invoice-candidates?search=` → `{ code:200, data: [{ invoice_id, invoice_code, tenant_name, amount, outstanding, due_on, category_id, category_name }] }`.

- [ ] **Step 1: Add the route** (auth + RECONCILE_PERM). Uses the pending row's `proposed_tenant_id` (if set) else its `contact_name` to scope the payer; with `?search=` it searches the org's open invoices instead.

```javascript
// Candidate invoices for a split allocation. Without ?search=, returns the
// payer's OPEN invoices (resolved from the pending row). With ?search=, returns
// open invoices matching code / tenant name / amount across the org.
router.get('/pending/:id/invoice-candidates', authenticate, requirePermission(RECONCILE_PERM), async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const search = (req.query.search || '').trim();

    const [[p]] = await req.pool.execute(
      'SELECT proposed_tenant_id, contact_name FROM xero_pending_reconciliation WHERE id = ? AND org_id = ?',
      [req.params.id, orgId]
    );
    if (!p) return fail(res, 'Pending row not found', 404);

    // paid subquery mirrors recalcInvoiceStatuses so outstanding matches status.
    const paidSub = `(SELECT COALESCE(SUM(al.amount),0) FROM accounting_line al
                        JOIN accounting a ON al.accounting_id = a.id
                       WHERE al.invoice_code = inv.invoice_code AND a.org_id = inv.org_id
                         AND a.deleted_at IS NULL AND al.deleted_at IS NULL)`;
    const base = `SELECT inv.id AS invoice_id, inv.invoice_code, inv.amount, inv.due_on,
                         inv.category AS category_id, cs.name AS category_name,
                         TRIM(CONCAT(COALESCE(t.first_name,''),' ',COALESCE(t.last_name,''))) AS person_name,
                         t.company_name,
                         (inv.amount - ${paidSub}) AS outstanding
                    FROM invoice inv
                    LEFT JOIN category_setting cs ON cs.id = inv.category
                    LEFT JOIN tenant t ON t.id = inv.tenant_id
                   WHERE inv.org_id = ? AND inv.deleted_at IS NULL AND inv.status IN (0,2)`;

    let rows;
    if (search) {
      const like = `%${search}%`;
      [rows] = await req.pool.execute(
        `${base} AND (inv.invoice_code LIKE ? OR t.first_name LIKE ? OR t.last_name LIKE ?
                      OR t.company_name LIKE ? OR CAST(inv.amount AS CHAR) LIKE ?)
         ORDER BY inv.due_on DESC LIMIT 50`,
        [orgId, like, like, like, like, like]
      );
    } else if (p.proposed_tenant_id) {
      [rows] = await req.pool.execute(
        `${base} AND inv.tenant_id = ? ORDER BY inv.due_on DESC LIMIT 50`,
        [orgId, String(p.proposed_tenant_id)]
      );
    } else if (p.contact_name) {
      const like = `%${p.contact_name.trim()}%`;
      [rows] = await req.pool.execute(
        `${base} AND (CONCAT(COALESCE(t.first_name,''),' ',COALESCE(t.last_name,'')) LIKE ?
                      OR t.company_name LIKE ?) ORDER BY inv.due_on DESC LIMIT 50`,
        [orgId, like, like]
      );
    } else {
      rows = [];
    }

    const data = rows.map(r => ({
      invoice_id: String(r.invoice_id),
      invoice_code: r.invoice_code,
      tenant_name: (r.company_name || r.person_name || '').trim() || '(no name)',
      amount: Number(r.amount),
      outstanding: Number(r.outstanding),
      due_on: r.due_on,
      category_id: r.category_id ? String(r.category_id) : null,
      category_name: r.category_name || null,
    }));
    return ok(res, data);
  } catch (err) {
    console.error('[xero/invoice-candidates] error:', err);
    return fail(res, err.message || 'Failed to load candidates', 500);
  }
});
```

- [ ] **Step 2: Confirm `ok`/`fail` helpers and `RECONCILE_PERM` exist** (they're used by the neighbouring routes).

Run: `cd backend && grep -nE "const RECONCILE_PERM|function ok\\(|function fail\\(|const ok =|const fail =" src/routes/xero.js | head`
Expected: matches for `RECONCILE_PERM` and the `ok`/`fail` helpers. If `ok`/`fail` are named differently, adapt the two calls in Step 1 to the actual helper names.

- [ ] **Step 3: Sanity-check parse**

Run: `cd backend && node -e "require('./src/routes/xero.js'); console.log('ok')"`
Expected: `ok`.

- [ ] **Step 4: Manual smoke** (backend running, valid JWT). Using a real pending row id from the queue:
`curl -s -b "__s_t=<JWT>" "http://localhost:3001/api/integrations/xero/pending/<pendingId>/invoice-candidates" | head -c 400`
Expected: `{"code":200,"data":[...]}` with `invoice_id`/`outstanding` fields; and with `?search=TRIV` returns code-matched invoices.

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/xero.js
git commit -m "feat(reconcile): endpoint for payer invoice candidates (+ search override)"
```

---

### Task 5: Frontend API client + approve payload carries `invoice_id`

**Files:**
- Modify: `frontend/src/lib/api.js` — the `xero` object (near line 78).
- Modify: `frontend/src/app/accounting/reconcile/page.js:187` and `:194` — include `invoice_id` in the line payload.

**Interfaces:**
- Produces: `xero.getInvoiceCandidates(pendingId, search)` → axios promise of the Task 4 response.
- The approve `lines` payload becomes `{ amount, category_id, invoice_id }` per line.

- [ ] **Step 1: Add the API method.** In `frontend/src/lib/api.js`, inside the `xero` object after `approvePending`:

```javascript
  getInvoiceCandidates: (pendingId, search) =>
    api.get(`/api/integrations/xero/pending/${pendingId}/invoice-candidates`, { params: search ? { search } : {} }),
```

- [ ] **Step 2: Carry `invoice_id` in the line payload.** In `reconcile/page.js`, both occurrences (lines ~187 and ~194) currently read:

```javascript
      lines: (ov.lines && splitValid(row)) ? ov.lines.map(l => ({ amount: Number(l.amount), category_id: l.category_id })) : undefined,
```

Change both to:

```javascript
      lines: (ov.lines && splitValid(row)) ? ov.lines.map(l => ({ amount: Number(l.amount), category_id: l.category_id, invoice_id: l.invoice_id || undefined })) : undefined,
```

- [ ] **Step 3: Verify the frontend builds**

Run: `cd frontend && npx next build 2>&1 | tail -20`
Expected: build completes without errors for `accounting/reconcile` and `lib/api`. (If build is slow/heavy, at minimum run `npx eslint src/lib/api.js src/app/accounting/reconcile/page.js` and expect no errors.)

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/api.js frontend/src/app/accounting/reconcile/page.js
git commit -m "feat(reconcile): send per-line invoice_id + invoice-candidates api client"
```

---

### Task 6: Frontend split editor — per-line invoice picker, auto-fill, warnings

Extend `renderCategoryOrSplit` so each split line has an optional invoice picker (pre-loaded with the payer's open invoices, searchable to the full list), auto-fills the amount to the invoice's outstanding, and shows non-blocking warnings.

**Files:**
- Modify: `frontend/src/app/accounting/reconcile/page.js` — add candidate state + loader; extend `renderCategoryOrSplit` (lines ~317-371).

**Interfaces:**
- Consumes: `xero.getInvoiceCandidates` (Task 5).
- Line objects gain optional `invoice_id`. `splitValid` is unchanged (category + amount still required; sum still enforced) — invoice is optional.

- [ ] **Step 1: Add candidate state + loader.** Near the other `useState` hooks (around line 49):

```javascript
  const [invCandidates, setInvCandidates] = useState({}); // pending row id → [{invoice_id, invoice_code, tenant_name, outstanding, ...}]
```

Add a loader (near the other data-loading callbacks). It caches per row and is a no-op if already loaded:

```javascript
  const loadInvCandidates = useCallback(async (rowId, search) => {
    try {
      const r = await xero.getInvoiceCandidates(rowId, search);
      if (r.data?.code === 200) setInvCandidates(prev => ({ ...prev, [rowId]: r.data.data || [] }));
    } catch { /* non-fatal — picker still works via manual search */ }
  }, []);
```

- [ ] **Step 2: Load candidates when a split is opened.** In `renderCategoryOrSplit`, the "Split into categories…" button (line ~334) creates the first line. Change its `onClick` to also fetch candidates:

```javascript
            <Button {...linkBtn} onClick={() => {
              setLines(row.id, [{ amount: amountAbs, category_id: categoryId || null, invoice_id: null }]);
              if (!invCandidates[row.id]) loadInvCandidates(row.id);
            }}>
              Split invoices / categories…
            </Button>
```

- [ ] **Step 3: Render the invoice picker per line.** Inside the `lines.map(...)` (lines ~345-359), add an invoice `Select` after the category `Select`. Build the option list from candidates, and on change auto-fill the amount from that invoice's outstanding. Replace the `<Space key={i} ...>...</Space>` block with:

```javascript
          <Space key={i} size={4} style={{ display: 'flex', marginBottom: 4 }} align="start" wrap>
            <InputNumber size="small" prefix="$" style={{ width: 95 }} controls={false} min={0}
              value={ln.amount}
              onChange={v => { const next = lines.map((x, j) => j === i ? { ...x, amount: v } : x); setLines(row.id, next); }} />
            <Select size="small" showSearch placeholder="Category" style={{ width: 140 }}
              value={ln.category_id || undefined}
              onChange={v => { const next = lines.map((x, j) => j === i ? { ...x, category_id: v } : x); setLines(row.id, next); }}
              options={catOptions} filterOption={catFilter} status={!ln.category_id ? 'warning' : undefined} />
            <Select size="small" showSearch allowClear placeholder="Invoice (optional)" style={{ width: 200 }}
              value={ln.invoice_id || undefined}
              onSearch={(txt) => { if (txt && txt.length >= 2) loadInvCandidates(row.id, txt); }}
              filterOption={false}
              notFoundContent={null}
              options={(invCandidates[row.id] || []).map(c => ({
                value: c.invoice_id,
                label: `${c.invoice_code} · ${c.tenant_name} · out HK$${Number(c.outstanding).toFixed(2)}`,
              }))}
              onChange={(v) => {
                const cand = (invCandidates[row.id] || []).find(c => c.invoice_id === v);
                const next = lines.map((x, j) => j === i
                  ? { ...x, invoice_id: v || null, amount: (v && cand) ? Number(cand.outstanding) : x.amount }
                  : x);
                setLines(row.id, next);
              }} />
            {lines.length > 1 && (
              <Button type="text" size="small" icon={<CloseOutlined />}
                onClick={() => setLines(row.id, lines.filter((_, j) => j !== i))} />
            )}
          </Space>
```

- [ ] **Step 4: Add non-blocking warnings** below the running total. Replace the footer `<Space size={10} ...>...</Space>` (lines ~360-368) with a version that appends warnings:

```javascript
        <Space size={10} wrap style={{ fontSize: 12 }}>
          <Button {...linkBtn} onClick={() => setLines(row.id, [...lines, { amount: Math.max(0, Number((amountAbs - sum).toFixed(2))), category_id: null, invoice_id: null }])}>
            + add line
          </Button>
          <Button {...linkBtn} onClick={() => setLines(row.id, null)}>single category</Button>
          <span style={{ color: balanced ? '#52c41a' : '#ff4d4f' }}>
            HK${sum.toFixed(2)} / HK${amountAbs.toFixed(2)}{balanced ? ' ✓' : ''}
          </span>
        </Space>
        {(() => {
          const cands = invCandidates[row.id] || [];
          const overs = lines.filter(l => {
            const c = cands.find(x => x.invoice_id === l.invoice_id);
            return c && Number(l.amount) > Number(c.outstanding) + 0.01;
          });
          const chosen = lines.map(l => l.invoice_id).filter(Boolean);
          const dupe = chosen.length !== new Set(chosen).size;
          const warns = [];
          if (overs.length) warns.push('A line exceeds its invoice’s outstanding (overpayment).');
          if (dupe) warns.push('The same invoice is used on more than one line.');
          return warns.length ? (
            <div style={{ color: '#faad14', fontSize: 12, marginTop: 2 }}>⚠ {warns.join(' ')}</div>
          ) : null;
        })()}
```

- [ ] **Step 5: Verify the frontend builds**

Run: `cd frontend && npx next build 2>&1 | tail -20`
Expected: build completes without errors. (Fallback: `npx eslint src/app/accounting/reconcile/page.js` → no errors.)

- [ ] **Step 6: Manual UI check (user-driven, per project convention — no automated browser).** In a running dev frontend: open Accounting → Reconcile, on an inflow row click **Split invoices / categories…**, confirm the payer's open invoices pre-load in the per-line invoice dropdown, selecting one auto-fills the amount to its outstanding, the running total gates Approve, typing in the invoice box searches the full list, and over-allocation / duplicate-invoice show the amber warning. Approve and confirm both invoices update on the Invoices page.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/app/accounting/reconcile/page.js
git commit -m "feat(reconcile): per-line invoice picker with auto-fill + allocation warnings"
```

---

## Self-Review

**Spec coverage:**
- Per-line invoice_code + header null when mixed → Task 3 (`resolveHeaderInvoiceCode`, per-line insert). ✓
- Auto-fill outstanding, editable, running total, Approve gated → Task 6 (onChange auto-fill; existing running total; `splitValid`/`newEntryApprovable` already gate Approve). ✓
- Category manual per line → unchanged; invoice optional → Task 6 (allowClear, optional). ✓
- Pre-load payer invoices + full-list search override → Task 4 endpoint + Task 6 picker (`onSearch`). ✓
- recalcInvoiceStatuses wired into reconcile (bug fix) → Tasks 1 & 3. ✓
- Over-allocation allowed-with-warning; duplicate-invoice warning → Task 6 Step 4. ✓
- Inflow-only allocation → the split editor is reached from the category/new-entry chrome; invoice picker is optional and candidates only meaningfully populate for inflows. (Note: outflow rows can still open a split, but the candidate list will be the payer's invoices; acceptable — no invoice is forced. If stricter gating is wanted, hide the invoice Select when `effectiveDirection(row)==='outflow'` — one-line guard.) ✓ (with note)
- Cross-org isolation → Task 4 filters `org_id`; recalc filters org. ✓
- Backwards compatible (no lines) → Task 3 `rawLines` fallback preserves today's single-line behaviour. ✓

**Placeholder scan:** No TBD/TODO; all code blocks concrete. ✓

**Type consistency:** `resolveHeaderInvoiceCode(lineRows)` receives objects with `invoice_code` — matches Task 2 signature. `validateSplitTotal(splitLines, amount)` returns `{ok, sum}` — used as such. `getInvoiceCandidates(pendingId, search)` — matches Task 5/6 usage. Line objects use `invoice_id` consistently across Tasks 3/5/6. ✓

**One flagged decision** (carried from the design): outflow rows aren't hard-blocked from the invoice picker — noted above as a trivial optional guard if you want it stricter.

---

## Revision 2026-07-16 — edge-case changes (Tasks 7–9)

Follow-up on committed Tasks 1–5. New rules: over-allocation BLOCKED (was warn),
duplicate-invoice BLOCKED (was warn), outflow allocation SUPPORTED (was non-goal).
Task 6 (inflow-only, warning-based frontend) is **superseded by Task 9** — do not
implement the original Task 6.

### Task 7: Backend enforcement + candidate direction filter (`xero.js`)

**Files:**
- Modify: `backend/src/routes/xero.js` — (a) the `/pending/:id/invoice-candidates` route (add direction filter); (b) `commitPendingRow` new-entry branch (the block Task 3 wrote — add duplicate + over-allocation guards, extending the `codeByInvoiceId` map to also carry amount/paid).

**Interfaces:**
- Consumes: existing `resolveHeaderInvoiceCode`, `validateSplitTotal`, `recalcInvoiceStatuses`.
- The candidate route gains an optional `?direction=inflow|outflow` query param.

- [ ] **Step 1 (candidate direction filter):** In the `/pending/:id/invoice-candidates` route, right after the `const [[p]] = ...` pending-row fetch (and its not-found guard), compute the invoice type to filter by:

```javascript
    const dir = String(req.query.direction || '').toLowerCase();
    // inflow payment -> inflow invoices (type 0); outflow payment -> outflow (type 1).
    // Fallback to the pending row's amount sign (negative = outflow) when no param.
    const invType = dir === 'outflow' ? 1 : dir === 'inflow' ? 0 : (Number(p.amount) < 0 ? 1 : 0);
```

Then add `AND inv.type = ?` to the shared `base` WHERE clause, so it reads:

```javascript
                   WHERE inv.org_id = ? AND inv.type = ? AND inv.deleted_at IS NULL AND inv.status IN (0,2)`;
```

And insert `invType` as the second param (right after `orgId`) in ALL THREE branch queries:
- search branch params: `[orgId, invType, like, like, like, like, like]`
- `proposed_tenant_id` branch params: `[orgId, invType, String(p.proposed_tenant_id)]`
- `contact_name` branch params: `[orgId, invType, like, like]`

- [ ] **Step 2 (commitPendingRow guards):** In `commitPendingRow`, locate the block Task 3 added that builds `const codeByInvoiceId = new Map();` … through the `const lineRows = rawLines.map(...)`. Replace that map-population + `lineRows` construction with an `invoiceMeta` map (code + amount + paid) and add the two guards immediately after it:

```javascript
      // Resolve each line's invoice: code + amount + current paid (org-scoped).
      const invoiceMeta = new Map(); // invoice_id → { code, amount, paid }
      for (const l of rawLines) {
        if (l.invoice_id && !invoiceMeta.has(l.invoice_id)) {
          const [[invRow]] = await conn.execute(
            'SELECT invoice_code, amount FROM invoice WHERE id = ? AND org_id = ? AND deleted_at IS NULL LIMIT 1',
            [l.invoice_id, orgId]
          );
          if (!invRow || !invRow.invoice_code) {
            invoiceMeta.set(l.invoice_id, { code: null, amount: 0, paid: 0 });
          } else {
            const [[paidRow]] = await conn.execute(
              `SELECT COALESCE(SUM(al.amount),0) AS paid FROM accounting_line al
                 JOIN accounting a ON al.accounting_id = a.id
                WHERE al.invoice_code = ? AND a.org_id = ? AND a.deleted_at IS NULL AND al.deleted_at IS NULL`,
              [invRow.invoice_code, orgId]
            );
            invoiceMeta.set(l.invoice_id, {
              code: invRow.invoice_code,
              amount: Number(invRow.amount) || 0,
              paid: Number(paidRow.paid) || 0,
            });
          }
        }
      }

      // Guard: the same invoice may not be used on more than one line.
      const chosenInvoiceIds = rawLines.map(l => l.invoice_id).filter(Boolean);
      if (new Set(chosenInvoiceIds).size !== chosenInvoiceIds.length) {
        await conn.rollback();
        const e = new Error('The same invoice cannot be allocated on more than one line.');
        e.httpStatus = 400;
        throw e;
      }
      // Guard: a line may not exceed its invoice's current outstanding balance.
      for (const l of rawLines) {
        if (!l.invoice_id) continue;
        const meta = invoiceMeta.get(l.invoice_id);
        if (!meta || meta.code == null) continue;
        const outstanding = meta.amount - meta.paid;
        if (l.amount > outstanding + 0.01) {
          await conn.rollback();
          const e = new Error(`Allocation for invoice ${meta.code} (HK$${l.amount.toFixed(2)}) exceeds its outstanding balance of HK$${outstanding.toFixed(2)}.`);
          e.httpStatus = 400;
          throw e;
        }
      }

      const lineRows = rawLines.map(l => ({
        amount: l.amount,
        category_id: l.category_id,
        invoice_code: l.invoice_id ? (invoiceMeta.get(l.invoice_id)?.code || null) : null,
      }));
```

- [ ] **Step 3:** Parse check: `cd backend && node -e "require('./src/routes/xero.js'); console.log('ok')"` → prints `ok`.
- [ ] **Step 4:** Manual DB smoke deferred (needs live backend + seeded data). Verify by re-reading: the two guards roll back before any INSERT; `invoiceMeta` replaces `codeByInvoiceId` everywhere it was used; `lineRows` still yields the same shape. Confirm no remaining reference to `codeByInvoiceId`.
- [ ] **Step 5:** Commit: `git commit -am "feat(reconcile): block over-allocation + duplicate invoice; direction-filter candidates"`

### Task 8: Fix invoice PDF paid-sum for outflow invoices (`pdf.js`)

**Files:**
- Modify: `backend/src/routes/pdf.js` — the invoice PDF `amountPaid` query (around line 52-59).

- [ ] **Step 1:** In the `amountPaid` query, remove the `AND a.type = 0` filter so the paid-sum matches `recalcInvoiceStatuses` and the invoice list (both sum all lines by invoice_code regardless of direction). The WHERE clause becomes:

```javascript
       WHERE al.invoice_code = ? AND a.org_id = ?
         AND a.deleted_at IS NULL AND al.deleted_at IS NULL`,
```

Leave the two OTHER `accounting_line` queries in this file (around lines 398 and 612) UNCHANGED — they select a transaction's line items for the receipt PDF, not a per-invoice paid-sum.

- [ ] **Step 2:** Parse check: `cd backend && node -e "require('./src/routes/pdf.js'); console.log('ok')"` → prints `ok`.
- [ ] **Step 3:** Commit: `git commit -am "fix(pdf): invoice paid-sum counts all payments (fixes outflow invoice PDFs)"`

### Task 9: Frontend reconcile picker — direction-matched candidates + blocking (supersedes Task 6)

**Files:**
- Modify: `frontend/src/lib/api.js` — `getInvoiceCandidates` gains a `direction` arg.
- Modify: `frontend/src/app/accounting/reconcile/page.js` — extend `renderCategoryOrSplit`, add candidate state/loader, block Approve on over-allocation/duplicate with an explanatory popup.

**Interfaces:**
- Consumes: `xero.getInvoiceCandidates(pendingId, search, direction)`, existing `setLines`, `splitSum`, `overrides`, `effectiveDirection(row)`, `onApprove`.

- [ ] **Step 1 (api client direction arg):** In `frontend/src/lib/api.js`, change `getInvoiceCandidates` to:

```javascript
  getInvoiceCandidates: (pendingId, search, direction) =>
    api.get(`/api/integrations/xero/pending/${pendingId}/invoice-candidates`, {
      params: { ...(search ? { search } : {}), ...(direction ? { direction } : {}) },
    }),
```

- [ ] **Step 2 (candidate state + loader):** In `reconcile/page.js`, near the other `useState` hooks:

```javascript
  const [invCandidates, setInvCandidates] = useState({}); // row id → [{invoice_id, invoice_code, tenant_name, outstanding, ...}]
```

And a loader that passes the row's effective direction:

```javascript
  const loadInvCandidates = useCallback(async (row, search) => {
    try {
      const r = await xero.getInvoiceCandidates(row.id, search, effectiveDirection(row));
      if (r.data?.code === 200) setInvCandidates(prev => ({ ...prev, [row.id]: r.data.data || [] }));
    } catch { /* non-fatal — manual search still works */ }
  }, []);
```

- [ ] **Step 3 (block-reason helper):** Add a helper that returns a human message when a split is invalid due to over-allocation or duplicate invoice, else null:

```javascript
  const splitBlockReason = (row) => {
    const lines = overrides[row.id]?.lines;
    if (!lines || !lines.length) return null;
    const cands = invCandidates[row.id] || [];
    const chosen = lines.map(l => l.invoice_id).filter(Boolean);
    if (new Set(chosen).size !== chosen.length) {
      return 'The same invoice is allocated on more than one line. Each invoice can appear only once.';
    }
    for (const l of lines) {
      const c = cands.find(x => x.invoice_id === l.invoice_id);
      if (c && Number(l.amount) > Number(c.outstanding) + 0.01) {
        return `The amount on invoice ${c.invoice_code} (HK$${Number(l.amount).toFixed(2)}) is more than its outstanding balance of HK$${Number(c.outstanding).toFixed(2)}. Lower the amount or pick another invoice.`;
      }
    }
    return null;
  };
```

- [ ] **Step 4 (gate Approve):** In the row's approvable check (`newEntryApprovable`), also require no block reason. Change:

```javascript
    !!effectiveAccount(row) && (overrides[row.id]?.lines ? splitValid(row) : true);
```

to:

```javascript
    !!effectiveAccount(row) && (overrides[row.id]?.lines ? (splitValid(row) && !splitBlockReason(row)) : true);
```

And in `onApprove(row)`, before building/sending the body, pop the explanatory modal if blocked:

```javascript
    const blocked = overrides[row.id]?.lines ? splitBlockReason(row) : null;
    if (blocked) { Modal.error({ title: 'Cannot approve this allocation', content: blocked }); return; }
```

(`Modal` is already imported in this file.)

- [ ] **Step 5 (split editor UI):** In `renderCategoryOrSplit`, change the "Split into categories…" button's onClick to seed a line with `invoice_id: null` and load candidates, and rename its label to "Split invoices / categories…":

```javascript
            <Button {...linkBtn} onClick={() => {
              setLines(row.id, [{ amount: amountAbs, category_id: categoryId || null, invoice_id: null }]);
              if (!invCandidates[row.id]) loadInvCandidates(row);
            }}>
              Split invoices / categories…
            </Button>
```

Replace the per-line `<Space key={i} ...>` block with one that adds the invoice Select (auto-fills amount from the chosen invoice's outstanding). Flag over-allocated lines and any duplicated invoice with `status="error"` on the invoice Select:

```javascript
          <Space key={i} size={4} style={{ display: 'flex', marginBottom: 4 }} align="start" wrap>
            <InputNumber size="small" prefix="$" style={{ width: 95 }} controls={false} min={0}
              value={ln.amount}
              onChange={v => { const next = lines.map((x, j) => j === i ? { ...x, amount: v } : x); setLines(row.id, next); }} />
            <Select size="small" showSearch placeholder="Category" style={{ width: 140 }}
              value={ln.category_id || undefined}
              onChange={v => { const next = lines.map((x, j) => j === i ? { ...x, category_id: v } : x); setLines(row.id, next); }}
              options={catOptions} filterOption={catFilter} status={!ln.category_id ? 'warning' : undefined} />
            <Select size="small" showSearch allowClear placeholder="Invoice (optional)" style={{ width: 200 }}
              value={ln.invoice_id || undefined}
              onSearch={(txt) => { if (txt && txt.length >= 2) loadInvCandidates(row, txt); }}
              filterOption={false} notFoundContent={null}
              status={(() => {
                const dupe = ln.invoice_id && lines.filter(x => x.invoice_id === ln.invoice_id).length > 1;
                const cand = (invCandidates[row.id] || []).find(c => c.invoice_id === ln.invoice_id);
                const over = cand && Number(ln.amount) > Number(cand.outstanding) + 0.01;
                return (dupe || over) ? 'error' : undefined;
              })()}
              options={(invCandidates[row.id] || []).map(c => ({
                value: c.invoice_id,
                label: `${c.invoice_code} · ${c.tenant_name} · out HK$${Number(c.outstanding).toFixed(2)}`,
              }))}
              onChange={(v) => {
                const cand = (invCandidates[row.id] || []).find(c => c.invoice_id === v);
                const next = lines.map((x, j) => j === i
                  ? { ...x, invoice_id: v || null, amount: (v && cand) ? Number(cand.outstanding) : x.amount }
                  : x);
                setLines(row.id, next);
              }} />
            {lines.length > 1 && (
              <Button type="text" size="small" icon={<CloseOutlined />}
                onClick={() => setLines(row.id, lines.filter((_, j) => j !== i))} />
            )}
          </Space>
```

Update the footer "+ add line" button to seed `invoice_id: null`, and below the running total show the block reason inline in red when present:

```javascript
        <Space size={10} wrap style={{ fontSize: 12 }}>
          <Button {...linkBtn} onClick={() => setLines(row.id, [...lines, { amount: Math.max(0, Number((amountAbs - sum).toFixed(2))), category_id: null, invoice_id: null }])}>
            + add line
          </Button>
          <Button {...linkBtn} onClick={() => setLines(row.id, null)}>single category</Button>
          <span style={{ color: balanced ? '#52c41a' : '#ff4d4f' }}>
            HK${sum.toFixed(2)} / HK${amountAbs.toFixed(2)}{balanced ? ' ✓' : ''}
          </span>
        </Space>
        {splitBlockReason(row) && (
          <div style={{ color: '#ff4d4f', fontSize: 12, marginTop: 2 }}>⛔ {splitBlockReason(row)}</div>
        )}
```

- [ ] **Step 6 (build):** `cd frontend && npx next build 2>&1 | tail -25` — completes without errors for `accounting/reconcile` and `lib/api`. Fallback if build unavailable: `npx eslint src/app/accounting/reconcile/page.js src/lib/api.js` and report actual output.
- [ ] **Step 7:** Commit: `git commit -am "feat(reconcile): invoice picker with direction-matched candidates + blocking over-allocation/duplicate"`
