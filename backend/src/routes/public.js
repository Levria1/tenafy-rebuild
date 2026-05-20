const express = require('express');
const router = express.Router();
const { authenticateApiKey } = require('../middleware/apiKeyAuth');

// All public routes require a valid API key (see middleware/apiKeyAuth.js).
// The middleware attaches req.pool (scoped to the caller's org DB) and
// req.apiKey.{id, orgId, name}. Every query below filters by req.apiKey.orgId
// AND runs against req.pool, so multi-tenant isolation is enforced in two places.
router.use(authenticateApiKey);

// Helper: consistent JSON response
function ok(res, data, meta) {
  res.json({ code: 200, data, meta: { total: Array.isArray(data) ? data.length : undefined, ...(meta || {}) } });
}
function fail(res, message, status = 500) {
  res.status(status).json({ code: status, message });
}

// ────────────────────────────────────────────────────────────────
// META / HEALTH
// ────────────────────────────────────────────────────────────────

// GET /api/public/health — confirms auth works, echoes caller's org + key name
router.get('/health', (req, res) => {
  res.json({
    ok: true,
    org_id: String(req.apiKey.orgId),
    key_name: req.apiKey.name,
    timestamp: new Date().toISOString(),
  });
});

// ────────────────────────────────────────────────────────────────
// PROPERTIES & UNITS
// ────────────────────────────────────────────────────────────────

// GET /api/public/units/available?date=YYYY-MM-DD&propertyId=123
// Units that are active AND have no lease covering the given date.
router.get('/units/available', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const propertyId = req.query.propertyId || null;

    let whereClause = 'p.org_id = ? AND p.status = 1 AND p.deleted_at IS NULL AND u.active_status = 1';
    const params = [orgId];

    if (propertyId) {
      whereClause += ' AND p.id = ?';
      params.push(propertyId);
    }

    const [units] = await req.pool.execute(
      `SELECT u.id AS unit_id, u.name AS unit_name, u.type AS unit_type, u.amenity_type,
              p.id AS property_id, p.display_name AS property_name,
              p.street_address, p.city, p.state, p.country, p.zip_code, p.type AS property_type,
              last_lease.price AS last_lease_price, last_lease.end_date AS last_lease_end_date
       FROM unit u
       JOIN property p ON u.property_id = p.id
       LEFT JOIN leasing active_lease
         ON active_lease.unit_id = u.id AND active_lease.deleted_at IS NULL
         AND active_lease.start_date <= ? AND (active_lease.end_date >= ? OR active_lease.end_date IS NULL)
       LEFT JOIN (
         SELECT l1.unit_id, l1.price, l1.end_date
         FROM leasing l1
         INNER JOIN (
           SELECT unit_id, MAX(start_date) AS max_start FROM leasing
           WHERE deleted_at IS NULL GROUP BY unit_id
         ) l2 ON l1.unit_id = l2.unit_id AND l1.start_date = l2.max_start
         WHERE l1.deleted_at IS NULL
       ) last_lease ON last_lease.unit_id = u.id
       WHERE ${whereClause} AND active_lease.id IS NULL
       ORDER BY p.display_name, u.name`,
      [date, date, ...params]
    );

    ok(res, units, { date });
  } catch (error) {
    console.error('Public available units error:', error);
    fail(res, 'Failed to fetch available units');
  }
});

// GET /api/public/units/search
// TaneChat-facing smart search. Filters + vacancy_gap sort.
// Query params:
//   move_in_date  (ISO date, default today)   — used for filtering + gap calc
//   move_out_date (ISO date, optional)        — excludes units booked in this range
//   bedrooms, bathrooms                       — exact match on unit.beds/baths
//   min_price, max_price                      — matched against last lease price OR rent_price_min/max
//   property_id                               — filter to property
//   amenities (csv)                           — names like "parking,gym"; unit must have ALL
//   sort_by                                   — vacancy_gap (default), price_asc, price_desc
//   limit                                     — default 10, max 100
router.get('/units/search', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const moveIn = req.query.move_in_date || new Date().toISOString().split('T')[0];
    const moveOut = req.query.move_out_date || null;
    const bedrooms = req.query.bedrooms !== undefined ? Number(req.query.bedrooms) : null;
    const bathrooms = req.query.bathrooms !== undefined ? Number(req.query.bathrooms) : null;
    const minPrice = req.query.min_price !== undefined ? Number(req.query.min_price) : null;
    const maxPrice = req.query.max_price !== undefined ? Number(req.query.max_price) : null;
    const propertyId = req.query.property_id || null;
    const amenityNames = (req.query.amenities || '').split(',').map(s => s.trim()).filter(Boolean);
    const sortBy = req.query.sort_by || 'vacancy_gap';
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 10, 1), 100);

    // Base WHERE for active units in active properties
    let where = 'p.org_id = ? AND p.status = 1 AND p.deleted_at IS NULL AND u.active_status = 1';
    const params = [orgId];
    if (propertyId) { where += ' AND p.id = ?'; params.push(propertyId); }
    if (bedrooms !== null && !Number.isNaN(bedrooms)) { where += ' AND u.beds = ?'; params.push(bedrooms); }
    if (bathrooms !== null && !Number.isNaN(bathrooms)) { where += ' AND u.baths = ?'; params.push(bathrooms); }

    // Pull candidate units with last-lease data for pricing + availability + gap
    // - "Available on move_in_date" = no lease covers it that day
    // - "current_move_out" = end_date of the most recent lease that ended on or before move_in_date
    //   (if a unit has never been leased OR the last lease was further back, current_move_out is null)
    const [rows] = await req.pool.execute(
      `SELECT u.id AS unit_id, u.name AS unit_name, u.beds, u.baths,
              u.size, u.size_unit, u.deposit_price, u.rent_price_min, u.rent_price_max,
              u.amenity_detail, u.listing_url, u.photo AS unit_photo_id,
              p.id AS property_id, p.display_name AS property_name,
              p.street_address, p.city, p.state, p.country, p.zip_code, p.currency,
              last_lease.price AS last_lease_price,
              last_lease.end_date AS last_lease_end_date,
              next_lease.start_date AS next_lease_start_date
       FROM unit u
       JOIN property p ON u.property_id = p.id
       LEFT JOIN leasing active_lease
         ON active_lease.unit_id = u.id AND active_lease.deleted_at IS NULL
         AND active_lease.start_date <= ? AND (active_lease.end_date >= ? OR active_lease.end_date IS NULL)
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
       WHERE ${where} AND active_lease.id IS NULL`,
      [moveIn, moveIn, moveIn, ...params]
    );

    // If move_out_date is set, drop units where a future lease starts before move_out_date
    let filtered = rows;
    if (moveOut) {
      filtered = filtered.filter(r => !r.next_lease_start_date || r.next_lease_start_date > moveOut);
    }

    // Pricing filter — use last_lease_price if available, else rent_price_min
    if (minPrice !== null && !Number.isNaN(minPrice)) {
      filtered = filtered.filter(r => {
        const p = Number(r.last_lease_price ?? r.rent_price_min ?? 0);
        return p >= minPrice;
      });
    }
    if (maxPrice !== null && !Number.isNaN(maxPrice)) {
      filtered = filtered.filter(r => {
        const p = Number(r.last_lease_price ?? r.rent_price_max ?? r.rent_price_min ?? Infinity);
        return p <= maxPrice;
      });
    }

    // Amenity filter — requires ALL named amenities
    if (amenityNames.length > 0 && filtered.length > 0) {
      const unitIds = filtered.map(r => r.unit_id);
      const placeholders = unitIds.map(() => '?').join(',');
      const amenityPlaceholders = amenityNames.map(() => '?').join(',');
      const [amRows] = await req.pool.execute(
        `SELECT ua.unit_id, a.name
         FROM unit_amenity ua JOIN amenity a ON ua.amenity_id = a.id
         WHERE ua.unit_id IN (${placeholders}) AND a.name IN (${amenityPlaceholders})`,
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

    // Annotate availability + gap; collect amenity names + gallery in a second pass
    const unitIds = filtered.map(r => r.unit_id);
    let amenitiesByUnit = new Map();
    let galleryByUnit = new Map();
    if (unitIds.length > 0) {
      const ph = unitIds.map(() => '?').join(',');
      const [amRows] = await req.pool.execute(
        `SELECT ua.unit_id, a.name FROM unit_amenity ua
         JOIN amenity a ON ua.amenity_id = a.id WHERE ua.unit_id IN (${ph})`,
        unitIds
      );
      for (const r of amRows) {
        if (!amenitiesByUnit.has(String(r.unit_id))) amenitiesByUnit.set(String(r.unit_id), []);
        amenitiesByUnit.get(String(r.unit_id)).push(r.name);
      }
      const [galRows] = await req.pool.execute(
        `SELECT object_id, file_id, \`order\` FROM object_gallery
         WHERE object_id IN (${ph}) ORDER BY \`order\``,
        unitIds
      );
      const base = `${req.protocol}://${req.get('host')}`;
      for (const r of galRows) {
        if (!galleryByUnit.has(String(r.object_id))) galleryByUnit.set(String(r.object_id), []);
        galleryByUnit.get(String(r.object_id)).push(`${base}/api/file/preview/${r.file_id}`);
      }
    }

    const today = new Date(moveIn);
    const enriched = filtered.map(r => {
      // current_move_out = last_lease_end_date if that lease has ended (<= move_in_date)
      let currentMoveOut = null;
      if (r.last_lease_end_date) {
        const endStr = r.last_lease_end_date instanceof Date
          ? r.last_lease_end_date.toISOString().split('T')[0]
          : String(r.last_lease_end_date).split('T')[0];
        if (endStr <= moveIn) currentMoveOut = endStr;
      }
      // available_from = currentMoveOut + 1 day, OR move_in_date if no prior lease
      let availableFrom = moveIn;
      let vacancyGapDays = null;
      if (currentMoveOut) {
        const out = new Date(currentMoveOut);
        out.setDate(out.getDate() + 1);
        availableFrom = out.toISOString().split('T')[0];
        vacancyGapDays = Math.max(0, Math.round((today - new Date(currentMoveOut)) / 86400000));
      }
      return {
        unit_id: String(r.unit_id),
        unit_name: r.unit_name,
        property_id: String(r.property_id),
        property_name: r.property_name,
        bedrooms: r.beds,
        bathrooms: r.baths,
        size: r.size != null ? Number(r.size) : null,
        size_unit: r.size_unit || null,
        monthly_rent: r.last_lease_price != null ? Number(r.last_lease_price)
          : r.rent_price_min != null ? Number(r.rent_price_min) : null,
        rent_price_min: r.rent_price_min != null ? Number(r.rent_price_min) : null,
        rent_price_max: r.rent_price_max != null ? Number(r.rent_price_max) : null,
        deposit: r.deposit_price != null ? Number(r.deposit_price) : null,
        currency: r.currency || null,
        amenities: amenitiesByUnit.get(String(r.unit_id)) || [],
        photos: galleryByUnit.get(String(r.unit_id)) || [],
        available_from: availableFrom,
        current_move_out: currentMoveOut,
        vacancy_gap_days: vacancyGapDays,
        listing_url: r.listing_url || null,
        description: r.amenity_detail || null,
      };
    });

    // Sort
    if (sortBy === 'price_asc') {
      enriched.sort((a, b) => (a.monthly_rent ?? Infinity) - (b.monthly_rent ?? Infinity));
    } else if (sortBy === 'price_desc') {
      enriched.sort((a, b) => (b.monthly_rent ?? -Infinity) - (a.monthly_rent ?? -Infinity));
    } else {
      // vacancy_gap (default): null gaps (never-leased) go last; smaller gap first
      enriched.sort((a, b) => {
        const ag = a.vacancy_gap_days, bg = b.vacancy_gap_days;
        if (ag == null && bg == null) return 0;
        if (ag == null) return 1;
        if (bg == null) return -1;
        return ag - bg;
      });
    }

    const limited = enriched.slice(0, limit);
    ok(res, limited, { total_matches: enriched.length, move_in_date: moveIn, sort_by: sortBy });
  } catch (error) {
    console.error('Public units search error:', error);
    fail(res, 'Failed to search units');
  }
});

// GET /api/public/properties?date=YYYY-MM-DD&has_available_units=true
// All active properties with total/available unit counts + amenity names.
router.get('/properties', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const onlyAvailable = req.query.has_available_units === 'true' || req.query.has_available_units === '1';

    const [properties] = await req.pool.execute(
      `SELECT p.id AS property_id, p.display_name AS property_name,
              p.street_address, p.city, p.state, p.country, p.zip_code, p.type AS property_type,
              p.currency, p.year_of_built, p.notes, p.payment_instructions, p.status,
              COUNT(u.id) AS total_units,
              SUM(CASE
                WHEN u.active_status = 1 AND NOT EXISTS (
                  SELECT 1 FROM leasing l
                  WHERE l.unit_id = u.id AND l.deleted_at IS NULL
                    AND l.start_date <= ? AND (l.end_date >= ? OR l.end_date IS NULL)
                ) THEN 1 ELSE 0 END) AS available_units
       FROM property p
       LEFT JOIN unit u ON u.property_id = p.id AND u.active_status = 1
       WHERE p.org_id = ? AND p.status = 1 AND p.deleted_at IS NULL
       GROUP BY p.id
       ORDER BY p.display_name`,
      [date, date, orgId]
    );

    // Attach amenity names per property
    let amenitiesByProp = new Map();
    if (properties.length > 0) {
      const propIds = properties.map(p => p.property_id);
      const ph = propIds.map(() => '?').join(',');
      const [amRows] = await req.pool.execute(
        `SELECT pa.property_id, a.name FROM property_amenity pa
         JOIN amenity a ON pa.amenity_id = a.id
         WHERE pa.property_id IN (${ph})`,
        propIds
      );
      for (const r of amRows) {
        if (!amenitiesByProp.has(String(r.property_id))) amenitiesByProp.set(String(r.property_id), []);
        amenitiesByProp.get(String(r.property_id)).push(r.name);
      }
    }

    let result = properties.map(p => ({
      ...p,
      total_units: Number(p.total_units),
      available_units: Number(p.available_units),
      amenities: amenitiesByProp.get(String(p.property_id)) || [],
    }));

    if (onlyAvailable) result = result.filter(p => p.available_units > 0);

    ok(res, result, { date });
  } catch (error) {
    console.error('Public properties error:', error);
    fail(res, 'Failed to fetch properties');
  }
});

// GET /api/public/properties/:id — single property detail + amenities + gallery
router.get('/properties/:id', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const { id } = req.params;

    const [properties] = await req.pool.execute(
      `SELECT p.*,
              (SELECT COUNT(*) FROM unit u WHERE u.property_id = p.id AND u.active_status = 1) as total_units,
              (SELECT COUNT(*) FROM unit u WHERE u.property_id = p.id AND u.active_status = 1 AND EXISTS (
                SELECT 1 FROM leasing l WHERE l.unit_id = u.id AND l.deleted_at IS NULL
                  AND l.start_date <= CURDATE() AND (l.end_date >= CURDATE() OR l.end_date IS NULL)
              )) as occupied_units
       FROM property p WHERE p.id = ? AND p.org_id = ? AND p.deleted_at IS NULL`,
      [id, orgId]
    );
    if (properties.length === 0) return fail(res, 'Property not found', 404);

    const [amenityRows] = await req.pool.execute(
      'SELECT amenity_id FROM property_amenity WHERE property_id = ?', [id]
    );
    const [galleryRows] = await req.pool.execute(
      'SELECT file_id, `order` FROM object_gallery WHERE object_id = ? ORDER BY `order`', [id]
    );

    res.json({
      code: 200,
      data: { ...properties[0], amenity_ids: amenityRows.map(r => r.amenity_id), gallery: galleryRows },
    });
  } catch (error) {
    console.error('Public property detail error:', error);
    fail(res, 'Failed to fetch property');
  }
});

// GET /api/public/units?property_id=&status=&active_status=
router.get('/units', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const { property_id, status, active_status } = req.query;

    let whereClause = 'p.org_id = ? AND p.deleted_at IS NULL';
    const params = [orgId];
    if (property_id) { whereClause += ' AND u.property_id = ?'; params.push(property_id); }
    if (status !== undefined) { whereClause += ' AND u.status = ?'; params.push(status); }
    if (active_status !== undefined) { whereClause += ' AND u.active_status = ?'; params.push(active_status); }

    const [units] = await req.pool.execute(
      `SELECT u.*, p.display_name AS property_name, p.street_address, p.city, p.state, p.country
       FROM unit u
       JOIN property p ON u.property_id = p.id
       WHERE ${whereClause}
       ORDER BY p.display_name, u.name`,
      params
    );
    ok(res, units);
  } catch (error) {
    console.error('Public units list error:', error);
    fail(res, 'Failed to fetch units');
  }
});

// GET /api/public/units/:id — unit detail + current lease + tenant + amenities + gallery
router.get('/units/:id', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const { id } = req.params;

    const [units] = await req.pool.execute(
      `SELECT u.*, p.display_name AS property_name, p.street_address, p.city, p.state,
              p.country, p.zip_code, p.currency, p.org_id
       FROM unit u JOIN property p ON u.property_id = p.id
       WHERE u.id = ? AND p.org_id = ?`,
      [id, orgId]
    );
    if (units.length === 0) return fail(res, 'Unit not found', 404);
    const unit = units[0];

    const [[currentLease]] = await req.pool.execute(
      `SELECT l.*, t.first_name, t.last_name, t.company_name, t.email, t.phone
       FROM leasing l LEFT JOIN tenant t ON l.tenant_id = t.id
       WHERE l.unit_id = ? AND l.deleted_at IS NULL
         AND l.start_date <= CURDATE() AND (l.end_date >= CURDATE() OR l.end_date IS NULL)
       ORDER BY l.start_date DESC LIMIT 1`,
      [id]
    );

    const [amenityRows] = await req.pool.execute(
      `SELECT ua.amenity_id, a.name
       FROM unit_amenity ua LEFT JOIN amenity a ON ua.amenity_id = a.id
       WHERE ua.unit_id = ?`,
      [id]
    );
    const [galleryRows] = await req.pool.execute(
      'SELECT file_id, `order` FROM object_gallery WHERE object_id = ? ORDER BY `order`', [id]
    );

    // Active, assigned viewing link token (null if none exists or employee not yet assigned)
    const [[linkRow]] = await req.pool.execute(
      `SELECT token FROM viewing_link
       WHERE unit_id = ? AND status = 1 AND employee_id IS NOT NULL
       ORDER BY created_at DESC LIMIT 1`,
      [id]
    );

    // Compute current_move_out + available_from from the latest lease
    const [[latestLease]] = await req.pool.execute(
      `SELECT start_date, end_date, price FROM leasing
       WHERE unit_id = ? AND deleted_at IS NULL
       ORDER BY start_date DESC LIMIT 1`,
      [id]
    );
    let currentMoveOut = null;
    let availableFrom = new Date().toISOString().split('T')[0];
    if (latestLease && latestLease.end_date) {
      const endStr = latestLease.end_date instanceof Date
        ? latestLease.end_date.toISOString().split('T')[0]
        : String(latestLease.end_date).split('T')[0];
      currentMoveOut = endStr;
      const next = new Date(endStr);
      next.setDate(next.getDate() + 1);
      const nextStr = next.toISOString().split('T')[0];
      if (nextStr > availableFrom) availableFrom = nextStr;
    }

    const base = `${req.protocol}://${req.get('host')}`;

    res.json({
      code: 200,
      data: {
        ...unit,
        current_lease: currentLease || null,
        // Existing fields preserved for MCP/Telegram callers
        amenity_ids: amenityRows.map(r => r.amenity_id),
        gallery: galleryRows,
        booking_token: linkRow ? linkRow.token : null,
        // New fields for TaneChat-style consumers
        amenities: amenityRows.map(r => r.name).filter(Boolean),
        photos: galleryRows.map(r => `${base}/api/file/preview/${r.file_id}`),
        availability: {
          available_from: availableFrom,
          current_move_out: currentMoveOut,
          status: currentLease
            ? 'occupied_until_move_out'
            : currentMoveOut
              ? 'vacant'
              : 'never_leased',
        },
      },
    });
  } catch (error) {
    console.error('Public unit detail error:', error);
    fail(res, 'Failed to fetch unit');
  }
});

// GET /api/public/units/:id/availability?from_date=&to_date=
// Walks all non-deleted leases on the unit within [from_date, to_date]
// (defaults: today / +12 months) and returns the gaps between them as
// availability_windows. Also reports the lease covering today, if any.
router.get('/units/:id/availability', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const { id } = req.params;
    const today = new Date().toISOString().split('T')[0];
    const fromDate = req.query.from_date || today;
    let toDate = req.query.to_date;
    if (!toDate) {
      const d = new Date(fromDate);
      d.setMonth(d.getMonth() + 12);
      toDate = d.toISOString().split('T')[0];
    }

    // Confirm unit exists in this org
    const [[unit]] = await req.pool.execute(
      `SELECT u.id AS unit_id, u.name AS unit_name, p.display_name AS property_name
       FROM unit u JOIN property p ON u.property_id = p.id
       WHERE u.id = ? AND p.org_id = ?`,
      [id, orgId]
    );
    if (!unit) return fail(res, 'Unit not found', 404);

    // All leases overlapping [fromDate, toDate], ordered by start
    const [leases] = await req.pool.execute(
      `SELECT id, start_date, end_date, tenant_id
       FROM leasing
       WHERE unit_id = ? AND deleted_at IS NULL
         AND (end_date IS NULL OR end_date >= ?)
         AND start_date <= ?
       ORDER BY start_date ASC`,
      [id, fromDate, toDate]
    );

    const toStr = (d) => d instanceof Date ? d.toISOString().split('T')[0] : String(d).split('T')[0];
    const addDays = (s, n) => {
      const d = new Date(s); d.setDate(d.getDate() + n); return d.toISOString().split('T')[0];
    };

    // Find current lease (covers today)
    const currentLease = leases.find(l => {
      const s = toStr(l.start_date);
      const e = l.end_date ? toStr(l.end_date) : null;
      return s <= today && (!e || e >= today);
    });

    // Build availability windows = the gaps in [fromDate, toDate] not covered by any lease
    const windows = [];
    let cursor = fromDate;
    for (const l of leases) {
      const s = toStr(l.start_date);
      const e = l.end_date ? toStr(l.end_date) : null;
      if (s > cursor) {
        windows.push({
          available_from: cursor,
          available_until: addDays(s, -1),
          reason: 'Gap before next lease',
        });
      }
      if (!e) { cursor = null; break; } // open-ended lease — no more availability after this
      if (addDays(e, 1) > cursor) cursor = addDays(e, 1);
    }
    if (cursor && cursor <= toDate) {
      windows.push({
        available_from: cursor,
        available_until: toDate,
        reason: 'No lease scheduled',
      });
    }

    res.json({
      code: 200,
      data: {
        unit_id: String(unit.unit_id),
        unit_name: unit.unit_name,
        property_name: unit.property_name,
        from_date: fromDate,
        to_date: toDate,
        availability_windows: windows,
        current_lease: currentLease ? {
          tenant_move_out: currentLease.end_date ? toStr(currentLease.end_date) : null,
          status: currentLease.end_date ? 'notice_given' : 'active_open_ended',
        } : null,
      },
    });
  } catch (error) {
    console.error('Public unit availability error:', error);
    fail(res, 'Failed to fetch availability');
  }
});

// GET /api/public/amenities — all amenities available on this org
router.get('/amenities', async (req, res) => {
  try {
    const [rows] = await req.pool.execute(
      'SELECT id, name, type FROM amenity ORDER BY name'
    );
    ok(res, rows);
  } catch (error) {
    console.error('Public amenities error:', error);
    fail(res, 'Failed to fetch amenities');
  }
});

// ────────────────────────────────────────────────────────────────
// TENANTS & CONTACTS
// ────────────────────────────────────────────────────────────────

// GET /api/public/tenants?status=&category=1|2
router.get('/tenants', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const { status, category } = req.query;

    let whereClause = 'org_id = ?';
    const params = [orgId];
    if (status !== undefined) { whereClause += ' AND status = ?'; params.push(status); }
    if (category !== undefined) { whereClause += ' AND category = ?'; params.push(category); }
    else { whereClause += ' AND category = 1'; } // default to tenants, not payees

    const [tenants] = await req.pool.execute(
      `SELECT * FROM tenant WHERE ${whereClause}
       ORDER BY COALESCE(first_name, company_name, '') ASC, COALESCE(last_name, '') ASC`,
      params
    );
    ok(res, tenants);
  } catch (error) {
    console.error('Public tenants list error:', error);
    fail(res, 'Failed to fetch tenants');
  }
});

// GET /api/public/tenants/:id
router.get('/tenants/:id', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const { id } = req.params;
    const [tenants] = await req.pool.execute(
      'SELECT * FROM tenant WHERE id = ? AND org_id = ?', [id, orgId]
    );
    if (tenants.length === 0) return fail(res, 'Tenant not found', 404);
    res.json({ code: 200, data: tenants[0] });
  } catch (error) {
    console.error('Public tenant detail error:', error);
    fail(res, 'Failed to fetch tenant');
  }
});

// GET /api/public/tenants/:id/leases
router.get('/tenants/:id/leases', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const { id } = req.params;
    const [leases] = await req.pool.execute(
      `SELECT l.*, u.name AS unit_name, p.display_name AS property_name, p.id AS property_id
       FROM leasing l
       LEFT JOIN unit u ON l.unit_id = u.id
       LEFT JOIN property p ON u.property_id = p.id
       WHERE l.tenant_id = ? AND p.org_id = ? AND l.deleted_at IS NULL
       ORDER BY l.start_date DESC`,
      [id, orgId]
    );
    ok(res, leases);
  } catch (error) {
    console.error('Public tenant leases error:', error);
    fail(res, 'Failed to fetch tenant leases');
  }
});

// GET /api/public/tenants/:id/invoices
router.get('/tenants/:id/invoices', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const { id } = req.params;
    const [invoices] = await req.pool.execute(
      `SELECT i.*, cs.name AS category_name,
              u.name AS unit_name, p.display_name AS property_name
       FROM invoice i
       LEFT JOIN category_setting cs ON i.category = cs.id
       LEFT JOIN unit u ON i.unit_id = u.id
       LEFT JOIN property p ON COALESCE(i.property_id, u.property_id) = p.id
       WHERE i.tenant_id = ? AND i.org_id = ? AND i.deleted_at IS NULL
       ORDER BY i.due_on DESC`,
      [id, orgId]
    );
    ok(res, invoices);
  } catch (error) {
    console.error('Public tenant invoices error:', error);
    fail(res, 'Failed to fetch tenant invoices');
  }
});

// GET /api/public/payees
router.get('/payees', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const [payees] = await req.pool.execute(
      `SELECT * FROM tenant WHERE org_id = ? AND category = 2
       ORDER BY COALESCE(first_name, company_name, '') ASC, COALESCE(last_name, '') ASC`,
      [orgId]
    );
    ok(res, payees);
  } catch (error) {
    console.error('Public payees error:', error);
    fail(res, 'Failed to fetch payees');
  }
});

// GET /api/public/payees/:id
router.get('/payees/:id', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const { id } = req.params;
    const [payees] = await req.pool.execute(
      'SELECT * FROM tenant WHERE id = ? AND org_id = ? AND category = 2',
      [id, orgId]
    );
    if (payees.length === 0) return fail(res, 'Payee not found', 404);
    res.json({ code: 200, data: payees[0] });
  } catch (error) {
    console.error('Public payee detail error:', error);
    fail(res, 'Failed to fetch payee');
  }
});

// GET /api/public/property-owners
router.get('/property-owners', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const [owners] = await req.pool.execute(
      'SELECT * FROM property_owner WHERE org_id = ? AND deleted_at IS NULL ORDER BY first_name, last_name',
      [orgId]
    );
    ok(res, owners);
  } catch (error) {
    console.error('Public owners list error:', error);
    fail(res, 'Failed to fetch property owners');
  }
});

// GET /api/public/property-owners/:id
router.get('/property-owners/:id', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const { id } = req.params;
    const [owners] = await req.pool.execute(
      'SELECT * FROM property_owner WHERE id = ? AND org_id = ? AND deleted_at IS NULL',
      [id, orgId]
    );
    if (owners.length === 0) return fail(res, 'Property owner not found', 404);
    res.json({ code: 200, data: owners[0] });
  } catch (error) {
    console.error('Public owner detail error:', error);
    fail(res, 'Failed to fetch property owner');
  }
});

// GET /api/public/service-vendors
router.get('/service-vendors', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const [vendors] = await req.pool.execute(
      'SELECT * FROM service_vendor WHERE org_id = ? AND deleted_at IS NULL ORDER BY first_name, last_name',
      [orgId]
    );
    ok(res, vendors);
  } catch (error) {
    console.error('Public vendors list error:', error);
    fail(res, 'Failed to fetch service vendors');
  }
});

// GET /api/public/service-vendors/:id
router.get('/service-vendors/:id', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const { id } = req.params;
    const [vendors] = await req.pool.execute(
      'SELECT * FROM service_vendor WHERE id = ? AND org_id = ? AND deleted_at IS NULL',
      [id, orgId]
    );
    if (vendors.length === 0) return fail(res, 'Service vendor not found', 404);
    res.json({ code: 200, data: vendors[0] });
  } catch (error) {
    console.error('Public vendor detail error:', error);
    fail(res, 'Failed to fetch service vendor');
  }
});

// ────────────────────────────────────────────────────────────────
// LEASES
// ────────────────────────────────────────────────────────────────

// GET /api/public/leases/expiring?days=30
// Static route — must be defined BEFORE /leases/:id
router.get('/leases/expiring', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const days = parseInt(req.query.days) || 30;
    const [leases] = await req.pool.execute(
      `SELECT l.*, u.name AS unit_name, p.display_name AS property_name,
              t.first_name AS tenant_first_name, t.last_name AS tenant_last_name,
              DATEDIFF(l.end_date, NOW()) AS days_until_expiry
       FROM leasing l
       LEFT JOIN unit u ON l.unit_id = u.id
       LEFT JOIN property p ON u.property_id = p.id
       LEFT JOIN tenant t ON l.tenant_id = t.id
       WHERE p.org_id = ? AND l.deleted_at IS NULL
         AND DATEDIFF(l.end_date, NOW()) BETWEEN 0 AND ?
       ORDER BY l.end_date ASC`,
      [orgId, days]
    );
    ok(res, leases, { days });
  } catch (error) {
    console.error('Public expiring leases error:', error);
    fail(res, 'Failed to fetch expiring leases');
  }
});

// GET /api/public/leases?status=active|upcoming|inactive|terminated&unit_id=&tenant_id=
router.get('/leases', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const { status, unit_id, tenant_id } = req.query;

    let whereClause = 'p.org_id = ? AND l.deleted_at IS NULL';
    const params = [orgId];
    if (unit_id) { whereClause += ' AND l.unit_id = ?'; params.push(unit_id); }
    if (tenant_id) { whereClause += ' AND l.tenant_id = ?'; params.push(tenant_id); }

    if (status === 'active') {
      whereClause += ' AND l.start_date <= CURDATE() AND (l.end_date >= CURDATE() OR l.end_date IS NULL)';
    } else if (status === 'upcoming') {
      whereClause += ' AND l.start_date > CURDATE()';
    } else if (status === 'inactive') {
      whereClause += ' AND l.end_date < CURDATE()';
    }
    // 'terminated' is handled by deleted_at, which is always excluded above

    const [leases] = await req.pool.execute(
      `SELECT l.*, u.name AS unit_name, p.display_name AS property_name, p.id AS property_id,
              t.first_name AS tenant_first_name, t.last_name AS tenant_last_name,
              t.company_name AS tenant_company_name, t.email AS tenant_email, t.phone AS tenant_phone,
              CASE
                WHEN l.start_date > CURDATE() THEN 'upcoming'
                WHEN l.end_date < CURDATE() THEN 'inactive'
                ELSE 'active'
              END AS lease_status
       FROM leasing l
       LEFT JOIN unit u ON l.unit_id = u.id
       LEFT JOIN property p ON u.property_id = p.id
       LEFT JOIN tenant t ON l.tenant_id = t.id
       WHERE ${whereClause}
       ORDER BY l.start_date DESC`,
      params
    );
    ok(res, leases);
  } catch (error) {
    console.error('Public leases list error:', error);
    fail(res, 'Failed to fetch leases');
  }
});

// GET /api/public/leases/:id — lease detail + additional tenants
router.get('/leases/:id', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const { id } = req.params;
    const [leases] = await req.pool.execute(
      `SELECT l.*, u.name AS unit_name, p.display_name AS property_name, p.id AS property_id,
              t.first_name AS tenant_first_name, t.last_name AS tenant_last_name,
              t.company_name AS tenant_company_name, t.email AS tenant_email, t.phone AS tenant_phone,
              CASE
                WHEN l.start_date > CURDATE() THEN 'upcoming'
                WHEN l.end_date < CURDATE() THEN 'inactive'
                ELSE 'active'
              END AS lease_status
       FROM leasing l
       LEFT JOIN unit u ON l.unit_id = u.id
       LEFT JOIN property p ON u.property_id = p.id
       LEFT JOIN tenant t ON l.tenant_id = t.id
       WHERE l.id = ? AND p.org_id = ? AND l.deleted_at IS NULL`,
      [id, orgId]
    );
    if (leases.length === 0) return fail(res, 'Lease not found', 404);
    const lease = leases[0];

    const [additional] = await req.pool.execute(
      `SELECT t.id, t.first_name, t.last_name, t.company_name, t.type, t.email, t.phone
       FROM leasing_additional_tenant lat
       LEFT JOIN tenant t ON t.id = lat.tenant_id
       WHERE lat.leasing_id = ?`,
      [id]
    );

    res.json({ code: 200, data: { ...lease, additional_tenants: additional } });
  } catch (error) {
    console.error('Public lease detail error:', error);
    fail(res, 'Failed to fetch lease');
  }
});

// ────────────────────────────────────────────────────────────────
// INVOICES & PAYMENTS
// ────────────────────────────────────────────────────────────────

// GET /api/public/invoices?status=&tenant_id=&from=&to=
router.get('/invoices', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const { status, tenant_id, from, to, property_id, unit_id } = req.query;

    let whereClause = 'i.org_id = ? AND i.deleted_at IS NULL';
    const params = [orgId];
    if (status !== undefined) { whereClause += ' AND i.status = ?'; params.push(status); }
    if (tenant_id) { whereClause += ' AND i.tenant_id = ?'; params.push(tenant_id); }
    if (property_id) { whereClause += ' AND i.property_id = ?'; params.push(property_id); }
    if (unit_id) { whereClause += ' AND i.unit_id = ?'; params.push(unit_id); }
    if (from) { whereClause += ' AND i.due_on >= ?'; params.push(from); }
    if (to) { whereClause += ' AND i.due_on <= ?'; params.push(to); }

    const [invoices] = await req.pool.execute(
      `SELECT i.*, cs.name AS category_name,
              t.first_name AS tenant_first_name, t.last_name AS tenant_last_name,
              t.company_name AS tenant_company_name,
              u.name AS unit_name, p.display_name AS property_name,
              bp.name AS booking_platform_name,
              sa.name AS sales_agent_name,
              lbp.name AS lease_booking_platform_name,
              lsa.name AS lease_sales_agent_name
       FROM invoice i
       LEFT JOIN category_setting cs ON i.category = cs.id
       LEFT JOIN tenant t ON i.tenant_id = t.id
       LEFT JOIN unit u ON i.unit_id = u.id
       LEFT JOIN property p ON COALESCE(i.property_id, u.property_id) = p.id
       LEFT JOIN booking_platform bp ON i.booking_platform_id = bp.id
       LEFT JOIN sales_agent sa ON i.sales_agent_id = sa.id
       LEFT JOIN leasing l ON i.leasing_id = l.id
       LEFT JOIN booking_platform lbp ON l.booking_platform_id = lbp.id
       LEFT JOIN sales_agent lsa ON l.sales_agent_id = lsa.id
       WHERE ${whereClause}
       ORDER BY i.due_on DESC`,
      params
    );
    ok(res, invoices);
  } catch (error) {
    console.error('Public invoices list error:', error);
    fail(res, 'Failed to fetch invoices');
  }
});

// GET /api/public/invoices/:id — invoice detail + payment history
router.get('/invoices/:id', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const { id } = req.params;

    const [invoices] = await req.pool.execute(
      `SELECT i.*, cs.name AS category_name,
              t.first_name AS tenant_first_name, t.last_name AS tenant_last_name,
              t.company_name AS tenant_company_name, t.email AS tenant_email,
              p.display_name AS property_name, u.name AS unit_name,
              l.lease_no,
              bp.name AS booking_platform_name,
              sa.name AS sales_agent_name,
              lbp.name AS lease_booking_platform_name,
              lsa.name AS lease_sales_agent_name
       FROM invoice i
       LEFT JOIN category_setting cs ON i.category = cs.id
       LEFT JOIN tenant t ON i.tenant_id = t.id
       LEFT JOIN unit u ON i.unit_id = u.id
       LEFT JOIN property p ON COALESCE(i.property_id, u.property_id) = p.id
       LEFT JOIN leasing l ON i.leasing_id = l.id
       LEFT JOIN booking_platform bp ON i.booking_platform_id = bp.id
       LEFT JOIN sales_agent sa ON i.sales_agent_id = sa.id
       LEFT JOIN booking_platform lbp ON l.booking_platform_id = lbp.id
       LEFT JOIN sales_agent lsa ON l.sales_agent_id = lsa.id
       WHERE i.id = ? AND i.org_id = ? AND i.deleted_at IS NULL`,
      [id, orgId]
    );
    if (invoices.length === 0) return fail(res, 'Invoice not found', 404);
    const inv = invoices[0];

    const [payments] = await req.pool.execute(
      `SELECT DISTINCT a.id, a.transaction_code, a.payment_date, a.amount AS header_amount, a.type, a.note,
              al.amount, pms.payment_method AS payment_method_name
       FROM accounting_line al
       JOIN accounting a ON al.accounting_id = a.id
       LEFT JOIN payment_method_setting pms ON a.payment_setting_id = pms.id
       WHERE al.invoice_code = ? AND a.org_id = ? AND a.deleted_at IS NULL AND al.deleted_at IS NULL
       ORDER BY a.payment_date DESC`,
      [inv.invoice_code, orgId]
    );

    const amountPaid = payments.reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);
    const outstanding = Number(inv.status) === 1 ? 0 : Math.max(0, (parseFloat(inv.amount) || 0) - amountPaid);

    res.json({ code: 200, data: { ...inv, payments, amount_paid: amountPaid, outstanding } });
  } catch (error) {
    console.error('Public invoice detail error:', error);
    fail(res, 'Failed to fetch invoice');
  }
});

// GET /api/public/payments?tenant_id=&from=&to=
router.get('/payments', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const { tenant_id, from, to } = req.query;

    let whereClause = 'a.org_id = ? AND a.deleted_at IS NULL';
    const params = [orgId];
    if (tenant_id) { whereClause += ' AND a.tenant_id = ?'; params.push(tenant_id); }
    if (from) { whereClause += ' AND a.payment_date >= ?'; params.push(from); }
    if (to) { whereClause += ' AND a.payment_date <= ?'; params.push(to); }

    const [payments] = await req.pool.execute(
      `SELECT a.id, a.transaction_code, a.invoice_code, a.payment_date, a.amount, a.type, a.note,
              a.tenant_id, a.property_id, a.unit_id, a.lease_id,
              t.first_name AS tenant_first_name, t.last_name AS tenant_last_name,
              pms.payment_method AS payment_method_name,
              cs.name AS category_name,
              p.display_name AS property_name, u.name AS unit_name
       FROM accounting a
       LEFT JOIN tenant t ON a.tenant_id = t.id
       LEFT JOIN payment_method_setting pms ON a.payment_setting_id = pms.id
       LEFT JOIN category_setting cs ON a.category = cs.id
       LEFT JOIN property p ON a.property_id = p.id
       LEFT JOIN unit u ON a.unit_id = u.id
       WHERE ${whereClause}
       ORDER BY a.payment_date DESC`,
      params
    );
    ok(res, payments);
  } catch (error) {
    console.error('Public payments list error:', error);
    fail(res, 'Failed to fetch payments');
  }
});

// ────────────────────────────────────────────────────────────────
// ACCOUNTING
// ────────────────────────────────────────────────────────────────

// GET /api/public/accounting?type=0|1&category=&from=&to=
router.get('/accounting', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const { type, category, from, to, tenant_id, property_id } = req.query;

    let whereClause = 'a.org_id = ? AND a.deleted_at IS NULL';
    const params = [orgId];
    if (type !== undefined) { whereClause += ' AND a.type = ?'; params.push(type); }
    if (category) { whereClause += ' AND a.category = ?'; params.push(category); }
    if (tenant_id) { whereClause += ' AND a.tenant_id = ?'; params.push(tenant_id); }
    if (property_id) { whereClause += ' AND a.property_id = ?'; params.push(property_id); }
    if (from) { whereClause += ' AND a.payment_date >= ?'; params.push(from); }
    if (to) { whereClause += ' AND a.payment_date <= ?'; params.push(to); }

    const [entries] = await req.pool.execute(
      `SELECT a.*, cs.name AS category_name,
              ast.name AS account_name,
              pms.payment_method AS payment_method_name,
              p.display_name AS property_name, u.name AS unit_name,
              t.first_name AS tenant_first_name, t.last_name AS tenant_last_name
       FROM accounting a
       LEFT JOIN category_setting cs ON a.category = cs.id
       LEFT JOIN account_setting ast ON a.account_setting_id = ast.id
       LEFT JOIN payment_method_setting pms ON a.payment_setting_id = pms.id
       LEFT JOIN property p ON a.property_id = p.id
       LEFT JOIN unit u ON a.unit_id = u.id
       LEFT JOIN tenant t ON a.tenant_id = t.id
       WHERE ${whereClause}
       ORDER BY a.payment_date DESC`,
      params
    );
    ok(res, entries);
  } catch (error) {
    console.error('Public accounting list error:', error);
    fail(res, 'Failed to fetch accounting entries');
  }
});

// GET /api/public/accounting/:id — entry detail + lines
router.get('/accounting/:id', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const { id } = req.params;

    const [rows] = await req.pool.execute(
      `SELECT a.*, cs.name AS category_name, ast.name AS account_name,
              pms.payment_method AS payment_method_name,
              p.display_name AS property_name, u.name AS unit_name,
              t.first_name AS tenant_first_name, t.last_name AS tenant_last_name
       FROM accounting a
       LEFT JOIN category_setting cs ON a.category = cs.id
       LEFT JOIN account_setting ast ON a.account_setting_id = ast.id
       LEFT JOIN payment_method_setting pms ON a.payment_setting_id = pms.id
       LEFT JOIN property p ON a.property_id = p.id
       LEFT JOIN unit u ON a.unit_id = u.id
       LEFT JOIN tenant t ON a.tenant_id = t.id
       WHERE a.id = ? AND a.org_id = ? AND a.deleted_at IS NULL`,
      [id, orgId]
    );
    if (rows.length === 0) return fail(res, 'Entry not found', 404);

    const [lines] = await req.pool.execute(
      `SELECT al.*, cs.name AS category_name,
              p.display_name AS property_name, u.name AS unit_name
       FROM accounting_line al
       LEFT JOIN category_setting cs ON al.category = cs.id
       LEFT JOIN property p ON al.property_id = p.id
       LEFT JOIN unit u ON al.unit_id = u.id
       WHERE al.accounting_id = ? AND al.deleted_at IS NULL`,
      [id]
    );

    res.json({ code: 200, data: { ...rows[0], lines } });
  } catch (error) {
    console.error('Public accounting detail error:', error);
    fail(res, 'Failed to fetch accounting entry');
  }
});

// ────────────────────────────────────────────────────────────────
// SERVICES
// ────────────────────────────────────────────────────────────────

// GET /api/public/services?status=
router.get('/services', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const { status, unit_id, property_id } = req.query;

    let whereClause = 's.org_id = ? AND s.deleted_at IS NULL';
    const params = [orgId];
    if (status !== undefined) { whereClause += ' AND s.status = ?'; params.push(status); }
    if (unit_id) { whereClause += ' AND s.unit_id = ?'; params.push(unit_id); }
    if (property_id) { whereClause += ' AND p.id = ?'; params.push(property_id); }

    const [services] = await req.pool.execute(
      `SELECT s.*, u.name AS unit_name, p.display_name AS property_name, p.id AS property_id,
              sv.first_name AS assignee_first_name, sv.last_name AS assignee_last_name,
              CASE WHEN t.type = 1 THEN t.company_name
                   ELSE CONCAT(COALESCE(t.first_name,''), ' ', COALESCE(t.last_name,''))
              END AS tenant_name, t.phone AS tenant_phone
       FROM service s
       LEFT JOIN unit u ON s.unit_id = u.id
       LEFT JOIN property p ON u.property_id = p.id
       LEFT JOIN service_vendor sv ON s.assignee = sv.id
       LEFT JOIN tenant t ON s.created_by = t.id
       WHERE ${whereClause}
       ORDER BY s.created_at DESC`,
      params
    );
    ok(res, services);
  } catch (error) {
    console.error('Public services list error:', error);
    fail(res, 'Failed to fetch services');
  }
});

// GET /api/public/services/:id — detail + activity timeline
router.get('/services/:id', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const { id } = req.params;

    const [services] = await req.pool.execute(
      `SELECT s.*, u.name AS unit_name, p.display_name AS property_name, p.id AS property_id,
              sv.first_name AS assignee_first_name, sv.last_name AS assignee_last_name,
              sv2.first_name AS assignee_2_first_name, sv2.last_name AS assignee_2_last_name,
              CASE WHEN rb.type = 1 THEN rb.company_name
                   ELSE CONCAT(COALESCE(rb.first_name,''), ' ', COALESCE(rb.last_name,''))
              END AS reported_by_name, rb.phone AS reported_by_phone,
              CASE WHEN t.type = 1 THEN t.company_name
                   ELSE CONCAT(COALESCE(t.first_name,''), ' ', COALESCE(t.last_name,''))
              END AS tenant_name, t.phone AS tenant_phone
       FROM service s
       LEFT JOIN unit u ON s.unit_id = u.id
       LEFT JOIN property p ON u.property_id = p.id
       LEFT JOIN service_vendor sv ON s.assignee = sv.id
       LEFT JOIN service_vendor sv2 ON s.assignee_2 = sv2.id
       LEFT JOIN tenant rb ON s.reported_by = rb.id
       LEFT JOIN tenant t ON s.created_by = t.id
       WHERE s.id = ? AND s.org_id = ? AND s.deleted_at IS NULL`,
      [id, orgId]
    );
    if (services.length === 0) return fail(res, 'Service not found', 404);

    const [activities] = await req.pool.execute(
      `SELECT sa.*, u.first_name AS user_first_name, u.last_name AS user_last_name
       FROM service_activity sa
       LEFT JOIN user u ON sa.created_by = u.id
       WHERE sa.service_id = ? AND sa.org_id = ?
       ORDER BY sa.created_at ASC`,
      [id, orgId]
    );

    res.json({ code: 200, data: { ...services[0], activities } });
  } catch (error) {
    console.error('Public service detail error:', error);
    fail(res, 'Failed to fetch service');
  }
});

// ────────────────────────────────────────────────────────────────
// UTILITIES
// ────────────────────────────────────────────────────────────────

// GET /api/public/utility/groups
router.get('/utility/groups', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const [rows] = await req.pool.execute(
      `SELECT g.id, g.name, g.property_id, g.status, p.display_name AS property_name
       FROM utility_group g
       LEFT JOIN property p ON g.property_id = p.id
       WHERE g.org_id = ? AND g.status = 1
       ORDER BY g.name`,
      [orgId]
    );
    ok(res, rows);
  } catch (error) {
    console.error('Public utility groups error:', error);
    fail(res, 'Failed to fetch utility groups');
  }
});

// GET /api/public/utility/bills?group_id=
router.get('/utility/bills', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const { group_id } = req.query;

    let sql = `SELECT b.id, b.group_id, b.period_start, b.period_end,
                      b.total_amount, b.total_kw, b.rate_per_kw, b.status,
                      g.name AS group_name
               FROM utility_bill b
               LEFT JOIN utility_group g ON b.group_id = g.id
               WHERE b.org_id = ?`;
    const params = [orgId];
    if (group_id) { sql += ' AND b.group_id = ?'; params.push(group_id); }
    sql += ' ORDER BY b.period_start DESC';

    const [rows] = await req.pool.execute(sql, params);
    ok(res, rows);
  } catch (error) {
    console.error('Public utility bills error:', error);
    fail(res, 'Failed to fetch utility bills');
  }
});

// GET /api/public/utility/bills/:id — bill + all lines
router.get('/utility/bills/:id', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const { id } = req.params;

    const [[bill]] = await req.pool.execute(
      `SELECT b.*, g.name AS group_name
       FROM utility_bill b
       LEFT JOIN utility_group g ON b.group_id = g.id
       WHERE b.id = ? AND b.org_id = ?`,
      [id, orgId]
    );
    if (!bill) return fail(res, 'Bill not found', 404);

    const [lines] = await req.pool.execute(
      `SELECT bl.*, m.meter_number, m.meter_type, m.meter_category,
              u.name AS unit_name, p.display_name AS property_name,
              t.first_name AS tenant_first_name, t.last_name AS tenant_last_name,
              i.invoice_code, i.status AS invoice_status
       FROM utility_bill_line bl
       LEFT JOIN utility_meter m ON bl.meter_id = m.id
       LEFT JOIN unit u ON bl.unit_id = u.id
       LEFT JOIN property p ON u.property_id = p.id
       LEFT JOIN tenant t ON bl.tenant_id = t.id
       LEFT JOIN invoice i ON bl.invoice_id = i.id
       WHERE bl.bill_id = ?
       ORDER BY bl.is_common_area, u.name, m.meter_number`,
      [id]
    );

    res.json({ code: 200, data: { ...bill, lines } });
  } catch (error) {
    console.error('Public utility bill detail error:', error);
    fail(res, 'Failed to fetch utility bill');
  }
});

// GET /api/public/utility/meters?group_id=&unit_id=
router.get('/utility/meters', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const { group_id, unit_id } = req.query;

    let sql = `SELECT m.id, m.group_id, m.unit_id, m.meter_number, m.meter_type,
                      m.meter_category, m.current_reading, m.status,
                      g.name AS group_name, u.name AS unit_name, p.display_name AS property_name
               FROM utility_meter m
               LEFT JOIN utility_group g ON m.group_id = g.id
               LEFT JOIN unit u ON m.unit_id = u.id
               LEFT JOIN property p ON u.property_id = p.id
               WHERE m.org_id = ? AND m.status = 1`;
    const params = [orgId];
    if (group_id) { sql += ' AND m.group_id = ?'; params.push(group_id); }
    if (unit_id) { sql += ' AND m.unit_id = ?'; params.push(unit_id); }
    sql += ' ORDER BY g.name, m.meter_category, u.name, m.meter_number';

    const [rows] = await req.pool.execute(sql, params);
    ok(res, rows);
  } catch (error) {
    console.error('Public utility meters error:', error);
    fail(res, 'Failed to fetch utility meters');
  }
});

// GET /api/public/utility/meters/:id/readings
router.get('/utility/meters/:id/readings', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const { id } = req.params;

    // Confirm meter belongs to org
    const [[meter]] = await req.pool.execute(
      'SELECT id FROM utility_meter WHERE id = ? AND org_id = ?', [id, orgId]
    );
    if (!meter) return fail(res, 'Meter not found', 404);

    const [rows] = await req.pool.execute(
      `SELECT mr.*, t.first_name AS tenant_first_name, t.last_name AS tenant_last_name
       FROM utility_meter_reading mr
       LEFT JOIN tenant t ON mr.tenant_id = t.id
       WHERE mr.meter_id = ? AND mr.org_id = ?
       ORDER BY mr.reading_date DESC, mr.created_at DESC`,
      [id, orgId]
    );
    ok(res, rows);
  } catch (error) {
    console.error('Public utility readings error:', error);
    fail(res, 'Failed to fetch meter readings');
  }
});

// GET /api/public/utility/settlements — all checkout settlements
router.get('/utility/settlements', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const { tenant_id } = req.query;

    let sql = `SELECT cs.*, m.meter_number, u.name AS unit_name, p.display_name AS property_name,
                      t.first_name AS tenant_first_name, t.last_name AS tenant_last_name,
                      i.invoice_code, i.status AS invoice_status
               FROM utility_checkout_settlement cs
               LEFT JOIN utility_meter m ON cs.meter_id = m.id
               LEFT JOIN unit u ON m.unit_id = u.id
               LEFT JOIN property p ON u.property_id = p.id
               LEFT JOIN tenant t ON cs.tenant_id = t.id
               LEFT JOIN invoice i ON cs.invoice_id = i.id
               WHERE cs.org_id = ?`;
    const params = [orgId];
    if (tenant_id) { sql += ' AND cs.tenant_id = ?'; params.push(tenant_id); }
    sql += ' ORDER BY cs.created_at DESC';

    const [rows] = await req.pool.execute(sql, params);
    ok(res, rows);
  } catch (error) {
    console.error('Public utility settlements error:', error);
    fail(res, 'Failed to fetch settlements');
  }
});

// ────────────────────────────────────────────────────────────────
// CLEANING
// ────────────────────────────────────────────────────────────────

// GET /api/public/cleaning/cleaners
router.get('/cleaning/cleaners', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const [rows] = await req.pool.execute(
      'SELECT id, name, status, created_at FROM cleaner WHERE org_id = ? ORDER BY name',
      [orgId]
    );
    ok(res, rows);
  } catch (error) {
    console.error('Public cleaners error:', error);
    fail(res, 'Failed to fetch cleaners');
  }
});

// GET /api/public/cleaning/schedule?week_of=YYYY-MM-DD
router.get('/cleaning/schedule', async (req, res) => {
  try {
    const orgId = req.apiKey.orgId;
    const { week_of } = req.query;
    if (!week_of) return fail(res, 'week_of required', 400);

    const [rows] = await req.pool.execute(
      `SELECT cs.id, cs.property_id, cs.unit_id, cs.cleaner_id, cs.scheduled_date,
              cs.type, cs.lease_id, cs.tenant_id, cs.status, cs.notes, cs.cleaning_notes,
              p.display_name AS property_name, u.name AS unit_name,
              cl.name AS cleaner_name,
              t.first_name, t.last_name
       FROM cleaning_schedule cs
       JOIN unit u ON cs.unit_id = u.id
       JOIN property p ON cs.property_id = p.id
       LEFT JOIN cleaner cl ON cs.cleaner_id = cl.id
       LEFT JOIN tenant t ON cs.tenant_id = t.id
       WHERE cs.org_id = ? AND cs.week_of = ?
       ORDER BY cs.scheduled_date, p.display_name, u.name`,
      [orgId, week_of]
    );
    ok(res, rows, { week_of });
  } catch (error) {
    console.error('Public cleaning schedule error:', error);
    fail(res, 'Failed to fetch cleaning schedule');
  }
});

module.exports = router;
