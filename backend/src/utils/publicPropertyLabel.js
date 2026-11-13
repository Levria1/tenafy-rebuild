/**
 * The website's building grouping for a property (migration 074), as the public API returns it.
 *
 * `public_label` is the group key: properties that share it are one building to the public,
 * e.g. the two Pearl City Mansion flats. `public_building_name` is the building's name and
 * `public_aliases` the extra names people use for it ("PCM"). The website FAQ groups on the
 * same columns (routes/websitePublic.js), so callers see the grouping the website shows.
 *
 * Blank text becomes null. Aliases come back as an array of non-blank strings, deduplicated
 * case-insensitively, or null when there are none. mysql2 normally parses the JSON column
 * already; a string is parsed here, and anything that is not an array is treated as none.
 */
function textOrNull(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function aliasesOrNull(value) {
  let list = value;
  if (typeof list === 'string') {
    try { list = JSON.parse(list); } catch { return null; }
  }
  if (!Array.isArray(list)) return null;
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (item == null || typeof item === 'object') continue;
    const text = String(item).trim();
    const key = text.toLocaleLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out.length ? out : null;
}

function publicLabelFields(row) {
  return {
    public_label: textOrNull(row?.public_label),
    public_building_name: textOrNull(row?.public_building_name),
    public_aliases: aliasesOrNull(row?.public_aliases),
  };
}

module.exports = { publicLabelFields };
