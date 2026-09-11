/**
 * The booking platform on the utility screens, and one eligibility filter.
 *
 * Two changes, both about not making someone re-derive what the system knows:
 *
 *   1. The Report showed a unit and a tenant but not which platform the tenant
 *      came through, so telling an Airbnb guest from a long-term tenant meant
 *      opening the lease. 469 of 502 bill lines resolve to a platform, so the
 *      column is nearly always populated.
 *
 *   2. The Generate Invoices modal opened with everyone already ticked, but its
 *      instruction ("Uncheck tenants who should not be billed, e.g. Airbnb/Agoda")
 *      asked for an audit of the list on every run. The utility credit is what
 *      actually excludes OTA guests — all 9 live Airbnb leases carry 1000-1500 —
 *      and a line whose credit covers its usage never reaches the modal, because
 *      eligibility requires net_amount > 0.
 *
 * The eligibility filter existed twice in the page: once to pre-tick the rows and
 * once to build the table. Two copies can drift, and the failure is silent — the
 * modal would pre-tick a set that isn't the set displayed.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// Line comments FIRST, or a "/*" inside one opens a phantom block comment.
const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');
const stripComments = (src) =>
  src.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

const route = () => stripComments(read('../src/routes/utility.js'));

// Slice a single route handler out of the file. An unbounded slice(indexOf(..))
// runs to EOF and picks up joins belonging to later routes, which is how the
// "both joins are LEFT" check first passed against the wrong text.
const routeBlock = (src, start, end) => {
  const from = src.indexOf(start);
  assert.ok(from !== -1, `route not found: ${start}`);
  const to = src.indexOf(end, from);
  assert.ok(to !== -1, `end marker not found after ${start}: ${end}`);
  return src.slice(from, to);
};
const page = () => stripComments(read('../../frontend/src/app/utilities/page.js'));

// ── the platform reaches the report ─────────────────────────────────────────

test('the report joins the lease through to its booking platform', () => {
  const src = route();
  const report = routeBlock(src, "router.get('/report'", "router.get('/highest-rate'");
  assert.match(report, /LEFT JOIN leasing l ON bl\.leasing_id = l\.id/,
    'bill lines carry leasing_id; that is the only route to the platform');
  assert.match(report, /LEFT JOIN booking_platform bp ON l\.booking_platform_id = bp\.id/);
  assert.match(report, /bp\.name AS booking_platform/);
});

test('both joins are LEFT, so a line with no lease still appears', () => {
  // 20 of 502 bill lines have no leasing_id and 33 resolve to no platform. An
  // inner join would drop those units out of the report entirely.
  const src = route();
  const report = routeBlock(src, "router.get('/report'", "router.get('/highest-rate'");
  assert.ok(!/\n\s+JOIN leasing/.test(report),
    'an inner join to leasing would hide unleased meters');
  assert.ok(!/\n\s+JOIN booking_platform/.test(report),
    'an inner join to booking_platform would hide lines with no platform set');
});

test('the platform is set beside tenant_name, inheriting its most-recent rule', () => {
  // Lines are ordered by period_end DESC and only the FIRST per meter builds the
  // header. Setting the platform anywhere else would let an older bill's lease
  // caption the current tenant.
  const src = route();
  const header = src.slice(src.indexOf('unitMap[key] = {'), src.indexOf('months: {},'));
  assert.match(header, /tenant_name: tenantName \|\| null/);
  assert.match(header, /booking_platform: line\.booking_platform \|\| null/,
    'the platform must be captured in the same first-line-wins block as the tenant');
});

test('the bill detail query exposes the platform for the modal', () => {
  const src = route();
  const detail = routeBlock(src, "router.get('/bill/:id'", "router.post('/bill'");
  assert.match(detail, /bp\.name AS booking_platform/);
  assert.match(detail, /LEFT JOIN booking_platform bp ON l\.booking_platform_id = bp\.id/);
});

// ── the report shows it ─────────────────────────────────────────────────────

test('both the desktop report and the mobile card render the platform', () => {
  const src = page();
  const matches = src.match(/unit\.booking_platform/g) || [];
  assert.ok(matches.length >= 2,
    `desktop and mobile both need it, found ${matches.length}`);
});

test('a unit with no platform renders nothing rather than "null"', () => {
  const src = page();
  assert.ok(!/\{unit\.booking_platform\}(?!\s*<\/div>)/.test(src.replace(/unit\.booking_platform &&[\s\S]{0,200}?\{unit\.booking_platform\}/g, '')),
    'every render of the platform must be guarded');
  const guards = src.match(/unit\.booking_platform && \(/g) || [];
  assert.ok(guards.length >= 2, 'both renders must be guarded by &&');
});

test('the report search matches on the platform too', () => {
  const src = page();
  assert.match(src, /\(u\.booking_platform \|\| ''\)\.toLowerCase\(\)\.includes\(q\)/,
    'typing "airbnb" should filter the report');
});

// ── the modal ───────────────────────────────────────────────────────────────

test('the modal no longer asks for an OTA audit on every run', () => {
  const src = page();
  assert.ok(!/Uncheck tenants who should not be billed/.test(src),
    'the instruction that made this a per-run chore is gone');
  assert.ok(!/e\.g\. Airbnb\/Agoda/.test(src));
});

test('the modal states how many will be billed and for how much', () => {
  const src = page();
  assert.match(src, /selectedLineIds\.length/);
  assert.match(src, /selectedTotal/);
});

test('the summary total is ceiled, matching what the invoice is raised at', () => {
  // The backend writes Math.ceil(net_amount) into invoice.amount. Summing the raw
  // net here would quote a total nobody is ever charged.
  const src = page();
  assert.match(src, /reduce\(\(sum, l\) => sum \+ Math\.ceil\(Number\(l\.net_amount\)\), 0\)/);
});

test('the modal shows the platform, so an OTA guest is identifiable in place', () => {
  const src = page();
  assert.match(src, /dataIndex: 'booking_platform'/);
});

// ── one eligibility filter ──────────────────────────────────────────────────

test('eligibility is defined once and used for both the pre-tick and the table', () => {
  const src = page();
  assert.match(src, /const isEligibleForInvoice = \(l\) =>/);
  const uses = src.match(/isEligibleForInvoice/g) || [];
  assert.ok(uses.length >= 3,
    `one definition plus at least two uses, found ${uses.length}`);
  assert.match(src, /setSelectedLineIds\(eligible\.map\(l => l\.id\)\)/);
  assert.match(src, /dataSource=\{eligibleLines\}/,
    'the table must not re-derive its own filter');
});

test('the shared filter matches the backend WHERE clause', () => {
  const src = page();
  const filter = src.slice(src.indexOf('const isEligibleForInvoice'));
  const body = filter.slice(0, filter.indexOf(';'));
  // is_common_area = 0 AND net_amount > 0 AND invoice_id IS NULL AND tenant_id IS NOT NULL
  assert.match(body, /!Number\(l\.is_common_area\)/);
  assert.match(body, /Number\(l\.net_amount\) > 0/);
  assert.match(body, /!l\.invoice_id/);
  assert.match(body, /l\.tenant_id/);

  const route_src = route();
  const gen = routeBlock(route_src, "generate-invoices'", "router.delete('/bill/:id'");
  assert.match(gen, /bl\.is_common_area = 0 AND bl\.net_amount > 0 AND bl\.invoice_id IS NULL AND bl\.tenant_id IS NOT NULL/,
    'if the backend filter changes, isEligibleForInvoice must change with it');
});

test('generation still posts explicit line_ids', () => {
  // The checkboxes remain usable: everyone is ticked by default, but unticking
  // someone must still narrow what the backend generates.
  const src = page();
  assert.match(src, /utility\.generateInvoices\(selectedBill, \{ line_ids: selectedLineIds \}\)/);
  const route_src = route();
  const gen = routeBlock(route_src, "generate-invoices'", "router.delete('/bill/:id'");
  assert.match(gen, /Array\.isArray\(line_ids\) && line_ids\.length > 0/,
    'the backend must keep honouring the narrowed list');
});
