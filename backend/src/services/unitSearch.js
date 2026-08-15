// Shared unit-search engine.
//
// One implementation used by BOTH the public API (`GET /api/public/units/search`,
// which TaneChat calls) and the internal chatbot tool (`search_available_units`
// in chatTools.js). Keeping a single engine means both bots rank and filter
// identically — no drift between the customer-facing and staff bots.
//
// Ranking: timing-first by default — units that free up closest to the
// requested move-in date (smallest vacancy gap) rank highest, since that's the
// most "suitable" match. Budget is surfaced as proximity metadata (and an
// optional soft margin) rather than a hard cut, so close-but-not-exact options
// can be shown with a note instead of returning nothing.

const { orgToday } = require('../utils/orgTime');

function toDateStr(d) {
  return (d instanceof Date ? d : new Date(d)).toISOString().split('T')[0];
}

// Acceptable forward-vacancy-gap band (days) by reservation length. Returns the
// max gap we'll tolerate, or null when the reservation length is unknown.
//   1–2 months  → 5    3–5 months → 7    6–11 months → 10    12+ months → 20
function gapBandDays(leaseDurationDays) {
  if (leaseDurationDays == null) return null;
  const months = Math.round(leaseDurationDays / 30.44);
  if (months <= 2) return 5;
  if (months <= 5) return 7;
  if (months <= 11) return 10;
  return 20;
}

/**
 * @param {object} pool  org DB pool
 * @param {object} criteria
 *   orgId            (required)
 *   moveIn           'YYYY-MM-DD' (default today)
 *   moveOut          'YYYY-MM-DD' | null
 *   bedrooms         exact bedroom count | null (0 = studio)
 *   bathrooms        exact bath count | null
 *   minPrice         number | null  (hard floor)
 *   maxPrice         number | null  (hard ceiling, widened by budgetMarginPct)
 *   budgetMarginPct  number (default 0) — e.g. 0.15 includes units up to 15% over maxPrice, flagged
 *   budget           number | null  — prospect's stated budget; drives over_budget_* metadata only
 *   propertyId       string | null
 *   cityNames        string[]  (lowercased, exact city match)
 *   districtNames    string[]  (lowercased, exact district match)
 *   amenityNames     string[]  (all required)
 *   sortBy           'vacancy_gap' (default) | 'price_asc' | 'price_desc'
 *   limit            number (default 10)
 *   baseUrl          string | null — when set, photo gallery URLs are built absolute
 * @returns {Promise<{ results: object[], total: number }>}
 */
async function searchUnits(pool, criteria = {}) {
  const {
    orgId,
    moveIn = orgToday(),
    moveOut = null,
    bedrooms = null,
    bathrooms = null,
    minPrice = null,
    maxPrice = null,
    budgetMarginPct = 0,
    budget = null,
    propertyId = null,
    cityNames = [],
    districtNames = [],
    amenityNames = [],
    sortBy = 'vacancy_gap',
    limit = 10,
    baseUrl = null,
    // When true (default), a unit that is occupied RIGHT NOW is only offerable
    // if its current lease ends before the move-in date AND the tenant is Not
    // Renewing (contract_type=3). Empty-now units are always offerable. This
    // stops us advertising "May Renew" units that probably won't free up.
    excludeRenewing = true,
  } = criteria;
  const NR_CONTRACT = 3; // contract_type: Not Renewing
  const todayStr = orgToday();

  let where = 'p.org_id = ? AND p.status = 1 AND p.deleted_at IS NULL AND u.active_status = 1 AND u.deleted_at IS NULL';
  const params = [orgId];
  if (propertyId) { where += ' AND p.id = ?'; params.push(propertyId); }
  if (bedrooms !== null && !Number.isNaN(bedrooms)) { where += ' AND u.beds = ?'; params.push(bedrooms); }
  if (bathrooms !== null && !Number.isNaN(bathrooms)) { where += ' AND u.baths = ?'; params.push(bathrooms); }
  if (cityNames.length > 0) {
    where += ` AND LOWER(TRIM(p.city)) IN (${cityNames.map(() => '?').join(',')})`;
    params.push(...cityNames);
  }
  if (districtNames.length > 0) {
    where += ` AND LOWER(TRIM(p.district)) IN (${districtNames.map(() => '?').join(',')})`;
    params.push(...districtNames);
  }

  // Candidate units with last-lease (pricing/availability) + next-lease data.
  // "Available on moveIn" = no active lease covers that day.
  // today_lease = the lease occupying the unit RIGHT NOW (one row/unit). Used to
  // exclude currently-occupied units whose lease ends before move-in but whose
  // tenant might renew (only contract_type=3 / Not Renewing is offerable).
  const todayJoin = excludeRenewing ? `
     LEFT JOIN (
       SELECT t1.unit_id, t1.end_date, t1.contract_type
       FROM leasing t1
       INNER JOIN (
         SELECT unit_id, MAX(start_date) AS max_start FROM leasing
         WHERE deleted_at IS NULL AND start_date <= ? AND (end_date >= ? OR end_date IS NULL)
         GROUP BY unit_id
       ) t2 ON t1.unit_id = t2.unit_id AND t1.start_date = t2.max_start
       WHERE t1.deleted_at IS NULL
     ) today_lease ON today_lease.unit_id = u.id` : '';
  const renewClause = excludeRenewing ? `
       AND (
         today_lease.unit_id IS NULL          -- empty now → offerable
         OR today_lease.end_date IS NULL       -- ongoing (also covered by active_lease)
         OR today_lease.end_date >= ?          -- still occupied at move-in (also covered by active_lease)
         OR today_lease.contract_type = ${NR_CONTRACT}  -- ends before move-in AND Not Renewing → offerable
       )` : '';

  const [rows] = await pool.execute(
    `SELECT u.id AS unit_id, u.name AS unit_name, u.beds, u.baths,
            u.size, u.size_unit, u.deposit_price, u.rent_price_min, u.rent_price_max,
            u.amenity_detail, u.listing_url, u.photo AS unit_photo_id,
            p.id AS property_id, p.display_name AS property_name,
            p.street_address, p.city, p.state, p.district, p.country, p.zip_code, p.currency,
            last_lease.price AS last_lease_price,
            last_lease.end_date AS last_lease_end_date,
            next_lease.start_date AS next_lease_start_date
     FROM unit u
     JOIN property p ON u.property_id = p.id
     LEFT JOIN leasing active_lease
       ON active_lease.unit_id = u.id AND active_lease.deleted_at IS NULL
       AND active_lease.start_date <= ? AND (active_lease.end_date >= ? OR active_lease.end_date IS NULL)${todayJoin}
     LEFT JOIN (
       SELECT l1.unit_id, l1.price, l1.end_date
       FROM leasing l1
       INNER JOIN (
         SELECT unit_id, MAX(start_date) AS max_start FROM leasing
         WHERE deleted_at IS NULL GROUP BY unit_id
       ) l2 ON l1.unit_id = l2.unit_id AND l1.start_date = l2.max_start
       WHERE l1.deleted_at IS NULL
     ) last_lease ON last_lease.unit_id = u.id
     LEFT JOIN (
       SELECT unit_id, MIN(start_date) AS start_date
       FROM leasing
       WHERE deleted_at IS NULL AND start_date > ?
       GROUP BY unit_id
     ) next_lease ON next_lease.unit_id = u.id
     WHERE ${where} AND active_lease.id IS NULL${renewClause}`,
    [
      moveIn, moveIn,
      ...(excludeRenewing ? [todayStr, todayStr] : []),
      moveIn,
      ...params,
      ...(excludeRenewing ? [moveIn] : []),
    ]
  );

  // If a move-out is set, drop units whose next lease starts before it.
  let filtered = rows;
  if (moveOut) {
    filtered = filtered.filter(r => !r.next_lease_start_date || r.next_lease_start_date > moveOut);
  }

  // Price filters. maxPrice is widened by budgetMarginPct so close-but-over
  // options survive (they're flagged via over_budget_* below).
  if (minPrice !== null && !Number.isNaN(minPrice)) {
    filtered = filtered.filter(r => Number(r.last_lease_price ?? r.rent_price_min ?? 0) >= minPrice);
  }
  if (maxPrice !== null && !Number.isNaN(maxPrice)) {
    const ceiling = maxPrice * (1 + (Number(budgetMarginPct) || 0));
    filtered = filtered.filter(r => Number(r.last_lease_price ?? r.rent_price_max ?? r.rent_price_min ?? Infinity) <= ceiling);
  }

  // Amenity filter — requires ALL named amenities.
  if (amenityNames.length > 0 && filtered.length > 0) {
    const unitIds = filtered.map(r => r.unit_id);
    const ph = unitIds.map(() => '?').join(',');
    const aph = amenityNames.map(() => '?').join(',');
    const [amRows] = await pool.execute(
      `SELECT ua.unit_id, a.display_name AS name
       FROM unit_amenity ua JOIN amenity a ON ua.amenity_id = a.id
       WHERE ua.unit_id IN (${ph}) AND a.display_name IN (${aph})`,
      [...unitIds, ...amenityNames]
    );
    const have = new Map();
    for (const r of amRows) {
      if (!have.has(String(r.unit_id))) have.set(String(r.unit_id), new Set());
      have.get(String(r.unit_id)).add(r.name);
    }
    filtered = filtered.filter(r => {
      const got = have.get(String(r.unit_id));
      return got && amenityNames.every(n => got.has(n));
    });
  }

  // Amenity names + gallery for the survivors.
  const unitIds = filtered.map(r => r.unit_id);
  const amenitiesByUnit = new Map();
  const galleryByUnit = new Map();
  if (unitIds.length > 0) {
    const ph = unitIds.map(() => '?').join(',');
    const [amRows] = await pool.execute(
      `SELECT ua.unit_id, a.display_name AS name FROM unit_amenity ua
       JOIN amenity a ON ua.amenity_id = a.id WHERE ua.unit_id IN (${ph})`,
      unitIds
    );
    for (const r of amRows) {
      if (!amenitiesByUnit.has(String(r.unit_id))) amenitiesByUnit.set(String(r.unit_id), []);
      amenitiesByUnit.get(String(r.unit_id)).push(r.name);
    }
    if (baseUrl) {
      const [galRows] = await pool.execute(
        `SELECT object_id, file_id, \`order\` FROM object_gallery
         WHERE object_id IN (${ph}) ORDER BY \`order\``,
        unitIds
      );
      for (const r of galRows) {
        if (!galleryByUnit.has(String(r.object_id))) galleryByUnit.set(String(r.object_id), []);
        galleryByUnit.get(String(r.object_id)).push(`${baseUrl}/api/file/preview/${r.file_id}`);
      }
    }
  }

  const today = new Date(moveIn);
  const realToday = new Date(orgToday());
  const leaseDurationDays = moveOut
    ? Math.max(0, Math.round((new Date(moveOut) - new Date(moveIn)) / 86400000))
    : null;
  // Gap-tolerance verdict (deterministic; both bots consume it instead of doing
  // their own band math). Band is null when reservation length is unknown.
  const gapBand = gapBandDays(leaseDurationDays);
  const needsManagerApproval = leaseDurationDays != null && Math.round(leaseDurationDays / 30.44) >= 12;

  const enriched = filtered.map(r => {
    let currentMoveOut = null;
    if (r.last_lease_end_date) {
      const endStr = toDateStr(r.last_lease_end_date);
      if (endStr <= moveIn) currentMoveOut = endStr;
    }
    let availableFrom = moveIn;
    let vacancyGapDays = null;
    if (currentMoveOut) {
      const out = new Date(currentMoveOut);
      out.setDate(out.getDate() + 1);
      availableFrom = out.toISOString().split('T')[0];
      vacancyGapDays = Math.max(0, Math.round((today - new Date(currentMoveOut)) / 86400000));
    }
    // Forward vacancy gap: empty days from TODAY (or from when the unit frees
    // up, whichever is later) until the prospect's move-in. Vacancy already
    // incurred before today is sunk cost and NOT counted. This is the number the
    // gap-tolerance-by-reservation-length policy should be judged against.
    const gapFromTs = Math.max(realToday.getTime(), new Date(availableFrom).getTime());
    const forwardGapDays = Math.max(0, Math.round((new Date(moveIn).getTime() - gapFromTs) / 86400000));
    const addressParts = [r.street_address, r.district, r.city, r.state, r.zip_code, r.country]
      .map(s => (s == null ? '' : String(s).trim())).filter(Boolean);
    const monthlyRent = r.last_lease_price != null ? Number(r.last_lease_price)
      : r.rent_price_min != null ? Number(r.rent_price_min) : null;
    return {
      unit_id: String(r.unit_id),
      unit_name: r.unit_name,
      property_id: String(r.property_id),
      property_name: r.property_name,
      street_address: r.street_address || null,
      city: r.city || null,
      state: r.state || null,
      district: r.district || null,
      country: r.country || null,
      zip_code: r.zip_code || null,
      full_address: addressParts.join(', ') || null,
      bedrooms: r.beds,
      bathrooms: r.baths,
      size: r.size != null ? Number(r.size) : null,
      size_unit: r.size_unit || null,
      monthly_rent: monthlyRent,
      rent_price_min: r.rent_price_min != null ? Number(r.rent_price_min) : null,
      rent_price_max: r.rent_price_max != null ? Number(r.rent_price_max) : null,
      deposit: r.deposit_price != null ? Number(r.deposit_price) : null,
      currency: r.currency || null,
      amenities: amenitiesByUnit.get(String(r.unit_id)) || [],
      photos: galleryByUnit.get(String(r.unit_id)) || [],
      available_from: availableFrom,
      current_move_out: currentMoveOut,
      vacancy_gap_days: vacancyGapDays,
      forward_gap_days: forwardGapDays,
      lease_duration_days: leaseDurationDays,
      gap_band_days: gapBand,                                            // max tolerated gap for this reservation length (null = unknown length)
      gap_within_tolerance: gapBand == null ? null : (forwardGapDays <= gapBand),
      needs_manager_approval: needsManagerApproval,                       // 12-month+ reservations
      days_until_available: Math.round((new Date(availableFrom) - realToday) / 86400000),
      over_budget_by: (budget != null && !Number.isNaN(budget) && monthlyRent != null)
        ? Number(monthlyRent) - budget : null,
      over_budget_pct: (budget != null && !Number.isNaN(budget) && budget > 0 && monthlyRent != null)
        ? Math.round(((monthlyRent - budget) / budget) * 1000) / 10 : null,
      listing_url: r.listing_url || null,
      description: r.amenity_detail || null,
    };
  });

  if (sortBy === 'price_asc') {
    enriched.sort((a, b) => (a.monthly_rent ?? Infinity) - (b.monthly_rent ?? Infinity));
  } else if (sortBy === 'price_desc') {
    enriched.sort((a, b) => (b.monthly_rent ?? -Infinity) - (a.monthly_rent ?? -Infinity));
  } else {
    // vacancy_gap (timing-first): smallest gap first; never-leased (null) last.
    enriched.sort((a, b) => {
      const ag = a.vacancy_gap_days, bg = b.vacancy_gap_days;
      if (ag == null && bg == null) return 0;
      if (ag == null) return 1;
      if (bg == null) return -1;
      return ag - bg;
    });
  }

  const total = enriched.length;
  return { results: enriched.slice(0, limit), total };
}

module.exports = { searchUnits };
