const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Tenant portal showed LEA3402 (1–31 Jan 2027) as "Dec 31, 2026 – Jan 30, 2027"
// on a phone in an American timezone: new Date('2027-01-01') is midnight UTC and
// toLocaleDateString moved it back a day. The fix formats the stored calendar
// date as-is. Each check runs in a child process with TZ set, because the bug
// only shows in timezones behind UTC.

const FRONTEND = path.join(__dirname, '../../frontend/src');
const HELPER = path.join(FRONTEND, 'lib/dateOnly.js');
const PORTAL_PAGES = ['leases', 'invoices', 'dashboard']
  .map(p => path.join(FRONTEND, `app/tenant-portal/${p}/page.js`));

function formatIn(tz, expr) {
  const src = fs.readFileSync(HELPER, 'utf8');
  const script = `
    import(${JSON.stringify('data:text/javascript,' + encodeURIComponent(src))})
      .then(({ formatDateOnly }) => process.stdout.write(JSON.stringify(${expr})));`;
  return JSON.parse(execFileSync(process.execPath, ['-e', script], { env: { ...process.env, TZ: tz } }).toString());
}

const ZONES = ['Asia/Hong_Kong', 'Europe/London', 'America/New_York', 'America/Los_Angeles', 'Pacific/Honolulu', 'Pacific/Kiritimati'];

test('the old formatting reproduces the bug in a timezone behind UTC', () => {
  const out = execFileSync(process.execPath,
    ['-e', "process.stdout.write(new Date('2027-01-01').toLocaleDateString('en-US',{year:'numeric',month:'short',day:'numeric'}))"],
    { env: { ...process.env, TZ: 'America/Los_Angeles' } }).toString();
  assert.equal(out, 'Dec 31, 2026');
});

test('LEA3402 shows 1 Jan – 31 Jan 2027 in every timezone', () => {
  for (const tz of ZONES) {
    const [start, end] = formatIn(tz, "[formatDateOnly('2027-01-01'), formatDateOnly('2027-01-31')]");
    assert.equal(start, 'Jan 1, 2027', tz);
    assert.equal(end, 'Jan 31, 2027', tz);
  }
});

test('long month, fallbacks and odd input', () => {
  const r = formatIn('America/Los_Angeles', `[
    formatDateOnly('2026-11-06', { month: 'long' }),
    formatDateOnly(null), formatDateOnly('', { fallback: '-' }), formatDateOnly('not a date'),
  ]`);
  assert.deepEqual(r, ['November 6, 2026', 'N/A', '-', 'not a date']);
});

test('no tenant portal page formats a date through new Date(...).toLocaleDateString', () => {
  for (const page of PORTAL_PAGES) {
    const src = fs.readFileSync(page, 'utf8');
    assert.doesNotMatch(src, /new Date\([^)]*\)\.toLocaleDateString/, page);
    assert.match(src, /formatDateOnly/, page);
  }
});

test('the portal lease list sends the rent the page displays', () => {
  const route = fs.readFileSync(path.join(__dirname, '../src/routes/tenantPortal.js'), 'utf8');
  const leases = route.slice(route.indexOf("router.get('/leases'"));
  assert.match(leases.slice(0, 800), /l\.amount AS rent_amount/);
  const page = fs.readFileSync(PORTAL_PAGES[0], 'utf8');
  assert.match(page, /dataIndex: 'rent_amount'/);
});
