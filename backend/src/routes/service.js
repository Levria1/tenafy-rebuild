const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');

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
       LEFT JOIN tenant t ON s.created_by = t.id
       LEFT JOIN service_vendor sv ON s.assignee = sv.id
       LEFT JOIN service_vendor sv2 ON s.assignee_2 = sv2.id
       LEFT JOIN tenant rb ON s.reported_by = rb.id`;

    const [services] = await req.pool.execute(
      `SELECT s.*, u.name as unit_name, p.display_name as property_name,
              CASE WHEN t.type = 1 THEN t.company_name
                   ELSE CONCAT(COALESCE(t.first_name,''), ' ', COALESCE(t.last_name,''))
              END AS tenant_name,
              t.phone AS tenant_phone,
              CONCAT(COALESCE(sv.first_name,''), ' ', COALESCE(sv.last_name,'')) AS assignee_name,
              CONCAT(COALESCE(sv2.first_name,''), ' ', COALESCE(sv2.last_name,'')) AS assignee_2_name,
              CASE WHEN rb.type = 1 THEN rb.company_name
                   ELSE CONCAT(COALESCE(rb.first_name,''), ' ', COALESCE(rb.last_name,''))
              END AS reported_by_name
       ${joinClause}
       WHERE ${whereClause} ORDER BY s.created_at DESC LIMIT ${limit} OFFSET ${offset}`,
      [...params]
    );

    const [[{ total }]] = await req.pool.execute(
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

    const [services] = await req.pool.execute(
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
      status, assignee, assignee_2, priority, reported_by, contact_phone,
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
      code = await generateSequenceCode(req.pool, orgId, 'service_code');
    } catch (seqErr) {
      console.error('Sequence lookup failed, using fallback code:', seqErr.message);
      code = 'S' + Date.now();
    }

    await req.pool.execute(
      `INSERT INTO service (id, org_id, code, unit_id, category, sub_category,
        note, additional_info, status, assignee, assignee_2, priority, created_by,
        reported_by, contact_phone,
        preferred_date_first_start, preferred_date_first_end,
        preferred_date_second_start, preferred_date_second_end,
        service_date_start, service_date_end, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [serviceId, orgId, code, unit_id, category || null, sub_category || null,
       note || null, additional_info || null, status ?? 0, assignee || null, assignee_2 || null,
       priority ?? null, userId, reported_by || null, contact_phone || null,
       preferred_date_first_start || null, preferred_date_first_end || null,
       preferred_date_second_start || null, preferred_date_second_end || null,
       service_date_start || null, service_date_end || null]
    );

    // Link uploaded files via object_file junction table
    const { file_ids } = req.body;
    if (Array.isArray(file_ids) && file_ids.length > 0) {
      const fileValues = file_ids.map(fid => [serviceId, fid.toString()]);
      for (const [objId, fId] of fileValues) {
        await req.pool.execute('INSERT INTO object_file (object_id, file_id) VALUES (?, ?)', [objId, fId]);
      }
    }

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
    const [categories] = await req.pool.execute(
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
    const [vendors] = await req.pool.execute(
      'SELECT id, first_name, last_name, email, phone FROM service_vendor WHERE org_id = ? AND status = 1 AND deleted_at IS NULL ORDER BY first_name, last_name',
      [orgId]
    );
    res.json({ code: 200, data: vendors });
  } catch (error) {
    console.error('Get vendors error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get vendors' });
  }
});

// GET /api/service/contacts - Get all contacts (tenants + service vendors) for Reported By dropdown
router.get('/contacts', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const [tenants] = await req.pool.execute(
      `SELECT id, first_name, last_name, company_name, type, phone, 'tenant' as contact_type
       FROM tenant WHERE org_id = ? AND status = 1 AND category = 1 ORDER BY first_name, last_name`,
      [orgId]
    );
    const [vendors] = await req.pool.execute(
      `SELECT id, first_name, last_name, NULL as company_name, 0 as type, phone, 'vendor' as contact_type
       FROM service_vendor WHERE org_id = ? AND status = 1 AND deleted_at IS NULL ORDER BY first_name, last_name`,
      [orgId]
    );
    res.json({ code: 200, data: [...tenants, ...vendors] });
  } catch (error) {
    console.error('Get contacts error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get contacts' });
  }
});

// GET /api/service/property/list - Get property list (for service form dropdowns)
router.get('/property/list', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const [properties] = await req.pool.execute(
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
    const [units] = await req.pool.execute(
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
    const [units] = await req.pool.execute(
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

    const [invoices] = await req.pool.execute(
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
    const [services] = await req.pool.execute(
      `SELECT s.*, u.name as unit_name, p.display_name as property_name, p.id as property_id,
              sv.first_name as assignee_first_name, sv.last_name as assignee_last_name,
              sv2.first_name as assignee_2_first_name, sv2.last_name as assignee_2_last_name,
              CASE WHEN rb.type = 1 THEN rb.company_name
                   ELSE CONCAT(COALESCE(rb.first_name,''), ' ', COALESCE(rb.last_name,''))
              END AS reported_by_name,
              rb.phone AS reported_by_phone,
              CASE WHEN t.type = 1 THEN t.company_name
                   ELSE CONCAT(COALESCE(t.first_name,''), ' ', COALESCE(t.last_name,''))
              END AS tenant_name,
              t.phone AS tenant_phone
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
    if (services.length === 0) {
      return res.status(404).json({ code: 404, message: 'Service not found' });
    }

    // Fetch linked files
    const [files] = await req.pool.execute(
      `SELECT f.id, f.filename, f.item_name, f.extension, f.mime_type, f.file_size
       FROM object_file of2
       JOIN file f ON of2.file_id = f.id
       WHERE of2.object_id = ? AND of2.deleted_at IS NULL AND f.deleted_at IS NULL
       ORDER BY f.created_at`,
      [id]
    );

    res.json({ code: 200, data: { ...services[0], files } });
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
      status, assignee, assignee_2, priority, reported_by, contact_phone,
      preferred_date_first_start, preferred_date_first_end,
      preferred_date_second_start, preferred_date_second_end,
      service_date_start, service_date_end
    } = req.body;

    // Verify exists
    const [existing] = await req.pool.execute(
      'SELECT id FROM service WHERE id = ? AND org_id = ? AND deleted_at IS NULL', [id, orgId]
    );
    if (existing.length === 0) {
      return res.status(404).json({ code: 404, message: 'Service not found' });
    }

    await req.pool.execute(
      `UPDATE service SET
        unit_id = ?, category = ?, sub_category = ?, note = ?, additional_info = ?,
        status = ?, assignee = ?, assignee_2 = ?, priority = ?,
        reported_by = ?, contact_phone = ?,
        preferred_date_first_start = ?, preferred_date_first_end = ?,
        preferred_date_second_start = ?, preferred_date_second_end = ?,
        service_date_start = ?, service_date_end = ?,
        updated_at = NOW()
       WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
      [unit_id || null, category || null, sub_category || null, note || null, additional_info || null,
       status ?? 0, assignee || null, assignee_2 || null, priority ?? null,
       reported_by || null, contact_phone || null,
       preferred_date_first_start || null, preferred_date_first_end || null,
       preferred_date_second_start || null, preferred_date_second_end || null,
       service_date_start || null, service_date_end || null,
       id, orgId]
    );

    // Update linked files: replace all object_file rows for this service
    const { file_ids } = req.body;
    if (Array.isArray(file_ids)) {
      // Soft-delete existing links
      await req.pool.execute('UPDATE object_file SET deleted_at = NOW() WHERE object_id = ? AND deleted_at IS NULL', [id]);
      // Insert new links
      for (const fId of file_ids) {
        await req.pool.execute(
          'INSERT INTO object_file (object_id, file_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE deleted_at = NULL',
          [id, fId.toString()]
        );
      }
    }

    res.json({ code: 200, message: 'Service updated' });
  } catch (error) {
    console.error('Update service error:', error);
    res.status(500).json({ code: 500, message: 'Failed to update service' });
  }
});

// PATCH /api/service/patch/:id - Partial update (for inline edits)
router.patch('/patch/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;

    // Only allow these fields for partial update
    const allowedFields = [
      'status', 'service_date_start', 'service_date_end',
      'assignee', 'assignee_2', 'priority', 'category', 'sub_category',
      'reported_by', 'contact_phone', 'note', 'additional_info',
    ];

    const setClauses = [];
    const values = [];
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        setClauses.push(`${field} = ?`);
        values.push(req.body[field]);
      }
    }

    if (setClauses.length === 0) {
      return res.status(400).json({ code: 400, message: 'No fields to update' });
    }

    setClauses.push('updated_at = NOW()');
    values.push(id, orgId);

    const [result] = await req.pool.execute(
      `UPDATE service SET ${setClauses.join(', ')} WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
      values
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ code: 404, message: 'Service not found' });
    }

    res.json({ code: 200, message: 'Service updated' });
  } catch (error) {
    console.error('Patch service error:', error);
    res.status(500).json({ code: 500, message: 'Failed to update service' });
  }
});

// DELETE /api/service/delete/:id - Soft-delete service
router.delete('/delete/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;
    await req.pool.execute('UPDATE service SET deleted_at = NOW() WHERE id = ? AND org_id = ?', [id, orgId]);
    res.json({ code: 200, message: 'Service deleted' });
  } catch (error) {
    console.error('Delete service error:', error);
    res.status(500).json({ code: 500, message: 'Failed to delete service' });
  }
});

module.exports = router;
