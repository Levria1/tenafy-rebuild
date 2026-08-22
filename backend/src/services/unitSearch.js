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
const { askingRentPublicShape, gapBandDays } = require('../utils/advertisingPlan');
const { PUBLIC_UNIT_NAME_SQL } = require('../utils/publicUnitScope');

function toDateStr(d) {
  return (d instanceof Date ? d : new Date(d)).toISOString().split('T')[0];
}

/**
 * Does the last lease bill on a recurring schedule? Only then is its stored `price`
 * a MONTHLY figure. Without a schedule the column holds whatever was agreed for the
 * stay — which for a short let is the whole-stay total.
 */
function hasRecurringSchedule(row) {
  return row?.last_lease_invoicing != null && String(row.last_lease_invoicing).trim() !== '';
}

/**
 * The unit's monthly rent for COMPARISON — filtering, sorting, budget maths.
 *
 * Matches vacancyToPublicShape and the published `monthly_rent`, and that is the
 * whole point: the price filter used to read `last_lease_price` raw while the
 * response reported the schedule-aware value, so a caller could be told a unit
 * costs 12,000 a month and still not get it back under `max_price=14000`.
 *
 * Poplar 2B is the live case: an 86-day let with no invoicing schedule stores
 * 34,434.99 — the total for the stay — against an advertised 12,000–13,000 a month.
 * A normal monthly band deleted it, and it is exactly the sort of long-availability
 * unit window search exists to surface.
 */
function comparableMonthlyRent(row) {
  if (hasRecurringSchedule(row)) {
    return row.last_lease_price != null ? Number(row.last_lease_price) : null;
  }
  return row?.rent_price_min != null ? Number(row.rent_price_min) : null;
}

function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d + days));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
}

function inclusiveDays(from, until) {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [uy, um, ud] = until.split('-').map(Number);
  return Math.round((Date.UTC(uy, um - 1, ud) - Date.UTC(fy, fm - 1, fd)) / 86400000) + 1;
}

function normalizeSqlDate(value) {
  return value == null ? value : toDateStr(value);
}

/**
 * @param {string} windowStart 'YYYY-MM-DD'
 * @param {string} windowEnd   'YYYY-MM-DD'
 * @param {Array<{start_date: string, end_date: string|null}>} leases
 * @returns {{from: string, until: string, days: number} | null}  null = no free day in window
 */
function longestFreeStretch(windowStart, windowEnd, leases) {
  let free = [{ from: windowStart, until: windowEnd }];

  for (const lease of leases || []) {
    const leaseStart = normalizeSqlDate(lease.start_date);
    const leaseEnd = lease.end_date == null ? windowEnd : normalizeSqlDate(lease.end_date);
    if (!leaseStart || leaseStart > windowEnd || leaseEnd < windowStart) continue;

    const occupiedFrom = leaseStart < windowStart ? windowStart : leaseStart;
    const occupiedUntil = leaseEnd > windowEnd ? windowEnd : leaseEnd;
    const nextFree = [];

    for (const interval of free) {
      if (occupiedUntil < interval.from || occupiedFrom > interval.until) {
        nextFree.push(interval);
        continue;
      }
      if (occupiedFrom > interval.from) {
        const leftUntil = addDays(occupiedFrom, -1);
        if (interval.from <= leftUntil) nextFree.push({ from: interval.from, until: leftUntil });
      }
      if (occupiedUntil < interval.until) {
        const rightFrom = addDays(occupiedUntil, 1);
        if (rightFrom <= interval.until) nextFree.push({ from: rightFrom, until: interval.until });
      }
    }

    free = nextFree;
    if (free.length === 0) return null;
  }

  let best = null;
  for (const interval of free) {
    const days = inclusiveDays(interval.from, interval.until);
    if (!best || days > best.days || (days === best.days && interval.from < best.from)) {
      best = { from: interval.from, until: interval.until, days };
    }
  }
  return best;
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
 *   preferredDistricts string[] (window mode ranking input; defaults to districtNames)
 *   windowStart      'YYYY-MM-DD' | null
 *   windowEnd        'YYYY-MM-DD' | null
 *   amenityNames     string[]  (all required)
 *   sortBy           'vacancy_gap' (default) | 'price_asc' | 'price_desc'
 *   limit            number (default 10)
 *   baseUrl          string | null — when set, photo gallery URLs are built absolute
 *   gapBands         resolved generic bands ({ band_1m_days, ... }); missing/junk keep 3/6/10
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
    preferredDistricts = null,
    windowStart = null,
    windowEnd = null,
    amenityNames = [],
    sortBy = 'vacancy_gap',
    limit = 10,
    baseUrl = null,
    gapBands,
    // When true (default), a unit that is occupied RIGHT NOW is only offerable
    // if its current lease ends before the move-in date AND the tenant is Not
    // Renewing (contract_type=3). Empty-now units are always offerable. This
    // stops us advertising "May Renew" units that probably won't free up.
    excludeRenewing = true,
  } = criteria;
  const NR_CONTRACT = 3; // contract_type: Not Renewing
  const todayStr = orgToday();
  const isWindowMode = !!(windowStart && windowEnd);
  const searchDate = isWindowMode ? windowStart : moveIn;
  const requestedDistrictNames = isWindowMode && Array.isArray(preferredDistricts) ? preferredDistricts : districtNames;

  // The test-name exclusion matches the vacancy feed. Without it this endpoint
  // offered "Test Property 2 Unit 1" as an alternative to real prospects — the
  // two endpoints described the same portfolio and disagreed about what was
  // public. Note this is NOT the p.status filter beside it: the offending
  // property is ACTIVE, so status could never have caught it.
  let where = `p.org_id = ? AND p.status = 1 AND p.deleted_at IS NULL AND u.active_status = 1 AND u.deleted_at IS NULL
    AND ${PUBLIC_UNIT_NAME_SQL}`;
  const params = [orgId];
  if (propertyId) { where += ' AND p.id = ?'; params.push(propertyId); }
  if (bedrooms !== null && !Number.isNaN(bedrooms)) { where += ' AND u.beds = ?'; params.push(bedrooms); }
  if (bathrooms !== null && !Number.isNaN(bathrooms)) { where += ' AND u.baths = ?'; params.push(bathrooms); }
  if (cityNames.length > 0) {
    where += ` AND LOWER(TRIM(p.city)) IN (${cityNames.map(() => '?').join(',')})`;
    params.push(...cityNames);
  }
  if (districtNames.length > 0 && !isWindowMode) {
    where += ` AND LOWER(TRIM(p.district)) IN (${districtNames.map(() => '?').join(',')})`;
    params.push(...districtNames);
  }

  // Candidate units with last-lease (pricing/availability) + next-lease data.
  // "Available on moveIn" = no active lease covers that day.
  // today_lease = the lease occupying the unit RIGHT NOW (one row/unit). Used to
  // exclude currently-occupied units whose lease ends before move-in but whose
  // tenant might renew (only contract_type=3 / Not Renewing is offerable).
  const todayJoin = (!isWindowMode && excludeRenewing) ? `
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
  const activeLeaseJoin = isWindowMode ? '' : `
     LEFT JOIN leasing active_lease
       ON active_lease.unit_id = u.id AND active_lease.deleted_at IS NULL
       AND active_lease.start_date <= ? AND (active_lease.end_date >= ? OR active_lease.end_date IS NULL)${todayJoin}`;
  const activeLeaseWhere = isWindowMode ? '' : ' AND active_lease.id IS NULL';
  const renewClause = (!isWindowMode && excludeRenewing) ? `
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
            last_lease.invoicing AS last_lease_invoicing,
            last_lease.end_date AS last_lease_end_date,
            next_lease.start_date AS next_lease_start_date
     FROM unit u
     JOIN property p ON u.property_id = p.id${activeLeaseJoin}
     LEFT JOIN (
       SELECT l1.unit_id, l1.price, l1.invoicing, l1.end_date
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
     WHERE ${where}${activeLeaseWhere}${renewClause}`,
    [
      ...(!isWindowMode ? [moveIn, moveIn] : []),
      ...(!isWindowMode && excludeRenewing ? [todayStr, todayStr] : []),
      searchDate,
      ...params,
      ...(!isWindowMode && excludeRenewing ? [moveIn] : []),
    ]
  );

  // If a move-out is set, drop units whose next lease starts before it.
  let filtered = rows;
  if (!isWindowMode && moveOut) {
    filtered = filtered.filter(r => !r.next_lease_start_date || r.next_lease_start_date > moveOut);
  }

  const stretchByUnit = new Map();
  const certainByUnit = new Map();
  if (isWindowMode && filtered.length > 0) {
    const unitIds = filtered.map(r => r.unit_id);
    const ph = unitIds.map(() => '?').join(',');
    const [leaseRows] = await pool.execute(
      `SELECT unit_id, start_date, end_date, contract_type
       FROM leasing
       WHERE deleted_at IS NULL AND unit_id IN (${ph})
         AND start_date <= ? AND (end_date >= ? OR end_date IS NULL)
       ORDER BY unit_id, start_date, end_date`,
      [...unitIds, windowEnd, windowStart]
    );
    const leasesByUnit = new Map();
    for (const r of leaseRows) {
      const key = String(r.unit_id);
      if (!leasesByUnit.has(key)) leasesByUnit.set(key, []);
      leasesByUnit.get(key).push({ start_date: r.start_date, end_date: r.end_date, contract_type: r.contract_type });
    }
    filtered = filtered.filter(r => {
      const unitLeases = leasesByUnit.get(String(r.unit_id)) || [];
      const stretch = longestFreeStretch(windowStart, windowEnd, unitLeases);
      if (!stretch) return false;
      stretchByUnit.set(String(r.unit_id), stretch);
      // Single-day mode refuses to offer a unit whose sitting tenant MAY renew
      // (excludeRenewing: only contract_type 3 / Not Renewing is offerable).
      // Window mode cannot reuse that rule — the whole point is to surface a unit
      // that frees up partway through the window, and the single-day clause would
      // discard it. Dropping the rule silently would be worse: it would offer a
      // flat whose tenant probably stays, which is exactly what that policy
      // exists to prevent. So the unit is returned and the uncertainty is
      // reported, the way /vacancies flags tier-3 rows as certain:false.
      //
      // The stretch is uncertain when a NON-NR lease ends the day before it
      // starts — that is the lease whose departure creates the opening. A unit
      // already empty at the start of the window has no such lease and is certain.
      const dayBefore = addDays(stretch.from, -1);
      const freeingLease = unitLeases.find(l => l.end_date != null && toDateStr(l.end_date) === dayBefore);
      certainByUnit.set(String(r.unit_id), !freeingLease || Number(freeingLease.contract_type) === NR_CONTRACT);
      return true;
    });
  }

  // Price filters. maxPrice is widened by budgetMarginPct so close-but-over
  // options survive (they're flagged via over_budget_* below).
  // Both bounds compare against the SAME schedule-aware monthly figure the response
  // publishes as `monthly_rent`. They previously read `last_lease_price` raw, which
  // is a whole-stay total on a lease with no invoicing schedule — so a caller's
  // monthly band silently deleted exactly the short-let units it should have matched.
  if (minPrice !== null && !Number.isNaN(minPrice)) {
    filtered = filtered.filter((r) => {
      const rent = comparableMonthlyRent(r);
      // Unpriced units cannot clear a floor. Number(null) is 0, which would have
      // passed every unpriced unit through a minPrice of 0.
      return rent != null && rent >= minPrice;
    });
  }
  if (maxPrice !== null && !Number.isNaN(maxPrice)) {
    const ceiling = maxPrice * (1 + (Number(budgetMarginPct) || 0));
    filtered = filtered.filter((r) => {
      const rent = comparableMonthlyRent(r);
      // Falls back to the advertised ceiling, then keeps an entirely unpriced unit
      // rather than dropping it: we cannot prove it is over budget.
      const compare = rent != null ? rent : (r.rent_price_max != null ? Number(r.rent_price_max) : null);
      return compare == null || compare <= ceiling;
    });
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

  let requestedDistrictCities = new Set();
  if (isWindowMode && requestedDistrictNames.length > 0) {
    const dph = requestedDistrictNames.map(() => '?').join(',');
    const [cityRows] = await pool.execute(
      `SELECT DISTINCT LOWER(TRIM(city)) AS city
       FROM property
       WHERE org_id = ? AND status = 1 AND deleted_at IS NULL
         AND LOWER(TRIM(district)) IN (${dph})`,
      [orgId, ...requestedDistrictNames]
    );
    requestedDistrictCities = new Set(cityRows.map(r => r.city).filter(Boolean));
  }

  const today = new Date(moveIn);
  const realToday = new Date(orgToday());
  const leaseDurationDays = moveOut
    ? Math.max(0, Math.round((new Date(moveOut) - new Date(moveIn)) / 86400000))
    : null;
  // Gap-tolerance verdict (deterministic; both bots consume it instead of doing
  // their own band math). Band is null when reservation length is unknown.
  const gapBand = gapBandDays(leaseDurationDays, gapBands);
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
    const hasLeaseSchedule = hasRecurringSchedule(r);
    const monthlyRent = comparableMonthlyRent(r);
    const monthlyRentBasis = monthlyRent == null ? null : (hasLeaseSchedule ? 'lease' : 'advertised');
    // computePostingRent uses DATEDIFF(end_date, today) semantics: positive
    // before move-out, negative after move-out. The search availability fields
    // clamp already-vacant units for other policy checks, so derive the raw
    // value from the same last lease end date instead of reusing the clamp.
    const askingRentDaysToAvailable = r.last_lease_end_date
      ? Math.round((new Date(toDateStr(r.last_lease_end_date)) - realToday) / 86400000)
      : null;
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
      monthly_rent_basis: monthlyRentBasis,
      rent_price_min: r.rent_price_min != null ? Number(r.rent_price_min) : null,
      rent_price_max: r.rent_price_max != null ? Number(r.rent_price_max) : null,
      deposit: r.deposit_price != null ? Number(r.deposit_price) : null,
      currency: r.currency || null,
      amenities: amenitiesByUnit.get(String(r.unit_id)) || [],
      photos: galleryByUnit.get(String(r.unit_id)) || [],
      available_from: isWindowMode ? stretchByUnit.get(String(r.unit_id)).from : availableFrom,
      available_until: isWindowMode
        ? stretchByUnit.get(String(r.unit_id)).until
        : (r.next_lease_start_date ? addDays(toDateStr(r.next_lease_start_date), -1) : null),
      current_move_out: currentMoveOut,
      // Every field below measured against moveIn is meaningless in window mode:
      // window mode ignores move_in_date for filtering, so moveIn is either today
      // or an arbitrary date the caller happened to send. Reporting a gap computed
      // from it beside an available_from computed from the stretch would put two
      // numbers describing different dates in the same object — the same class of
      // confusion that made available_from unreadable in the first place. Null is
      // honest; a plausible wrong number is not.
      vacancy_gap_days: isWindowMode ? null : vacancyGapDays,
      forward_gap_days: isWindowMode ? null : forwardGapDays,
      ...(isWindowMode ? {
        coverage_days: stretchByUnit.get(String(r.unit_id)).days,
        // false = the opening depends on a sitting tenant who has NOT confirmed
        // they are leaving. Quote it as possible, not as available.
        availability_certain: certainByUnit.get(String(r.unit_id)) !== false,
      } : {}),
      lease_duration_days: isWindowMode ? null : leaseDurationDays,
      gap_band_days: isWindowMode ? null : gapBand,                      // max tolerated gap for this reservation length (null = unknown length)
      gap_within_tolerance: isWindowMode ? null : (gapBand == null ? null : (forwardGapDays <= gapBand)),
      needs_manager_approval: needsManagerApproval,                       // 12-month+ reservations
      days_until_available: isWindowMode
        ? Math.round((new Date(stretchByUnit.get(String(r.unit_id)).from) - realToday) / 86400000)
        : Math.round((new Date(availableFrom) - realToday) / 86400000),
      asking_rent: askingRentPublicShape(r.rent_price_min, r.rent_price_max, askingRentDaysToAvailable),
      over_budget_by: (budget != null && !Number.isNaN(budget) && monthlyRent != null)
        ? Number(monthlyRent) - budget : null,
      over_budget_pct: (budget != null && !Number.isNaN(budget) && budget > 0 && monthlyRent != null)
        ? Math.round(((monthlyRent - budget) / budget) * 1000) / 10 : null,
      listing_url: r.listing_url || null,
      description: r.amenity_detail || null,
      ...(isWindowMode ? { area_match: areaMatch(r, requestedDistrictNames, requestedDistrictCities) } : {}),
    };
  });

  if (isWindowMode) {
    enriched.sort(compareWindowResult);
  } else if (sortBy === 'price_asc') {
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
  if (isWindowMode) {
    if (requestedDistrictNames.length === 0) return { results: enriched.slice(0, limit), total, alternativesOutsideArea: [] };
    const results = enriched.filter(r => r.area_match === 'district').slice(0, limit);
    const alternativesOutsideArea = enriched.filter(r => r.area_match !== 'district').slice(0, limit);
    return { results, total, alternativesOutsideArea };
  }
  return { results: enriched.slice(0, limit), total };
}

function normText(value) {
  return value == null ? '' : String(value).trim().toLowerCase();
}

function areaMatch(row, districtNames, requestedDistrictCities) {
  if (districtNames.length === 0) return 'district';
  if (districtNames.includes(normText(row.district))) return 'district';
  if (requestedDistrictCities.has(normText(row.city))) return 'same_side';
  return 'other';
}

function compareWindowResult(a, b) {
  const ranks = { district: 0, same_side: 1, other: 2 };
  const ar = ranks[a.area_match] ?? 2;
  const br = ranks[b.area_match] ?? 2;
  if (ar !== br) return ar - br;
  if (a.coverage_days !== b.coverage_days) return b.coverage_days - a.coverage_days;
  if (a.available_from !== b.available_from) return a.available_from < b.available_from ? -1 : 1;
  return String(a.property_name || '').localeCompare(String(b.property_name || ''));
}

module.exports = { searchUnits, longestFreeStretch, comparableMonthlyRent, gapBandDays };
