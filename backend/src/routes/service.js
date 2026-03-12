const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const pool = require('../config/database');
const { generateSequenceCode } = require('../utils/sequenceCode');

// POST /api/service/list - List services with paging
router.post('/list', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { search, searchFields, status, category, subCategoryList, property, unitIdList } = req.body || {};
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;

    let whereClause = 's.org_id = ? AND s.deleted_at IS NULL';
    const params = [orgId];

    // Search: supports searchFields array (propertyName, tenantName)
    if (search) {
      const sv = '%' + search + '%';
      const fields = Array.isArray(searchFields) && searchFields.length > 0 ? searchFields : null;
      if (!fields) {
        // No fields selected: search property name, unit name, and tenant name
        whereClause += ` AND (p.display_name LIKE ? OR u.name LIKE ?
          OR t.id IN (SELECT id FROM tenant WHERE type = 0 AND CONCAT(COALESCE(first_name,''), ' ', COALESCE(middle_name,''), ' ', COALESCE(last_name,'')) LIKE ?)
          OR t.id IN (SELECT id FROM tenant WHERE type = 1 AND company_name LIKE ?))`;
        params.push(sv, sv, sv, sv);
      } else {
        const searchParts = [];
        for (const f of fields) {
          if (f === 'propertyName') {
            searchParts.push('(p.display_name LIKE ? OR u.name LIKE ?)');
            params.push(sv, sv);
          } else if (f === 'tenantName') {
            searchParts.push(`(t.id IN (SELECT id FROM tenant WHERE type = 0 AND CONCAT(COALESCE(first_name,''), ' ', COALESCE(middle_name,''), ' ', COALESCE(last_name,'')) LIKE ?)
              OR t.id IN (SELECT id FROM tenant WHERE type = 1 AND company_name LIKE ?))`);
            params.push(sv, sv);
          }
        }
        if (searchParts.length > 0) {
          whereClause += ' AND (' + searchParts.join(' OR ') + ')';
        }
      }
    }

    if (status !== undefined && status !== null) {
      whereClause += ' AND s.status = ?';
      params.push(status);
    }
    // Category filter — supports array or single value
    if (Array.isArray(category) && category.length > 0) {
      whereClause += ' AND s.category IN (' + category.map(() => '?').join(',') + ')';
      params.push(...category);
    } else if (category && !Array.isArray(category)) {
      whereClause += ' AND s.category = ?';
      params.push(category);
    }
    // Sub-category filter
    if (Array.isArray(subCategoryList) && subCategoryList.length > 0) {
      whereClause += ' AND s.sub_category IN (' + subCategoryList.map(() => '?').join(',') + ')';
      params.push(...subCategoryList);
    }
    // Property filter — array of property IDs
    if (Array.isArray(property) && property.length > 0) {
      whereClause += ' AND p.id IN (' + property.map(() => '?').join(',') + ')';
      params.push(...property);
    }
    // Unit filter — array of unit IDs
    if (Array.isArray(unitIdList) && unitIdList.length > 0) {
      whereClause += ' AND u.id IN (' + unitIdList.map(() => '?').join(',') + ')';
      params.push(...unitIdList);
    }

    // Count query needs same JOINs for property/unit/tenant filters
    const joinClause = `FROM service s
       LEFT JOIN unit u ON s.unit_id = u.id
       LEFT JOIN property p ON u.property_id = p.id
       LEFT JOIN tenant t ON s.created_by = t.id`;

    const [services] = await pool.execute(
      `SELECT s.*, u.name as unit_name, p.display_name as property_name,
              CASE WHEN t.type = 1 THEN t.company_name
                   ELSE CONCAT(COALESCE(t.first_name,''), ' ', COALESCE(t.last_name,''))
              END AS tenant_name,
              t.phone AS tenant_phone
       ${joinClause}
       WHERE ${whereClause} ORDER BY s.created_at DESC LIMIT ${limit} OFFSET ${offset}`,
      [...params]
    );

    const [[{ total }]] = await pool.execute(
      `SELECT COUNT(*) as total ${joinClause} WHERE ${whereClause}`,
      [...params]
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

    // Snowflake ID
    const serviceId = (BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000))).toString();

    // Generate service code from sequence (uses MAX of existing codes)
    let code;
    try {
      code = await generateSequenceCode(orgId, 'service_code');
    } catch (seqErr) {
      console.error('Sequence lookup failed, using fallback code:', seqErr.message);
      code = 'S' + Date.now();
    }

    await pool.execute(
      `INSERT INTO service (id, org_id, code, unit_id, category, sub_category,
        note, additional_info, status, assignee, priority, created_by,
        preferred_date_first_start, preferred_date_first_end,
        preferred_date_second_start, preferred_date_second_end,
        service_date_start, service_date_end, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [serviceId, orgId, code, unit_id, category || null, sub_category || null,
       note || null, additional_info || null, status ?? 0, assignee || null, priority ?? null, userId,
       preferred_date_first_start || null, preferred_date_first_end || null,
       preferred_date_second_start || null, preferred_date_second_end || null,
       service_date_start || null, service_date_end || null]
    );
    res.json({ code: 200, message: 'Service created', data: { id: serviceId, code } });
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
              sv.first_name as assignee_first_name, sv.last_name as assignee_last_name,
              CASE WHEN t.type = 1 THEN t.company_name
                   ELSE CONCAT(COALESCE(t.first_name,''), ' ', COALESCE(t.last_name,''))
              END AS tenant_name,
              t.phone AS tenant_phone
       FROM service s
       LEFT JOIN unit u ON s.unit_id = u.id
       LEFT JOIN property p ON u.property_id = p.id
       LEFT JOIN service_vendor sv ON s.assignee = sv.id
       LEFT JOIN tenant t ON s.created_by = t.id
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
      unit_id, category, sub_category, note, additional_info,
      status, assignee, priority,
      preferred_date_first_start, preferred_date_first_end,
      preferred_date_second_start, preferred_date_second_end,
      service_date_start, service_date_end
    } = req.body;

    // Verify exists
    const [existing] = await pool.execute(
      'SELECT id FROM service WHERE id = ? AND org_id = ? AND deleted_at IS NULL', [id, orgId]
    );
    if (existing.length === 0) {
      return res.status(404).json({ code: 404, message: 'Service not found' });
    }

    await pool.execute(
      `UPDATE service SET
        unit_id = ?, category = ?, sub_category = ?, note = ?, additional_info = ?,
        status = ?, assignee = ?, priority = ?,
        preferred_date_first_start = ?, preferred_date_first_end = ?,
        preferred_date_second_start = ?, preferred_date_second_end = ?,
        service_date_start = ?, service_date_end = ?,
        updated_at = NOW()
       WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
      [unit_id || null, category || null, sub_category || null, note || null, additional_info || null,
       status ?? 0, assignee || null, priority ?? null,
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
