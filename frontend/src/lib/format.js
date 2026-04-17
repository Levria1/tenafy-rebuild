/**
 * Shared display helpers for unit/property fields.
 *
 * Convention: `beds = 0` in the DB means a studio apartment (no separate
 * bedroom). We keep the numeric 0 in the data layer and only transform at
 * display time.
 */

// "Studio" when 0, "-" when null/undefined, otherwise the number as a string.
// Pass `asFull=true` to get "Studio" / "1 bed" / "2 beds" (pluralised).
export function formatBeds(beds, { asFull = false } = {}) {
  if (beds == null || beds === '') return '-';
  const n = Number(beds);
  if (!Number.isFinite(n) || n < 0) return '-';
  if (n === 0) return 'Studio';
  if (asFull) return `${n} bed${n === 1 ? '' : 's'}`;
  return String(n);
}

// True if the unit is a studio (beds === 0).
export function isStudio(beds) {
  return Number(beds) === 0;
}

// Convert a raw unit.type value (usually stored lowercase, e.g. "apartment")
// into a display label ("Apartment"). Falls back to title-casing unknown
// values so legacy types ("coLivingBedSpace") at least read nicely.
export function formatUnitType(value) {
  if (value == null || value === '') return '-';
  const raw = String(value).trim();
  const key = raw.toLowerCase();
  const LABELS = {
    apartment: 'Apartment',
    'co-op':   'Co-Op',
    condo:     'Condo',
    house:     'House',
    villa:     'Villa',
  };
  if (LABELS[key]) return LABELS[key];
  // Fallback: split camelCase / dashes / underscores and title-case each piece
  return raw
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

// Standard unit-type dropdown options, alphabetical by label.
// `value` is the canonical lowercase string stored in unit.type.
// Pass a `currentValue` so that legacy/non-standard types already in the DB
// (e.g. "coLivingBedSpace", "duplex") still render correctly in the edit form.
export function unitTypeOptions(currentValue) {
  const standard = [
    { value: 'apartment', label: 'Apartment' },
    { value: 'co-op',     label: 'Co-Op' },
    { value: 'condo',     label: 'Condo' },
    { value: 'house',     label: 'House' },
    { value: 'villa',     label: 'Villa' },
  ];
  const cur = currentValue && String(currentValue).trim();
  if (cur && !standard.some(o => o.value === cur)) {
    standard.push({ value: cur, label: `${cur} (legacy)` });
  }
  return standard;
}

// Standard bedroom dropdown options. Studio maps to 0.
// Call with a current value to ensure it's represented even if it falls
// outside the default range (e.g. legacy data with beds=7).
export function bedsSelectOptions(currentValue) {
  const standard = [
    { value: 0, label: 'Studio' },
    { value: 1, label: '1 bedroom' },
    { value: 2, label: '2 bedrooms' },
    { value: 3, label: '3 bedrooms' },
    { value: 4, label: '4 bedrooms' },
    { value: 5, label: '5 bedrooms' },
    { value: 6, label: '6 bedrooms' },
  ];
  const n = Number(currentValue);
  if (Number.isFinite(n) && n > 6) {
    standard.push({ value: n, label: `${n} bedrooms` });
  }
  return standard;
}
