const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  isExpiredRequest,
  isLiveRequest,
  periodOf,
  periodsOverlap,
  findOverlappingLive,
} = require('../src/utils/signatureOverlap');

const lease = { start_date: '2025-06-05', end_date: '2027-01-05' };
const now = new Date('2026-09-22T12:00:00.000Z');

test('contiguous day-after periods do not overlap', () => {
  assert.equal(periodsOverlap(
    { start: '2025-08-20', end: '2026-08-19' },
    { start: '2026-08-20', end: '2027-08-19' }
  ), false);
});

test('periods sharing one boundary day overlap inclusively', () => {
  assert.equal(periodsOverlap(
    { start: '2025-08-20', end: '2026-08-20' },
    { start: '2026-08-20', end: '2027-08-19' }
  ), true);
});

test('a null-period legacy request covers the whole lease', () => {
  const legacy = { id: '2824', status: 1, term_start: null, term_end: null, expires_at: null };
  assert.deepEqual(periodOf(legacy, lease), { start: '2025-06-05', end: '2027-01-05' });
  assert.deepEqual(
    findOverlappingLive([legacy], { start: '2026-09-05', end: '2026-11-05' }, lease, { now }),
    [legacy]
  );
});

test('expired sent/viewed requests are not live and do not conflict', () => {
  const expired = { id: '1', status: '2', expires_at: '2026-09-22T11:59:59.000Z' };
  assert.equal(isExpiredRequest(expired, now), true);
  assert.equal(isLiveRequest(expired, now), false);
  assert.deepEqual(findOverlappingLive([expired], {}, lease, { now }), []);
});

test('signed and cancelled requests are excluded', () => {
  const requests = [
    { id: '3', status: 3, expires_at: null },
    { id: '6', status: 6, expires_at: null },
  ];
  assert.deepEqual(findOverlappingLive(requests, {}, lease, { now }), []);
});

test('excludeId compares snowflake ids as strings', () => {
  const request = { id: '123', status: 1, expires_at: null };
  assert.deepEqual(findOverlappingLive([request], {}, lease, { now, excludeId: 123 }), []);
});

test('Date inputs use local wall-clock date parts', () => {
  const dateLease = { start_date: new Date(2025, 5, 5), end_date: new Date(2027, 0, 5) };
  const doc = { term_start: new Date(2026, 8, 5), term_end: new Date(2026, 10, 5) };
  assert.deepEqual(periodOf(doc, dateLease), { start: '2026-09-05', end: '2026-11-05' });
});

test('a sent request without expires_at remains live', () => {
  const request = { status: 1, expires_at: null };
  assert.equal(isExpiredRequest(request, now), false);
  assert.equal(isLiveRequest(request, now), true);
});

test('signature routes enforce overlap before side effects and scope supersession', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/routes/signature.js'), 'utf8');
  const createStart = src.indexOf("router.post('/request'");
  const createEnd = src.indexOf("router.post('/record-paper'", createStart);
  const create = src.slice(createStart, createEnd);
  assert.ok(create.indexOf('findOverlappingLive(') < create.indexOf('renderer.renderFromTemplate'));
  assert.match(create, /status\(409\)|overlapResponse\(res, conflicts/);
  assert.match(src, /reason:\s*'overlapping_request'/);
  assert.match(src, /WHERE id = \? AND org_id = \? AND status IN \(1,2\)/);
  assert.ok(create.indexOf('cancelSuperseded(') > create.indexOf('INSERT INTO signature_request'));

  const resendStart = src.indexOf("router.post('/request/:id/resend'");
  const resend = src.slice(resendStart, src.indexOf('// \u2500', resendStart));
  assert.match(resend, /findOverlappingLive\([\s\S]*\{ excludeId: r\.id \}/);
});

test('a shared boundary day overlaps whichever period comes first', () => {
  const early = { start: '2025-08-20', end: '2026-08-20' };
  const late = { start: '2026-08-20', end: '2027-08-19' };
  assert.equal(periodsOverlap(early, late), true);
  assert.equal(periodsOverlap(late, early), true);
});

test('both create and resend refuse with 409 unless replace_overlapping is exactly true', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/routes/signature.js'), 'utf8');
  const guards = src.match(/if \(conflicts\.length && req\.body\?\.replace_overlapping !== true\) \{\s*return overlapResponse\(res, conflicts, lease\);/g) || [];
  assert.equal(guards.length, 2, 'create and resend each guard on replace_overlapping');
  assert.match(src, /res\.status\(409\)\.json\(/);
});

test('every lease document list carries is_expired, and the calendar reads expires_at', () => {
  const sig = fs.readFileSync(path.join(__dirname, '../src/routes/signature.js'), 'utf8');
  const list = sig.slice(sig.indexOf("router.get('/lease/:leaseId'"), sig.indexOf("router.post('/request/:id/cancel'"));
  assert.match(list, /is_expired: isExpiredRequest\(row\)/);

  const leasing = fs.readFileSync(path.join(__dirname, '../src/routes/leasing.js'), 'utf8');
  const paperwork = leasing.slice(leasing.indexOf('async function loadPaperwork'), leasing.indexOf('async function verifyLeaseOwnership'));
  assert.match(paperwork, /sent_at, expires_at/);
  assert.match(paperwork, /is_expired: isExpiredRequest\(r\)/);
  // Without expires_at the calendar's computePaperworkState would count expired
  // requests as in flight and hide the paperwork gap marker.
  const cal = leasing.slice(leasing.indexOf('const documentsByLease = {}'), leasing.indexOf('documentsByLease[key].push(d)'));
  assert.match(cal, /SELECT lease_id, status, expires_at,/);
});
