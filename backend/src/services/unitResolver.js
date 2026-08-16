/**
 * Fuzzy resolution of a prospect's free text ("mongkok 6a", "mk 6a", "mongkok")
 * to a unit, for the viewing relay. The scoring is PURE (scoreUnits) so it is
 * unit-tested in isolation; resolveUnit() adds the DB load + per-unit marketable
 * flag (used to build disambiguation lists).
 *
 * NO unit is ever renamed — matching tolerates messy names: a stray suffix like
 * "6A Test" still matches "6a" (unit "core" token = the first token of the name).
 */

const { orgTodaySql } = require('../utils/orgTime');

function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}
function squish(s) { return norm(s).replace(/ /g, ''); }
function toTokens(s) { const n = norm(s); return n ? n.split(' ') : []; }
// property initials alias: "Mong Kok" -> "mk", "Nam Pak Hong" -> "nph"
function initials(name) { return toTokens(name).map(w => w[0]).join(''); }
// A leading generic word carries no identity — the meaningful token is what
// follows it: "Unit 22" -> "22", "Flat 3B" -> "3b".
const GENERIC_UNIT_WORDS = new Set(['unit', 'flat', 'apt', 'apartment', 'room', 'suite', 'rm']);
// the meaningful unit token. Non-generic names use the first token, so a stray
// suffix is tolerated ("6A Test" -> "6a"). When the name starts with a generic
// word, that word carries no identity, so we join the REMAINING tokens to keep a
// multi-part tail intact — "Unit 22" -> "22", "Unit 3 B" -> "3b", "Flat 3B" ->
// "3b" (taking only the next token would collide "Unit 3 A"/"Unit 3 B" on "3").
// A name that is ONLY a generic word keeps it (nothing better to use).
function unitCore(name) {
  const t = toTokens(name);
  if (!t.length) return '';
  if (t.length > 1 && GENERIC_UNIT_WORDS.has(t[0])) return t.slice(1).join('');
  return t[0];
}

// bounded Levenshtein (early-exit once the running best exceeds max)
function editDistance(a, b, max) {
  a = a || ''; b = b || '';
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev = [];
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]; prev[0] = i; let best = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + cost);
      diag = tmp;
      if (prev[j] < best) best = prev[j];
    }
    if (best > max) return max + 1;
  }
  return prev[b.length];
}

// Score one unit against the pre-normalized query pieces.
// Full match requires prop>0 AND unit>0.
function locationMatchScore(value, score, qSquish, qTokens) {
  const lSquish = squish(value);
  if (lSquish.length < 3) return 0;
  if (qSquish.includes(lSquish)) return score;
  const lTokens = toTokens(value);
  if (lTokens.length === 1 && qTokens.includes(lTokens[0])) return score;
  return 0;
}

const ADDRESS_STOPWORDS = new Set([
  'street', 'road', 'building', 'mansion', 'apartments', 'apartment', 'bazaar',
  'tower', 'court', 'block', 'house', 'centre', 'center', 'commercial', 'floor',
  'unit', 'flat', 'lane', 'terrace', 'estate', 'garden', 'gardens', 'st', 'rd',
  'fl',
]);

function addressMatchScore(streetAddress, qTokens) {
  const query = new Set(qTokens);
  const tokens = toTokens(streetAddress);
  return tokens.some(t => {
    if (t.length < 4) return false;
    // Numeric street-address parts and generic address words carry no property
    // identity: "8 Cleverly Street" must not let "8" identify a unit or property.
    if (/^\d+$/.test(t)) return false;
    if (ADDRESS_STOPWORDS.has(t)) return false;
    return query.has(t);
  }) ? 2 : 0;
}

function scoreOne(qSquish, qTokens, unit) {
  const pName = unit.property_name || '';
  const pSquish = squish(pName);
  const pInit = initials(pName);
  let prop = 0;
  let nameProp = 0;
  if (pSquish && qSquish.includes(pSquish)) prop = 3;                          // "mongkok" in "mongkok6a"
  else if (pInit.length >= 2 && qTokens.includes(pInit)) prop = 3;            // alias "mk"
  else {
    const pWords = toTokens(pName).filter(w => w.length >= 3);
    if (pWords.some(w => qTokens.includes(w))) prop = 2;                      // a property word appears
    else if (pSquish.length >= 4 &&
             qTokens.some(t => t.length >= 4 && editDistance(t, pSquish, 1) <= 1)) prop = 2; // typo "mongok"
  }
  nameProp = prop;
  // Address is location-like, never a property-name signal. Keeping it out of
  // nameProp preserves scoreUnits' namedFull filter, so "mercer 5b" still beats
  // location-only matches at other Sheung Wan 5B units. Score 2 matches district
  // strength and remains below an exact property-name hit (3).
  prop = Math.max(
    prop,
    locationMatchScore(unit.district, 2, qSquish, qTokens),
    locationMatchScore(unit.city, 1, qSquish, qTokens),
    addressMatchScore(unit.street_address, qTokens)
  );
  const core = unitCore(unit.name);
  let u = 0;
  if (core) {
    if (qTokens.includes(core)) u = 3;                                        // exact unit token "6a"
    else if (qTokens.some(t => t.length >= 2 && (t.startsWith(core) || core.startsWith(t)))) u = 2; // "6" ~ "6a"
  }
  return { prop, nameProp, unit: u, total: prop + u };
}

function unitOut(u) {
  return {
    unit_id: String(u.id),
    unit_name: u.name,
    property_id: u.property_id != null ? String(u.property_id) : null,
    property_name: u.property_name,
    label: `${u.property_name} ${u.name}`.trim(),
    marketable: !!u.marketable,
  };
}

// Build the candidate list for a disambiguation prompt: marketable units first;
// if none are marketable, fall back to all so the prospect still gets options.
function candidateList(rows, cap = 8) {
  const marketable = rows.filter(r => r.u.marketable);
  const chosen = (marketable.length ? marketable : rows).slice(0, cap);
  return chosen.map(r => unitOut(r.u));
}

/**
 * Pure resolver. `units` = [{id,name,property_id,property_name,marketable}].
 * Returns { status, match, candidates, query }.
 *   status: 'confident' | 'ambiguous' | 'property_only' | 'none'
 */
function scoreUnits(text, units) {
  const qSquish = squish(text);
  const qTokens = toTokens(text);
  if (!qTokens.length) return { status: 'none', match: null, candidates: [], query: String(text || '') };

  const rows = units.map(u => ({ u, s: scoreOne(qSquish, qTokens, u) }));

  // "More than one unit" intent: the prospect named ≥2 DISTINCT units, each an
  // exact unit-token match (e.g. "mongkok 6a 5a"). We don't auto-arrange a
  // multi-unit viewing — the caller escalates it to staff. "Distinct" is by unit
  // core, so a single token that merely collides across properties ("6a" at two
  // buildings) stays a normal ambiguous pick, NOT a multi-unit request.
  const exactUnitRows = rows.filter(r => r.s.unit === 3);
  const namedCores = new Set(exactUnitRows.map(r => unitCore(r.u.name)));
  if (namedCores.size >= 2) {
    return { status: 'multi_unit', match: null, candidates: candidateList(exactUnitRows), query: norm(text) };
  }

  const fullRows = rows.filter(r => r.s.prop > 0 && r.s.unit > 0).sort((a, b) => b.s.total - a.s.total);
  // Naming a BUILDING beats merely naming its area. If any full match got there via
  // the property name, location-only matches are discarded rather than ranked below
  // it — otherwise "mercer 5b" at a Sheung Wan property would stay 'ambiguous'
  // against every other Sheung Wan 5B, and the prospect gets asked a question they
  // already answered. Location only ever decides when NO name matched at all.
  const namedFull = fullRows.filter(r => r.s.nameProp > 0);
  const full = namedFull.length ? namedFull : fullRows;
  const propMatched = rows.filter(r => r.s.prop > 0).sort((a, b) => b.s.prop - a.s.prop);
  const unitMatched = rows.filter(r => r.s.unit > 0).sort((a, b) => b.s.unit - a.s.unit);

  if (full.length === 1) {
    return { status: 'confident', match: unitOut(full[0].u), candidates: [unitOut(full[0].u)], query: norm(text) };
  }
  if (full.length > 1) {
    return { status: 'ambiguous', match: null, candidates: candidateList(full), query: norm(text) };
  }
  if (propMatched.length > 0) {
    return { status: 'property_only', match: null, candidates: candidateList(propMatched), query: norm(text) };
  }
  if (unitMatched.length > 0) {
    return { status: 'ambiguous', match: null, candidates: candidateList(unitMatched), query: norm(text) };
  }
  return { status: 'none', match: null, candidates: [], query: norm(text) };
}

// Load active units for the org + a `marketable` flag (current lease opted in, or
// vacant with an active host link — i.e. what resolveMarketedUnit would accept).
async function loadUnitsWithMarketable(pool, orgId) {
  const [rows] = await pool.execute(
    `SELECT u.id, u.name, u.property_id, p.display_name AS property_name, p.district, p.city, p.street_address,
            (SELECT l.viewing_enabled FROM leasing l
               WHERE l.unit_id = u.id AND l.deleted_at IS NULL
                 AND l.start_date <= ${orgTodaySql()} AND (l.end_date >= ${orgTodaySql()} OR l.end_date IS NULL)
               ORDER BY l.start_date DESC LIMIT 1) AS cur_ve,
            (SELECT COUNT(*) FROM leasing l
               WHERE l.unit_id = u.id AND l.deleted_at IS NULL
                 AND l.start_date <= ${orgTodaySql()} AND (l.end_date >= ${orgTodaySql()} OR l.end_date IS NULL)) AS has_lease,
            (SELECT COUNT(*) FROM viewing_link vl
               WHERE vl.unit_id = u.id AND vl.status = 1 AND vl.employee_id IS NOT NULL) AS host_links
       FROM unit u JOIN property p ON u.property_id = p.id
      WHERE p.org_id = ? AND u.active_status = 1 AND u.deleted_at IS NULL AND (p.deleted_at IS NULL)
      ORDER BY p.display_name, u.name`,
    [orgId]
  );
  return rows.map(r => ({
    id: r.id, name: r.name, property_id: r.property_id, property_name: r.property_name,
    district: r.district, city: r.city, street_address: r.street_address,
    marketable: (Number(r.has_lease) > 0 && Number(r.cur_ve) === 1) || (Number(r.has_lease) === 0 && Number(r.host_links) > 0),
  }));
}

async function resolveUnit(pool, orgId, text) {
  const units = await loadUnitsWithMarketable(pool, orgId);
  return scoreUnits(text, units);
}

// Render a candidate list as numbered options for the %Unit Options% template var.
function optionsText(candidates) {
  return (candidates || []).map((c, i) => `${i + 1}) ${c.label}`).join('\n');
}

module.exports = {
  // unitOut is exported so /units/resolve emits the identical shape rather than
  // keeping its own copy. Partners learn one unit vocabulary; two hand-maintained
  // formatters would drift apart silently the first time either gains a field.
  scoreUnits, resolveUnit, loadUnitsWithMarketable, optionsText, unitOut,
  // exported for tests
  _norm: norm, _squish: squish, _editDistance: editDistance, _unitCore: unitCore,
};
