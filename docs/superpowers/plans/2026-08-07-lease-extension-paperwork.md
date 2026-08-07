# Lease Extension Paperwork Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each period of a tenancy carry its own signed document — e-signed or signed on paper — so extending a lease by editing its end date raises, and can resolve, the paperwork for the new period.

**Architecture:** `signature_request` becomes a per-period document ledger by gaining four columns; it already has a non-unique `lease_id`. The PDF renderer gains an optional term override so a document prints its own period. A pure utility decides whether an undocumented stretch is long enough to need paperwork. **The `leasing` table is not modified.**

**Tech Stack:** Node.js + Express, MySQL2 (promise pool), `node:test` (no DB in tests — pure helpers plus fake connection stubs), Next.js 14 App Router, Ant Design 5, dayjs.

**Spec:** `docs/superpowers/specs/2026-08-07-lease-extension-paperwork-design.md`

## Global Constraints

- **Never modify the `leasing` table.** The whole point of this design is that extending stays an edit to the existing lease row.
- **Route files are mounted with a prefix** in `backend/src/index.js` — routes inside must not repeat it. `router.post('/record-paper', ...)` → `/api/signature/record-paper`.
- **Static routes before dynamic ones.** `/record-paper` must be declared before any `/:id` route in `signature.js`.
- **All IDs are Snowflake strings**, generated explicitly: `(BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000))).toString()`. `signature.js` already has this as `newId()`.
- **The pools run with `bigNumberStrings: true`** — a SQL tinyint/boolean arrives as the string `"0"`, and `!!"0"` is `true`. Always compare with `Number(x) === 1`.
- **mysql2 returns DATE columns as LOCAL-midnight `Date` objects.** Read wall-clock parts (`getFullYear`/`getMonth`/`getDate`) or use `DATE_FORMAT(col, '%Y-%m-%d')` in SQL. **Never `toISOString()`** — it shifts the day on the HK server.
- **Every query is org-scoped.** `leasing` and `unit` have no `org_id`; scope via `unit → property.org_id`. `signature_request` has its own `org_id`.
- **Migrations are per-org and idempotent**, guarded with `information_schema` + `PREPARE`/`EXECUTE`. Run with `npm run migrate:orgs`.
- **Tests use `node:test`**, run with `npm test` from `backend/`. There is no frontend test framework — frontend tasks verify with `npm run build` plus explicit manual steps.
- **Threshold rule:** paperwork is required when the uncovered stretch is **a month or more**, measured from the last signed period. Covered to 19 Aug → end 5 Sep is quiet, end 19 Sep needs a document.
- **Do not push or deploy.** Commit locally only; the user authorises each push and each deploy separately.

---

## File Structure

**Created:**
- `backend/migrations-org/033_signature_request_term.sql` — the four ledger columns plus an index
- `backend/src/utils/paperworkPeriod.js` — pure date maths and the gap decision; no DB, no Express
- `backend/test/paperworkPeriod.test.js`
- `backend/test/signatureTerm.test.js` — term override isolation and signature-status recomputation

**Modified:**
- `backend/src/services/leasePdfRenderer.js` — optional `term` on `renderFromTemplate`; exports `applyTermOverride`
- `backend/src/routes/signature.js` — term fields on create, `/record-paper`, cancel recomputation, richer lease listing
- `backend/src/routes/leasing.js` — `documents` + `paperwork` on the detail GET, `paperwork` on the update response, `paperwork_gap` on the calendar
- `frontend/src/lib/api.js` — `signature.recordPaper`
- `frontend/src/app/leasing/[id]/detail/page.js` — Documents & Signatures section
- `frontend/src/app/leasing/[id]/review-and-send/page.js` — period and stamped-term fields
- `frontend/src/app/leasing/[id]/edit/page.js` — post-save paperwork prompt
- `frontend/src/app/leasing/calendar/page.js` — paperwork marker and filter option

**Deviation from the spec, deliberate:** the spec says the client and server "must share one clamped calendar-month helper". Duplicating that maths in two packages is exactly how they drift. Instead **the server is authoritative**: `PUT /api/leasing/:id` returns the recomputed `paperwork` state and the edit page renders the prompt from it. No date arithmetic on the client. Task 12 updates the spec to match.

---

### Task 1: Migration — the ledger columns

**Files:**
- Create: `backend/migrations-org/033_signature_request_term.sql`

**Interfaces:**
- Produces: `signature_request.term_start DATE NULL`, `term_end DATE NULL`, `signature_method VARCHAR(16) NOT NULL DEFAULT 'esign'`, `term_stamp_end DATE NULL`, and index `idx_sr_lease_term (lease_id, status, term_end)`.

- [ ] **Step 1: Write the migration**

Follow the guarded pattern from `032_property_landlord_name.sql` exactly — each statement must be safe to run twice, and safe on an org whose DB was built from `org_schema_template.sql`.

```sql
-- Per-org migration: turn signature_request into a per-period document ledger.
--
-- A tenancy that is extended by editing leasing.end_date needs a separate
-- signed document per period. signature_request already allows many rows per
-- lease (lease_id is not unique) — it just never recorded WHICH period each
-- document covers, nor whether it was signed electronically or on paper.
--
-- No changes to the leasing table: extending stays an edit to the lease row.

-- ── signature_request.term_start ─────────────────────────────────────────────
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'signature_request'
     AND COLUMN_NAME = 'term_start');
SET @s := IF(@c = 0,
  'ALTER TABLE signature_request ADD COLUMN term_start DATE NULL DEFAULT NULL AFTER template_version',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ── signature_request.term_end ───────────────────────────────────────────────
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'signature_request'
     AND COLUMN_NAME = 'term_end');
SET @s := IF(@c = 0,
  'ALTER TABLE signature_request ADD COLUMN term_end DATE NULL DEFAULT NULL AFTER term_start',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ── signature_request.term_stamp_end ─────────────────────────────────────────
-- The stamped Term of Tenancy for THIS period. NULL = the period's own end.
-- leasing.stamp_end_date is one value per lease and is never written back.
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'signature_request'
     AND COLUMN_NAME = 'term_stamp_end');
SET @s := IF(@c = 0,
  'ALTER TABLE signature_request ADD COLUMN term_stamp_end DATE NULL DEFAULT NULL AFTER term_end',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ── signature_request.signature_method ───────────────────────────────────────
-- 'esign' = signed through the token flow; 'paper' = a scan recorded by staff.
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'signature_request'
     AND COLUMN_NAME = 'signature_method');
SET @s := IF(@c = 0,
  "ALTER TABLE signature_request ADD COLUMN signature_method VARCHAR(16) NOT NULL DEFAULT 'esign' AFTER status",
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- ── index for the gap query ──────────────────────────────────────────────────
SET @c := (SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'signature_request'
     AND INDEX_NAME = 'idx_sr_lease_term');
SET @s := IF(@c = 0,
  'ALTER TABLE signature_request ADD INDEX idx_sr_lease_term (lease_id, status, term_end)',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

-- NO BACKFILL, deliberately. Existing rows keep NULL periods and display as
-- "period not recorded". Backfilling from the lease's current dates would
-- assert that an old document covers a term it may never have covered — a
-- lease already extended by editing would get a wrong, official-looking period.
```

- [ ] **Step 2: Run it locally**

Run from `backend/`: `npm run migrate:orgs`
Expected: every org reports success. If an org fails on a missing `signature_request` table, that org predates migration 004 — the guards make the statements no-ops only for *columns*, so confirm 004 ran for that org before proceeding.

- [ ] **Step 3: Verify it is idempotent**

Run: `npm run migrate:orgs` a second time.
Expected: succeeds again with no errors and no duplicate-column failures.

- [ ] **Step 4: Commit**

```bash
git add backend/migrations-org/033_signature_request_term.sql
git commit -m "feat(signature): per-period document columns on signature_request"
```

---

### Task 2: The paperwork period utility

The heart of the feature. Pure functions, no DB, no Express — which is what makes the threshold rule properly testable.

**Files:**
- Create: `backend/src/utils/paperworkPeriod.js`
- Test: `backend/test/paperworkPeriod.test.js`

**Interfaces:**
- Produces:
  - `ymd(value) -> 'YYYY-MM-DD' | ''` — wall-clock, never `toISOString()`
  - `addDays(dateStr, n) -> 'YYYY-MM-DD'`
  - `addOneMonthMinusDay(dateStr) -> 'YYYY-MM-DD'` — clamped to month length
  - `computePaperworkState({ leaseEndDate, documents }) -> state`
  - `state = { has_documents, covered_end, next_period_start, in_flight, uncovered, needs_document, reason }`
  - `reason ∈ 'no_documents' | 'in_flight' | 'period_not_recorded' | 'covered' | 'under_a_month' | 'gap'`
  - `documents` is `[{ status, term_start, term_end }]` where `status` is the `signature_request.status` tinyint (3 = fully signed, 1/2 = in flight).

- [ ] **Step 1: Write the failing tests**

Create `backend/test/paperworkPeriod.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const {
  addDays,
  addOneMonthMinusDay,
  computePaperworkState,
} = require('../src/utils/paperworkPeriod');

// ── date maths ──────────────────────────────────────────────────────────────

test('addDays crosses a month boundary', () => {
  assert.equal(addDays('2026-08-31', 1), '2026-09-01');
});

test('addOneMonthMinusDay: a plain month', () => {
  // A period starting 20 Aug is exactly one month long through 19 Sep.
  assert.equal(addOneMonthMinusDay('2026-08-20'), '2026-09-19');
});

test('addOneMonthMinusDay: clamps into a short month', () => {
  // 31 Jan + 1 month clamps to 28 Feb, minus a day -> 27 Feb. Same convention
  // as defaultStampEndDate, dayjs .add(1,"month") and MySQL DATE_ADD.
  assert.equal(addOneMonthMinusDay('2026-01-31'), '2026-02-27');
});

test('addOneMonthMinusDay: 1 Feb in a non-leap year', () => {
  assert.equal(addOneMonthMinusDay('2026-02-01'), '2026-02-28');
});

test('addOneMonthMinusDay: 1 Feb in a leap year', () => {
  assert.equal(addOneMonthMinusDay('2028-02-01'), '2028-02-29');
});

test('date maths reads a mysql2 Date as wall-clock, not UTC', () => {
  // mysql2 hands back DATE columns as LOCAL-midnight Date objects. On the HK
  // server toISOString() would report the previous day.
  assert.equal(addDays(new Date(2026, 7, 31), 1), '2026-09-01');
});

// ── the gap decision ────────────────────────────────────────────────────────

const signed = (term_start, term_end) => ({ status: 3, term_start, term_end });
const inFlight = (term_start, term_end) => ({ status: 1, term_start, term_end });

test('a lease with no documents is never flagged', () => {
  // 110 of 113 live leases predate e-signature. Nagging about them would make
  // the marker useless — documenting a lease is what opts it in.
  const s = computePaperworkState({ leaseEndDate: '2027-08-31', documents: [] });
  assert.equal(s.needs_document, false);
  assert.equal(s.reason, 'no_documents');
  assert.equal(s.has_documents, false);
});

test('a signed document covering the lease end is enough', () => {
  const s = computePaperworkState({
    leaseEndDate: '2026-08-19',
    documents: [signed('2025-08-20', '2026-08-19')],
  });
  assert.equal(s.needs_document, false);
  assert.equal(s.reason, 'covered');
  assert.equal(s.covered_end, '2026-08-19');
});

test('under a month uncovered stays quiet', () => {
  // covered to 19 Aug, extended to 5 Sep -> 17 days. No contract needed.
  const s = computePaperworkState({
    leaseEndDate: '2026-09-05',
    documents: [signed('2025-08-20', '2026-08-19')],
  });
  assert.equal(s.needs_document, false);
  assert.equal(s.reason, 'under_a_month');
  assert.deepEqual(s.uncovered, { from: '2026-08-20', to: '2026-09-05' });
});

test('exactly one month uncovered DOES need a document', () => {
  // covered to 19 Aug -> period starts 20 Aug -> one month ends 19 Sep.
  const s = computePaperworkState({
    leaseEndDate: '2026-09-19',
    documents: [signed('2025-08-20', '2026-08-19')],
  });
  assert.equal(s.needs_document, true);
  assert.equal(s.reason, 'gap');
  assert.deepEqual(s.uncovered, { from: '2026-08-20', to: '2026-09-19' });
});

test('more than a month uncovered needs a document', () => {
  const s = computePaperworkState({
    leaseEndDate: '2026-10-19',
    documents: [signed('2025-08-20', '2026-08-19')],
  });
  assert.equal(s.needs_document, true);
  assert.equal(s.reason, 'gap');
});

test('short extensions accumulate against the last SIGNED period', () => {
  // Three-week rollovers each look short in isolation. Measuring from the last
  // signed document is what stops a month-to-month tenant drifting a year past
  // their paperwork.
  const docs = [signed('2025-08-20', '2026-08-19')];
  const after21Days = computePaperworkState({ leaseEndDate: '2026-09-09', documents: docs });
  assert.equal(after21Days.needs_document, false);
  const after42Days = computePaperworkState({ leaseEndDate: '2026-09-30', documents: docs });
  assert.equal(after42Days.needs_document, true);
});

test('an in-flight request covering the end date suppresses the flag', () => {
  const s = computePaperworkState({
    leaseEndDate: '2027-08-31',
    documents: [signed('2025-08-20', '2026-08-19'), inFlight('2026-08-20', '2027-08-31')],
  });
  assert.equal(s.needs_document, false);
  assert.equal(s.reason, 'in_flight');
  assert.equal(s.in_flight, true);
});

test('an in-flight request with no recorded period also suppresses the flag', () => {
  // Pre-existing requests carry no period. Nothing should nag while a document
  // is genuinely out for signature.
  const s = computePaperworkState({
    leaseEndDate: '2027-08-31',
    documents: [inFlight(null, null)],
  });
  assert.equal(s.needs_document, false);
  assert.equal(s.reason, 'in_flight');
});

test('a signed document with no recorded period asks for the period', () => {
  const s = computePaperworkState({
    leaseEndDate: '2027-08-31',
    documents: [signed(null, null)],
  });
  assert.equal(s.needs_document, true);
  assert.equal(s.reason, 'period_not_recorded');
  assert.equal(s.covered_end, null);
});

test('the latest signed period wins, whatever order the rows arrive in', () => {
  const s = computePaperworkState({
    leaseEndDate: '2026-09-19',
    documents: [signed('2026-08-20', '2026-09-19'), signed('2025-08-20', '2026-08-19')],
  });
  assert.equal(s.needs_document, false);
  assert.equal(s.covered_end, '2026-09-19');
});

test('a cancelled or declined document does not count as coverage', () => {
  // status 4 = declined, 6 = cancelled.
  const s = computePaperworkState({
    leaseEndDate: '2026-09-19',
    documents: [
      signed('2025-08-20', '2026-08-19'),
      { status: 6, term_start: '2026-08-20', term_end: '2026-09-19' },
    ],
  });
  assert.equal(s.needs_document, true);
  assert.equal(s.covered_end, '2026-08-19');
});

test('an open-ended lease is never flagged', () => {
  const s = computePaperworkState({
    leaseEndDate: null,
    documents: [signed('2025-08-20', '2026-08-19')],
  });
  assert.equal(s.needs_document, false);
});

test('bigNumberStrings: a status arriving as a STRING still counts', () => {
  // The pools run with bigNumberStrings, so tinyints can arrive as "3".
  const s = computePaperworkState({
    leaseEndDate: '2026-08-19',
    documents: [{ status: '3', term_start: '2025-08-20', term_end: '2026-08-19' }],
  });
  assert.equal(s.needs_document, false);
  assert.equal(s.reason, 'covered');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run from `backend/`: `node --test test/paperworkPeriod.test.js`
Expected: FAIL — `Cannot find module '../src/utils/paperworkPeriod'`.

- [ ] **Step 3: Write the implementation**

Create `backend/src/utils/paperworkPeriod.js`:

```js
/**
 * Whether a lease's term is covered by signed paperwork, and if not, whether
 * the uncovered stretch is long enough to need a document.
 *
 * Pure — no DB, no Express — so the threshold rule is testable on its own.
 *
 * The rule: an uncovered stretch of A MONTH OR MORE needs a signed document.
 * It is measured from the last SIGNED period, never from the last edit, so a
 * run of short month-to-month rollovers cannot quietly accumulate into an
 * undocumented year.
 */

// Wall-clock YYYY-MM-DD. mysql2 hands back DATE columns as LOCAL-midnight Date
// objects; toISOString() would shift the day west of UTC. Same convention as
// ymd() in services/leaseTemplateVariables.js.
function ymd(v) {
  if (!v) return '';
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return '';
    const p = (n) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  const s = String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

function parts(dateStr) {
  const s = ymd(dateStr);
  if (!s) return null;
  return { y: Number(s.slice(0, 4)), m: Number(s.slice(5, 7)), d: Number(s.slice(8, 10)) };
}

function fromUtc(dt) {
  const p = (n) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

// Calendar arithmetic in UTC so no timezone can shift the resulting date.
function addDays(dateStr, n) {
  const p = parts(dateStr);
  if (!p) return '';
  const dt = new Date(Date.UTC(p.y, p.m - 1, p.d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return fromUtc(dt);
}

// The last day of a one-month period that STARTS on dateStr.
// The day is clamped to the target month's length before subtracting, matching
// defaultStampEndDate, dayjs .add(1,'month') and MySQL DATE_ADD.
function addOneMonthMinusDay(dateStr) {
  const p = parts(dateStr);
  if (!p) return '';
  const targetY = p.m === 12 ? p.y + 1 : p.y;
  const targetM = p.m === 12 ? 1 : p.m + 1;
  const lastDay = new Date(Date.UTC(targetY, targetM, 0)).getUTCDate();
  const dt = new Date(Date.UTC(targetY, targetM - 1, Math.min(p.d, lastDay)));
  dt.setUTCDate(dt.getUTCDate() - 1);
  return fromUtc(dt);
}

const isSigned = (doc) => Number(doc.status) === 3;
const isInFlight = (doc) => Number(doc.status) === 1 || Number(doc.status) === 2;

/**
 * @param {object}   input
 * @param {*}        input.leaseEndDate  leasing.end_date (string, Date or null)
 * @param {Array}    input.documents     [{ status, term_start, term_end }]
 */
function computePaperworkState({ leaseEndDate, documents }) {
  const docs = Array.isArray(documents) ? documents : [];
  const leaseEnd = ymd(leaseEndDate);

  const base = {
    has_documents: docs.length > 0,
    covered_end: null,
    next_period_start: null,
    in_flight: false,
    uncovered: null,
    needs_document: false,
    reason: 'no_documents',
  };

  if (!docs.length) return base;

  const signedEnds = docs.filter(isSigned).map(d => ymd(d.term_end)).filter(Boolean);
  signedEnds.sort();
  const coveredEnd = signedEnds.length ? signedEnds[signedEnds.length - 1] : null;
  base.covered_end = coveredEnd;

  // Something out for signature suppresses the flag — including a request with
  // no recorded period, so pre-existing requests do not nag while in flight.
  base.in_flight = docs.some(d =>
    isInFlight(d) && (!ymd(d.term_end) || (leaseEnd && ymd(d.term_end) >= leaseEnd))
  );
  if (base.in_flight) return { ...base, reason: 'in_flight' };

  // An open-ended lease has no end to measure against.
  if (!leaseEnd) return { ...base, reason: 'covered' };

  // Documented, but we cannot tell which period — ask for it rather than guess.
  if (!coveredEnd) return { ...base, needs_document: true, reason: 'period_not_recorded' };

  if (leaseEnd <= coveredEnd) return { ...base, reason: 'covered' };

  const nextStart = addDays(coveredEnd, 1);
  const threshold = addOneMonthMinusDay(nextStart);
  const long = leaseEnd >= threshold;

  return {
    ...base,
    next_period_start: nextStart,
    uncovered: { from: nextStart, to: leaseEnd },
    needs_document: long,
    reason: long ? 'gap' : 'under_a_month',
  };
}

module.exports = { ymd, addDays, addOneMonthMinusDay, computePaperworkState };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run from `backend/`: `node --test test/paperworkPeriod.test.js`
Expected: PASS, 19 tests.

- [ ] **Step 5: Run the whole suite for regressions**

Run from `backend/`: `npm test`
Expected: 150 existing tests still pass, plus the 19 new ones.

- [ ] **Step 6: Commit**

```bash
git add backend/src/utils/paperworkPeriod.js backend/test/paperworkPeriod.test.js
git commit -m "feat(leasing): paperwork period utility with the one-month threshold"
```

---

### Task 3: Render a document for a specific period

The override that lets one lease produce documents for different periods — and the stamped-date isolation that stops an extension printing the original term's stamped date.

**Files:**
- Modify: `backend/src/services/leasePdfRenderer.js:137` (`renderFromTemplate`) and its `module.exports` at line ~301
- Test: `backend/test/signatureTerm.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `applyTermOverride(ctx, term) -> ctx` — exported for testing; mutates and returns the context
  - `renderFromTemplate({ pool, orgId, leaseId, templateId, stamp, term })` where `term` is `{ start_date, end_date, stamp_end_date? }` or null

- [ ] **Step 1: Write the failing tests**

Create `backend/test/signatureTerm.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { applyTermOverride } = require('../src/services/leasePdfRenderer');
const { effectiveStampEndDate } = require('../src/services/leaseTemplateVariables');

test('no term supplied leaves the context untouched', () => {
  const ctx = { lease: { start_date: '2025-09-01', end_date: '2026-08-19', stamp_end_date: '2027-08-31' } };
  applyTermOverride(ctx, null);
  assert.equal(ctx.lease.start_date, '2025-09-01');
  assert.equal(ctx.lease.end_date, '2026-08-19');
  assert.equal(ctx.lease.stamp_end_date, '2027-08-31');
});

test('a term override replaces the printed period', () => {
  const ctx = { lease: { start_date: '2025-09-01', end_date: '2026-09-19' } };
  applyTermOverride(ctx, { start_date: '2026-08-20', end_date: '2026-09-19' });
  assert.equal(ctx.lease.start_date, '2026-08-20');
  assert.equal(ctx.lease.end_date, '2026-09-19');
});

test('THE BUG: a stored stamped date must not leak into a period document', () => {
  // effectiveStampEndDate returns stamp_end_date || end_date, so the STORED
  // value wins. Overriding only the dates would print the ORIGINAL term's
  // stamped date as the extension's Term of Tenancy — a wrong date on a legal
  // document. The override must null it explicitly.
  const ctx = { lease: { start_date: '2025-09-01', end_date: '2026-09-19', stamp_end_date: '2027-08-31' } };
  applyTermOverride(ctx, { start_date: '2026-08-20', end_date: '2026-09-19' });
  assert.equal(effectiveStampEndDate(ctx.lease), '2026-09-19');
});

test('a stamped term supplied for THIS period is what prints', () => {
  const ctx = { lease: { start_date: '2025-09-01', end_date: '2026-09-19', stamp_end_date: '2027-08-31' } };
  applyTermOverride(ctx, {
    start_date: '2026-08-20', end_date: '2026-09-19', stamp_end_date: '2028-08-19',
  });
  assert.equal(effectiveStampEndDate(ctx.lease), '2028-08-19');
});

test('an incomplete term is ignored rather than half-applied', () => {
  const ctx = { lease: { start_date: '2025-09-01', end_date: '2026-08-19' } };
  applyTermOverride(ctx, { start_date: '2026-08-20' });
  assert.equal(ctx.lease.start_date, '2025-09-01');
  assert.equal(ctx.lease.end_date, '2026-08-19');
});

test('other lease fields survive the override', () => {
  // {{RENT}} deliberately still comes from the lease row, so an extension
  // prints the current rent.
  const ctx = { lease: { start_date: '2025-09-01', end_date: '2026-09-19', amount: 18000 } };
  applyTermOverride(ctx, { start_date: '2026-08-20', end_date: '2026-09-19' });
  assert.equal(ctx.lease.amount, 18000);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run from `backend/`: `node --test test/signatureTerm.test.js`
Expected: FAIL — `applyTermOverride is not a function`.

- [ ] **Step 3: Implement the override**

In `backend/src/services/leasePdfRenderer.js`, add above `renderFromTemplate`:

```js
/**
 * Point a lease context at ONE period of the tenancy, for documents that cover
 * an extension rather than the whole lease.
 *
 * stamp_end_date MUST be set explicitly, never left to fall through:
 * effectiveStampEndDate returns `stamp_end_date || end_date`, so a lease with
 * "Stamp for a longer term" ticked for its ORIGINAL period would otherwise
 * print that original stamped date as the extension's Term of Tenancy.
 *
 * Everything else — rent, tenant, property, unit — deliberately still comes
 * from the lease row.
 */
function applyTermOverride(ctx, term) {
  if (!ctx || !ctx.lease) return ctx;
  if (!term || !term.start_date || !term.end_date) return ctx;
  ctx.lease = {
    ...ctx.lease,
    start_date: term.start_date,
    end_date: term.end_date,
    stamp_end_date: term.stamp_end_date || null,
  };
  return ctx;
}
```

Change the signature at line 137 and apply the override right after the context loads:

```js
async function renderFromTemplate({ pool, orgId, leaseId, templateId, stamp = true, term = null }) {
```

```js
  // Fetch the full lease context
  const ctx = await loadLeaseContext(pool, orgId, leaseId);
  // Documents that cover one period of the tenancy print that period, not the
  // lease's own dates.
  applyTermOverride(ctx, term);
  ctx.realRender = true;
```

Add `applyTermOverride` to `module.exports` alongside `renderFromTemplate`.

- [ ] **Step 4: Run the tests to verify they pass**

Run from `backend/`: `node --test test/signatureTerm.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 5: Verify no regression in whole-lease rendering**

Run from `backend/`: `npm test`
Expected: all pass — in particular `stampEndDate.test.js` and `pickTemplate.test.js`.

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/leasePdfRenderer.js backend/test/signatureTerm.test.js
git commit -m "feat(signature): render a lease document for a single period"
```

---

### Task 4: Store the period when sending for e-signature

**Files:**
- Modify: `backend/src/routes/signature.js:248` (`POST /request`) and `:408` (`GET /lease/:leaseId`)

**Interfaces:**
- Consumes: `renderFromTemplate({ ..., term })` from Task 3.
- Produces: `POST /api/signature/request` additionally accepts `term_start`, `term_end`, `term_stamp_end` (all optional, `YYYY-MM-DD`). `GET /api/signature/lease/:leaseId` additionally returns `term_start`, `term_end`, `term_stamp_end`, `signature_method`, `template_id`.

- [ ] **Step 1: Accept and pass the period**

In `POST /request`, extend the destructure:

```js
    const { lease_id, template_id, landlord_signature_id,
            parties, message, expires_in_days,
            term_start, term_end, term_stamp_end } = req.body || {};
```

Immediately after the existing `parties` validation, normalise and validate the period. A period whose end precedes its start would produce a nonsensical contract:

```js
    // The period this document covers. Optional — a whole-lease document sends
    // none — but if given it must be coherent.
    const termStart = (term_start || '').slice(0, 10) || null;
    const termEnd = (term_end || '').slice(0, 10) || null;
    const termStampEnd = (term_stamp_end || '').slice(0, 10) || null;
    if ((termStart && !termEnd) || (termEnd && !termStart)) {
      return fail(res, 'A document period needs both a start and an end date', 400);
    }
    if (termStart && termEnd && termEnd < termStart) {
      return fail(res, 'The period end cannot be before its start', 400);
    }
```

Pass the term into the render so the PDF prints that period:

```js
    const { pdfBuffer, templateId, version } = await renderer.renderFromTemplate({
      pool: req.pool, orgId, leaseId: lease_id, templateId: template_id,
      term: termStart && termEnd
        ? { start_date: termStart, end_date: termEnd, stamp_end_date: termStampEnd }
        : null,
    });
```

Store the columns on the insert:

```js
    await req.pool.execute(
      `INSERT INTO signature_request
         (id, org_id, lease_id, template_id, template_version, original_file_id,
          landlord_signature_id, token, status, message, expires_at, sent_at, created_by,
          term_start, term_end, term_stamp_end, signature_method)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NOW(), ?, ?, ?, ?, 'esign')`,
      [requestId, orgId, lease_id, templateId, version, fileId,
       resolvedLandlordSigId, token, message || null, expiresAt, userId || null,
       termStart, termEnd, termStampEnd]
    );
```

- [ ] **Step 2: Return the period in the lease listing**

In `GET /lease/:leaseId`, extend the SELECT and format the dates in SQL so no timezone can shift them:

```js
      `SELECT sr.id, sr.status, sr.sent_at, sr.completed_at, sr.expires_at, sr.token,
              sr.original_file_id, sr.signed_file_id, sr.template_id,
              sr.signature_method,
              DATE_FORMAT(sr.term_start, '%Y-%m-%d')     AS term_start,
              DATE_FORMAT(sr.term_end, '%Y-%m-%d')       AS term_end,
              DATE_FORMAT(sr.term_stamp_end, '%Y-%m-%d') AS term_stamp_end,
              (SELECT COUNT(*) FROM signature_party WHERE request_id = sr.id) AS party_count,
              (SELECT COUNT(*) FROM signature_party WHERE request_id = sr.id AND status = 2) AS signed_count
         FROM signature_request sr
        WHERE sr.lease_id = ? AND sr.org_id = ?
        ORDER BY sr.term_start IS NULL, sr.term_start ASC, sr.created_at ASC`,
```

The ordering change is deliberate: documents read chronologically by period, with period-less legacy rows last.

- [ ] **Step 3: Verify by hand**

Start the backend (`npm start` from `backend/`), and with the frontend running send a signature request as normal from Review & Send. It sends no period yet (Task 10 adds the fields), so confirm the request still sends and the PDF still renders exactly as before.

Expected: unchanged behaviour; the new columns are NULL.

- [ ] **Step 4: Run the suite**

Run from `backend/`: `npm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/signature.js
git commit -m "feat(signature): record which period an e-signature request covers"
```

---

### Task 5: Record a lease signed on paper

**Files:**
- Modify: `backend/src/routes/signature.js` — new route declared **before** `GET /request/:id` (line ~382)

**Interfaces:**
- Produces: `POST /api/signature/record-paper` taking `{ lease_id, term_start, term_end, file_id, signed_at, term_stamp_end?, template_id?, note? }` and returning `{ id }`.

- [ ] **Step 1: Write the endpoint**

Insert after the `POST /request` handler and before `GET /request/:id` — static before dynamic:

```js
// POST /api/signature/record-paper — record a lease signed on ink, not e-signed.
//
// Without this the only option was "Cancel Request", which resets the lease to
// signature_status='none' — making an ink-signed lease indistinguishable from
// one nobody ever sent, with no scan stored anywhere.
//
// Creates a fully-signed ledger row with NO signature_party rows. That is safe:
// the public signing URL resolves by PARTY token (resolveTokenContext joins on
// sp.party_token), so a party-less request has no reachable link.
router.post('/record-paper', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const userId = req.user.id;
    const { lease_id, term_start, term_end, term_stamp_end,
            file_id, signed_at, template_id, note } = req.body || {};

    if (!lease_id) return fail(res, 'lease_id is required', 400);
    const termStart = (term_start || '').slice(0, 10) || null;
    const termEnd = (term_end || '').slice(0, 10) || null;
    if (!termStart || !termEnd) {
      return fail(res, 'The period this document covers is required', 400);
    }
    if (termEnd < termStart) {
      return fail(res, 'The period end cannot be before its start', 400);
    }
    const signedAt = (signed_at || '').slice(0, 10) || null;
    if (!signedAt) return fail(res, 'The date it was signed is required', 400);

    // Org-scope the lease. leasing has no org_id — scope via unit -> property.
    const [[lease]] = await req.pool.execute(
      `SELECT l.id FROM leasing l
         JOIN unit u ON l.unit_id = u.id
         JOIN property p ON u.property_id = p.id
        WHERE l.id = ? AND p.org_id = ? AND l.deleted_at IS NULL LIMIT 1`,
      [lease_id, orgId]
    );
    if (!lease) return fail(res, 'Lease not found', 404);

    // The scan is optional, but if given it must belong to this org — a file_id
    // is caller-supplied and must never be trusted across tenants.
    let fileId = file_id || null;
    if (fileId) {
      const [[f]] = await req.pool.execute(
        `SELECT id FROM file WHERE id = ? AND org_id = ? LIMIT 1`, [fileId, orgId]
      );
      if (!f) return fail(res, 'That file was not found', 400);
    }

    // Any in-flight request for this same period is moot now.
    await req.pool.execute(
      `UPDATE signature_request SET status = 6, updated_at = NOW()
        WHERE lease_id = ? AND org_id = ? AND status IN (1, 2)
          AND (term_end IS NULL OR term_end = ?)`,
      [lease_id, orgId, termEnd]
    );

    const requestId = newId();
    await req.pool.execute(
      `INSERT INTO signature_request
         (id, org_id, lease_id, template_id, original_file_id, signed_file_id,
          token, status, signature_method, message,
          term_start, term_end, term_stamp_end, completed_at, created_by)
       VALUES (?, ?, ?, ?, NULL, ?, ?, 3, 'paper', ?, ?, ?, ?, ?, ?)`,
      [requestId, orgId, lease_id, template_id || null, fileId,
       newToken(), note || null, termStart, termEnd,
       (term_stamp_end || '').slice(0, 10) || null, signedAt, userId || null]
    );

    // Audit trail must never imply an e-signature took place.
    await req.pool.execute(
      `INSERT INTO signature_event (id, request_id, event_type, ip, user_agent, metadata)
       VALUES (?, ?, 'completed', ?, ?, ?)`,
      [newId(), requestId, req.ip || null,
       (req.headers['user-agent'] || '').slice(0, 500),
       JSON.stringify({ recorded_manually: true, method: 'paper', signed_at: signedAt })]
    );

    // Keep the lease's own pointer on the most recent signed document, matching
    // what finalizeRequest does for the e-sign path.
    await req.pool.execute(
      `UPDATE leasing SET signature_status = 'signed',
              signed_file_id = COALESCE(?, signed_file_id), signed_at = ?
        WHERE id = ?`,
      [fileId, signedAt, lease_id]
    );

    logActivity(req, { action: 'CREATE', entityType: 'SIGNATURE_REQUEST', entityId: requestId }).catch(() => {});
    ok(res, { id: requestId });
  } catch (err) {
    console.error('[signature] record-paper error:', err);
    fail(res, err.message || 'Failed to record the signed document');
  }
});
```

- [ ] **Step 2: Verify the route resolves before the dynamic one**

Run from `backend/`: `grep -n "router.post('/record-paper'\|router.get('/request/:id'" src/routes/signature.js`
Expected: the `/record-paper` line number is **lower** than the `/request/:id` line number.

- [ ] **Step 3: Verify by hand**

With the backend running and logged in, POST to `/api/signature/record-paper` with a real `lease_id` and a period, no `file_id`. Then query the ledger for that lease.

Expected: 200 with an id; the row has `status=3`, `signature_method='paper'`, the period stored, and no `signature_party` rows.

Then repeat with a `file_id` belonging to a **different** org.
Expected: 400 "That file was not found".

- [ ] **Step 4: Commit**

```bash
git add backend/src/routes/signature.js
git commit -m "feat(signature): record a lease signed on paper against its period"
```

---

### Task 6: Stop cancelling from erasing a genuine signature

**Files:**
- Modify: `backend/src/routes/signature.js:429` (`POST /request/:id/cancel`)
- Test: `backend/test/signatureTerm.test.js` (append)

**Interfaces:**
- Produces: `nextSignatureStatus(rows) -> 'signed' | 'pending' | 'none'`, exported from `signature.js` for testing.

- [ ] **Step 1: Write the failing tests**

Append to `backend/test/signatureTerm.test.js`:

```js
const { nextSignatureStatus } = require('../src/routes/signature');

test('cancelling leaves a genuinely signed lease signed', () => {
  // The bug: cancel hardcoded 'none', so cancelling an extension request would
  // erase "signed" from a lease whose FIRST period really is signed.
  assert.equal(nextSignatureStatus([{ status: 3 }, { status: 6 }]), 'signed');
});

test('another request still in flight keeps the lease pending', () => {
  assert.equal(nextSignatureStatus([{ status: 1 }, { status: 6 }]), 'pending');
});

test('nothing signed and nothing in flight resets to none', () => {
  assert.equal(nextSignatureStatus([{ status: 6 }]), 'none');
});

test('no rows at all resets to none', () => {
  assert.equal(nextSignatureStatus([]), 'none');
});

test('signed wins over in-flight', () => {
  assert.equal(nextSignatureStatus([{ status: 3 }, { status: 2 }]), 'signed');
});

test('bigNumberStrings: statuses arriving as strings still resolve', () => {
  assert.equal(nextSignatureStatus([{ status: '3' }]), 'signed');
  assert.equal(nextSignatureStatus([{ status: '2' }]), 'pending');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run from `backend/`: `node --test test/signatureTerm.test.js`
Expected: FAIL — `nextSignatureStatus is not a function`.

- [ ] **Step 3: Implement it**

In `backend/src/routes/signature.js`, add beside the other helpers near the top:

```js
/**
 * The lease's signature_status implied by its document ledger.
 *
 * Cancelling used to hardcode 'none', which was fine when a lease had one
 * document — but with a document per period it would erase "signed" from a
 * lease whose earlier period genuinely is signed.
 */
function nextSignatureStatus(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (list.some(r => Number(r.status) === 3)) return 'signed';
  if (list.some(r => Number(r.status) === 1 || Number(r.status) === 2)) return 'pending';
  return 'none';
}
```

Replace the reset block at the end of the cancel handler:

```js
    // Recompute the lease's status from the whole ledger rather than assuming
    // 'none' — an earlier period may be legitimately signed.
    const [siblings] = await req.pool.execute(
      `SELECT status FROM signature_request
        WHERE lease_id = ? AND org_id = ? AND id != ?`,
      [r.lease_id, orgId, req.params.id]
    );
    await req.pool.execute(
      `UPDATE leasing SET signature_status = ? WHERE id = ?`,
      [nextSignatureStatus(siblings), r.lease_id]
    );
```

Export it at the bottom of the file — the file currently ends with `module.exports = router;`, so attach the helper to the router object rather than replacing the export:

```js
module.exports = router;
module.exports.nextSignatureStatus = nextSignatureStatus;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run from `backend/`: `node --test test/signatureTerm.test.js`
Expected: PASS, 12 tests.

- [ ] **Step 5: Confirm the route still mounts**

Run from `backend/`: `npm start`
Expected: the server boots with no "Router.use() requires a middleware function" error — attaching a property to the exported router must not break the mount in `src/index.js`.

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/signature.js backend/test/signatureTerm.test.js
git commit -m "fix(signature): cancelling a request no longer erases a signed period"
```

---

### Task 7: Expose documents and the paperwork state on the lease

**Files:**
- Modify: `backend/src/routes/leasing.js:407` (detail GET) and the `PUT /:id` handler (~line 1240-1360)

**Interfaces:**
- Consumes: `computePaperworkState` from Task 2.
- Produces: `GET /api/leasing/:id` returns `documents: [...]` and `paperwork: state`. `PUT /api/leasing/:id` returns `data: { paperwork: state }`.

- [ ] **Step 1: Add a shared loader**

Near the other helpers in `backend/src/routes/leasing.js`, add:

```js
const { computePaperworkState } = require('../utils/paperworkPeriod');

/**
 * The lease's signed-document ledger and whether its term is covered.
 *
 * Tolerates an un-migrated org (033 not yet applied): no ledger means no
 * documents, which reads as "not flagged" — the same as a legacy lease.
 */
async function loadPaperwork(conn, orgId, leaseId, leaseEndDate) {
  let documents = [];
  try {
    const [rows] = await conn.execute(
      `SELECT id, status, signature_method, template_id, signed_file_id,
              DATE_FORMAT(term_start, '%Y-%m-%d')     AS term_start,
              DATE_FORMAT(term_end, '%Y-%m-%d')       AS term_end,
              DATE_FORMAT(term_stamp_end, '%Y-%m-%d') AS term_stamp_end,
              DATE_FORMAT(completed_at, '%Y-%m-%d')   AS completed_at,
              sent_at
         FROM signature_request
        WHERE lease_id = ? AND org_id = ?
        ORDER BY term_start IS NULL, term_start ASC, created_at ASC`,
      [leaseId, orgId]
    );
    documents = rows.map(r => ({ ...r, id: String(r.id) }));
  } catch (e) {
    console.error('[leasing] paperwork lookup skipped:', e.message);
  }
  return { documents, paperwork: computePaperworkState({ leaseEndDate: leaseEndDate, documents }) };
}
```

- [ ] **Step 2: Attach it to the detail GET**

In `router.get('/:id', ...)`, after the `lease.moveout` block:

```js
    // The per-period document ledger + whether the term is covered by signed
    // paperwork. Drives the Documents section and the gap banner.
    const pw = await loadPaperwork(req.pool, orgId, id, lease.end_date);
    lease.documents = pw.documents;
    lease.paperwork = pw.paperwork;
```

- [ ] **Step 3: Return the state from the update**

At the end of the successful `PUT /:id` handler, replace the plain success response so the edit page can prompt without doing any date maths of its own:

```js
    // Server-authoritative: the edit page prompts from THIS, so the prompt and
    // the banner can never disagree about whether paperwork is due.
    const [[fresh]] = await req.pool.execute(
      `SELECT DATE_FORMAT(end_date, '%Y-%m-%d') AS end_date FROM leasing WHERE id = ?`,
      [id]
    );
    const pw = await loadPaperwork(req.pool, orgId, id, fresh ? fresh.end_date : null);
    res.json({ code: 200, message: 'Lease updated', data: { paperwork: pw.paperwork } });
```

- [ ] **Step 4: Verify by hand**

With both servers running, open a lease detail in the browser and inspect the network response for `GET /api/leasing/<id>`.

Expected: `documents: []` and `paperwork.reason === 'no_documents'` on a lease that has never been sent for signature; `needs_document` is `false`.

Then save an unrelated field from the edit page and inspect the `PUT` response.
Expected: `data.paperwork` present.

- [ ] **Step 5: Run the suite**

Run from `backend/`: `npm test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/leasing.js
git commit -m "feat(leasing): expose the document ledger and paperwork state on a lease"
```

---

### Task 8: Flag the gap on the calendar

**Files:**
- Modify: `backend/src/routes/leasing.js` — the calendar route's lease query and per-lease payload (lines ~296-372)

**Interfaces:**
- Consumes: `computePaperworkState` from Task 2.
- Produces: each calendar lease gains `paperwork_gap: Boolean`.

- [ ] **Step 1: Fetch the ledger for the visible leases**

One query for all leases in the window, mirroring how `moveoutByLease` is built. Place it immediately after that block:

```js
    // Per-period signed documents for the leases in view, so the calendar can
    // flag a term that has run past its paperwork.
    const documentsByLease = {};
    if (leaseIds.length > 0) {
      try {
        const leasePlaceholders = leaseIds.map(() => '?').join(',');
        const [docs] = await req.pool.execute(
          `SELECT lease_id, status,
                  DATE_FORMAT(term_start, '%Y-%m-%d') AS term_start,
                  DATE_FORMAT(term_end, '%Y-%m-%d')   AS term_end
             FROM signature_request
            WHERE org_id = ? AND lease_id IN (${leasePlaceholders})`,
          [orgId, ...leaseIds]
        );
        for (const d of docs) {
          const key = String(d.lease_id);
          if (!documentsByLease[key]) documentsByLease[key] = [];
          documentsByLease[key].push(d);
        }
      } catch (e) {
        // signature_request absent or un-migrated on this org — no flags.
        console.error('[leasing/calendar] paperwork lookup skipped:', e.message);
      }
    }
```

- [ ] **Step 2: Add the flag to each lease**

Inside the `for (const lease of leases)` loop, before `leasesByUnit[uid].push({...})`:

```js
      const paperwork = computePaperworkState({
        leaseEndDate: lease.end_date,
        documents: documentsByLease[String(lease.id)] || [],
      });
```

and add to the pushed object, beside `deposit_pending`:

```js
        paperwork_gap: paperwork.needs_document,
```

- [ ] **Step 3: Verify by hand**

Open `/leasing/calendar` and inspect the network response for the calendar request.

Expected: every lease carries `paperwork_gap: false` today, because no lease has any documents yet. A lease that has one is the only way to see `true` — record one with `/record-paper` from Task 5 using a period that ends before the lease does, then reload.

- [ ] **Step 4: Run the suite**

Run from `backend/`: `npm test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/leasing.js
git commit -m "feat(leasing): flag leases whose term outruns their paperwork on the calendar"
```

---

### Task 9: Documents & Signatures section on the lease

**Files:**
- Modify: `frontend/src/lib/api.js:383-399` (the `signature` object)
- Modify: `frontend/src/app/leasing/[id]/detail/page.js` — replaces the existing E-Signature card at ~line 948

**Interfaces:**
- Consumes: `lease.documents` and `lease.paperwork` from Task 7; `POST /api/signature/record-paper` from Task 5.
- Produces: `signature.recordPaper(data)` in `api.js`.

- [ ] **Step 1: Add the API method**

In `frontend/src/lib/api.js`, inside the `signature` object after `listForLease`:

```js
  recordPaper: (data) => api.post('/api/signature/record-paper', data),
```

- [ ] **Step 2: Replace the E-Signature card with the ledger**

In `frontend/src/app/leasing/[id]/detail/page.js`, replace the whole `{(lease?.signature_status && lease.signature_status !== 'none') && (...)}` card (line ~948) with a section driven by the ledger.

Two import lines need exact edits first. Line 5 — add `Upload`:

```jsx
import { Card, Descriptions, Button, Space, Tag, Tabs, Table, message, Input, Divider, Popconfirm, Modal, DatePicker, Alert, Checkbox, InputNumber, Upload } from 'antd';
```

Line 12 — the file API is exported as `file`, so alias it (`signature` is already imported; the path is relative, not `@/lib/api`):

```jsx
import { leasing, pdf, utility, signature, file as fileApi } from '../../../../lib/api';
```

```jsx
{/* Documents & Signatures — one row per period of the tenancy. A tenancy that
    is extended by editing its end date needs a signed document for the new
    period; this is where each one lives, e-signed or signed on paper. */}
{(lease?.documents?.length > 0 || lease?.paperwork?.needs_document) && (
  <Card size="small" title="Documents & Signatures" style={{ marginBottom: 16 }}>
    <Table
      size="small"
      pagination={false}
      rowKey="id"
      dataSource={lease.documents || []}
      columns={[
        {
          title: 'Period',
          key: 'period',
          render: (_, d) => (d.term_start && d.term_end
            ? `${dayjs(d.term_start).format('D MMM YYYY')} – ${dayjs(d.term_end).format('D MMM YYYY')}`
            : <span style={{ color: '#999' }}>Period not recorded</span>),
        },
        {
          title: 'Status',
          key: 'status',
          render: (_, d) => {
            const st = Number(d.status);
            if (st === 3) return <Tag color="green">{d.signature_method === 'paper' ? 'Signed on paper' : 'E-signed'}{d.completed_at ? ` · ${dayjs(d.completed_at).format('D MMM YYYY')}` : ''}</Tag>;
            if (st === 1 || st === 2) return <Tag color="blue">Out for signature</Tag>;
            if (st === 4) return <Tag color="red">Declined</Tag>;
            return <Tag>Cancelled</Tag>;
          },
        },
        {
          title: '',
          key: 'actions',
          align: 'right',
          render: (_, d) => (d.signed_file_id
            ? <Button size="small" onClick={() => window.open(`/api/file/preview/${d.signed_file_id}`, '_blank')}>View PDF</Button>
            : null),
        },
      ]}
    />

    {/* The gap. Only ever shown when the uncovered stretch reaches a month —
        the server decides, so this can never disagree with the prompt. */}
    {lease.paperwork?.needs_document && (
      <Alert
        type="warning"
        showIcon
        style={{ marginTop: 12 }}
        message={lease.paperwork.reason === 'period_not_recorded'
          ? 'A signed document exists but its period was never recorded.'
          : `No signed document covers ${dayjs(lease.paperwork.uncovered?.from).format('D MMM YYYY')} – ${dayjs(lease.paperwork.uncovered?.to).format('D MMM YYYY')}.`}
        action={
          <Space>
            <Button size="small" type="primary" onClick={() => router.push(`/leasing/${leaseId}/review-and-send`)}>Send for e-signature</Button>
            <Button size="small" onClick={() => setPaperOpen(true)}>Record signed on paper</Button>
          </Space>
        }
      />
    )}

    {/* Under a month: informational, never a warning. */}
    {!lease.paperwork?.needs_document && lease.paperwork?.reason === 'under_a_month' && (
      <div style={{ marginTop: 12, color: '#888', fontSize: 12 }}>
        {dayjs(lease.paperwork.uncovered?.from).format('D MMM YYYY')} – {dayjs(lease.paperwork.uncovered?.to).format('D MMM YYYY')} · no paperwork required (under a month)
      </div>
    )}

    <div style={{ marginTop: 12 }}>
      <Button size="small" onClick={() => setPaperOpen(true)}>Record signed on paper</Button>
    </div>
  </Card>
)}
```

- [ ] **Step 3: Add the paper-record modal**

Add the state beside the other `useState` declarations:

```jsx
  const [paperOpen, setPaperOpen] = useState(false);
  const [paperSaving, setPaperSaving] = useState(false);
  const [paperFrom, setPaperFrom] = useState(null);
  const [paperTo, setPaperTo] = useState(null);
  const [paperSignedAt, setPaperSignedAt] = useState(null);
  const [paperFileId, setPaperFileId] = useState(null);
```

Open it prefilled from the server's uncovered period so staff never retype dates:

```jsx
  const openPaperModal = () => {
    const gap = lease?.paperwork?.uncovered;
    setPaperFrom(gap?.from ? dayjs(gap.from) : null);
    setPaperTo(gap?.to ? dayjs(gap.to) : (lease?.end_date ? dayjs(lease.end_date) : null));
    setPaperSignedAt(dayjs());
    setPaperFileId(null);
    setPaperOpen(true);
  };

  const handleRecordPaper = async () => {
    if (!paperFrom || !paperTo) return message.warning('Set the period this document covers.');
    if (!paperSignedAt) return message.warning('Set the date it was signed.');
    setPaperSaving(true);
    try {
      const res = await signature.recordPaper({
        lease_id: leaseId,
        term_start: paperFrom.format('YYYY-MM-DD'),
        term_end: paperTo.format('YYYY-MM-DD'),
        signed_at: paperSignedAt.format('YYYY-MM-DD'),
        file_id: paperFileId,
      });
      if (res.data?.code === 200) {
        message.success('Recorded.');
        setPaperOpen(false);
        loadLease();
      } else {
        message.error(res.data?.message || 'Failed to record');
      }
    } catch (e) {
      message.error(e.response?.data?.message || 'Failed to record');
    } finally {
      setPaperSaving(false);
    }
  };
```

Replace both `onClick={() => setPaperOpen(true)}` in Step 2 with `onClick={openPaperModal}`. Then add the modal beside the move-out modal:

```jsx
<Modal
  title="Record a document signed on paper"
  open={paperOpen}
  onOk={handleRecordPaper}
  confirmLoading={paperSaving}
  okText="Record"
  onCancel={() => setPaperOpen(false)}
>
  <Space direction="vertical" style={{ width: '100%' }} size="middle">
    <div>
      <div style={{ marginBottom: 4 }}>Period this document covers</div>
      <Space>
        <DatePicker value={paperFrom} onChange={setPaperFrom} placeholder="From" />
        <DatePicker value={paperTo} onChange={setPaperTo} placeholder="To" />
      </Space>
    </div>
    <div>
      <div style={{ marginBottom: 4 }}>Date signed</div>
      <DatePicker value={paperSignedAt} onChange={setPaperSignedAt} />
    </div>
    <div>
      <div style={{ marginBottom: 4 }}>Scan (optional)</div>
      <Upload
        maxCount={1}
        customRequest={async ({ file, onSuccess, onError }) => {
          try {
            const fd = new FormData();
            fd.append('file', file);
            const r = await fileApi.upload(fd);
            const id = r.data?.data?.id || r.data?.data;
            setPaperFileId(id);
            onSuccess({ id });
          } catch (e) { onError(e); }
        }}
      >
        <Button size="small">Upload scan</Button>
      </Upload>
    </div>
  </Space>
</Modal>
```

`loadLease` is the existing loader at line 58 — calling it refreshes `lease.documents` and `lease.paperwork` after recording.

- [ ] **Step 4: Build**

Run from `frontend/`: `npm run build`
Expected: builds with no errors. (Do **not** use `npx next lint` — ESLint is unconfigured and prompts interactively.)

- [ ] **Step 5: Verify by hand**

Open a lease detail page.
Expected: no Documents section on a lease with no documents and no gap — exactly as before.

Record a paper document covering a period ending before the lease's end date, with the period at least a month short.
Expected: the section appears, the row reads "Signed on paper", and the warning names the uncovered period.

Record a second one covering the rest.
Expected: the warning disappears, two rows show in period order.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/api.js "frontend/src/app/leasing/[id]/detail/page.js"
git commit -m "feat(leasing): documents and signatures section with paper recording"
```

---

### Task 10: Period and stamped term on Review & Send

**Files:**
- Modify: `frontend/src/app/leasing/[id]/review-and-send/page.js:147` (the `createRequest` call) and its form area

**Interfaces:**
- Consumes: `POST /api/signature/request` accepting `term_start`/`term_end`/`term_stamp_end` from Task 4; `lease.paperwork` from Task 7.

- [ ] **Step 1: Add the state, prefilled from the server's uncovered period**

```jsx
  const [termFrom, setTermFrom] = useState(null);
  const [termTo, setTermTo] = useState(null);
  const [stampLonger, setStampLonger] = useState(false);
  const [termStampEnd, setTermStampEnd] = useState(null);
```

Where the lease loads, prefill from `paperwork.uncovered`, falling back to the whole lease:

```jsx
      const gap = data.paperwork?.uncovered;
      setTermFrom(dayjs(gap?.from || data.start_date));
      setTermTo(dayjs(gap?.to || data.end_date));
```

- [ ] **Step 2: Add the fields**

Place above the signers list:

```jsx
<Card size="small" title="Period this document covers" style={{ marginBottom: 16 }}>
  <Space wrap>
    <DatePicker value={termFrom} onChange={setTermFrom} placeholder="From" />
    <DatePicker value={termTo} onChange={setTermTo} placeholder="To" />
  </Space>
  <div style={{ fontSize: 12, color: '#888', marginTop: 8 }}>
    The contract prints these dates as its term. For an extension this starts the
    day after the last signed period ended.
  </div>
  <div style={{ marginTop: 12 }}>
    <Checkbox
      checked={stampLonger}
      onChange={(e) => {
        setStampLonger(e.target.checked);
        // +2 years - 1 day from the period start, matching the lease form.
        setTermStampEnd(e.target.checked && termFrom
          ? termFrom.add(2, 'year').subtract(1, 'day') : null);
      }}
    >
      Stamp this period for a longer term
    </Checkbox>
    {stampLonger && (
      <div style={{ marginTop: 8 }}>
        <DatePicker value={termStampEnd} onChange={setTermStampEnd} />
      </div>
    )}
  </div>
</Card>
```

- [ ] **Step 3: Send them**

Extend the `createRequest` payload:

```jsx
      const r = await signature.createRequest({
        lease_id: leaseId,
        template_id: selectedTemplateId,
        landlord_signature_id: selectedLandlordSigId || null,
        parties: cleanParties,
        message: msg || null,
        expires_in_days: exp,
        term_start: termFrom ? termFrom.format('YYYY-MM-DD') : null,
        term_end: termTo ? termTo.format('YYYY-MM-DD') : null,
        term_stamp_end: stampLonger && termStampEnd ? termStampEnd.format('YYYY-MM-DD') : null,
      });
```

- [ ] **Step 4: Build**

Run from `frontend/`: `npm run build`
Expected: builds clean.

- [ ] **Step 5: Verify the printed dates**

On a lease with an uncovered period, open Review & Send.
Expected: the period prefills to the uncovered stretch, not the whole lease.

Preview the PDF.
Expected: the contract's term reads the period's dates. On a lease that has "Stamp for a longer term" ticked at lease level, confirm the Term of Tenancy shows the **period's** end and not the lease's stored stamped date — this is the bug Task 3 exists to prevent.

- [ ] **Step 6: Commit**

```bash
git add "frontend/src/app/leasing/[id]/review-and-send/page.js"
git commit -m "feat(leasing): choose the period and stamped term when sending for signature"
```

---

### Task 11: Prompt after extending

**Files:**
- Modify: `frontend/src/app/leasing/[id]/edit/page.js:263-335` (`onFinish`)

**Interfaces:**
- Consumes: `data.paperwork` on the `PUT /api/leasing/:id` response from Task 7.

- [ ] **Step 1: Capture the end date the page loaded with**

Beside the other state:

```jsx
  // The end date as it was BEFORE this edit, so we can tell an extension from
  // any other change. Set once when the lease loads.
  const [loadedEndDate, setLoadedEndDate] = useState(null);
```

Where the lease is loaded into the form (near line 239):

```jsx
        setLoadedEndDate(d.end_date ? dayjs(d.end_date).format('YYYY-MM-DD') : null);
```

- [ ] **Step 2: Prompt on a successful extension**

Replace the success branch in `onFinish`:

```jsx
      const res = await leasing.update(leaseId, payload);
      if (res.data.code === 200) {
        message.success('Lease updated successfully');

        // Only when the term actually grew, and only when the SERVER says the
        // uncovered stretch is long enough to need paperwork. No date maths
        // here — the prompt and the banner must never disagree.
        const newEnd = values.end_date ? values.end_date.format('YYYY-MM-DD') : null;
        const extended = !!(newEnd && loadedEndDate && newEnd > loadedEndDate);
        const pw = res.data.data?.paperwork;
        if (extended && pw?.needs_document && pw.uncovered) {
          Modal.confirm({
            title: 'Paperwork for the extended term',
            content: `No signed document covers ${dayjs(pw.uncovered.from).format('D MMM YYYY')} – ${dayjs(pw.uncovered.to).format('D MMM YYYY')}.`,
            okText: 'Send for e-signature',
            cancelText: 'Later',
            onOk: () => router.push(`/leasing/${leaseId}/review-and-send`),
            onCancel: () => router.push(`/leasing/${leaseId}/detail`),
          });
          return;
        }
        router.push('/leasing');
      } else {
```

Confirm `Modal` is in the `antd` import for this file; add it if not.

- [ ] **Step 3: Build**

Run from `frontend/`: `npm run build`
Expected: builds clean.

- [ ] **Step 4: Verify all three paths by hand**

On a lease with a signed document covering to a given date:

1. Extend the end date by two months, save. Expected: the prompt appears naming the uncovered period; "Later" lands on the detail page with the banner showing.
2. Extend by two weeks, save. Expected: **no prompt** — under a month; the detail page shows the grey informational line.
3. Change the rent without touching the end date, save. Expected: no prompt, and it returns to `/leasing` as before.

On a lease with **no** documents, extend by a year and save.
Expected: no prompt — undocumented leases stay opted out.

- [ ] **Step 5: Commit**

```bash
git add "frontend/src/app/leasing/[id]/edit/page.js"
git commit -m "feat(leasing): prompt for extension paperwork after pushing an end date out"
```

---

### Task 12: Calendar marker, filter, and spec reconciliation

**Files:**
- Modify: `frontend/src/app/leasing/calendar/page.js` — the tooltip/cell markers, the legend, and the Lease Status filter
- Modify: `docs/superpowers/specs/2026-08-07-lease-extension-paperwork-design.md`

**Interfaces:**
- Consumes: `paperwork_gap` on each calendar lease from Task 8.

- [ ] **Step 1: Add the marker**

Beside the existing `*PENDING*` / `*UNCONFIRMED*` markers, following the same pattern. Note the existing ordering rule: the draft test runs first because the API's `unconfirmed` flag covers both cases.

```jsx
{l.paperwork_gap && <span style={{ color: '#fa8c16', fontWeight: 600 }}>*UNSIGNED PERIOD*</span>}
```

Add a legend entry reading "Unsigned period — the term runs past its paperwork".

- [ ] **Step 2: Add the filter option**

Extend the `matchesLeaseStatus` helper:

```jsx
const matchesLeaseStatus = (unit, want) => (unit.leases || []).some(l => {
  const isDraft = l.lease_state === 'pending';
  if (want === 'unconfirmed') return isDraft;
  if (want === 'pending') return !isDraft && !!l.unconfirmed;
  if (want === 'deposit_due') return !!l.deposit_pending;
  if (want === 'paperwork_gap') return !!l.paperwork_gap;
  return false;
});
```

Add the option to the Lease Status select, labelled **"Paperwork gap"**.

- [ ] **Step 3: Build**

Run from `frontend/`: `npm run build`
Expected: builds clean.

- [ ] **Step 4: Verify by hand**

Open `/leasing/calendar` with a lease that has a recorded gap.
Expected: the marker shows on that unit; selecting Lease Status → Paperwork gap narrows to it; properties with no matching unit drop out.

**If a change looks "not applied", check the built bundle before re-investigating** — this has twice been stale browser cache:

```bash
grep -rl "UNSIGNED PERIOD" frontend/.next/static/chunks/app/leasing/calendar/
```

If it is present, hard-refresh rather than debugging the code.

- [ ] **Step 5: Reconcile the spec**

In the spec's threshold section, replace the sentence requiring a shared client/server helper with what was actually built:

```markdown
Calendar-month arithmetic, clamped the same way as `defaultStampEndDate` (31 Jan + 1
month → 28 Feb), and computed **only on the server**. `PUT /api/leasing/:id` returns the
recomputed `paperwork` state and the edit page prompts from that — no date arithmetic on
the client, so the prompt and the banner cannot drift apart.
```

- [ ] **Step 6: Run the whole suite one last time**

Run from `backend/`: `npm test`
Expected: 150 pre-existing tests plus 31 new ones pass.

- [ ] **Step 7: Commit**

```bash
git add "frontend/src/app/leasing/calendar/page.js" docs/superpowers/specs/2026-08-07-lease-extension-paperwork-design.md
git commit -m "feat(leasing): paperwork-gap marker and filter on the lease calendar"
```

---

## Deployment

**Do not deploy without asking.** When the user authorises it, the order matters — the migration must land before the code that reads the new columns:

1. Ask for permission to push. Push.
2. Ask for permission to deploy. On the droplet: pull, `npm run migrate:orgs` from `backend/`, restart the backend, rebuild the frontend.
3. Verify on prod: open a lease with no documents (expect no Documents section), then record one paper document and confirm the ledger and gap behave.

## Not in this plan

- **Unit-detail lease history** — approved as a separate change (see the spec's follow-up section). `GET /api/property/unit/:unit_id/current-lease` returns only one current and one future lease, so a unit shows no past tenancies.
- Writing a period's stamped term back onto `leasing.stamp_end_date`.
- Any recital of earlier terms on an extension document.
- Backfilling periods onto existing signature requests.
