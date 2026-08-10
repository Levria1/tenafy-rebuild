const DAY_MS = 24 * 60 * 60 * 1000;
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

function utf8Bytes(str) {
  return Buffer.byteLength(str, 'utf8');
}

// Fold a content line to 75 octets with a leading space on continuations (RFC 5545).
function foldLine(line) {
  const text = String(line);
  if (utf8Bytes(text) <= 75) return text;

  const chunks = [];
  let current = '';
  let currentBytes = 0;
  let limit = 75;

  for (const char of text) {
    const charBytes = utf8Bytes(char);
    if (currentBytes + charBytes > limit) {
      chunks.push(current);
      current = ' ' + char;
      currentBytes = 1 + charBytes;
      limit = 75;
    } else {
      current += char;
      currentBytes += charBytes;
    }
  }
  chunks.push(current);
  return chunks.join('\r\n');
}

// Escape a TEXT value: backslash, semicolon, comma, newline (RFC 5545 section 3.3.11).
function escapeText(value) {
  return String(value == null ? '' : value)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

// 'YYYY-MM-DD' -> 'YYYYMMDD'. Input is already a string from DATE_FORMAT; do NOT construct a Date.
function toIcalDate(ymd) {
  return String(ymd).replace(/-/g, '');
}

function parseYmdUtc(ymd) {
  if (!YMD_RE.test(String(ymd))) throw new Error(`Invalid YYYY-MM-DD date: ${ymd}`);
  const [year, month, day] = String(ymd).split('-').map(Number);
  return Date.UTC(year, month - 1, day);
}

// Add days to a 'YYYY-MM-DD' string using UTC arithmetic only.
function addDaysYmd(ymd, days) {
  const d = new Date(parseYmdUtc(ymd) + Number(days) * DAY_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function compareYmd(a, b) {
  return String(a).localeCompare(String(b));
}

function clampEnd(endDate, horizon) {
  if (endDate == null || endDate === '') return horizon;
  return compareYmd(endDate, horizon) > 0 ? horizon : endDate;
}

/**
 * blocks: [{ uid, start_date: 'YYYY-MM-DD', end_date: 'YYYY-MM-DD' | null }]
 * now:    'YYYY-MM-DD' (today, Hong Kong)
 * Returns the full .ics body as a string, CRLF line endings.
 */
function buildUnitCalendar({ calendarName, blocks, now, dtstamp }) {
  const horizon = addDaysYmd(now, 365);
  const lines = [
    'BEGIN:VCALENDAR',
    'PRODID:-//Tenafy//Airbnb Availability//EN',
    'VERSION:2.0',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(calendarName || 'Tenafy Availability')}`,
    'X-PUBLISHED-TTL:PT1H',
  ];

  for (const block of blocks || []) {
    const start = compareYmd(block.start_date, now) < 0 ? now : block.start_date;
    const end = clampEnd(block.end_date, horizon);

    if (compareYmd(end, now) < 0) continue;
    if (compareYmd(start, horizon) > 0) continue;
    if (compareYmd(start, end) > 0) continue;

    lines.push(
      'BEGIN:VEVENT',
      `UID:lease-${escapeText(block.uid)}@tenafy`,
      `DTSTAMP:${dtstamp}`,
      `DTSTART;VALUE=DATE:${toIcalDate(start)}`,
      `DTEND;VALUE=DATE:${toIcalDate(addDaysYmd(end, 1))}`,
      'SUMMARY:Unavailable',
      'END:VEVENT'
    );
  }

  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

module.exports = {
  foldLine,
  escapeText,
  toIcalDate,
  addDaysYmd,
  buildUnitCalendar,
};
