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
  { token: '%Baths%',           description: 'Number of bathrooms' },
  { token: '%Size%',            description: 'Floor size (with unit, e.g. 500 ft²)' },
  { token: '%Rent%',            description: 'Asking monthly rent (HK$)' },
  { token: '%Deposit%',         description: 'Deposit (HK$)' },
  { token: '%AvailableDate%',   description: 'Date the unit is / becomes available' },
  { token: '%WebpageLink%',     description: "The template's webpage link" },
];

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

  // Available date: current lease's end (becomes available then), else the last
  // ended lease's end (already available since). Null if never leased.
  const [[cur]] = await pool.execute(
    `SELECT DATE_FORMAT(end_date, '%Y-%m-%d') AS d FROM leasing
      WHERE unit_id = ? AND deleted_at IS NULL
        AND start_date <= CURDATE() AND (end_date IS NULL OR end_date >= CURDATE())
      ORDER BY end_date DESC LIMIT 1`,
    [String(unitId)]
  );
  let availableDate;
  if (cur) {
    // Occupied. cur.d may be NULL (open-ended / month-to-month lease) → available
    // date is genuinely unknown, so leave it blank rather than falling back to a
    // long-past date. Only look up the last ended lease when there is NO current
    // lease at all (the unit is actually vacant now).
    availableDate = cur.d || null;
  } else {
    const [[past]] = await pool.execute(
      `SELECT DATE_FORMAT(MAX(end_date), '%Y-%m-%d') AS d FROM leasing
        WHERE unit_id = ? AND deleted_at IS NULL AND end_date IS NOT NULL AND end_date < CURDATE()`,
      [String(unitId)]
    );
    availableDate = past ? past.d : null;
  }

  const sizeStr = u.size != null ? `${u.size}${u.size_unit ? ' ' + u.size_unit : ''}` : '';

  return {
    '%PropertyName%':    u.property_name || '',
    '%PropertyAddress%': u.street_address || '',
    '%District%':        u.district || '',
    '%City%':            u.city || '',
    '%UnitName%':        u.unit_name || '',
    '%UnitType%':        u.unit_type || '',
    '%Beds%':            u.beds != null ? String(u.beds) : '',
    '%Baths%':           u.baths != null ? String(u.baths) : '',
    '%Size%':            sizeStr,
    '%Rent%':            rentStr,
    '%Deposit%':         fmtMoney(deposit),
    '%AvailableDate%':   fmtDate(availableDate),
    '%WebpageLink%':     template.webpage_link || '',
  };
}

module.exports = { PLACEHOLDERS, PLACEHOLDER_TOKENS, applyPlaceholders, resolveUnitValues };
