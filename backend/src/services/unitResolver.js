/**
 * Fuzzy resolution of a prospect's free text ("mongkok 6a", "mk 6a", "mongkok")
 * to a unit, for the viewing relay. The scoring is PURE (scoreUnits) so it is
 * unit-tested in isolation; resolveUnit() adds the DB load + per-unit marketable
 * flag (used to build disambiguation lists).
 *
 * NO unit is ever renamed — matching tolerates messy names: a stray suffix on a
 * real unit still matches its core token (unit "core" token = the first token of
 * the name).
 *
 * Placeholder/test records are excluded from the candidate load entirely — see
 * utils/publicUnitScope. That is scope-by-omission on purpose: a test unit that
 * never enters the candidate set cannot be scored, cannot win, and cannot be
 * named back to a customer. Filtering after scoring would leave the "confident"
 * decision to have already been made against it.
 */

const { orgTodaySql } = require('../utils/orgTime');
const { PUBLIC_UNIT_NAME_SQL } = require('../utils/publicUnitScope');

// A hyphen INSIDE a word joins; a space separates. unitCore keeps only the first
// token, which is what lets a stray suffix be tolerated ("6A Test" -> "6a") — but
// norm() turned every punctuation run into a space, so "3D-A" and "3D-B" both
// collapsed to "3d" and a customer typing either name exactly was still asked to
// choose between them. Only a hyphen between two alphanumerics is joined, so a
// hyphen used as punctuation ("mong kok - 6a") keeps separating as before.
function joinHyphens(s) {
  return String(s == null ? '' : s).replace(/([a-z0-9])-([a-z0-9])/ig, '$1$2');
}
function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}
function squish(s) { return norm(s).replace(/ /g, ''); }
function toTokens(s) { const n = norm(s); return n ? n.split(' ') : []; }

// "25,000" must survive normalisation as ONE token. norm() turns every
// non-alphanumeric run into a space, so a comma-written budget arrives as
// ["25","000"] - neither half looks like money, so the /^\d+[km]$/ rule never
// fires and "000" was reported to callers as a flat we could not find.
// Collapsing here rather than suppressing later keeps a real "unit 103 105"
// intact: it is the COMMA that says these digits are one number, unless the run
// is explicitly introduced as a unit reference.
const UNIT_MARKER_BEFORE_DIGITS = /(\b(?:units?|flats?|apt|apartments?|rooms?|suites?|rm|nos?)\.?\s*|#\s*)$/i;

function collapseThousands(text) {
  let out = String(text == null ? '' : text);
  let prev;
  do {
    prev = out;
    out = out.replace(/(\d),(\d{3})(?!\d)/g, (match, a, b, offset, whole) => {
      let runStart = offset;
      while (runStart > 0 && /\d/.test(whole[runStart - 1])) runStart -= 1;
      return UNIT_MARKER_BEFORE_DIGITS.test(whole.slice(0, runStart)) ? match : a + b;
    });
  } while (out !== prev);
  return out;
}

// "12,500.50" is one price. collapseThousands makes it "12500.50" and norm() then
// splits on the dot, leaving a bare "50" that gets reported as a flat we could not
// find. A dot between digits is a decimal point; no unit we own has one in its name.
// Dropping the fraction here keeps the integer part intact for every other rule.
function dropDecimalFraction(text) {
  return String(text == null ? '' : text).replace(/(\d)\.\d{1,2}(?!\d)/g, '$1');
}

const FLOOR_UNIT_WORDS = new Set(['studio', 'flat', 'unit', 'room', 'apt', 'apartment', 'suite', 'rm', 'no']);

function normalizeFloorUnit(text) {
  if (typeof text !== 'string') return text;

  const floorMarker = /(^|[^a-z0-9])(\d{1,2})\s*\/?\s*f(?=$|[^a-z0-9])/ig;
  const letterToken = /(^|[^a-z0-9])([a-z])(?=$|[^a-z0-9])/ig;

  for (const floor of text.matchAll(floorMarker)) {
    const floorStart = floor.index + floor[1].length;
    const floorEnd = floor.index + floor[0].length;
    const floorDigits = floor[2];

    for (const letter of text.matchAll(letterToken)) {
      const letterStart = letter.index + letter[1].length;
      const letterEnd = letter.index + letter[0].length;
      const value = letter[2].toLowerCase();

      if (letterStart <= floorEnd) continue;
      if ((value === 'a' || value === 'i') && toTokens(text.slice(letterEnd)).length > 0) continue;

      const betweenTokens = toTokens(text.slice(floorEnd, letterStart));
      const allowedGap = betweenTokens.length === 0 ||
        (betweenTokens.length === 1 && FLOOR_UNIT_WORDS.has(betweenTokens[0]));
      if (!allowedGap) continue;

      return norm([
        text.slice(0, floorStart),
        text.slice(floorEnd, letterStart),
        text.slice(letterEnd),
        `${floorDigits}${value}`,
      ].join(' '));
    }
  }

  return text;
}
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
  const t = toTokens(joinHyphens(name));
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

function locationMatchedTokens(value, qSquish, qTokens) {
  const lSquish = squish(value);
  if (lSquish.length < 3) return [];
  const lTokens = toTokens(value);
  if (qSquish.includes(lSquish)) return lTokens;
  if (lTokens.length === 1 && qTokens.includes(lTokens[0])) return lTokens;
  return [];
}

const ADDRESS_STOPWORDS = new Set([
  'street', 'road', 'building', 'mansion', 'apartments', 'apartment', 'bazaar',
  'tower', 'court', 'block', 'house', 'centre', 'center', 'commercial', 'floor',
  'unit', 'flat', 'lane', 'terrace', 'estate', 'garden', 'gardens', 'st', 'rd',
  'fl',
]);

function qualifyingAddressTokens(streetAddress) {
  return toTokens(streetAddress).filter(t => {
    if (t.length < 4) return false;
    // Numeric street-address parts and generic address words carry no property
    // identity: "8 Cleverly Street" must not let "8" identify a unit or property.
    if (/^\d+$/.test(t)) return false;
    if (ADDRESS_STOPWORDS.has(t)) return false;
    return true;
  });
}

function addressMatchedTokens(streetAddress, qTokens) {
  const query = new Set(qTokens);
  return [...new Set(qualifyingAddressTokens(streetAddress).filter(t => query.has(t)))];
}

// Words that mark the token beside them as a STREET NAME rather than an ordinary
// word. They are address stopwords above (they carry no identity of their own),
// but in the customer's sentence they are the evidence that "possession" means
// Possession Street and not "I need possession by 1 Oct".
const STREET_TYPE_WORDS = new Set([
  'street', 'st', 'road', 'rd', 'lane', 'avenue', 'ave', 'terrace', 'crescent',
  'path', 'square', 'drive', 'quay', 'praya',
]);

// Place names are excluded from single-token matching: "kowloon" appears in
// exactly one property's address, but it is also a district, and "anything in
// Kowloon?" must not resolve to the one building that happens to sit there.
function placeNameTokens(units) {
  const out = new Set();
  for (const u of units || []) {
    for (const t of toTokens(u.district)) out.add(t);
    for (const t of toTokens(u.city)) out.add(t);
  }
  return out;
}

// True when the customer wrote a street-type word next to this token.
function namedAsStreet(token, qTokens) {
  for (let i = 0; i < qTokens.length; i++) {
    if (qTokens[i] !== token) continue;
    if (STREET_TYPE_WORDS.has(qTokens[i + 1] || '')) return true;
    if (STREET_TYPE_WORDS.has(qTokens[i - 1] || '')) return true;
  }
  return false;
}

// Two matching address words identify a building on their own ("Bonham Strand
// West"). ONE does too, but only when it is long enough to be a real street name,
// is not a district/city, and the customer wrote "Street"/"Road" beside it — which
// is what rescues "Russell Street" and "Possession Street", each of which has a
// single distinctive word and matched nothing at all before.
function addressMatchScore(streetAddress, qTokens, placeTokens = new Set()) {
  const matched = addressMatchedTokens(streetAddress, qTokens);
  if (matched.length >= 2) return 2;
  return matched.some(t =>
    t.length >= 6 && !placeTokens.has(t) && namedAsStreet(t, qTokens)
  ) ? 2 : 0;
}

// A bare number in a sentence is a price, a headcount or a duration far more often
// than it is a flat: "my budget is 10,000" tokenises to ["my","budget","is","10","000"]
// and "10" is the exact core of unit "10/F". So a purely numeric unit name is only
// matched when the customer MARKED the number as a unit reference - "flat 10",
// "unit 25", "10/F". Names carrying a letter ("6a") are unaffected; they cannot
// collide with a quantity.
function markedNumericTokens(qTokens) {
  const marked = new Set();
  for (let i = 0; i < qTokens.length; i++) {
    if (!/^\d+$/.test(qTokens[i])) continue;
    const before = i > 0 ? qTokens[i - 1] : null;
    const after = i + 1 < qTokens.length ? qTokens[i + 1] : null;
    const coordinatedAfterMarkedNumber =
      before === 'and' && i > 1 && marked.has(qTokens[i - 2]);
    if ((before && FLOOR_UNIT_WORDS.has(before)) || after === 'f' || after === 'floor' || coordinatedAfterMarkedNumber) {
      marked.add(qTokens[i]);
    }
  }
  return marked;
}

// A bare unit letter: "Studio A", "unit a", "A unit". Read from the RAW message,
// before norm() lowercases it, because for the letter "a" the capital is the only
// thing separating a unit name from the English article.
//
//   marker THEN letter ("studio A", "unit a")  - safe in any case: an article
//     cannot follow "studio", so there is nothing to confuse it with.
//   letter THEN marker ("A unit")              - safe in any case for b-z, but
//     for "a"/"i" it is exactly the shape of "do you have a unit available".
//     Those need a capital that the writer chose: not sentence-initial (every
//     sentence starts capitalised), and not in an all-caps message (where the
//     capital says nothing). When the guard rejects it we simply fall through to
//     the old behaviour - list the building's units and ask.
const UNIT_MARKER_WORDS = 'studios?|units?|flats?|rooms?|apt|apartments?|suites?|rm';
const ARTICLE_LETTERS = new Set(['a', 'i']);
const EMPTY_SET = new Set();

// "3/F unit" is a FLOOR, and its "F" is not unit F — at Nam Pak Hong it would
// have matched 7F and answered a question about the 3rd floor with a 7th-floor
// flat. normalizeFloorUnit reads floor markers properly; here they are simply
// removed so they cannot be misread as a letter.
function stripFloorMarkers(text) {
  return text.replace(/\b\d{1,2}\s*\/?\s*f\b/ig, ' ');
}

function explicitUnitLetters(rawText) {
  const text = stripFloorMarkers(String(rawText == null ? '' : rawText));
  const letters = new Set();
  const caseIsInformative = /[a-z]/.test(text);

  for (const m of text.matchAll(new RegExp(`\\b(?:${UNIT_MARKER_WORDS})\\.?\\s*([A-Za-z])\\b`, 'ig'))) {
    letters.add(m[1].toLowerCase());
  }
  for (const m of text.matchAll(new RegExp(`\\b([A-Za-z])\\s+(?:${UNIT_MARKER_WORDS})\\b`, 'ig'))) {
    const letter = m[1];
    const lower = letter.toLowerCase();
    if (!ARTICLE_LETTERS.has(lower)) { letters.add(lower); continue; }
    const startsMessage = text.slice(0, m.index).trim() === '';
    if (caseIsInformative && letter === letter.toUpperCase() && !startsMessage) letters.add(lower);
  }
  return letters;
}

// The letter that distinguishes one unit on a floor from its neighbours: the last
// letter of a core like "7a" or "3da" (Po Thai's 3D-A, where "3D" is the flat and
// "A" the half). Purely numeric cores have none.
function coreUnitLetter(core) {
  return /^\d+[a-z]{1,2}$/.test(core) ? core[core.length - 1] : null;
}

function scoreOne(qSquish, qTokens, unit, markedNumbers = new Set(), opts = {}) {
  const pName = unit.property_name || '';
  const pSquish = squish(pName);
  const pInit = initials(pName);
  let prop = 0;
  let nameProp = 0;
  // How much of the property's name the customer actually typed. `prop`
  // deliberately scores 2 for ANY single matching word, so "tai yuen" ties Tai
  // Yuen Apartments with 13B Lai Yuen Apartments on the shared word "yuen" - and
  // a stable sort then hands the tie to database order. This breaks that tie by
  // the customer's own words WITHOUT moving anyone between score tiers.
  const nameWordHits = toTokens(pName).filter(w => w.length >= 3 && qTokens.includes(w)).length;
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
    addressMatchScore(unit.street_address, qTokens, opts.placeTokens)
  );
  const core = unitCore(unit.name);
  let u = 0;
  // Whether this unit scored on a bare letter rather than on its own token. The
  // multi_unit rule counts distinct units the customer NAMED, and one letter at a
  // building with five A-units is not five requests — see scoreUnits.
  let viaLetter = false;
  if (core) {
    if (qTokens.includes(core) && (!/^\d+$/.test(core) || markedNumbers.has(core))) u = 3; // exact unit token "6a"
    // A purely-numeric core must match EXACTLY. The prefix tolerance below exists so a
    // customer who drops the letter ("10" for "10A") still lands; a numeric name has no
    // letter to drop, so the tolerance buys nothing there and costs plenty — "my budget
    // is 25k" matched flat 25/F, and "30k" matched a unit whose core is "3".
    else if (!/^\d+$/.test(core) &&
             qTokens.some(t => t.length >= 2 && (t.startsWith(core) || core.startsWith(t)))) u = 2; // "6a" ~ "6ab"
    // A bare letter names the unit once the BUILDING is known: at Nam Pak Hong,
    // whose units are all on the 7th floor, "Studio A" can only be 7A. It is
    // gated on prop > 0 because the letter alone is not a unit reference — "unit
    // A" with no building named would otherwise match an A on every floor of all
    // 17 properties, where today it honestly reports nothing found. Where the
    // building DOES have several (Mong Kok has 1A-5A), every one of them scores
    // and the existing ambiguous path asks which — with the other 14 units of
    // that building no longer in the list.
    if (u < 3 && prop > 0) {
      const letter = coreUnitLetter(core);
      if (letter && (opts.letters || EMPTY_SET).has(letter)) { u = 3; viaLetter = true; }
    }
  }
  const consumed = {
    property: toTokens(pName).filter(w => w.length >= 3),
    district: locationMatchScore(unit.district, 2, qSquish, qTokens)
      ? locationMatchedTokens(unit.district, qSquish, qTokens)
      : [],
    city: locationMatchScore(unit.city, 1, qSquish, qTokens)
      ? locationMatchedTokens(unit.city, qSquish, qTokens)
      : [],
    address: addressMatchScore(unit.street_address, qTokens, opts.placeTokens)
      ? addressMatchedTokens(unit.street_address, qTokens)
      : [],
  };
  return { prop, nameProp, nameWordHits, unit: u, viaLetter, total: prop + u, consumed };
}

// Apply the existing scorer to a second full name. The final normalized token
// is the unit part ("Studio D", "4/F Studio B" -> d / 4b); preceding words are
// its website property name. No new fuzzy or distance rule is introduced.
function scoreWithWebsiteName(qSquish, qTokens, unit, markedNumbers, opts) {
  const original = scoreOne(qSquish, qTokens, unit, markedNumbers, opts);
  if (!unit.website_name) return original;
  const normalized = normalizeFloorUnit(dropDecimalFraction(collapseThousands(joinHyphens(unit.website_name))));
  const tokens = toTokens(normalized);
  if (tokens.length < 2) return original;
  const propertyWords = tokens.slice(0, -1).filter(t => !FLOOR_UNIT_WORDS.has(t) && !['bedroom', 'bedrooms'].includes(t) && !/^\d+$/.test(t));
  if (!propertyWords.length) return original;
  const alias = { ...unit, name: tokens.at(-1), property_name: propertyWords.join(' ') };
  const alternative = scoreOne(qSquish, qTokens, alias, markedNumbers, opts);
  // Property words cannot also be a partial unit token: "1Bedroom" in the
  // website property prefix must not name unit 1B, nor "Bonham" unit B.
  const unitTokens = qTokens.filter(t => !propertyWords.includes(t));
  const unitScore = scoreOne(qSquish, unitTokens, alias, markedNumbers, opts);
  alternative.unit = alias.name.length === 1 && !unitTokens.includes(alias.name) ? 0 : unitScore.unit;
  alternative.viaLetter = unitScore.viaLetter;
  alternative.total = alternative.prop + alternative.unit;
  if (alternative.total < original.total ||
      (alternative.total === original.total && alternative.nameWordHits <= original.nameWordHits)) return original;
  alternative.consumed.property = [...alternative.consumed.property, ...tokens];
  return alternative;
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

function toDateStr(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
  return match ? match[0] : null;
}

function hasAvailability(u) {
  return Object.prototype.hasOwnProperty.call(u, 'vacant_now') ||
    Object.prototype.hasOwnProperty.call(u, 'occupied_until');
}

function availabilityCompare(a, b) {
  if (!hasAvailability(a.u) || !hasAvailability(b.u)) return 0;

  if (a.u.vacant_now === true || b.u.vacant_now === true) {
    if (a.u.vacant_now === true && b.u.vacant_now !== true) return -1;
    if (b.u.vacant_now === true && a.u.vacant_now !== true) return 1;
  }

  const aEnd = a.u.occupied_until || null;
  const bEnd = b.u.occupied_until || null;
  if (aEnd && bEnd) return String(aEnd).localeCompare(String(bEnd));
  if (aEnd) return -1;
  if (bEnd) return 1;
  return 0;
}

function candidateCompare(a, b) {
  return b.s.prop - a.s.prop ||
    b.s.nameWordHits - a.s.nameWordHits ||
    // Unit score belongs ABOVE availability: an exact unit token ("6a") must outrank
    // a partial one at the same building, which is how the ambiguous list was ordered
    // before candidateList sorted internally. Availability only breaks ties between
    // units the customer's words rank equally.
    b.s.unit - a.s.unit ||
    availabilityCompare(a, b) ||
    String(a.u.name || '').localeCompare(String(b.u.name || '')) ||
    String(a.u.property_name || '').localeCompare(String(b.u.property_name || ''));
}

// Build the candidate list for a disambiguation prompt: marketable units first;
// if none are marketable, fall back to all so the prospect still gets options.
function candidateList(rows, cap = 40) {
  const marketable = rows.filter(r => r.u.marketable);
  const availableRows = (marketable.length ? marketable : rows).slice().sort(candidateCompare);
  return {
    candidates: availableRows.slice(0, cap).map(r => unitOut(r.u)),
    candidate_count: availableRows.length,
  };
}

function unitShape(core) {
  return String(core || '').replace(/[0-9]/g, '9').replace(/[a-z]/g, 'x');
}

const FLOOR_CONTEXT_LIMIT = 8;

function unitCoreFloor(core) {
  const match = String(core || '').match(/^(\d+)/);
  return match ? match[1] : null;
}

function floorContext(token, matchedPropertyIds, units) {
  const tokenFloor = String(token || '').match(/^(\d+)[a-z]$/);
  if (!tokenFloor || matchedPropertyIds.size !== 1) {
    return { floor: null, floor_units: [], floor_unit_count: 0 };
  }

  const floor = tokenFloor[1];
  const [propertyId] = matchedPropertyIds;
  const floorUnits = units
    .filter(u => String(u.property_id) === propertyId && unitCoreFloor(unitCore(u.name)) === floor)
    .sort((a, b) => unitCore(a.name).localeCompare(unitCore(b.name)) || String(a.name || '').localeCompare(String(b.name || '')))
    .map(u => unitOut(u).label);

  return {
    floor,
    floor_units: floorUnits.slice(0, FLOOR_CONTEXT_LIMIT),
    floor_unit_count: floorUnits.length,
  };
}

const MONTH_WORDS = new Set([
  'jan', 'january', 'feb', 'february', 'mar', 'march', 'apr', 'april', 'may',
  'jun', 'june', 'jul', 'july', 'aug', 'august', 'sep', 'sept', 'september',
  'oct', 'october', 'nov', 'november', 'dec', 'december',
]);
const UNIT_DOMAIN_FOLLOWERS = new Set([
  'month', 'months', 'year', 'years', 'sqft', 'sq', 'sf', 'ft', 'pax',
  'bed', 'beds', 'bedroom', 'bedrooms', 'br',
]);

function suppressedNonUnitToken(tokens, index, markedNumbers = new Set()) {
  const token = tokens[index];
  if (/^\d+[km]$/.test(token)) return true;
  if (/^\d+(am|pm)$/.test(token)) return true;
  if (MONTH_WORDS.has(token)) return true;
  if (/^\d{1,3}$/.test(token) && /^\d{3}$/.test(tokens[index + 1] || '') &&
      !markedNumbers.has(token) && !markedNumbers.has(tokens[index + 1])) return true;
  if (/^\d{3}$/.test(token) && /^\d{1,3}$/.test(tokens[index - 1] || '') &&
      !markedNumbers.has(token) && !markedNumbers.has(tokens[index - 1])) return true;
  return UNIT_DOMAIN_FOLLOWERS.has(tokens[index + 1]);
}

function scoreResult(status, match, candidateInfo, query, rows, qTokens, units, markedNumbers = new Set(), ignoredUnitPropertyIds = new Set()) {
  const candidates = Array.isArray(candidateInfo) ? candidateInfo : (candidateInfo && candidateInfo.candidates) || [];
  const candidate_count = Array.isArray(candidateInfo)
    ? candidateInfo.length
    : Number(candidateInfo && candidateInfo.candidate_count) || 0;
  const result = { status, match, candidates, candidate_count, query, unmatched: [] };
  if (status === 'none') return result;

  const candidateIds = new Set((candidates || []).map(c => String(c.unit_id)));
  if (match) candidateIds.add(String(match.unit_id));
  const candidateRows = rows.filter(r =>
    candidateIds.has(String(r.u.id)) && !ignoredUnitPropertyIds.has(String(r.u.property_id))
  );
  const matchedRows = candidateRows.length ? candidateRows : rows.filter(r => r.s.prop > 0);
  const matchedPropertyIds = new Set(matchedRows.map(r => String(r.u.property_id)));

  const consumed = new Set(GENERIC_UNIT_WORDS);
  for (const row of matchedRows) {
    for (const group of ['property', 'district', 'city', 'address']) {
      for (const token of row.s.consumed[group] || []) consumed.add(token);
    }
  }
  for (const row of rows) {
    if (ignoredUnitPropertyIds.has(String(row.u.property_id))) continue;
    if (row.s.unit > 0 && (row.s.prop > 0 || matchedPropertyIds.has(String(row.u.property_id)))) {
      consumed.add(unitCore(row.u.name));
    }
  }
  for (const row of candidateRows) consumed.add(unitCore(row.u.name));

  const coreByUnit = units.map(u => ({ u, core: unitCore(u.name), shape: unitShape(unitCore(u.name)) }));
  const shapes = new Set(coreByUnit.map(x => x.shape).filter(Boolean));
  const matchedPropertyHasNumeric = coreByUnit.some(x =>
    /^\d+$/.test(x.core) && matchedPropertyIds.has(String(x.u.property_id))
  );
  const seen = new Set();

  for (let i = 0; i < qTokens.length; i++) {
    const token = qTokens[i];
    if (seen.has(token)) continue;
    if (consumed.has(token)) continue;
    if (suppressedNonUnitToken(qTokens, i, markedNumbers)) continue;
    const shape = unitShape(token);
    if (!shapes.has(shape)) continue;
    if (/^9+$/.test(shape) && !matchedPropertyHasNumeric) continue;

    seen.add(token);
    result.unmatched.push({
      text: token,
      reason: 'unit_like_not_found',
      ...floorContext(token, matchedPropertyIds, units),
    });
  }

  return result;
}

/**
 * Pure resolver. `units` = [{id,name,property_id,property_name,marketable}].
 * Returns { status, match, candidates, query, unmatched }.
 *   status: 'confident' | 'ambiguous' | 'property_only' | 'multi_unit' | 'none'
 */
function scoreUnits(text, units) {
  const scoreText = normalizeFloorUnit(dropDecimalFraction(collapseThousands(joinHyphens(text))));
  const qSquish = squish(scoreText);
  const qTokens = toTokens(scoreText);
  if (!qTokens.length) return { status: 'none', match: null, candidates: [], candidate_count: 0, query: String(text || ''), unmatched: [] };

  const markedNumbers = markedNumericTokens(qTokens);
  const placeTokens = placeNameTokens(units);
  let rows = units.map(u => ({ u, s: scoreWithWebsiteName(qSquish, qTokens, u, markedNumbers, { placeTokens }) }));

  // The bare letter is a FALLBACK, read from the RAW text (the capital on "A" is
  // the whole signal and norm() destroys it). It is consulted only when nothing at
  // a matched building was named by its own token — because a sentence that
  // already names a unit is not also asking for a different one by letter. A unit
  // genuinely CALLED "3/F Unit 1 (Room A and Room B)" is the case in point: typed
  // out in full it names itself, and its own "Room A"/"Room B" were then matching
  // flats 3A and 3B, turning an exact request into a list of three.
  const letters = explicitUnitLetters(text);
  if (letters.size && !rows.some(r => r.s.prop > 0 && r.s.unit === 3)) {
    rows = units.map(u => ({ u, s: scoreWithWebsiteName(qSquish, qTokens, u, markedNumbers, { placeTokens, letters }) }));
  }

  // "More than one unit" intent: the prospect named ≥2 DISTINCT units at a
  // matched property, each an exact unit-token match (e.g. "mongkok 6a 5a"). We
  // don't auto-arrange a multi-unit viewing — the caller escalates it to staff.
  // "Distinct" is by unit core, so a single token that merely collides across
  // properties ("6a" at two buildings) stays a normal ambiguous pick, NOT a
  // multi-unit request.
  // viaLetter is excluded: "Tung Choi A unit" scores 1A-5A at 3 apiece, but the
  // customer typed ONE letter. Counting those as five named units escalated a
  // plain enquiry to staff as a multi-flat viewing request.
  const exactUnitRows = rows.filter(r => r.s.unit === 3 && r.s.prop > 0 && !r.s.viaLetter);
  const namedCores = new Set(exactUnitRows.map(r => unitCore(r.u.name)));
  if (namedCores.size >= 2) {
    return scoreResult('multi_unit', null, candidateList(exactUnitRows), norm(text), rows, qTokens, units, markedNumbers);
  }

  const byNameWordHits = (a, b) => b.s.nameWordHits - a.s.nameWordHits;
  const fullRows = rows.filter(r => r.s.prop > 0 && r.s.unit > 0)
    .sort((a, b) => b.s.total - a.s.total || byNameWordHits(a, b));
  // Naming a BUILDING beats merely naming its area. If any full match got there via
  // the property name, location-only matches are discarded rather than ranked below
  // it — otherwise "mercer 5b" at a Sheung Wan property would stay 'ambiguous'
  // against every other Sheung Wan 5B, and the prospect gets asked a question they
  // already answered. Location only ever decides when NO name matched at all.
  const namedFull = fullRows.filter(r => r.s.nameProp > 0);
  const full = namedFull.length ? namedFull : fullRows;
  // A full match at a building the customer named LESS well than another building is
  // not a confident answer, it is a guess. "tai yuen unit 103" matched 13B Lai Yuen on
  // the shared word "yuen" alone, while Tai Yuen Apartments matched both words and
  // simply has no 103 — so the honest reply is "Tai Yuen has no 103", not a confident
  // flat in a different building.
  const bestNameHits = rows.reduce((m, r) => Math.max(m, r.s.nameWordHits), 0);
  const fullWellNamed = full.filter(r => r.s.nameWordHits >= bestNameHits);
  const propMatched = rows.filter(r => r.s.prop > 0)
    .sort((a, b) => b.s.prop - a.s.prop || byNameWordHits(a, b));
  const unitMatched = rows.filter(r => r.s.unit > 0)
    .sort((a, b) => b.s.unit - a.s.unit || byNameWordHits(a, b));

  if (fullWellNamed.length === 1) {
    const match = unitOut(fullWellNamed[0].u);
    return scoreResult('confident', match, { candidates: [match], candidate_count: 1 }, norm(text), rows, qTokens, units, markedNumbers);
  }
  if (fullWellNamed.length > 1) {
    return scoreResult('ambiguous', null, candidateList(fullWellNamed), norm(text), rows, qTokens, units, markedNumbers);
  }
  if (propMatched.length > 0) {
    const weakFullRejected = full.length > 0 && fullWellNamed.length === 0;
    const propertyRows = weakFullRejected
      ? propMatched.filter(r => r.s.nameWordHits >= bestNameHits)
      : propMatched;
    const ignoredUnitPropertyIds = weakFullRejected
      ? new Set(full.map(r => String(r.u.property_id)))
      : new Set();
    return scoreResult('property_only', null, candidateList(propertyRows), norm(text), rows, qTokens, units, markedNumbers, ignoredUnitPropertyIds);
  }
  if (unitMatched.length > 0) {
    return scoreResult('ambiguous', null, candidateList(unitMatched), norm(text), rows, qTokens, units, markedNumbers);
  }
  return scoreResult('none', null, [], norm(text), rows, qTokens, units, markedNumbers);
}

// Load active units for the org + a `marketable` flag (current lease opted in, or
// vacant with an active host link — i.e. what resolveMarketedUnit would accept).
// The property's own status matters as much as the unit's. Deactivating a property in Tenafy is how
// an operator takes a building out of service; without that filter its units kept matching prospect
// messages, so a deactivated (or test) building could answer a real customer and collide with a live
// unit, escalating a straightforward booking as multi_unit.
async function loadUnitsWithMarketable(pool, orgId) {
  const [rows] = await pool.execute(
    `SELECT u.id, u.name, u.property_id, p.display_name AS property_name, p.district, p.city, p.street_address, u.website_name,
            (SELECT l.viewing_enabled FROM leasing l
               WHERE l.unit_id = u.id AND l.deleted_at IS NULL
                 AND l.start_date <= ${orgTodaySql()} AND (l.end_date >= ${orgTodaySql()} OR l.end_date IS NULL)
               ORDER BY l.start_date DESC LIMIT 1) AS cur_ve,
            (SELECT COUNT(*) FROM leasing l
               WHERE l.unit_id = u.id AND l.deleted_at IS NULL
                 AND l.start_date <= ${orgTodaySql()} AND (l.end_date >= ${orgTodaySql()} OR l.end_date IS NULL)) AS has_lease,
            (SELECT l.end_date FROM leasing l
               WHERE l.unit_id = u.id AND l.deleted_at IS NULL
                 AND l.start_date <= ${orgTodaySql()} AND (l.end_date >= ${orgTodaySql()} OR l.end_date IS NULL)
               ORDER BY l.start_date DESC LIMIT 1) AS cur_end,
            (SELECT COUNT(*) FROM viewing_link vl
               WHERE vl.unit_id = u.id AND vl.status = 1 AND vl.employee_id IS NOT NULL) AS host_links
       FROM unit u JOIN property p ON u.property_id = p.id
      WHERE p.org_id = ? AND u.active_status = 1 AND u.deleted_at IS NULL
        AND p.deleted_at IS NULL AND p.status = 1
        AND ${PUBLIC_UNIT_NAME_SQL}
      ORDER BY p.display_name, u.name`,
    [orgId]
  );
  return rows.map(r => ({
    id: r.id, name: r.name, property_id: r.property_id, property_name: r.property_name,
    district: r.district, city: r.city, street_address: r.street_address, website_name: r.website_name,
    marketable: (Number(r.has_lease) > 0 && Number(r.cur_ve) === 1) || (Number(r.has_lease) === 0 && Number(r.host_links) > 0),
    vacant_now: Number(r.has_lease) === 0,
    occupied_until: r.cur_end ? toDateStr(r.cur_end) : null,
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
  candidateList, normalizeFloorUnit, collapseThousands, dropDecimalFraction, joinHyphens, explicitUnitLetters, _norm: norm, _squish: squish, _editDistance: editDistance, _unitCore: unitCore,
};
