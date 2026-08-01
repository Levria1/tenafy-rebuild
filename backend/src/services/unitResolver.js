/**
 * Fuzzy resolution of a prospect's free text ("mongkok 6a", "mk 6a", "mongkok")
 * to a unit, for the viewing relay. The scoring is PURE (scoreUnits) so it is
 * unit-tested in isolation; resolveUnit() adds the DB load + per-unit marketable
 * flag (used to build disambiguation lists).
 *
 * NO unit is ever renamed — matching tolerates messy names: a stray suffix like
 * "6A Test" still matches "6a" (unit "core" token = the first token of the name).
 */

function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}
function squish(s) { return norm(s).replace(/ /g, ''); }
function toTokens(s) { const n = norm(s); return n ? n.split(' ') : []; }
// property initials alias: "Mong Kok" -> "mk", "Nam Pak Hong" -> "nph"
function initials(name) { return toTokens(name).map(w => w[0]).join(''); }
// the meaningful unit token: first token of the name — "6A Test" -> "6a"
function unitCore(name) { const t = toTokens(name); return t.length ? t[0] : ''; }

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
function scoreOne(qSquish, qTokens, unit) {
  const pName = unit.property_name || '';
  const pSquish = squish(pName);
  const pInit = initials(pName);
  let prop = 0;
  if (pSquish && qSquish.includes(pSquish)) prop = 3;                          // "mongkok" in "mongkok6a"
  else if (pInit.length >= 2 && qTokens.includes(pInit)) prop = 3;            // alias "mk"
  else {
    const pWords = toTokens(pName).filter(w => w.length >= 3);
    if (pWords.some(w => qTokens.includes(w))) prop = 2;                      // a property word appears
    else if (pSquish.length >= 4 &&
             qTokens.some(t => t.length >= 4 && editDistance(t, pSquish, 1) <= 1)) prop = 2; // typo "mongok"
  }
  const core = unitCore(unit.name);
  let u = 0;
  if (core) {
    if (qTokens.includes(core)) u = 3;                                        // exact unit token "6a"
    else if (qTokens.some(t => t.length >= 2 && (t.startsWith(core) || core.startsWith(t)))) u = 2; // "6" ~ "6a"
  }
  return { prop, unit: u, total: prop + u };
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
  const full = rows.filter(r => r.s.prop > 0 && r.s.unit > 0).sort((a, b) => b.s.total - a.s.total);
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
    `SELECT u.id, u.name, u.property_id, p.display_name AS property_name,
            (SELECT l.viewing_enabled FROM leasing l
               WHERE l.unit_id = u.id AND l.deleted_at IS NULL
                 AND l.start_date <= CURDATE() AND (l.end_date >= CURDATE() OR l.end_date IS NULL)
               ORDER BY l.start_date DESC LIMIT 1) AS cur_ve,
            (SELECT COUNT(*) FROM leasing l
               WHERE l.unit_id = u.id AND l.deleted_at IS NULL
                 AND l.start_date <= CURDATE() AND (l.end_date >= CURDATE() OR l.end_date IS NULL)) AS has_lease,
            (SELECT COUNT(*) FROM viewing_link vl
               WHERE vl.unit_id = u.id AND vl.status = 1 AND vl.employee_id IS NOT NULL) AS host_links
       FROM unit u JOIN property p ON u.property_id = p.id
      WHERE p.org_id = ? AND u.active_status = 1 AND u.deleted_at IS NULL AND (p.deleted_at IS NULL)
      ORDER BY p.display_name, u.name`,
    [orgId]
  );
  return rows.map(r => ({
    id: r.id, name: r.name, property_id: r.property_id, property_name: r.property_name,
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
  scoreUnits, resolveUnit, loadUnitsWithMarketable, optionsText,
  // exported for tests
  _norm: norm, _squish: squish, _editDistance: editDistance, _unitCore: unitCore,
};
