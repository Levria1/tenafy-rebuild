const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { logActivity } = require('../utils/activityLog');


// POST /api/property/list - List properties with paging
// Filters: search, propertyType (residential=0/commercial=1), propertyStatus (active=1/inactive=0), unitStatus (vacant/occupied)
router.post('/list', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { search, propertyType, propertyStatus, unitStatus } = req.body || {};
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    let whereClause = 'p.org_id = ? AND p.deleted_at IS NULL';
    const params = [orgId];

    // Property Status filter (default show active only if not specified)
    if (propertyStatus !== undefined && propertyStatus !== null) {
      whereClause += ' AND p.status = ?';
      params.push(propertyStatus);
    } else {
      whereClause += ' AND p.status = 1';
    }

    if (search) {
      whereClause += ' AND (p.display_name LIKE ? OR p.street_address LIKE ?)';
      params.push('%' + search + '%', '%' + search + '%');
    }

    // Property Type: 0 = residential, 1 = commercial
    if (propertyType !== undefined && propertyType !== null) {
      whereClause += ' AND p.type = ?';
      params.push(propertyType);
    }

    // Unit Status filter: filter properties that have at least one vacant/occupied unit
    let havingClause = '';
    if (unitStatus === 'vacant') {
      havingClause = ' HAVING (total_units - occupied_units) > 0';
    } else if (unitStatus === 'occupied') {
      havingClause = ' HAVING occupied_units > 0';
    }

    const [properties] = await req.pool.execute(
      `SELECT p.*,
              (SELECT COUNT(*) FROM unit u WHERE u.property_id = p.id AND u.active_status = 1) as total_units,
              (SELECT COUNT(*) FROM unit u WHERE u.property_id = p.id AND u.active_status = 1 AND EXISTS (
                SELECT 1 FROM leasing l WHERE l.unit_id = u.id AND l.deleted_at IS NULL
                  AND l.start_date <= CURDATE() AND (l.end_date >= CURDATE() OR l.end_date IS NULL)
              )) as occupied_units
       FROM property p
       WHERE ${whereClause}
       ${havingClause}
       ORDER BY p.display_name
       LIMIT ${limit} OFFSET ${offset}`,
      params
    );

    // For count, we need a subquery approach if using HAVING
    let countQuery;
    if (havingClause) {
      countQuery = `SELECT COUNT(*) as total FROM (
        SELECT p.id,
               (SELECT COUNT(*) FROM unit u WHERE u.property_id = p.id AND u.active_status = 1) as total_units,
               (SELECT COUNT(*) FROM unit u WHERE u.property_id = p.id AND u.active_status = 1 AND EXISTS (
                SELECT 1 FROM leasing l WHERE l.unit_id = u.id AND l.deleted_at IS NULL
                  AND l.start_date <= CURDATE() AND (l.end_date >= CURDATE() OR l.end_date IS NULL)
              )) as occupied_units
        FROM property p WHERE ${whereClause} ${havingClause}
      ) sub`;
    } else {
      countQuery = `SELECT COUNT(*) as total FROM property p WHERE ${whereClause}`;
    }

    const [[{ total }]] = await req.pool.execute(countQuery, params);

    res.json({ code: 200, data: { content: properties, totalElements: total, totalPages: Math.ceil(total / limit), currentPage: page } });
  } catch (error) {
    console.error('List properties error:', error);
    res.status(500).json({ code: 500, message: 'Failed to list properties' });
  }
});

// GET /api/property/all - Get all properties (for dropdowns)
router.get('/all', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const [properties] = await req.pool.execute(
      'SELECT id, display_name, street_address, city, status FROM property WHERE org_id = ? AND status = 1 ORDER BY display_name',
      [orgId]
    );
    res.json({ code: 200, data: properties });
  } catch (error) {
    console.error('Get all properties error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get properties' });
  }
});

// GET /api/property/all/with_units - Get all properties with their units
router.get('/all/with_units', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const [properties] = await req.pool.execute(
      'SELECT id, display_name, street_address, city FROM property WHERE org_id = ? AND status = 1 ORDER BY display_name',
      [orgId]
    );

    for (const property of properties) {
      const [units] = await req.pool.execute(
        'SELECT id, name, rent_price_min, status FROM unit WHERE property_id = ? AND active_status = 1 ORDER BY name',
        [property.id]
      );
      property.units = units;
    }

    res.json({ code: 200, data: properties });
  } catch (error) {
    console.error('Get all properties with units error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get properties' });
  }
});

// GET /api/property/unit/unoccupied - List unoccupied units (must be before /:id routes)
router.get('/unit/unoccupied', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const [units] = await req.pool.execute(
      `SELECT u.*, p.display_name as property_name FROM unit u LEFT JOIN property p ON u.property_id = p.id WHERE p.org_id = ? AND u.active_status = 1 AND NOT EXISTS (
        SELECT 1 FROM leasing l WHERE l.unit_id = u.id AND l.deleted_at IS NULL
          AND l.start_date <= CURDATE() AND (l.end_date >= CURDATE() OR l.end_date IS NULL)
      ) ORDER BY p.display_name, u.name`,
      [orgId]
    );
    res.json({ code: 200, data: units });
  } catch (error) {
    console.error('Get unoccupied units error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get units' });
  }
});

// GET /api/property/unit/active/occupancy/rate - Get occupancy rate
router.get('/unit/active/occupancy/rate', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const [result] = await req.pool.execute(
      `SELECT COUNT(*) as total, SUM(CASE WHEN EXISTS (
        SELECT 1 FROM leasing l WHERE l.unit_id = u.id AND l.deleted_at IS NULL
          AND l.start_date <= CURDATE() AND (l.end_date >= CURDATE() OR l.end_date IS NULL)
      ) THEN 1 ELSE 0 END) as occupied FROM unit u LEFT JOIN property p ON u.property_id = p.id WHERE p.org_id = ? AND u.active_status = 1`,
      [orgId]
    );
    const total = result[0].total || 0;
    const occupied = result[0].occupied || 0;
    const rate = total > 0 ? Math.round((occupied / total) * 100) : 0;
    res.json({ code: 200, data: { total, occupied, rate } });
  } catch (error) {
    console.error('Get occupancy rate error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get occupancy rate' });
  }
});

// GET /api/property/unit/nolease/within5days - Units with no lease within 5 days
router.get('/unit/nolease/within5days', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const status = parseInt(req.query.status) || -1;
    const [units] = await req.pool.execute(
      `SELECT u.*, p.display_name as property_name,
        (SELECT l.end_date FROM leasing l WHERE l.unit_id = u.id AND l.deleted_at IS NULL ORDER BY l.end_date DESC LIMIT 1) as lease_end_date
       FROM unit u
       LEFT JOIN property p ON u.property_id = p.id
       WHERE p.org_id = ? AND u.active_status = 1
       HAVING lease_end_date IS NULL OR DATEDIFF(lease_end_date, NOW()) <= 5
       ORDER BY lease_end_date ASC`,
      [orgId]
    );
    res.json({ code: 200, data: units });
  } catch (error) {
    console.error('Get units no lease error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get units' });
  }
});

// GET /api/property/unit/:unit_id/basic - Get unit basic detail
router.get('/unit/:unit_id/basic', authenticate, async (req, res) => {
  try {
    const { unit_id } = req.params;
    const orgId = req.user.orgId;
    const [units] = await req.pool.execute(
      'SELECT u.id, u.name, u.rent_price_min, u.status, u.property_id, p.display_name as property_name FROM unit u LEFT JOIN property p ON u.property_id = p.id WHERE u.id = ? AND p.org_id = ? AND u.active_status = 1',
      [unit_id, orgId]
    );
    if (units.length === 0) {
      return res.status(404).json({ code: 404, message: 'Unit not found' });
    }
    res.json({ code: 200, data: units[0] });
  } catch (error) {
    console.error('Get unit basic error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get unit' });
  }
});

// GET /api/property/unit/:unit_id/clone - Clone unit
router.get('/unit/:unit_id/clone', authenticate, async (req, res) => {
  try {
    const { unit_id } = req.params;
    const orgId = req.user.orgId;
    const [units] = await req.pool.execute(
      'SELECT u.* FROM unit u LEFT JOIN property p ON u.property_id = p.id WHERE u.id = ? AND p.org_id = ?',
      [unit_id, orgId]
    );
    if (units.length === 0) {
      return res.status(404).json({ code: 404, message: 'Unit not found' });
    }
    const original = units[0];
    const [result] = await req.pool.execute(
      'INSERT INTO unit (property_id, name, internal_note, rent_price_min, deposit_price, status, beds, baths, size, active_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NOW())',
      [original.property_id, original.name + ' (Copy)', original.internal_note, original.rent_price_min, original.deposit_price, 0, original.beds, original.baths, original.size]
    );
    res.json({ code: 200, message: 'Unit cloned', data: { id: result.insertId } });
  } catch (error) {
    console.error('Clone unit error:', error);
    res.status(500).json({ code: 500, message: 'Failed to clone unit' });
  }
});

// GET /api/property/unit/:unit_id - Get unit detail
router.get('/unit/:unit_id', authenticate, async (req, res) => {
  try {
    const { unit_id } = req.params;
    const orgId = req.user.orgId;
    const [units] = await req.pool.execute(
      'SELECT u.*, p.display_name as property_name, p.street_address as property_address FROM unit u LEFT JOIN property p ON u.property_id = p.id WHERE u.id = ? AND p.org_id = ? AND u.active_status = 1',
      [unit_id, orgId]
    );
    if (units.length === 0) {
      return res.status(404).json({ code: 404, message: 'Unit not found' });
    }
    // Attach gallery
    const [galleryRows] = await req.pool.execute(
      'SELECT file_id, `order` FROM object_gallery WHERE object_id = ? ORDER BY `order`', [unit_id]
    );
    res.json({ code: 200, data: { ...units[0], gallery: galleryRows } });
  } catch (error) {
    console.error('Get unit error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get unit' });
  }
});

// GET /api/property/unit/tenant/:id - Get unit by tenant
router.get('/unit/tenant/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;
    const [units] = await req.pool.execute(
      `SELECT u.*, p.display_name as property_name
       FROM unit u
       LEFT JOIN property p ON u.property_id = p.id
       LEFT JOIN leasing l ON l.unit_id = u.id AND l.deleted_at IS NULL
         AND l.start_date <= CURDATE() AND (l.end_date >= CURDATE() OR l.end_date IS NULL)
       WHERE l.tenant_id = ? AND p.org_id = ? AND u.active_status = 1`,
      [id, orgId]
    );
    res.json({ code: 200, data: units });
  } catch (error) {
    console.error('Get unit by tenant error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get unit' });
  }
});

// PUT /api/property/unit/:unit_id - Update unit
router.put('/unit/:unit_id', authenticate, async (req, res) => {
  try {
    const { unit_id } = req.params;
    const {
      name, type, size, size_unit, beds, baths,
      smoking, laundry, parking,
      amenity_detail, access_information, key_code, wifi_information, internal_note,
      rent_price_min, rent_price_max, deposit_price,
      charge_method, fee, photo, galleryFileIds, active_status,
      listing_url,
    } = req.body;
    const orgId = req.user.orgId;

    // Block deactivation if there are active or upcoming leases on this unit
    if (active_status != null && Number(active_status) === 0) {
      const [[existing]] = await req.pool.execute(
        'SELECT active_status FROM unit u LEFT JOIN property p ON u.property_id = p.id WHERE u.id = ? AND p.org_id = ?',
        [unit_id, orgId]
      );
      if (existing && Number(existing.active_status) === 1) {
        const [[leaseCheck]] = await req.pool.execute(
          `SELECT COUNT(*) AS cnt FROM leasing
           WHERE unit_id = ? AND deleted_at IS NULL
             AND (end_date IS NULL OR end_date >= CURDATE())`,
          [unit_id]
        );
        if (leaseCheck && Number(leaseCheck.cnt) > 0) {
          return res.status(400).json({ code: 400, message: 'Cannot deactivate: unit has active or upcoming leases' });
        }
      }
    }

    await req.pool.execute(
      `UPDATE unit u LEFT JOIN property p ON u.property_id = p.id
       SET u.name = ?, u.type = ?, u.size = ?, u.size_unit = ?, u.beds = ?, u.baths = ?,
           u.smoking = ?, u.laundry = ?, u.parking = ?,
           u.amenity_detail = ?, u.access_information = ?, u.key_code = ?, u.wifi_information = ?, u.internal_note = ?,
           u.listing_url = ?,
           u.rent_price_min = ?, u.rent_price_max = ?, u.deposit_price = ?,
           u.charge_method = ?, u.fee = ?, u.photo = ?,
           u.active_status = ?
       WHERE u.id = ? AND p.org_id = ?`,
      [
        name || null, type || null, size ?? null, size_unit || null, beds ?? null, baths ?? null,
        smoking ?? null, laundry ?? null, parking ?? null,
        amenity_detail || null, access_information || null, key_code || null, wifi_information || null, internal_note || null,
        listing_url || null,
        rent_price_min ?? null, rent_price_max ?? null, deposit_price ?? null,
        charge_method ?? null, fee ?? null, photo || null,
        active_status != null ? Number(active_status) : 1,
        unit_id, orgId
      ]
    );

    // Update gallery if provided
    if (galleryFileIds !== undefined) {
      await req.pool.execute('DELETE FROM object_gallery WHERE object_id = ?', [unit_id]);
      if (galleryFileIds && galleryFileIds.length > 0) {
        const galleryValues = galleryFileIds.map(() => '(?, ?, ?)').join(',');
        const galleryParams = galleryFileIds.flatMap((fid, idx) => [unit_id, fid, idx]);
        await req.pool.execute(
          `INSERT INTO object_gallery (object_id, file_id, \`order\`) VALUES ${galleryValues}`,
          galleryParams
        );
      }
    }

    await logActivity(req, 'UPDATE', 'unit', unit_id, 'Updated unit ' + unit_id);
    res.json({ code: 200, message: 'Unit updated' });
  } catch (error) {
    console.error('Update unit error:', error);
    res.status(500).json({ code: 500, message: 'Failed to update unit' });
  }
});

// DELETE /api/property/unit/:unit_id - Delete unit
router.delete('/unit/:unit_id', authenticate, async (req, res) => {
  try {
    const { unit_id } = req.params;
    const orgId = req.user.orgId;
    await req.pool.execute(
      'UPDATE unit u LEFT JOIN property p ON u.property_id = p.id SET u.active_status = 0, u.deleted_at = NOW() WHERE u.id = ? AND p.org_id = ?',
      [unit_id, orgId]
    );
    await logActivity(req, 'DELETE', 'unit', unit_id, 'Deleted unit ' + unit_id);
    res.json({ code: 200, message: 'Unit deleted' });
  } catch (error) {
    console.error('Delete unit error:', error);
    res.status(500).json({ code: 500, message: 'Failed to delete unit' });
  }
});

// Unit Inventory routes
// GET /api/property/unit/:unit_id/inventory - List inventory
router.get('/unit/:unit_id/inventory', authenticate, async (req, res) => {
  try {
    const { unit_id } = req.params;
    const { search } = req.query;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    let whereClause = 'unit_id = ? AND active_status = 1';
    const params = [unit_id];

    if (search) {
      whereClause += ' AND name LIKE ?';
      params.push('%' + search + '%');
    }

    const [inventory] = await req.pool.execute(
      'SELECT * FROM unit_inventory WHERE ' + whereClause + ' ORDER BY name LIMIT ' + limit + ' OFFSET ' + offset,
      params
    );
    const [[{ total }]] = await req.pool.execute(
      'SELECT COUNT(*) as total FROM unit_inventory WHERE ' + whereClause,
      params
    );
    res.json({ code: 200, data: { content: inventory, totalElements: total } });
  } catch (error) {
    console.error('List inventory error:', error);
    res.status(500).json({ code: 500, message: 'Failed to list inventory' });
  }
});

// POST /api/property/unit/:unit_id/inventory - Create inventory item
router.post('/unit/:unit_id/inventory', authenticate, async (req, res) => {
  try {
    const { unit_id } = req.params;
    const orgId = req.user.orgId;
    const { name, description, quantity, condition_status, value, purchase_date } = req.body;

    const [result] = await req.pool.execute(
      'INSERT INTO unit_inventory (org_id, unit_id, name, description, quantity, condition_status, value, purchase_date, active_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, NOW())',
      [orgId, unit_id, name, description, quantity || 1, condition_status, value, purchase_date]
    );
    res.json({ code: 200, message: 'Inventory created', data: { id: result.insertId } });
  } catch (error) {
    console.error('Create inventory error:', error);
    res.status(500).json({ code: 500, message: 'Failed to create inventory' });
  }
});

// GET /api/property/unit/inventory/:id - Get inventory detail
router.get('/unit/inventory/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const [items] = await req.pool.execute('SELECT * FROM unit_inventory WHERE id = ?', [id]);
    if (items.length === 0) {
      return res.status(404).json({ code: 404, message: 'Inventory item not found' });
    }
    res.json({ code: 200, data: items[0] });
  } catch (error) {
    console.error('Get inventory error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get inventory' });
  }
});

// PUT /api/property/unit/inventory/:id - Update inventory item
router.put('/unit/inventory/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, quantity, condition_status, value, purchase_date } = req.body;

    await req.pool.execute(
      'UPDATE unit_inventory SET name = ?, description = ?, quantity = ?, condition_status = ?, value = ?, purchase_date = ?, updated_at = NOW() WHERE id = ?',
      [name, description, quantity, condition_status, value, purchase_date, id]
    );
    res.json({ code: 200, message: 'Inventory updated' });
  } catch (error) {
    console.error('Update inventory error:', error);
    res.status(500).json({ code: 500, message: 'Failed to update inventory' });
  }
});

// DELETE /api/property/unit/inventory/:id - Delete inventory item
router.delete('/unit/inventory/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    await req.pool.execute('UPDATE unit_inventory SET active_status = 0 WHERE id = ?', [id]);
    res.json({ code: 200, message: 'Inventory deleted' });
  } catch (error) {
    console.error('Delete inventory error:', error);
    res.status(500).json({ code: 500, message: 'Failed to delete inventory' });
  }
});

// GET /api/property/amenities/list - Get all org property amenities for create form
// ?type=1 (Residential) or ?type=2 (Commercial) — defaults to 1
router.get('/amenities/list', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const propertyType = parseInt(req.query.type) || 1;
    const category = parseInt(req.query.category) || 0;
    const [amenities] = await req.pool.execute(
      'SELECT id, display_name, category, type FROM amenity WHERE org_id = ? AND enabled = 1 AND category = ? AND type = ? ORDER BY order_id, display_name',
      [orgId, category, propertyType]
    );
    res.json({ code: 200, data: amenities });
  } catch (error) {
    console.error('Get org amenities error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get amenities' });
  }
});

// GET /api/property/:id/base - Get property base info
router.get('/:id/base', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;
    const [properties] = await req.pool.execute(
      'SELECT id, display_name, street_address, city, state, country, zip_code, type FROM property WHERE id = ? AND org_id = ? AND status = 1',
      [id, orgId]
    );
    if (properties.length === 0) {
      return res.status(404).json({ code: 404, message: 'Property not found' });
    }
    res.json({ code: 200, data: properties[0] });
  } catch (error) {
    console.error('Get property base error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get property' });
  }
});

// GET /api/property/:id/clone - Clone property
router.get('/:id/clone', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;
    const [properties] = await req.pool.execute(
      'SELECT * FROM property WHERE id = ? AND org_id = ? AND status = 1',
      [id, orgId]
    );
    if (properties.length === 0) {
      return res.status(404).json({ code: 404, message: 'Property not found' });
    }
    const original = properties[0];
    const [result] = await req.pool.execute(
      'INSERT INTO property (org_id, display_name, street_address, city, state, country, zip_code, type, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, NOW())',
      [orgId, original.display_name + ' (Copy)', original.street_address, original.city, original.state, original.country, original.zip_code, original.type]
    );
    res.json({ code: 200, message: 'Property cloned', data: { id: result.insertId } });
  } catch (error) {
    console.error('Clone property error:', error);
    res.status(500).json({ code: 500, message: 'Failed to clone property' });
  }
});

// GET /api/property/:id/amenities - Get all org property amenities with selected flag
// Filters by the property's own type (Residential=1 / Commercial=2) to avoid duplicates
router.get('/:id/amenities', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;
    const [amenities] = await req.pool.execute(
      `SELECT a.id, a.display_name, a.category, a.type,
              CASE WHEN pa.property_id IS NOT NULL THEN 1 ELSE 0 END AS selected
       FROM amenity a
       JOIN property p ON p.id = ? AND p.org_id = ?
       LEFT JOIN property_amenity pa ON pa.amenity_id = a.id AND pa.property_id = ?
       WHERE a.org_id = ? AND a.enabled = 1 AND a.category = 0 AND a.type = p.type
       ORDER BY a.order_id, a.display_name`,
      [id, orgId, id, orgId]
    );
    res.json({ code: 200, data: amenities });
  } catch (error) {
    console.error('Get property amenities error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get property amenities' });
  }
});

// PUT /api/property/:id/amenities - Update property amenities
router.put('/:id/amenities', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { amenityIds } = req.body;
    await req.pool.execute('DELETE FROM property_amenity WHERE property_id = ?', [id]);
    if (amenityIds && amenityIds.length > 0) {
      await req.pool.execute(
        `INSERT INTO property_amenity (property_id, amenity_id) VALUES ${amenityIds.map(() => '(?, ?)').join(',')}`,
        amenityIds.flatMap(aid => [id, aid])
      );
    }
    res.json({ code: 200, message: 'Property amenities updated' });
  } catch (error) {
    console.error('Update property amenities error:', error);
    res.status(500).json({ code: 500, message: 'Failed to update property amenities' });
  }
});

// GET /api/property/:id - Get property detail
router.get('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;
    const [properties] = await req.pool.execute(
      `SELECT p.*, (SELECT COUNT(*) FROM unit u WHERE u.property_id = p.id AND u.active_status = 1) as total_units, (SELECT COUNT(*) FROM unit u WHERE u.property_id = p.id AND u.active_status = 1 AND EXISTS (
        SELECT 1 FROM leasing l WHERE l.unit_id = u.id AND l.deleted_at IS NULL
          AND l.start_date <= CURDATE() AND (l.end_date >= CURDATE() OR l.end_date IS NULL)
      )) as occupied_units FROM property p WHERE p.id = ? AND p.org_id = ?`,
      [id, orgId]
    );
    if (properties.length === 0) {
      return res.status(404).json({ code: 404, message: 'Property not found' });
    }
    // Attach selected amenity IDs and gallery
    const [amenityRows] = await req.pool.execute(
      'SELECT amenity_id FROM property_amenity WHERE property_id = ?', [id]
    );
    const [galleryRows] = await req.pool.execute(
      'SELECT file_id, `order` FROM object_gallery WHERE object_id = ? ORDER BY `order`', [id]
    );
    const data = { ...properties[0], amenity_ids: amenityRows.map(r => r.amenity_id), gallery: galleryRows };
    res.json({ code: 200, data });
  } catch (error) {
    console.error('Get property error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get property' });
  }
});

// POST /api/property - Create property
router.post('/', authenticate, async (req, res) => {
  try {
    const { display_name, street_address, city, state, country, zip_code, district,
            type, status, currency, year_of_built, notes, payment_instructions, amenityIds,
            photo, galleryFileIds, listing_url } = req.body;
    const orgId = req.user.orgId;

    const propertyId = (BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000))).toString();

    await req.pool.execute(
      `INSERT INTO property (id, org_id, display_name, street_address, city, state, country,
       zip_code, district, type, status, currency, year_of_built, notes, payment_instructions, photo, listing_url, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [propertyId, orgId, display_name || null, street_address || null, city || null, state || null, country || null, zip_code || null,
       district || null, type || 1, status ?? 1, currency || null,
       year_of_built || null, notes || null, payment_instructions || null, photo || null, listing_url || null]
    );

    // Save amenities if provided
    if (amenityIds && amenityIds.length > 0) {
      await req.pool.execute(
        `INSERT INTO property_amenity (property_id, amenity_id) VALUES ${amenityIds.map(() => '(?, ?)').join(',')}`,
        amenityIds.flatMap(aid => [propertyId, aid])
      );
    }

    // Save gallery images if provided
    if (galleryFileIds && galleryFileIds.length > 0) {
      const galleryValues = galleryFileIds.map((fid, idx) => '(?, ?, ?)').join(',');
      const galleryParams = galleryFileIds.flatMap((fid, idx) => [propertyId, fid, idx]);
      await req.pool.execute(
        `INSERT INTO object_gallery (object_id, file_id, \`order\`) VALUES ${galleryValues}`,
        galleryParams
      );
    }

    await logActivity(req, 'CREATE', 'property', propertyId, 'Created property ' + (display_name || propertyId));
    res.json({ code: 200, message: 'Property created', data: { id: propertyId } });
  } catch (error) {
    console.error('Create property error:', error.message, error.sql || '');
    res.status(500).json({ code: 500, message: 'Failed to create property: ' + error.message });
  }
});

// PUT /api/property/:id - Update property
router.put('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { display_name, street_address, city, state, country, zip_code, district,
            type, status, currency, year_of_built, mls, notes, payment_instructions, amenityIds,
            photo, galleryFileIds, listing_url } = req.body;
    const orgId = req.user.orgId;

    // Block deactivation if there are active or upcoming leases on any unit of this property
    if (status != null && Number(status) === 0) {
      const [[existing]] = await req.pool.execute(
        'SELECT status FROM property WHERE id = ? AND org_id = ?',
        [id, orgId]
      );
      if (existing && Number(existing.status) === 1) {
        const [[leaseCheck]] = await req.pool.execute(
          `SELECT COUNT(*) AS cnt FROM leasing l
           JOIN unit u ON l.unit_id = u.id
           WHERE u.property_id = ? AND l.deleted_at IS NULL
             AND (l.end_date IS NULL OR l.end_date >= CURDATE())`,
          [id]
        );
        if (leaseCheck && Number(leaseCheck.cnt) > 0) {
          return res.status(400).json({ code: 400, message: 'Cannot deactivate: property has units with active or upcoming leases' });
        }
      }
    }

    await req.pool.execute(
      `UPDATE property SET display_name = ?, street_address = ?, city = ?, state = ?,
       country = ?, zip_code = ?, district = ?, type = ?, status = ?, currency = ?,
       year_of_built = ?, mls = ?, notes = ?, payment_instructions = ?, photo = ?,
       listing_url = ?, updated_at = NOW()
       WHERE id = ? AND org_id = ?`,
      [display_name || null, street_address || null, city || null, state || null,
       country || null, zip_code || null, district || null, type ?? 1, status ?? 1,
       currency || null, year_of_built || null, mls || null, notes || null,
       payment_instructions || null, photo || null,
       listing_url || null, id, orgId]
    );

    // Update amenities if provided
    if (amenityIds !== undefined) {
      await req.pool.execute('DELETE FROM property_amenity WHERE property_id = ?', [id]);
      if (amenityIds && amenityIds.length > 0) {
        await req.pool.execute(
          `INSERT INTO property_amenity (property_id, amenity_id) VALUES ${amenityIds.map(() => '(?, ?)').join(',')}`,
          amenityIds.flatMap(aid => [id, aid])
        );
      }
    }

    // Update gallery if provided
    if (galleryFileIds !== undefined) {
      await req.pool.execute('DELETE FROM object_gallery WHERE object_id = ?', [id]);
      if (galleryFileIds && galleryFileIds.length > 0) {
        const galleryValues = galleryFileIds.map(() => '(?, ?, ?)').join(',');
        const galleryParams = galleryFileIds.flatMap((fid, idx) => [id, fid, idx]);
        await req.pool.execute(
          `INSERT INTO object_gallery (object_id, file_id, \`order\`) VALUES ${galleryValues}`,
          galleryParams
        );
      }
    }

    await logActivity(req, 'UPDATE', 'property', id, 'Updated property ' + (display_name || id));
    res.json({ code: 200, message: 'Property updated' });
  } catch (error) {
    console.error('Update property error:', error);
    res.status(500).json({ code: 500, message: 'Failed to update property' });
  }
});

// DELETE /api/property/:id - Delete property (blocked if active lease exists)
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;

    // Block deletion if any unit in this property has an active lease
    const [[{ active_count }]] = await req.pool.execute(
      `SELECT COUNT(*) as active_count FROM leasing l
       JOIN unit u ON l.unit_id = u.id
       WHERE u.property_id = ? AND l.deleted_at IS NULL
         AND l.start_date <= CURDATE() AND (l.end_date >= CURDATE() OR l.end_date IS NULL)`,
      [id]
    );
    if (active_count > 0) {
      return res.status(409).json({
        code: 409,
        message: 'Unable to delete as there is an active lease on the property'
      });
    }

    await req.pool.execute(
      'UPDATE property SET status = 0, deleted_at = NOW() WHERE id = ? AND org_id = ?',
      [id, orgId]
    );
    await logActivity(req, 'DELETE', 'property', id, 'Deleted property ' + id);
    res.json({ code: 200, message: 'Property deleted' });
  } catch (error) {
    console.error('Delete property error:', error);
    res.status(500).json({ code: 500, message: 'Failed to delete property' });
  }
});

// GET /api/property/:property_id/unit - List units for property (with current tenant)
router.get('/:property_id/unit', authenticate, async (req, res) => {
  try {
    const { property_id } = req.params;
    const orgId = req.user.orgId;
    const [units] = await req.pool.execute(
      `SELECT u.*,
              lt.tenant_id,
              lt.tenant_first_name,
              lt.tenant_last_name,
              lt.lease_start_date,
              lt.lease_end_date,
              lt.lease_amount
       FROM unit u
       JOIN property p ON u.property_id = p.id
       LEFT JOIN (
         SELECT l.unit_id,
                t.id AS tenant_id,
                t.first_name AS tenant_first_name,
                t.last_name AS tenant_last_name,
                l.start_date AS lease_start_date,
                l.end_date AS lease_end_date,
                l.amount AS lease_amount,
                ROW_NUMBER() OVER (PARTITION BY l.unit_id ORDER BY l.start_date DESC) AS rn
         FROM leasing l
         JOIN tenant t ON l.tenant_id = t.id
         WHERE l.deleted_at IS NULL
           AND l.start_date <= CURDATE() AND (l.end_date >= CURDATE() OR l.end_date IS NULL)
       ) lt ON lt.unit_id = u.id AND lt.rn = 1
       WHERE u.property_id = ? AND p.org_id = ?
       ORDER BY u.active_status DESC, u.name`,
      [property_id, orgId]
    );
    res.json({ code: 200, data: units });
  } catch (error) {
    console.error('List units error:', error);
    res.status(500).json({ code: 500, message: 'Failed to list units' });
  }
});

// POST /api/property/:property_id/unit - Create unit
router.post('/:property_id/unit', authenticate, async (req, res) => {
  try {
    const { property_id } = req.params;
    const {
      name, type, amenity_type, beds, baths, size, size_unit, parking,
      smoking, laundry, amenity_detail, access_information, key_code,
      wifi_information, internal_note,
      rent_price_min, rent_price_max, deposit_price, owner_id,
      charge_method, fee, amenityIds, photo, galleryFileIds,
      listing_url,
    } = req.body;
    const orgId = req.user.orgId;

    // Verify property belongs to org
    const [props] = await req.pool.execute('SELECT id FROM property WHERE id = ? AND org_id = ?', [property_id, orgId]);
    if (props.length === 0) {
      return res.status(404).json({ code: 404, message: 'Property not found' });
    }

    const unitId = (BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000))).toString();

    await req.pool.execute(
      `INSERT INTO unit (id, property_id, name, type, amenity_type, beds, baths, size, size_unit,
       parking, smoking, laundry, amenity_detail, access_information, key_code,
       wifi_information, internal_note, listing_url,
       rent_price_min, rent_price_max, deposit_price, owner_id,
       charge_method, fee, photo, status, active_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1)`,
      [unitId, property_id, name || null, type || null, amenity_type ?? 1,
       beds ?? null, baths ?? null, size ?? null, size_unit || 'sqft',
       parking ?? null, smoking ? 1 : 0, laundry ? 1 : 0,
       amenity_detail || null, access_information || null, key_code || null,
       wifi_information || null, internal_note || null, listing_url || null,
       rent_price_min ?? null, rent_price_max ?? null, deposit_price ?? null,
       owner_id || null, charge_method || null, fee ?? null, photo || null]
    );

    // Save unit amenities if provided
    if (amenityIds && amenityIds.length > 0) {
      await req.pool.execute(
        `INSERT INTO unit_amenity (unit_id, amenity_id) VALUES ${amenityIds.map(() => '(?, ?)').join(',')}`,
        amenityIds.flatMap(aid => [unitId, aid])
      );
    }

    // Save gallery images if provided
    if (galleryFileIds && galleryFileIds.length > 0) {
      const galleryValues = galleryFileIds.map(() => '(?, ?, ?)').join(',');
      const galleryParams = galleryFileIds.flatMap((fid, idx) => [unitId, fid, idx]);
      await req.pool.execute(
        `INSERT INTO object_gallery (object_id, file_id, \`order\`) VALUES ${galleryValues}`,
        galleryParams
      );
    }

    await logActivity(req, 'CREATE', 'unit', unitId, 'Created unit ' + (name || unitId));
    res.json({ code: 200, message: 'Unit created', data: { id: unitId } });
  } catch (error) {
    console.error('Create unit error:', error);
    res.status(500).json({ code: 500, message: 'Failed to create unit' });
  }
});

// ─── MAINTENANCE ROUTES ───────────────────────────────────────────────────────

// GET /api/property/unit/:id/maintenance/sum - Sum maintenance costs for a unit
router.get('/unit/:id/maintenance/sum', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;
    const [[sum]] = await req.pool.execute(
      'SELECT COALESCE(SUM(cost), 0) as total, COUNT(*) as count FROM unit_maintenance WHERE unit_id = ? AND org_id = ? AND status = 1',
      [id, orgId]
    );
    res.json({ code: 200, data: sum });
  } catch (error) {
    console.error('Maintenance sum error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get maintenance sum' });
  }
});

// GET /api/property/unit/maintenance/:id/detail - Get single maintenance record
router.get('/unit/maintenance/:id/detail', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;
    const [rows] = await req.pool.execute(
      'SELECT * FROM unit_maintenance WHERE id = ? AND org_id = ?',
      [id, orgId]
    );
    if (rows.length === 0) return res.status(404).json({ code: 404, message: 'Record not found' });
    res.json({ code: 200, data: rows[0] });
  } catch (error) {
    console.error('Maintenance detail error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get maintenance record' });
  }
});

// PUT /api/property/unit/maintenance/:id - Update maintenance record
router.put('/unit/maintenance/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;
    const { title, description, cost, category, vendor_name, maintenance_date } = req.body;
    await req.pool.execute(
      'UPDATE unit_maintenance SET title = ?, description = ?, cost = ?, category = ?, vendor_name = ?, maintenance_date = ?, updated_at = NOW() WHERE id = ? AND org_id = ?',
      [title, description, cost, category, vendor_name, maintenance_date, id, orgId]
    );
    res.json({ code: 200, message: 'Maintenance record updated' });
  } catch (error) {
    console.error('Update maintenance error:', error);
    res.status(500).json({ code: 500, message: 'Failed to update maintenance record' });
  }
});

// DELETE /api/property/unit/maintenance/:id - Soft-delete maintenance record
router.delete('/unit/maintenance/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;
    await req.pool.execute('UPDATE unit_maintenance SET status = 0 WHERE id = ? AND org_id = ?', [id, orgId]);
    res.json({ code: 200, message: 'Maintenance record deleted' });
  } catch (error) {
    console.error('Delete maintenance error:', error);
    res.status(500).json({ code: 500, message: 'Failed to delete maintenance record' });
  }
});

// GET /api/property/unit/:id/maintenance - List maintenance records for a unit
router.get('/unit/:id/maintenance', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;
    const [rows] = await req.pool.execute(
      'SELECT * FROM unit_maintenance WHERE unit_id = ? AND org_id = ? AND status = 1 ORDER BY maintenance_date DESC, created_at DESC',
      [id, orgId]
    );
    res.json({ code: 200, data: rows });
  } catch (error) {
    console.error('List maintenance error:', error);
    res.status(500).json({ code: 500, message: 'Failed to list maintenance records' });
  }
});

// POST /api/property/unit/:id/maintenance - Create maintenance record
router.post('/unit/:id/maintenance', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;
    const { title, description, cost, category, vendor_name, maintenance_date } = req.body;
    const [result] = await req.pool.execute(
      'INSERT INTO unit_maintenance (org_id, unit_id, title, description, cost, category, vendor_name, maintenance_date, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, NOW())',
      [orgId, id, title, description || null, cost || 0, category || 'GENERAL', vendor_name || null, maintenance_date || null]
    );
    res.json({ code: 200, message: 'Maintenance record created', data: { id: result.insertId } });
  } catch (error) {
    console.error('Create maintenance error:', error);
    res.status(500).json({ code: 500, message: 'Failed to create maintenance record' });
  }
});

// ─── INVENTORY HISTORY ROUTES ─────────────────────────────────────────────────

// GET /api/property/unit/:id/inventory/sum - Get total inventory value for a unit
router.get('/unit/:id/inventory/sum', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;
    const [[sum]] = await req.pool.execute(
      'SELECT COALESCE(SUM(CASE WHEN value IS NOT NULL THEN value * COALESCE(quantity, 1) ELSE 0 END), 0) as total, COUNT(*) as count FROM unit_inventory WHERE unit_id = ? AND org_id = ? AND active_status = 1',
      [id, orgId]
    );
    res.json({ code: 200, data: sum });
  } catch (error) {
    console.error('Inventory sum error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get inventory sum' });
  }
});

// POST /api/property/unit/:id/inventory/history - List inventory history
router.post('/unit/:id/inventory/history', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;
    const { action } = req.body || {};
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    let whereClause = 'h.unit_id = ? AND h.org_id = ?';
    const params = [id, orgId];
    if (action) { whereClause += ' AND h.action = ?'; params.push(action); }

    const [rows] = await req.pool.execute(
      `SELECT h.*, inv.name as item_name FROM unit_inventory_history h
       LEFT JOIN unit_inventory inv ON h.inventory_id = inv.id
       WHERE ` + whereClause + ` ORDER BY h.created_at DESC LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    const [[{ total }]] = await req.pool.execute(
      'SELECT COUNT(*) as total FROM unit_inventory_history h WHERE ' + whereClause,
      params
    );

    res.json({ code: 200, data: { content: rows, totalElements: total } });
  } catch (error) {
    console.error('Inventory history error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get inventory history' });
  }
});

// GET /api/property/unit/:unit_id/amenities - Get unit amenities with details
router.get('/unit/:unit_id/amenities', authenticate, async (req, res) => {
  try {
    const unitId = req.params.unit_id;
    // Get all amenities for the org, mark which ones this unit has
    const orgId = req.user.orgId;
    // Get unit's amenity_type to filter amenities
    const [unitRows] = await req.pool.execute(
      'SELECT u.amenity_type FROM unit u JOIN property p ON u.property_id = p.id WHERE u.id = ? AND p.org_id = ?',
      [unitId, orgId]
    );
    const amenityType = unitRows.length > 0 ? unitRows[0].amenity_type : 1;
    const [amenities] = await req.pool.execute(
      `SELECT a.id, a.display_name, a.category, a.type,
              CASE WHEN ua.unit_id IS NOT NULL THEN 1 ELSE 0 END AS selected
       FROM amenity a
       LEFT JOIN unit_amenity ua ON ua.amenity_id = a.id AND ua.unit_id = ?
       WHERE a.org_id = ? AND a.enabled = 1 AND a.category = 1 AND a.type = ?
       ORDER BY a.order_id, a.display_name`,
      [unitId, orgId, amenityType]
    );
    res.json({ code: 200, data: amenities });
  } catch (error) {
    console.error('Get unit amenities error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get unit amenities' });
  }
});

// PUT /api/property/unit/:unit_id/amenities - Update unit amenities
router.put('/unit/:unit_id/amenities', authenticate, async (req, res) => {
  try {
    const unitId = req.params.unit_id;
    const { amenityIds } = req.body; // array of amenity IDs
    // Clear existing
    await req.pool.execute('DELETE FROM unit_amenity WHERE unit_id = ?', [unitId]);
    // Insert new
    if (amenityIds && amenityIds.length > 0) {
      await req.pool.execute(
        `INSERT INTO unit_amenity (unit_id, amenity_id) VALUES ${amenityIds.map(() => '(?, ?)').join(',')}`,
        amenityIds.flatMap(aid => [unitId, aid])
      );
    }
    res.json({ code: 200, message: 'Amenities updated' });
  } catch (error) {
    console.error('Update unit amenities error:', error);
    res.status(500).json({ code: 500, message: 'Failed to update amenities' });
  }
});

// GET /api/property/unit/:unit_id/furnishing - List unit furnishings
router.get('/unit/:unit_id/furnishing', authenticate, async (req, res) => {
  try {
    const unitId = req.params.unit_id;
    const search = req.query.search;
    let whereClause = 'unit_id = ? AND deleted_at IS NULL';
    const params = [unitId];
    if (search) {
      whereClause += ' AND item_name LIKE ?';
      params.push('%' + search + '%');
    }
    const [items] = await req.pool.execute(
      `SELECT * FROM unit_furnishing WHERE ${whereClause} ORDER BY item_name`,
      params
    );
    // Sum
    const [[{ total_sum }]] = await req.pool.execute(
      'SELECT COALESCE(SUM(item_price * quantity), 0) as total_sum FROM unit_furnishing WHERE unit_id = ? AND deleted_at IS NULL',
      [unitId]
    );
    res.json({ code: 200, data: { items, totalSum: total_sum } });
  } catch (error) {
    console.error('List furnishing error:', error);
    res.status(500).json({ code: 500, message: 'Failed to list furnishings' });
  }
});

// POST /api/property/unit/:unit_id/furnishing - Create furnishing item
router.post('/unit/:unit_id/furnishing', authenticate, async (req, res) => {
  try {
    const unitId = req.params.unit_id;
    const { item_name, quantity, item_price, note, currency_id } = req.body;
    const id = BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000));
    await req.pool.execute(
      'INSERT INTO unit_furnishing (id, unit_id, item_name, quantity, item_price, note, currency_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())',
      [id.toString(), unitId, item_name, quantity || 1, item_price || 0, note || null, currency_id || null]
    );
    res.json({ code: 200, message: 'Furnishing added', data: { id: id.toString() } });
  } catch (error) {
    console.error('Create furnishing error:', error);
    res.status(500).json({ code: 500, message: 'Failed to create furnishing' });
  }
});

// PUT /api/property/unit/furnishing/:id - Update furnishing item
router.put('/unit/furnishing/:id', authenticate, async (req, res) => {
  try {
    const { item_name, quantity, item_price, note } = req.body;
    await req.pool.execute(
      'UPDATE unit_furnishing SET item_name = ?, quantity = ?, item_price = ?, note = ?, updated_at = NOW() WHERE id = ?',
      [item_name, quantity || 1, item_price || 0, note || null, req.params.id]
    );
    res.json({ code: 200, message: 'Furnishing updated' });
  } catch (error) {
    console.error('Update furnishing error:', error);
    res.status(500).json({ code: 500, message: 'Failed to update furnishing' });
  }
});

// DELETE /api/property/unit/furnishing/:id - Soft-delete furnishing item
router.delete('/unit/furnishing/:id', authenticate, async (req, res) => {
  try {
    await req.pool.execute('UPDATE unit_furnishing SET deleted_at = NOW() WHERE id = ?', [req.params.id]);
    res.json({ code: 200, message: 'Furnishing deleted' });
  } catch (error) {
    console.error('Delete furnishing error:', error);
    res.status(500).json({ code: 500, message: 'Failed to delete furnishing' });
  }
});

// GET /api/property/unit/:unit_id/current-lease - Get current active lease for unit
router.get('/unit/:unit_id/current-lease', authenticate, async (req, res) => {
  try {
    const unitId = req.params.unit_id;
    const [leases] = await req.pool.execute(
      `SELECT l.*, t.first_name, t.last_name, t.email, t.phone,
              p.currency AS currency_code
       FROM leasing l
       LEFT JOIN tenant t ON l.tenant_id = t.id
       LEFT JOIN unit u ON l.unit_id = u.id
       LEFT JOIN property p ON u.property_id = p.id
       WHERE l.unit_id = ? AND l.deleted_at IS NULL
         AND l.start_date <= CURDATE() AND (l.end_date >= CURDATE() OR l.end_date IS NULL)
       ORDER BY l.start_date DESC LIMIT 1`,
      [unitId]
    );
    // Also get next lease (future start_date)
    const [nextLeases] = await req.pool.execute(
      `SELECT l.*, t.first_name, t.last_name
       FROM leasing l
       LEFT JOIN tenant t ON l.tenant_id = t.id
       WHERE l.unit_id = ? AND l.deleted_at IS NULL AND l.start_date > CURDATE()
       ORDER BY l.start_date ASC LIMIT 1`,
      [unitId]
    );
    res.json({ code: 200, data: { current: leases[0] || null, next: nextLeases[0] || null } });
  } catch (error) {
    console.error('Get current lease error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get lease' });
  }
});

// GET /api/property/unit/:unit_id/services - List service requests for unit
router.get('/unit/:unit_id/services', authenticate, async (req, res) => {
  try {
    const unitId = req.params.unit_id;
    const status = req.query.status; // 0=pending, 1=in-progress, 2=completed
    let whereClause = 's.unit_id = ? AND s.deleted_at IS NULL';
    const params = [unitId];
    if (status !== undefined && status !== '') {
      whereClause += ' AND s.status = ?';
      params.push(status);
    }
    const [services] = await req.pool.execute(
      `SELECT s.*, t.first_name AS tenant_first, t.last_name AS tenant_last, t.phone AS tenant_phone
       FROM service s
       LEFT JOIN leasing l ON l.unit_id = s.unit_id AND l.deleted_at IS NULL
         AND l.start_date <= CURDATE() AND (l.end_date >= CURDATE() OR l.end_date IS NULL)
       LEFT JOIN tenant t ON l.tenant_id = t.id
       WHERE ${whereClause}
       ORDER BY s.created_at DESC`,
      params
    );
    res.json({ code: 200, data: services });
  } catch (error) {
    console.error('Get unit services error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get service history' });
  }
});

// POST /api/property/unit/:unit_id/service-costs - Get accounting entries for unit
router.post('/unit/:unit_id/service-costs', authenticate, async (req, res) => {
  try {
    const unitId = req.params.unit_id;
    const orgId = req.user.orgId;
    const { search, startDate, endDate, period } = req.body || {};
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    let whereClause = 'al.unit_id = ? AND a.org_id = ? AND a.deleted_at IS NULL';
    const params = [unitId, orgId];

    if (search) {
      whereClause += ' AND (a.note LIKE ? OR al.description LIKE ?)';
      params.push('%' + search + '%', '%' + search + '%');
    }
    if (startDate) {
      whereClause += ' AND a.payment_date >= ?';
      params.push(startDate);
    }
    if (endDate) {
      whereClause += ' AND a.payment_date <= ?';
      params.push(endDate);
    }

    const [rows] = await req.pool.execute(
      `SELECT a.id, a.payment_date, a.note, a.type,
              al.amount AS line_amount, a.type AS line_type,
              al.invoice_code,
              t.first_name AS tenant_first, t.last_name AS tenant_last,
              p.display_name AS property_name, u.name AS unit_name,
              acc.name AS account_name, cat.name AS category_name
       FROM accounting_line al
       JOIN accounting a ON a.id = al.accounting_id
       LEFT JOIN tenant t ON a.tenant_id = t.id
       LEFT JOIN unit u ON al.unit_id = u.id
       LEFT JOIN property p ON al.property_id = p.id
       LEFT JOIN account_setting acc ON a.account_setting_id = acc.id
       LEFT JOIN category_setting cat ON al.category = cat.id
       WHERE ${whereClause}
       ORDER BY a.payment_date DESC
       LIMIT ${limit} OFFSET ${offset}`,
      params
    );

    const [[{ total }]] = await req.pool.execute(
      `SELECT COUNT(*) as total FROM accounting_line al JOIN accounting a ON a.id = al.accounting_id WHERE ${whereClause}`,
      params
    );

    // Inflow/outflow summary — type is on accounting table (0=outflow, 1=inflow)
    const [[summary]] = await req.pool.execute(
      `SELECT
        COALESCE(SUM(CASE WHEN a.type = 1 THEN al.amount ELSE 0 END), 0) AS inflow,
        COALESCE(SUM(CASE WHEN a.type = 0 THEN al.amount ELSE 0 END), 0) AS outflow
       FROM accounting_line al
       JOIN accounting a ON a.id = al.accounting_id
       WHERE al.unit_id = ? AND a.org_id = ? AND a.deleted_at IS NULL`,
      [unitId, orgId]
    );

    res.json({
      code: 200,
      data: {
        content: rows,
        totalElements: total,
        inflow: summary.inflow,
        outflow: summary.outflow,
        balance: summary.inflow - summary.outflow,
      },
    });
  } catch (error) {
    console.error('Get service costs error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get service costs' });
  }
});

// GET /api/property/unit/:unit_id/property-info - Get parent property info for unit
router.get('/unit/:unit_id/property-info', authenticate, async (req, res) => {
  try {
    const unitId = req.params.unit_id;
    const [[propInfo]] = await req.pool.execute(
      `SELECT p.id, p.display_name, p.street_address, p.city, p.state, p.zip_code, p.country,
              p.year_of_built, p.district, p.currency
       FROM property p
       JOIN unit u ON u.property_id = p.id
       WHERE u.id = ?`,
      [unitId]
    );
    res.json({ code: 200, data: propInfo || null });
  } catch (error) {
    console.error('Get property info error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get property info' });
  }
});

module.exports = router;
