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

// ---------------------------------------------------------------------------
// The signature Certificate of Completion.
//
// This is the audit trail on a legal document: when each party viewed and signed.
// It used to print UTC — correctly labelled, so not misleading, but it meant a
// Hong Kong tenant signing at 00:30 saw the previous day's date on their own
// certificate. Operator's call: show Hong Kong, and label it Hong Kong.
// ---------------------------------------------------------------------------

const { stampTimestamp } = require('../src/services/signatureStamper');

test('the certificate timestamps a signature in Hong Kong', () => {
  assert.equal(stampTimestamp(STRADDLE), '2026-08-16 00:05:00 HKT');
});

test('the certificate never prints a UTC-labelled time', () => {
  const out = stampTimestamp(STRADDLE);
  assert.ok(!out.includes('UTC'), `still labelled UTC: ${out}`);
  assert.ok(!out.startsWith('2026-08-15'), 'must not show the UTC calendar date');
});

test('the certificate timestamp is stable across server timezones', () => {
  // A legal record must not read differently depending on where the server runs.
  const { execFileSync } = require('child_process');
  const path = require('path');
  const mod = path.join(__dirname, '..', 'src/services/signatureStamper').replace(/\\/g, '/');
  const run = (tz) => execFileSync(process.execPath, ['-e',
    `process.stdout.write(require('${mod}').stampTimestamp(new Date('2026-08-15T16:05:00Z')))`],
    { env: { ...process.env, TZ: tz }, encoding: 'utf8' }).trim();
  assert.equal(run('UTC'), '2026-08-16 00:05:00 HKT');
  assert.equal(run('Asia/Hong_Kong'), '2026-08-16 00:05:00 HKT');
  assert.equal(run('America/New_York'), '2026-08-16 00:05:00 HKT');
});

test('a missing timestamp renders as a dash, not a bogus date', () => {
  assert.equal(stampTimestamp(null), '—');
  assert.equal(stampTimestamp(undefined), '—');
});

// ---------------------------------------------------------------------------
// Public viewing-negotiation API. The payload is labelled Asia/Hong_Kong.
//
// Three column kinds live on the same row and need opposite treatment:
//   TIMESTAMP / NOW()-written DATETIME → convert the instant to Hong Kong
//   appointment DATETIME               → re-emit the stored digits unchanged
//   pagination cursor                  → stay in server terms for the SQL compare
//
// This machine is already Asia/Hong_Kong, so a same-process assertion cannot
// tell dateToWallClock from orgWallClock. Production is UTC; pin that.
// ---------------------------------------------------------------------------

function publicNegotiationTimesUnderTz(tz) {
  const { execFileSync } = require('child_process');
  const path = require('path');
  const publicMod = path.join(__dirname, '..', 'src/routes/public').replace(/\\/g, '/');
  const script = `
    const Module = require('node:module');
    const orig = Module._load;
    Module._load = function (request, parent, isMain) {
      if (request === 'googleapis') {
        return { google: { auth: { GoogleAuth: class GoogleAuth {} }, calendar: () => ({ events: {} }) } };
      }
      return orig.call(this, request, parent, isMain);
    };
    const router = require('${publicMod}');
    function handler(p, m) {
      return router.stack.find(l => l.route && l.route.path === p && l.route.methods[m])
        .route.stack.at(-1).handle;
    }
    const STRADDLE = new Date('2026-08-15T16:05:00Z');
    const APPOINTMENT = new Date(2026, 7, 16, 19, 0, 0);
    function call(h, query, pool) {
      return new Promise((resolve, reject) => {
        const res = { status(c) { this.statusCode = c; return this; }, json(b) { resolve(b); } };
        Promise.resolve(h({ query, pool, apiKey: { orgId: 'ORG' }, params: {}, body: {} }, res)).catch(reject);
      });
    }
    (async () => {
      const draftPool = {
        async execute(sql) {
          if (/viewing_negotiation_event/.test(sql)) {
            return [[{
              event_id: '1', negotiation_id: 'n1', negotiation_state: 'RESOLVE_UNIT',
              awaiting: 'prospect', party: 'prospect', to_phone: '+852',
              body: 'x', template_type: 'Viewing-Choose-Unit', event_type: null,
              send_mode: 'approve', idempotency_key: null,
              deadline_at: STRADDLE, created_at: STRADDLE, expires_at: STRADDLE,
              age_hours: 0, unit_id: null, prospect_name: 'P', prospect_phone: '+852',
              unit_name: null, property_name: null,
            }]];
          }
          return [[]];
        },
      };
      const drafts = await call(handler('/viewing-negotiation/drafts', 'get'), {}, draftPool);

      const row = {
        id: '9', state: 'ASK_PROSPECT_DAY', awaiting: 'prospect',
        unit_id: null, tenant_id: null, prospect_name: 'P', prospect_phone: '+852',
        current_proposed_datetime: APPOINTMENT, needs_staff_reason: null,
        policy_opt_out_hours: null, policy_explicit_confirm: null, policy_source: null,
        customer_asked_at: STRADDLE, tenant_notified_at: null, auto_confirmed_at: null,
        opt_out_deadline_at: null, created_at: STRADDLE, updated_at: STRADDLE,
        unit_name: '1A', property_name: 'Alpha', street_address: null, city: null, state_name: null,
        tenant_phone: null, tenant_first_name: null, tenant_last_name: null, tenant_company_name: null,
      };
      const boardPool = {
        async execute(sql) {
          if (/FROM viewing_setting/.test(sql)) return [[null]];
          if (/FROM viewing_negotiation n/.test(sql)) return [[row, { ...row, id: '8' }]];
          if (/FROM viewing_negotiation_event e/.test(sql)) {
            return [[{ negotiation_id: '9', event_type: 'x', party: 'prospect',
              send_mode: 'auto', status: 'sent', created_at: STRADDLE }]];
          }
          return [[]];
        },
      };
      const board = await call(handler('/viewing-negotiations', 'get'), { limit: '1' }, boardPool);
      const cursor = board.meta && board.meta.next_cursor;
      const decoded = cursor ? JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) : null;
      process.stdout.write(JSON.stringify({
        draft_created_at: drafts.data.drafts[0].created_at,
        proposed_start_at: board.data[0].viewing.proposed_start_at,
        cursor_updated_at: decoded && decoded.updated_at,
      }));
    })().catch(err => { console.error(err && err.stack || err); process.exit(1); });
  `;
  return JSON.parse(execFileSync(process.execPath, ['-e', script], {
    env: { ...process.env, TZ: tz }, encoding: 'utf8',
  }).trim());
}

const UTC_PUBLIC = publicNegotiationTimesUnderTz('UTC');

test('a draft created_at is published in Hong Kong, on a UTC server', () => {
  // 16:05 UTC on the 15th is 00:05 on the 16th in Hong Kong. dateToWallClock
  // would have printed the UTC digits and claimed they were Hong Kong.
  assert.equal(UTC_PUBLIC.draft_created_at, '2026-08-16T00:05:00',
    `expected Hong Kong wall clock, got ${UTC_PUBLIC.draft_created_at}`);
});

test('proposed_start_at keeps the stored appointment digits on a UTC server', () => {
  // mysql2 parsed a Hong Kong DATETIME as if the digits were UTC. Re-emitting
  // those digits is correct; converting the instant would move 19:00 to 03:00
  // the next day.
  assert.equal(UTC_PUBLIC.proposed_start_at, '2026-08-16T19:00:00',
    `appointment must not shift. got ${UTC_PUBLIC.proposed_start_at}`);
});

test('the pagination cursor stays in server terms, not Hong Kong', () => {
  // encodeCursor is compared back against raw DB values. Shifting it to Hong
  // Kong would skip or repeat rows on a UTC database connection.
  assert.equal(UTC_PUBLIC.cursor_updated_at, '2026-08-15T16:05:00',
    `cursor must stay in server terms. got ${UTC_PUBLIC.cursor_updated_at}`);
});
