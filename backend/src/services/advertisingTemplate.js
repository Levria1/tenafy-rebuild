// ---------------------------------------------------------------------------
// Advertising template placeholders
//
// A template's title/body may contain %Placeholder% tokens that are filled from
// a unit's live data when the ad is rendered (preview now; the Scheduler/API
// later). `applyPlaceholders` is a pure string substitution (testable);
// `resolveUnitValues` does the DB lookup.
// ---------------------------------------------------------------------------

// The public list — shown in the editor so staff know what they can insert.
const PLACEHOLDERS = [
  { token: '%PropertyName%',    description: 'Property / building display name' },
  { token: '%PropertyAddress%', description: 'Street address' },
  { token: '%District%',        description: 'District' },
  { token: '%City%',            description: 'City' },
  { token: '%UnitName%',        description: 'Unit name / number' },
  { token: '%UnitType%',        description: 'Unit type (e.g. apartment)' },
  { token: '%Beds%',            description: 'Number of bedrooms' },
  { token: '%BedSize%',         description: 'Bed size from the unit\'s Mattress amenity (e.g. "Double (1.2m)")' },
  { token: '%Baths%',           description: 'Number of bathrooms' },
  { token: '%Size%',            description: 'Floor size (with unit, e.g. 500 ft²)' },
  { token: '%Rent%',            description: 'Asking monthly rent (HK$), or the range' },
  { token: '%RentAmount%',      description: 'Rent as a plain number (e.g. 5,500), no currency' },
  { token: '%PostingRent%',     description: 'Rent to advertise now (steps down as availability nears), HK$' },
  { token: '%PostingRentAmount%', description: 'Posting rent as a plain number, no currency' },
  { token: '%Deposit%',         description: 'Deposit (HK$)' },
  { token: '%AvailableDate%',   description: 'Available date, or "Now" if already vacant' },
  { token: '%WebpageLink%',     description: "The template's webpage link" },
];

// Posting rent — the rate to advertise at, stepping DOWN as availability nears,
// across the unit's rent_price_min..max range:
//   >= 8 weeks (56d)  → high (top of range)
//   6–8 weeks (42d)   → mid  (midpoint)
//   < 6 weeks upcoming→ low  (bottom of range)
//   vacant > 1 day    → low − 10%
// `daysToAvailable`: positive = days until vacant; negative = days already vacant;
// null = unknown. Pure + testable. Returns { amount, tier } or null.
function computePostingRent(rentMin, rentMax, daysToAvailable) {
  // Guard null/'' explicitly — Number(null) is 0 (finite), which would masquerade
  // as a real HK$0 bound.
  const min = (rentMin == null || rentMin === '') ? NaN : Number(rentMin);
  const max = (rentMax == null || rentMax === '') ? NaN : Number(rentMax);
  const hasMin = Number.isFinite(min), hasMax = Number.isFinite(max);
  if (!hasMin && !hasMax) return null;
  // Order-safe: if both bounds exist but were entered reversed, low is still the
  // smaller so the step-down doesn't invert.
  const lo = (hasMin && hasMax) ? Math.min(min, max) : (hasMin ? min : max);
  const hi = (hasMin && hasMax) ? Math.max(min, max) : (hasMax ? max : min);
  const mid = Math.round((lo + hi) / 2);
  const d = daysToAvailable;
  if (d == null)     return { amount: lo, tier: 'low' };                     // unknown → conservative
  if (d >= 56)       return { amount: hi, tier: 'high' };                    // >= 8 weeks
  if (d >= 42)       return { amount: mid, tier: 'mid' };                    // 6–8 weeks
  if (d >= 0)        return { amount: lo, tier: 'low' };                     // < 6 weeks, upcoming
  if (d < -1)        return { amount: Math.round(lo * 0.9), tier: 'discount' }; // vacant > 1 day
  return { amount: lo, tier: 'low' };                                        // vacant 0–1 day
}

const PLACEHOLDER_TOKENS = PLACEHOLDERS.map(p => p.token);

// Pure: replace every KNOWN %Token% in `text` with values[token]. Unknown tokens
// are left as-is (so a typo is visible rather than silently blanked). A null/empty
// value replaces with ''. SINGLE PASS — a substituted value that happens to
// contain a %Token%-looking string is NOT re-processed.
const TOKEN_SET = new Set(PLACEHOLDER_TOKENS);
function applyPlaceholders(text, values = {}) {
  if (text == null) return '';
  return String(text).replace(/%[A-Za-z]+%/g, (m) => {
    if (!TOKEN_SET.has(m)) return m;          // unknown token → leave visible
    const v = values[m];
    return v == null ? '' : String(v);
  });
}

// Facebook posts are plain text — no real bold. `**text**` markers are converted
// to Unicode Mathematical Bold characters (𝐭𝐞𝐱𝐭) as a visual approximation.
function boldChar(ch) {
  const c = ch.codePointAt(0);
  if (c >= 0x41 && c <= 0x5A) return String.fromCodePoint(0x1D400 + (c - 0x41)); // A–Z
  if (c >= 0x61 && c <= 0x7A) return String.fromCodePoint(0x1D41A + (c - 0x61)); // a–z
  if (c >= 0x30 && c <= 0x39) return String.fromCodePoint(0x1D7CE + (c - 0x30)); // 0–9
  return ch;
}
function convertBold(text) {
  return String(text == null ? '' : text).replace(/\*\*([^*]+)\*\*/g, (_, inner) => [...inner].map(boldChar).join(''));
}

// Bed size is modeled as an on/off "Mattress (X Size Ym)" interior amenity, not a
// unit column. Parse the width class out of the amenity's display_name:
//   "Mattress (Double Size 1.2m)" → "Double (1.2m)"  ;  "" for none/unparseable.
// Pure + testable. (Mirrors frontend lib/format.js bedSizeFromAmenities.)
function parseBedSize(mattressName) {
  if (!mattressName) return '';
  const m = /(twin|full|double|queen|king)\b[^0-9]*([0-9.]+\s*m)/i.exec(mattressName);
  if (!m) return String(mattressName); // unrecognised naming — show as-is
  const name = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
  return `${name} (${m[2].replace(/\s+/g, '')})`;
}

function fmtMoney(n) {
  if (n == null || n === '' || Number.isNaN(Number(n))) return '';
  return `HK$${Number(n).toLocaleString('en-US')}`;
}

function fmtDate(d) {
  if (!d) return '';
  const s = typeof d === 'string' ? d.slice(0, 10) : new Date(d).toISOString().slice(0, 10);
  return s;
}

// Resolve the %Token% → value map for a given unit. Pulls unit + property, an
// asking rent (unit range first, else the most recent lease), and an available
// date (current lease end if occupied, else the last lease end = already vacant).
// `template` supplies %WebpageLink%. Returns a plain object keyed by token.
async function resolveUnitValues(pool, orgId, unitId, template = {}) {
  const [[u]] = await pool.execute(
    `SELECT u.name AS unit_name, u.type AS unit_type, u.beds, u.baths,
            u.size, u.size_unit, u.rent_price_min, u.rent_price_max, u.deposit_price,
            p.display_name AS property_name, p.street_address, p.district, p.city
       FROM unit u JOIN property p ON u.property_id = p.id
      WHERE u.id = ? AND p.org_id = ?
      LIMIT 1`,
    [String(unitId), orgId]
  );
  if (!u) return null;

  // Bed size — from the unit's selected "Mattress (…)" interior amenity (bed size
  // isn't a unit column). First matching amenity wins.
  const [[bedRow]] = await pool.execute(
    `SELECT a.display_name AS name
       FROM unit_amenity ua JOIN amenity a ON a.id = ua.amenity_id
      WHERE ua.unit_id = ? AND a.org_id = ? AND a.category = 1
        AND a.display_name LIKE 'Mattress%'
      ORDER BY a.order_id, a.id LIMIT 1`,
    [String(unitId), orgId]
  );
  const bedSize = parseBedSize(bedRow && bedRow.name);

  // Asking rent: prefer the unit's advertised range, else the most recent lease.
  let rent = u.rent_price_min != null ? u.rent_price_min : u.rent_price_max;
  let deposit = u.deposit_price;
  if (rent == null || deposit == null) {
    const [[lastLease]] = await pool.execute(
      `SELECT amount, deposit FROM leasing
        WHERE unit_id = ? AND deleted_at IS NULL
        ORDER BY start_date DESC, id DESC LIMIT 1`,
      [String(unitId)]
    );
    if (lastLease) {
      if (rent == null) rent = lastLease.amount;
      if (deposit == null) deposit = lastLease.deposit;
    }
  }
  // Rent as a range when both bounds present and differ.
  let rentStr = fmtMoney(rent);
  if (u.rent_price_min != null && u.rent_price_max != null
      && Number(u.rent_price_min) !== Number(u.rent_price_max)) {
    rentStr = `${fmtMoney(u.rent_price_min)} - ${fmtMoney(u.rent_price_max)}`;
  }

  // Available date + days-to-available. Current lease → becomes available at its
  // end (days_to_end); else the last ended lease → already vacant (negative days).
  const [[cur]] = await pool.execute(
    `SELECT DATE_FORMAT(end_date, '%Y-%m-%d') AS d, DATEDIFF(end_date, CURDATE()) AS days_to_end
       FROM leasing
      WHERE unit_id = ? AND deleted_at IS NULL
        AND start_date <= CURDATE() AND (end_date IS NULL OR end_date >= CURDATE())
      ORDER BY end_date DESC LIMIT 1`,
    [String(unitId)]
  );
  let availableDate;      // date string, null if unknown
  let daysToAvailable;    // +days until vacant, -days already vacant, null unknown
  if (cur) {
    availableDate = cur.d || null;            // may be NULL for an open-ended lease
    daysToAvailable = cur.days_to_end != null ? Number(cur.days_to_end) : null;
  } else {
    const [[past]] = await pool.execute(
      `SELECT DATE_FORMAT(MAX(end_date), '%Y-%m-%d') AS d, DATEDIFF(CURDATE(), MAX(end_date)) AS days_vacant
         FROM leasing
        WHERE unit_id = ? AND deleted_at IS NULL AND end_date IS NOT NULL AND end_date < CURDATE()`,
      [String(unitId)]
    );
    availableDate = past && past.d ? past.d : null;
    daysToAvailable = past && past.days_vacant != null ? -Number(past.days_vacant) : null;
  }

  // "Now" reads better than a past date for an already-vacant unit.
  const availableLabel = (daysToAvailable != null && daysToAvailable <= 0) ? 'Now' : fmtDate(availableDate);

  const posting = computePostingRent(u.rent_price_min, u.rent_price_max, daysToAvailable);
  const postingAmount = posting ? posting.amount : (rent != null ? Number(rent) : null);

  const sizeStr = u.size != null ? `${u.size}${u.size_unit ? ' ' + u.size_unit : ''}` : '';
  const rawNum = (n) => (n == null || n === '' || Number.isNaN(Number(n))) ? '' : Math.round(Number(n)).toLocaleString('en-US');

  return {
    '%PropertyName%':    u.property_name || '',
    '%PropertyAddress%': u.street_address || '',
    '%District%':        u.district || '',
    '%City%':            u.city || '',
    '%UnitName%':        u.unit_name || '',
    '%UnitType%':        u.unit_type || '',
    '%Beds%':            u.beds != null ? String(u.beds) : '',
    '%BedSize%':         bedSize,
    '%Baths%':           u.baths != null ? String(u.baths) : '',
    '%Size%':            sizeStr,
    '%Rent%':            rentStr,
    '%RentAmount%':      rawNum(rent),
    '%PostingRent%':     fmtMoney(postingAmount),
    '%PostingRentAmount%': rawNum(postingAmount),
    '%Deposit%':         fmtMoney(deposit),
    '%AvailableDate%':   availableLabel,
    '%WebpageLink%':     template.webpage_link || '',
  };
}

module.exports = { PLACEHOLDERS, PLACEHOLDER_TOKENS, applyPlaceholders, resolveUnitValues, computePostingRent, convertBold, parseBedSize };
