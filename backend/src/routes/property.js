const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const pool = require('../config/database');

// POST /api/property/list - List properties with paging
router.post('/list', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { search, status } = req.body || {};
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    let whereClause = 'org_id = ? AND status = 1';
    const params = [orgId];

    if (search) {
      whereClause += ' AND (display_name LIKE ? OR street_address LIKE ?)';
      params.push('%' + search + '%', '%' + search + '%');
    }
    if (status !== undefined && status !== null) {
      whereClause += ' AND status = ?';
      params.push(status);
    }

    const [properties] = await pool.execute(
      'SELECT p.*, (SELECT COUNT(*) FROM unit u WHERE u.property_id = p.id AND u.active_status = 1) as total_units, (SELECT COUNT(*) FROM unit u WHERE u.property_id = p.id AND u.active_status = 1 AND u.status = 1) as occupied_units FROM property p WHERE ' + whereClause + ' ORDER BY p.display_name LIMIT ' + limit + ' OFFSET ' + offset,
      params
    );

    const [[{ total }]] = await pool.execute(
      'SELECT COUNT(*) as total FROM property WHERE ' + whereClause,
      params
    );

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
    const [properties] = await pool.execute(
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
    const [properties] = await pool.execute(
      'SELECT id, display_name, street_address, city FROM property WHERE org_id = ? AND status = 1 ORDER BY display_name',
      [orgId]
    );

    for (const property of properties) {
      const [units] = await pool.execute(
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
    const [units] = await pool.execute(
      'SELECT u.*, p.display_name as property_name FROM unit u LEFT JOIN property p ON u.property_id = p.id WHERE p.org_id = ? AND u.active_status = 1 AND u.status = 0 ORDER BY p.display_name, u.name',
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
    const [result] = await pool.execute(
      'SELECT COUNT(*) as total, SUM(CASE WHEN u.status = 1 THEN 1 ELSE 0 END) as occupied FROM unit u LEFT JOIN property p ON u.property_id = p.id WHERE p.org_id = ? AND u.active_status = 1',
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
    const [units] = await pool.execute(
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
    const [units] = await pool.execute(
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
    const [units] = await pool.execute(
      'SELECT u.* FROM unit u LEFT JOIN property p ON u.property_id = p.id WHERE u.id = ? AND p.org_id = ?',
      [unit_id, orgId]
    );
    if (units.length === 0) {
      return res.status(404).json({ code: 404, message: 'Unit not found' });
    }
    const original = units[0];
    const [result] = await pool.execute(
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
    const [units] = await pool.execute(
      'SELECT u.*, p.display_name as property_name, p.street_address as property_address FROM unit u LEFT JOIN property p ON u.property_id = p.id WHERE u.id = ? AND p.org_id = ? AND u.active_status = 1',
      [unit_id, orgId]
    );
    if (units.length === 0) {
      return res.status(404).json({ code: 404, message: 'Unit not found' });
    }
    res.json({ code: 200, data: units[0] });
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
    const [units] = await pool.execute(
      `SELECT u.*, p.display_name as property_name
       FROM unit u
       LEFT JOIN property p ON u.property_id = p.id
       LEFT JOIN leasing l ON l.unit_id = u.id AND l.deleted_at IS NULL AND l.status = 1
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
    const { name, internal_note, rent_price_min, deposit_price, beds, baths, size } = req.body;
    const orgId = req.user.orgId;

    await pool.execute(
      'UPDATE unit u LEFT JOIN property p ON u.property_id = p.id SET u.name = ?, u.internal_note = ?, u.rent_price_min = ?, u.deposit_price = ?, u.beds = ?, u.baths = ?, u.size = ?, u.updated_at = NOW() WHERE u.id = ? AND p.org_id = ?',
      [name, internal_note, rent_price_min, deposit_price, beds, baths, size, unit_id, orgId]
    );
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
    await pool.execute(
      'UPDATE unit u LEFT JOIN property p ON u.property_id = p.id SET u.active_status = 0, u.deleted_at = NOW() WHERE u.id = ? AND p.org_id = ?',
      [unit_id, orgId]
    );
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

    const [inventory] = await pool.execute(
      'SELECT * FROM unit_inventory WHERE ' + whereClause + ' ORDER BY name LIMIT ' + limit + ' OFFSET ' + offset,
      params
    );
    const [[{ total }]] = await pool.execute(
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
    const { name, description, quantity, condition_status, value, purchase_date } = req.body;

    const [result] = await pool.execute(
      'INSERT INTO unit_inventory (unit_id, name, description, quantity, condition_status, value, purchase_date, active_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, NOW())',
      [unit_id, name, description, quantity || 1, condition_status, value, purchase_date]
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
    const [items] = await pool.execute('SELECT * FROM unit_inventory WHERE id = ?', [id]);
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

    await pool.execute(
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
    await pool.execute('UPDATE unit_inventory SET active_status = 0 WHERE id = ?', [id]);
    res.json({ code: 200, message: 'Inventory deleted' });
  } catch (error) {
    console.error('Delete inventory error:', error);
    res.status(500).json({ code: 500, message: 'Failed to delete inventory' });
  }
});

// GET /api/property/:id/base - Get property base info
router.get('/:id/base', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;
    const [properties] = await pool.execute(
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
    const [properties] = await pool.execute(
      'SELECT * FROM property WHERE id = ? AND org_id = ? AND status = 1',
      [id, orgId]
    );
    if (properties.length === 0) {
      return res.status(404).json({ code: 404, message: 'Property not found' });
    }
    const original = properties[0];
    const [result] = await pool.execute(
      'INSERT INTO property (org_id, display_name, street_address, city, state, country, zip_code, type, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, NOW())',
      [orgId, original.display_name + ' (Copy)', original.street_address, original.city, original.state, original.country, original.zip_code, original.type]
    );
    res.json({ code: 200, message: 'Property cloned', data: { id: result.insertId } });
  } catch (error) {
    console.error('Clone property error:', error);
    res.status(500).json({ code: 500, message: 'Failed to clone property' });
  }
});

// GET /api/property/:id - Get property detail
router.get('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;
    const [properties] = await pool.execute(
      'SELECT p.*, (SELECT COUNT(*) FROM unit u WHERE u.property_id = p.id AND u.active_status = 1) as total_units, (SELECT COUNT(*) FROM unit u WHERE u.property_id = p.id AND u.active_status = 1 AND u.status = 1) as occupied_units FROM property p WHERE p.id = ? AND p.org_id = ? AND p.status = 1',
      [id, orgId]
    );
    if (properties.length === 0) {
      return res.status(404).json({ code: 404, message: 'Property not found' });
    }
    res.json({ code: 200, data: properties[0] });
  } catch (error) {
    console.error('Get property error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get property' });
  }
});

// POST /api/property - Create property
router.post('/', authenticate, async (req, res) => {
  try {
    const { display_name, street_address, city, state, country, zip_code, type } = req.body;
    const orgId = req.user.orgId;

    const [result] = await pool.execute(
      'INSERT INTO property (org_id, display_name, street_address, city, state, country, zip_code, type, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, NOW())',
      [orgId, display_name, street_address, city, state, country, zip_code, type]
    );
    res.json({ code: 200, message: 'Property created', data: { id: result.insertId } });
  } catch (error) {
    console.error('Create property error:', error);
    res.status(500).json({ code: 500, message: 'Failed to create property' });
  }
});

// PUT /api/property/:id - Update property
router.put('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { display_name, street_address, city, state, country, zip_code, type, status } = req.body;
    const orgId = req.user.orgId;

    await pool.execute(
      'UPDATE property SET display_name = ?, street_address = ?, city = ?, state = ?, country = ?, zip_code = ?, type = ?, status = ?, updated_at = NOW() WHERE id = ? AND org_id = ?',
      [display_name, street_address, city, state, country, zip_code, type, status, id, orgId]
    );
    res.json({ code: 200, message: 'Property updated' });
  } catch (error) {
    console.error('Update property error:', error);
    res.status(500).json({ code: 500, message: 'Failed to update property' });
  }
});

// DELETE /api/property/:id - Delete property
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;
    await pool.execute(
      'UPDATE property SET status = 0, deleted_at = NOW() WHERE id = ? AND org_id = ?',
      [id, orgId]
    );
    res.json({ code: 200, message: 'Property deleted' });
  } catch (error) {
    console.error('Delete property error:', error);
    res.status(500).json({ code: 500, message: 'Failed to delete property' });
  }
});

// GET /api/property/:property_id/unit - List units for property
router.get('/:property_id/unit', authenticate, async (req, res) => {
  try {
    const { property_id } = req.params;
    const orgId = req.user.orgId;
    const [units] = await pool.execute(
      'SELECT u.* FROM unit u LEFT JOIN property p ON u.property_id = p.id WHERE u.property_id = ? AND p.org_id = ? AND u.active_status = 1 ORDER BY u.name',
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
    const { name, internal_note, rent_price_min, deposit_price, beds, baths, size } = req.body;
    const orgId = req.user.orgId;

    // Verify property belongs to org
    const [props] = await pool.execute('SELECT id FROM property WHERE id = ? AND org_id = ?', [property_id, orgId]);
    if (props.length === 0) {
      return res.status(404).json({ code: 404, message: 'Property not found' });
    }

    const [result] = await pool.execute(
      'INSERT INTO unit (property_id, name, internal_note, rent_price_min, deposit_price, status, beds, baths, size, active_status, created_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, 1, NOW())',
      [property_id, name, internal_note, rent_price_min, deposit_price, beds, baths, size]
    );
    res.json({ code: 200, message: 'Unit created', data: { id: result.insertId } });
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
    const [[sum]] = await pool.execute(
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
    const [rows] = await pool.execute(
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
    await pool.execute(
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
    await pool.execute('UPDATE unit_maintenance SET status = 0 WHERE id = ? AND org_id = ?', [id, orgId]);
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
    const [rows] = await pool.execute(
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
    const [result] = await pool.execute(
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
    const [[sum]] = await pool.execute(
      'SELECT COALESCE(SUM(CASE WHEN value IS NOT NULL THEN value * COALESCE(quantity, 1) ELSE 0 END), 0) as total, COUNT(*) as count FROM unit_inventory WHERE unit_id = ? AND org_id = ? AND status = 1',
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

    const [rows] = await pool.execute(
      `SELECT h.*, inv.name as item_name FROM unit_inventory_history h
       LEFT JOIN unit_inventory inv ON h.inventory_id = inv.id
       WHERE ` + whereClause + ` ORDER BY h.created_at DESC LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    const [[{ total }]] = await pool.execute(
      'SELECT COUNT(*) as total FROM unit_inventory_history h WHERE ' + whereClause,
      params
    );

    res.json({ code: 200, data: { content: rows, totalElements: total } });
  } catch (error) {
    console.error('Inventory history error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get inventory history' });
  }
});

module.exports = router;
