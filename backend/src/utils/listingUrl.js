function normalizeListingUrl(value) {
  if (typeof value !== 'string') return null;

  let normalized = value.trim();
  if (!normalized) return null;

  normalized = normalized.replace(/^https?:\/\//i, '');
  normalized = normalized.replace(/^www\./i, '');
  normalized = normalized.split(/[?#]/, 1)[0];
  normalized = normalized.replace(/\/+$/, '');
  normalized = normalized.toLowerCase();

  // Null is deliberately not comparable. Several active units have no URL; if
  // those normalize to '' and are compared with ===, a junk lookup can match a
  // real unit that also has no URL.
  return normalized || null;
}

function findUnitByListingUrl(units, value) {
  const target = normalizeListingUrl(value);
  if (!target) return { status: 'none', unit_id: null };

  const matches = [];
  for (const unit of Array.isArray(units) ? units : []) {
    const listingUrl = normalizeListingUrl(unit?.listing_url);
    if (!listingUrl) continue;

    // Treat path case differences as the same listing. Real slugs are lowercase
    // today, and any future collision is handled by the ambiguity branch below.
    if (listingUrl === target) matches.push(unit);
  }

  if (matches.length === 1) return { status: 'match', unit_id: String(matches[0].unit_id) };
  if (matches.length > 1) return { status: 'ambiguous', unit_id: null };
  return { status: 'none', unit_id: null };
}

module.exports = {
  normalizeListingUrl,
  findUnitByListingUrl,
};
