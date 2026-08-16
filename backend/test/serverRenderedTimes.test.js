/**
 * Times the SERVER renders — PDFs, chatbot answers, LLM prompts.
 *
 * A stored instant is correct wherever it is read from; the browser converts it
 * to the viewer's zone automatically. Anything the server renders itself does not
 * get that conversion, so it comes out in the server's zone (UTC) — a London
 * reading for a Hong Kong reader, and the wrong DATE between midnight and 08:00.
 *
 * The instant used throughout is 16:05 UTC, which is 00:05 the NEXT day in Hong
 * Kong. It is the only kind of instant that can tell the two apart.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  orgWallClock, orgUtcOffsetSeconds, orgTimeSql, ORG_TIME_ZONE,
} = require('../src/utils/orgTime');

const STRADDLE = new Date('2026-08-15T16:05:00Z');

test('Hong Kong is 8 hours ahead, expressed in seconds for SQL', () => {
  assert.equal(orgUtcOffsetSeconds(STRADDLE), 8 * 3600);
});

test('orgTimeSql shifts by the operator offset MINUS the connection offset', () => {
  // Written against the session's own offset rather than assuming UTC, so it
  // stays correct if the MySQL session timezone is ever changed — which is a
  // live possibility, not a hypothetical.
  const sql = orgTimeSql('s.created_at', STRADDLE);
  assert.match(sql, /s\.created_at/);
  assert.match(sql, /28800/);
  assert.match(sql, /TIMESTAMPDIFF\(SECOND, UTC_TIMESTAMP\(\), NOW\(\)\)/);
  // On a UTC connection TIMESTAMPDIFF is 0, so the net shift is +8h.
  assert.match(sql, /INTERVAL \(28800 - TIMESTAMPDIFF/);
});

test('orgTimeSql does not use CONVERT_TZ with named zones', () => {
  // CONVERT_TZ returns NULL — silently, no error — unless the server's timezone
  // tables have been populated, which they are not here. A NULL date would read
  // as "never" rather than as a failure.
  assert.ok(!/CONVERT_TZ/.test(orgTimeSql('x', STRADDLE)));
});

// ---------------------------------------------------------------------------
// The LLM that reads WhatsApp threads to extract inquiry details.
// ---------------------------------------------------------------------------

const { transcriptToText } = require('../src/services/inquiryExtractor');

test('the transcript handed to the LLM is timestamped in Hong Kong', () => {
  const out = transcriptToText([
    { role: 'user', created_at: STRADDLE, content: 'can I view it tomorrow?' },
  ]);
  // 16:05 UTC on the 15th is 00:05 on the 16th in Hong Kong. If the model is told
  // "15 Aug 16:05", its idea of "tomorrow" is off by a day.
  assert.match(out, /2026-08-16 00:05/, `expected Hong Kong time, got: ${out}`);
  assert.ok(!out.includes('2026-08-15 16:05'), 'must not hand the model UTC');
});

test('the transcript labels the zone, so the model cannot assume UTC', () => {
  const out = transcriptToText([{ role: 'user', created_at: STRADDLE, content: 'hi' }]);
  assert.match(out, /HKT/, 'the timestamp should say which zone it is in');
});

test('a message with no timestamp still renders', () => {
  const out = transcriptToText([{ role: 'user', created_at: null, content: 'hello' }]);
  assert.match(out, /PROSPECT\] hello/);
});

test('system and tool messages stay excluded', () => {
  const out = transcriptToText([
    { role: 'system', created_at: STRADDLE, content: 'you are a bot' },
    { role: 'user', created_at: STRADDLE, content: 'hi' },
  ]);
  assert.ok(!out.includes('you are a bot'));
});

// ---------------------------------------------------------------------------
// Invoice PDFs — customer facing.
// ---------------------------------------------------------------------------

// Rendering the invoice needs the process timezone pinned, so run it in a child
// with TZ set. Without that this test is only able to fail on a machine that is not
// already in Hong Kong: the unfixed formatter inherits the process zone, so on a
// Hong Kong laptop it produces the right answer by accident and the revert slips
// through. Production is UTC, which is the case that has to be proven.
function renderDateLineUnderTz(tz) {
  const { execFileSync } = require('child_process');
  const script = `
    const { renderInvoicePdf } = require('${require('path').join(__dirname, '..', 'src/routes/pdf').replace(/\\/g, '/')}');
    const emitted = [];
    const doc = new Proxy({}, { get: (_t, p) => {
      if (p === 'page') return { width: 595, height: 842 };
      return (...a) => { if (p === 'text') emitted.push(String(a[0])); return doc; };
    }});
    renderInvoicePdf(doc, {
      inv: { invoice_code: 'TRIV1', amount: 100, status: 0,
             created_at: new Date('2026-08-15T16:05:00Z'), due_on: new Date(2026, 8, 1) },
      org: {}, amountTotal: 100, amountPaid: 0, outstanding: 100,
    });
    process.stdout.write(emitted.find(t => t.startsWith('Date:')) || 'NO DATE LINE');
  `;
  return execFileSync(process.execPath, ['-e', script], {
    env: { ...process.env, TZ: tz }, encoding: 'utf8',
  }).trim();
}

test('the real invoice PDF renderer prints the Hong Kong date, on a UTC server', () => {
  // Drives renderInvoicePdf() itself, so reverting pdf.js makes this fail. An
  // earlier version re-implemented fmtInstant locally and would have passed
  // against the unfixed code entirely.
  assert.equal(renderDateLineUnderTz('UTC'), 'Date: August 16, 2026',
    'an invoice created at 00:05 Hong Kong must not be dated the previous day');
});

test('...and the same answer on a Hong Kong server', () => {
  // The output must not depend on where the process happens to run.
  assert.equal(renderDateLineUnderTz('Asia/Hong_Kong'), 'Date: August 16, 2026');
});

test('the invoice PDF does NOT timezone-shift the due date', () => {
  // due_on is a bare calendar date. Pushing it through a zone conversion is how a
  // due date slides a day, so the fix must be confined to the instant.
  const { renderInvoicePdf } = require('../src/routes/pdf');
  const emitted = [];
  const doc = new Proxy({}, {
    get: (_t, prop) => {
      if (prop === 'page') return { width: 595, height: 842 };
      return (...a) => { if (prop === 'text') emitted.push(String(a[0])); return doc; };
    },
  });
  renderInvoicePdf(doc, {
    inv: { invoice_code: 'TRIV2', amount: 100, status: 0, created_at: null, due_on: new Date(2026, 7, 16) },
    org: {}, amountTotal: 100, amountPaid: 0, outstanding: 100,
  });
  assert.ok(emitted.includes('Date: August 16, 2026'),
    `due_on fallback must stay on its own date. Got: ${emitted.filter(t => t.startsWith('Date')).join(' | ')}`);
});

test('a plain DATE keeps its own value and is not shifted by a zone', () => {
  // due_on is a calendar date with no time and no zone. mysql2 hands it over as
  // LOCAL midnight, so it must be read back with the local getters — pushing it
  // through a timezone conversion is how a due date slides a day.
  const { dbDate } = require('../src/utils/orgTime');
  assert.equal(dbDate(new Date(2026, 7, 16)), '2026-08-16');
});

// ---------------------------------------------------------------------------
// The staff chatbot. These drive the REAL tool `execute()` against a fake pool and
// assert the SQL it actually sends — an earlier version only checked what
// orgTimeSql() returned in isolation, which would have passed even if none of the
// four call sites used it.
// ---------------------------------------------------------------------------

const { ALL_BY_NAME } = require('../src/services/chatTools');

function capturingPool() {
  const queries = [];
  return {
    queries,
    execute: async (sql, params = []) => { queries.push(sql); return [[]]; },
    query:   async (sql, params = []) => { queries.push(sql); return [[]]; },
  };
}

test('search_services converts created_at to Hong Kong in the SQL it runs', async () => {
  const pool = capturingPool();
  await ALL_BY_NAME.search_services.execute({ pool, orgId: 'ORG' }, {});
  const sql = pool.queries.join('\n');
  assert.match(sql, /DATE_FORMAT\(DATE_ADD\(s\.created_at, INTERVAL \(28800 -/,
    `created_at must be shifted to Hong Kong. SQL was:\n${sql}`);
  assert.ok(!/DATE_FORMAT\(s\.created_at,/.test(sql),
    'the raw server-clock rendering of created_at must be gone');
});

test('search_services leaves the appointment dates alone', async () => {
  // service_date_start/end are DATETIME holding Hong Kong wall clock already.
  // Shifting those would move every scheduled job eight hours.
  const pool = capturingPool();
  await ALL_BY_NAME.search_services.execute({ pool, orgId: 'ORG' }, {});
  const sql = pool.queries.join('\n');
  assert.match(sql, /DATE_FORMAT\(s\.service_date_start, '%Y-%m-%d'\)/,
    'service_date_start must NOT be timezone-shifted');
  assert.match(sql, /DATE_FORMAT\(s\.service_date_end,\s+'%Y-%m-%d'\)/,
    'service_date_end must NOT be timezone-shifted');
});


// ---------------------------------------------------------------------------
// Signature completion date — a TIMESTAMP rendered into the lease detail payload.
// ---------------------------------------------------------------------------

test('the signature request query converts completed_at to Hong Kong', async () => {
  // leasing.js builds this SQL inline; capture it by driving the route's pool.
  // Asserted on the SQL rather than a rendered string because the value goes
  // straight to the client as text.
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '../src/routes/leasing.js'), 'utf8');
  const line = src.split('\n').find(l => l.includes('AS completed_at'));
  assert.ok(line, 'expected a completed_at projection in leasing.js');
  assert.match(line, /orgTimeSql\('completed_at'\)/,
    'completed_at is a TIMESTAMP and must be converted before DATE_FORMAT');
  // term_* are DATE columns in the same SELECT and must stay untouched.
  const termLine = src.split('\n').find(l => l.includes('AS term_start'));
  assert.ok(termLine && !termLine.includes('orgTimeSql'),
    'term_start is a DATE and must NOT be timezone-shifted');
});

// ---------------------------------------------------------------------------
// Inquiry note stamps.
// ---------------------------------------------------------------------------

const { appendDiffToNotes } = require('../src/services/inquiryExtractor');

test('appended inquiry notes are dated by the Hong Kong clock', () => {
  const notes = appendDiffToNotes('', ['Budget updated to $10,000'], STRADDLE);
  assert.match(notes, /2026-08-16/, `expected the Hong Kong date, got: ${notes}`);
  assert.ok(!notes.includes('2026-08-15'), 'must not stamp the UTC date');
});

// ---------------------------------------------------------------------------
// The lease PDF renderer's ESM dependency.
// ---------------------------------------------------------------------------

test('puppeteer loads through import(), not require()', async () => {
  // puppeteer is ESM. A require() of it throws ERR_REQUIRE_ESM below Node 22.12,
  // and moving that require inside the function only defers the same throw to the
  // first render — which is exactly the bug this replaced.
  const { loadPuppeteer } = require('../src/services/leasePdfRenderer');
  const p = await loadPuppeteer();
  assert.equal(typeof p.launch, 'function',
    'the loader must resolve to the puppeteer namespace default, which carries launch()');
});

test('the puppeteer loader caches one promise for concurrent callers', async () => {
  const { loadPuppeteer } = require('../src/services/leasePdfRenderer');
  const [a, b] = await Promise.all([loadPuppeteer(), loadPuppeteer()]);
  assert.equal(a, b, 'concurrent first calls must share one load, not race');
});

test('nothing in the renderer reaches for puppeteer via require()', () => {
  // The behavioural test above exercises loadPuppeteer() directly, so on its own it
  // stays green even if getBrowser() goes back to require('puppeteer') — which is
  // the exact regression that shipped once already. Actually calling getBrowser()
  // would launch Chromium, so guard the footgun by name instead: a require() of
  // this ESM package throws ERR_REQUIRE_ESM below Node 22.12, at first render.
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '../src/services/leasePdfRenderer.js'), 'utf8');
  const offenders = src.split('\n')
    .map((l, i) => [l, i + 1])
    .filter(([l]) => /require\(\s*['"]puppeteer['"]\s*\)/.test(l))
    .filter(([l]) => !l.trim().startsWith('//') && !l.trim().startsWith('*'));
  assert.deepEqual(offenders.map(([l, n]) => `${n}: ${l.trim()}`), [],
    "use the cached import('puppeteer') via loadPuppeteer() instead of require()");
  assert.match(src, /import\('puppeteer'\)/, 'the dynamic import must still be there');
});
