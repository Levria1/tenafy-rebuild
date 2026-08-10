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

// `end_date` is the HANDOVER day, not the last night slept — same-day move-ins are
// allowed and 45% of consecutive tenancies start the day the previous one ends. So the
// handover day must stay bookable: DTEND (exclusive) equals end_date, and the last
// blocked night is the day before. Adding a day here costs a lettable night per turnover.
test('a real end_date leaves the handover day bookable', () => {
  const body = buildUnitCalendar({
    calendarName: 'Unit 5B',
    blocks: [{ uid: '123', start_date: '2026-08-12', end_date: '2026-08-28' }],
    now: NOW,
    dtstamp: DTSTAMP,
  });

  assert.match(body, /DTSTART;VALUE=DATE:20260812\r\n/);
  assert.match(body, /DTEND;VALUE=DATE:20260828\r\n/, 'DTEND must equal end_date, not end_date + 1');
  assert.doesNotMatch(body, /DTEND;VALUE=DATE:20260829\r\n/, 'the handover day must not be blocked');
  assert.match(body, /UID:lease-123@tenafy\r\n/);
});

// The real case that prompted the change: 12-B6 Pearl City Unit 22.
test('Unit 22: lease ending 2027-01-03 frees the 3rd for check-in', () => {
  const body = buildUnitCalendar({
    calendarName: 'Unit 22',
    blocks: [{ uid: 'u22', start_date: '2026-07-10', end_date: '2027-01-03' }],
    now: NOW,
    dtstamp: DTSTAMP,
  });
  assert.match(body, /DTEND;VALUE=DATE:20270103\r\n/);
});

test('a lease handing over TOMORROW still blocks tonight', () => {
  const body = buildUnitCalendar({
    calendarName: 'x',
    blocks: [{ uid: 't', start_date: '2026-01-01', end_date: '2026-08-11' }],
    now: '2026-08-10',
    dtstamp: DTSTAMP,
  });
  assert.match(body, /DTSTART;VALUE=DATE:20260810\r\n/);
  assert.match(body, /DTEND;VALUE=DATE:20260811\r\n/);
});

// Handover today means no remaining night is occupied, and a zero-length VEVENT is
// invalid iCal, so the event must be omitted entirely rather than emitted empty.
test('a lease handing over TODAY produces no event', () => {
  const body = buildUnitCalendar({
    calendarName: 'x',
    blocks: [{ uid: 't', start_date: '2026-01-01', end_date: '2026-08-10' }],
    now: '2026-08-10',
    dtstamp: DTSTAMP,
  });
  assert.doesNotMatch(body, /BEGIN:VEVENT/);
  assert.match(body, /END:VCALENDAR/);
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
