const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const pool = require('../config/database');

// POST /api/service/list - List services with paging
router.post('/list', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { search, status, category } = req.body || {};
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    let whereClause = 's.org_id = ? AND s.deleted_at IS NULL';
    const params = [orgId];

    if (search) {
      whereClause += ' AND (s.code LIKE ? OR s.note LIKE ? OR s.additional_info LIKE ?)';
      const sv = '%' + search + '%';
      params.push(sv, sv, sv);
    }
    if (status !== undefined && status !== null) {
      whereClause += ' AND s.status = ?';
      params.push(status);
    }
    if (category) {
      whereClause += ' AND s.category = ?';
      params.push(category);
    }

    const [services] = await pool.execute(
      `SELECT s.*, u.name as unit_name, p.display_name as property_name,
              ua.first_name as assignee_first_name, ua.last_name as assignee_last_name
       FROM service s
       LEFT JOIN unit u ON s.unit_id = u.id
       LEFT JOIN property p ON u.property_id = p.id
       LEFT JOIN user ua ON s.assignee = ua.id
       WHERE ${whereClause} ORDER BY s.created_at DESC LIMIT ${limit} OFFSET ${offset}`,
      [...params]
    );

    const [[{ total }]] = await pool.execute(
      `SELECT COUNT(*) as total FROM service s WHERE ${whereClause}`,
      params
    );

    res.json({ code: 200, data: { content: services, totalElements: total, totalPages: Math.ceil(total / limit), currentPage: page } });
  } catch (error) {
    console.error('List services error:', error);
    res.status(500).json({ code: 500, message: 'Failed to list services' });
  }
});

// POST /api/service/list/status - Service list grouped by status
router.post('/list/status', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { search } = req.body || {};

    let whereClause = 'org_id = ? AND deleted_at IS NULL';
    const params = [orgId];

    if (search) {
      whereClause += ' AND (code LIKE ? OR note LIKE ?)';
      const sv = '%' + search + '%';
      params.push(sv, sv);
    }

    const [services] = await pool.execute(
      'SELECT * FROM service WHERE ' + whereClause + ' ORDER BY status, created_at DESC',
      params
    );

    res.json({ code: 200, data: services });
  } catch (error) {
    console.error('List services by status error:', error);
    res.status(500).json({ code: 500, message: 'Failed to list services' });
  }
});

// POST /api/service/create - Create service
router.post('/create', authenticate, async (req, res) => {
  try {
    const {
      unit_id, category, sub_category, note, additional_info,
      status, assignee, priority,
      preferred_date_first_start, preferred_date_first_end,
      preferred_date_second_start, preferred_date_second_end,
      service_date_start, service_date_end
    } = req.body;
    const orgId = req.user.orgId;
    const userId = req.user.id;

    // Generate service code from sequence
    let code = 'SRV-' + Date.now();
    const [[seq]] = await pool.execute(
      'SELECT id, seq_next, pattern FROM sequence WHERE org_id = ? AND `key` = ? FOR UPDATE',
      [orgId, 'service_code']
    );
    if (seq) {
      code = seq.pattern.replace(/{#,(\d+)}/, (_, pad) =>
        String(seq.seq_next).padStart(parseInt(pad), '0')
      );
      await pool.execute('UPDATE sequence SET seq_next = seq_next + 1 WHERE id = ?', [seq.id]);
    }

    const [result] = await pool.execute(
      `INSERT INTO service (org_id, code, unit_id, category, sub_category,
        note, additional_info, status, assignee, priority, created_by,
        preferred_date_first_start, preferred_date_first_end,
        preferred_date_second_start, preferred_date_second_end,
        service_date_start, service_date_end, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [orgId, code, unit_id, category || null, sub_category || null,
       note || null, additional_info || null, status || 0, assignee || null, priority || null, userId,
       preferred_date_first_start || null, preferred_date_first_end || null,
       preferred_date_second_start || null, preferred_date_second_end || null,
       service_date_start || null, service_date_end || null]
    );
    res.json({ code: 200, message: 'Service created', data: { id: result.insertId, code } });
  } catch (error) {
    console.error('Create service error:', error);
    res.status(500).json({ code: 500, message: 'Failed to create service' });
  }
});

// GET /api/service/category - Get service categories (distinct from existing services)
router.get('/category', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const [categories] = await pool.execute(
      'SELECT DISTINCT category FROM service WHERE org_id = ? AND category IS NOT NULL AND deleted_at IS NULL ORDER BY category',
      [orgId]
    );
    res.json({ code: 200, data: categories });
  } catch (error) {
    console.error('Get categories error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get categories' });
  }
});

// GET /api/service/vendor/list - Get all active service vendors
router.get('/vendor/list', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const [vendors] = await pool.execute(
      'SELECT id, first_name, last_name, email, phone FROM service_vendor WHERE org_id = ? AND status = 1 AND deleted_at IS NULL ORDER BY first_name, last_name',
      [orgId]
    );
    res.json({ code: 200, data: vendors });
  } catch (error) {
    console.error('Get vendors error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get vendors' });
  }
});

// GET /api/service/property/list - Get property list (for service form dropdowns)
router.get('/property/list', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const [properties] = await pool.execute(
      'SELECT id, display_name FROM property WHERE org_id = ? AND status = 1 ORDER BY display_name',
      [orgId]
    );
    res.json({ code: 200, data: properties });
  } catch (error) {
    console.error('Get property list error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get properties' });
  }
});

// GET /api/service/property/:id/unit - Get units by property (for service form)
router.get('/property/:id/unit', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;
    const [units] = await pool.execute(
      'SELECT u.id, u.name FROM unit u LEFT JOIN property p ON u.property_id = p.id WHERE u.property_id = ? AND p.org_id = ? AND u.active_status = 1 ORDER BY u.name',
      [id, orgId]
    );
    res.json({ code: 200, data: units });
  } catch (error) {
    console.error('Get units error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get units' });
  }
});

// GET /api/service/property/unit/:id - Get unit info for service
router.get('/property/unit/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;
    const [units] = await pool.execute(
      'SELECT u.id, u.name, u.property_id, p.display_name as property_name FROM unit u LEFT JOIN property p ON u.property_id = p.id WHERE u.id = ? AND p.org_id = ?',
      [id, orgId]
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

// GET /api/service/invoice/list - Get service invoice list
router.get('/invoice/list', authenticate, async (req, res) => {
  try {
    const { id } = req.query;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    const [invoices] = await pool.execute(
      'SELECT i.* FROM invoice i WHERE i.unit_id IN (SELECT unit_id FROM service WHERE id = ?) LIMIT ' + limit + ' OFFSET ' + offset + '',
      [id]
    );
    res.json({ code: 200, data: { content: invoices } });
  } catch (error) {
    console.error('Get service invoices error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get invoices' });
  }
});

// GET /api/service/detail/:id - Get service detail
router.get('/detail/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;
    const [services] = await pool.execute(
      `SELECT s.*, u.name as unit_name, p.display_name as property_name, p.id as property_id,
              ua.first_name as assignee_first_name, ua.last_name as assignee_last_name,
              uc.first_name as created_by_first_name, uc.last_name as created_by_last_name
       FROM service s
       LEFT JOIN unit u ON s.unit_id = u.id
       LEFT JOIN property p ON u.property_id = p.id
       LEFT JOIN user ua ON s.assignee = ua.id
       LEFT JOIN user uc ON s.created_by = uc.id
       WHERE s.id = ? AND s.org_id = ? AND s.deleted_at IS NULL`,
      [id, orgId]
    );
    if (services.length === 0) {
      return res.status(404).json({ code: 404, message: 'Service not found' });
    }
    res.json({ code: 200, data: services[0] });
  } catch (error) {
    console.error('Get service error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get service' });
  }
});

// PUT /api/service/update/:id - Update service
router.put('/update/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;
    const {
      category, sub_category, note, additional_info,
      status, assignee, priority,
      preferred_date_first_start, preferred_date_first_end,
      preferred_date_second_start, preferred_date_second_end,
      service_date_start, service_date_end
    } = req.body;

    await pool.execute(
      `UPDATE service SET
        category = ?, sub_category = ?, note = ?, additional_info = ?,
        status = ?, assignee = ?, priority = ?,
        preferred_date_first_start = ?, preferred_date_first_end = ?,
        preferred_date_second_start = ?, preferred_date_second_end = ?,
        service_date_start = ?, service_date_end = ?,
        updated_at = NOW()
       WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
      [category || null, sub_category || null, note || null, additional_info || null,
       status, assignee || null, priority || null,
       preferred_date_first_start || null, preferred_date_first_end || null,
       preferred_date_second_start || null, preferred_date_second_end || null,
       service_date_start || null, service_date_end || null,
       id, orgId]
    );
    res.json({ code: 200, message: 'Service updated' });
  } catch (error) {
    console.error('Update service error:', error);
    res.status(500).json({ code: 500, message: 'Failed to update service' });
  }
});

// DELETE /api/service/delete/:id - Soft-delete service
router.delete('/delete/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;
    await pool.execute('UPDATE service SET deleted_at = NOW() WHERE id = ? AND org_id = ?', [id, orgId]);
    res.json({ code: 200, message: 'Service deleted' });
  } catch (error) {
    console.error('Delete service error:', error);
    res.status(500).json({ code: 500, message: 'Failed to delete service' });
  }
});

module.exports = router;
