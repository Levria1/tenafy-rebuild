/**
 * Street, district, city joined with commas — skipping a district or city the street
 * address already names. 9 of 19 properties had the district typed into the street
 * address too, so contracts printed "..., Causeway Bay, Causeway Bay, Hong Kong".
 * Matched as a whole comma-separated part, case-insensitively, so "Bay" alone or a
 * street that merely contains the word does not swallow a real district.
 */
function fullAddress(property) {
  const street = String(property?.street_address || '').trim();
  const norm = (v) => String(v || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const seen = new Set(street.split(',').map(norm).filter(Boolean));
  const parts = street ? [street] : [];
  for (const extra of [property?.district, property?.city]) {
    const key = norm(extra);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    parts.push(String(extra).trim());
  }
  return parts.join(', ');
}

module.exports = { fullAddress };
