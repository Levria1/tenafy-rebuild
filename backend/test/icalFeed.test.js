const test = require('node:test');
const assert = require('node:assert');
const {
  foldLine,
  escapeText,
  addDaysYmd,
  buildUnitCalendar,
} = require('../src/services/icalFeed');

const NOW = '2026-08-10';
const DTSTAMP = '20260810T010203Z';

test('single closed block emits date-only DTSTART and exclusive DTEND', () => {
  const body = buildUnitCalendar({
    calendarName: 'Unit 5B',
    blocks: [{ uid: '123', start_date: '2026-08-12', end_date: '2026-08-28' }],
    now: NOW,
    dtstamp: DTSTAMP,
  });

  assert.match(body, /DTSTART;VALUE=DATE:20260812\r\n/);
  // DTEND is exclusive; an off-by-one here loses a lettable night per booking.
  assert.match(body, /DTEND;VALUE=DATE:20260829\r\n/);
  assert.match(body, /UID:lease-123@tenafy\r\n/);
});

test('open-ended block is clamped to now plus 365 days and remains present', () => {
  const body = buildUnitCalendar({
    calendarName: 'Unit 5B',
    blocks: [{ uid: 'open', start_date: '2026-08-12', end_date: null }],
    now: NOW,
    dtstamp: DTSTAMP,
  });

  assert.match(body, /UID:lease-open@tenafy\r\n/);
  assert.match(body, /DTEND;VALUE=DATE:20270811\r\n/);
});

test('block ending before now is omitted', () => {
  const body = buildUnitCalendar({
    calendarName: 'Unit 5B',
    blocks: [{ uid: 'past', start_date: '2026-08-01', end_date: '2026-08-09' }],
    now: NOW,
    dtstamp: DTSTAMP,
  });

  assert.doesNotMatch(body, /BEGIN:VEVENT/);
  assert.doesNotMatch(body, /lease-past@tenafy/);
});

test('block starting beyond the horizon is omitted', () => {
  const body = buildUnitCalendar({
    calendarName: 'Unit 5B',
    blocks: [{ uid: 'future', start_date: '2027-08-11', end_date: '2027-08-20' }],
    now: NOW,
    dtstamp: DTSTAMP,
  });

  assert.doesNotMatch(body, /BEGIN:VEVENT/);
});

test('block spanning the horizon is included and clamped', () => {
  const body = buildUnitCalendar({
    calendarName: 'Unit 5B',
    blocks: [{ uid: 'span', start_date: '2027-08-01', end_date: '2027-09-01' }],
    now: NOW,
    dtstamp: DTSTAMP,
  });

  assert.match(body, /UID:lease-span@tenafy\r\n/);
  assert.match(body, /DTSTART;VALUE=DATE:20270801\r\n/);
  assert.match(body, /DTEND;VALUE=DATE:20270811\r\n/);
});

test('summary is constant and contains no input-derived text', () => {
  const body = buildUnitCalendar({
    calendarName: 'Tenant Alice HKD 10000 Lease ABC',
    blocks: [{ uid: 'Alice-lease-code', start_date: '2026-08-12', end_date: '2026-08-28' }],
    now: NOW,
    dtstamp: DTSTAMP,
  });

  assert.match(body, /SUMMARY:Unavailable\r\n/);
  assert.doesNotMatch(body, /SUMMARY:.*Alice/);
  assert.doesNotMatch(body, /SUMMARY:.*10000/);
  assert.doesNotMatch(body, /SUMMARY:.*ABC/);
});

test('escapeText escapes reserved TEXT characters', () => {
  assert.equal(escapeText('a\\b;c,d\ne'), 'a\\\\b\\;c\\,d\\ne');
});

test('foldLine folds past 75 octets with a leading space on continuation lines', () => {
  const folded = foldLine(`SUMMARY:${'a'.repeat(80)}`);
  const lines = folded.split('\r\n');
  assert.equal(Buffer.byteLength(lines[0], 'utf8'), 75);
  assert.equal(lines[1][0], ' ');
  assert.equal(lines.join('').replace(/^SUMMARY:/, '').replace(/^ /, '').length >= 80, true);
});

test('addDaysYmd crosses month and year boundaries independent of host timezone', () => {
  const prevTz = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  try {
    assert.equal(addDaysYmd('2026-08-31', 1), '2026-09-01');
    assert.equal(addDaysYmd('2026-12-31', 1), '2027-01-01');
  } finally {
    if (prevTz === undefined) delete process.env.TZ;
    else process.env.TZ = prevTz;
  }
});

test('output uses CRLF and opens and closes VCALENDAR', () => {
  const body = buildUnitCalendar({ calendarName: 'Unit 5B', blocks: [], now: NOW, dtstamp: DTSTAMP });
  assert.equal(body.startsWith('BEGIN:VCALENDAR\r\n'), true);
  assert.equal(body.endsWith('END:VCALENDAR\r\n'), true);
  assert.equal(body.includes('\n'), true);
  assert.equal(body.includes('\n') && !body.includes('\r\n'), false);
});

test('zero blocks is a valid calendar with no events', () => {
  const body = buildUnitCalendar({ calendarName: 'Unit 5B', blocks: [], now: NOW, dtstamp: DTSTAMP });
  assert.match(body, /BEGIN:VCALENDAR\r\n/);
  assert.match(body, /END:VCALENDAR\r\n/);
  assert.doesNotMatch(body, /BEGIN:VEVENT/);
});
