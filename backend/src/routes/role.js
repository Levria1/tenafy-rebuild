const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const pool = require('../config/database');

// POST /api/role/list - List roles
router.post('/list', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { search } = req.body || {};
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    
    let whereClause = 'org_id = ?';
    const params = [orgId];
    
    if (search) {
      whereClause += ' AND (name LIKE ? OR description LIKE ?)';
      params.push('%' + search + '%', '%' + search + '%');
    }
    
    const [roles] = await pool.execute(
      'SELECT * FROM role WHERE ' + whereClause + ' ORDER BY name LIMIT ' + limit + ' OFFSET ' + offset + '',
      [...params, limit, (page - 1) * limit]
    );
    
    const [countResult] = await pool.execute(
      'SELECT COUNT(*) as total FROM role WHERE ' + whereClause,
      params
    );
    
    res.json({ code: 200, data: { content: roles, totalElements: countResult[0].total } });
  } catch (error) {
    console.error('List roles error:', error);
    res.status(500).json({ code: 500, message: 'Failed to list roles' });
  }
});

// GET /api/role/all - Get all roles
router.get('/all', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const [roles] = await pool.execute(
      'SELECT * FROM role WHERE org_id = ? AND status = 1 ORDER BY name',
      [orgId]
    );
    res.json({ code: 200, data: roles });
  } catch (error) {
    console.error('Get all roles error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get roles' });
  }
});

// GET /api/role/permissions - List all available permissions (must be BEFORE /:id)
router.get('/permissions', authenticate, async (req, res) => {
  const permissions = [
    { key: 'property.view', label: 'View Properties', group: 'Properties' },
    { key: 'property.manage', label: 'Manage Properties', group: 'Properties' },
    { key: 'tenant.view', label: 'View Tenants', group: 'Tenants' },
    { key: 'tenant.manage', label: 'Manage Tenants', group: 'Tenants' },
    { key: 'leasing.view', label: 'View Leases', group: 'Leasing' },
    { key: 'leasing.manage', label: 'Manage Leases', group: 'Leasing' },
    { key: 'invoice.view', label: 'View Invoices', group: 'Invoices' },
    { key: 'invoice.manage', label: 'Manage Invoices', group: 'Invoices' },
    { key: 'accounting.view', label: 'View Accounting', group: 'Accounting' },
    { key: 'accounting.manage', label: 'Manage Accounting', group: 'Accounting' },
    { key: 'service.view', label: 'View Services', group: 'Services' },
    { key: 'service.manage', label: 'Manage Services', group: 'Services' },
    { key: 'contacts.view', label: 'View Contacts', group: 'Contacts' },
    { key: 'contacts.manage', label: 'Manage Contacts', group: 'Contacts' },
    { key: 'settings.view', label: 'View Settings', group: 'Settings' },
    { key: 'settings.manage', label: 'Manage Settings', group: 'Settings' },
    { key: 'reports.view', label: 'View Reports', group: 'Reports' },
    { key: 'admin', label: 'Administrator (Full Access)', group: 'Admin' },
  ];
  res.json({ code: 200, data: permissions });
});

// GET /api/role/:id - Get role
router.get('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;
    
    const [roles] = await pool.execute(
      'SELECT r.*, GROUP_CONCAT(rm.permission) as permissions FROM role r LEFT JOIN role_permission rm ON r.id = rm.role_id WHERE r.id = ? AND r.org_id = ? GROUP BY r.id',
      [id, orgId]
    );
    
    if (roles.length === 0) {
      return res.status(404).json({ code: 404, message: 'Role not found' });
    }
    
    const role = roles[0];
    role.permissions = role.permissions ? role.permissions.split(',') : [];
    
    res.json({ code: 200, data: role });
  } catch (error) {
    console.error('Get role error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get role' });
  }
});

// POST /api/role - Create role
router.post('/', authenticate, async (req, res) => {
  try {
    const { name, description, permissions, status } = req.body;
    const orgId = req.user.orgId;
    
    const [result] = await pool.execute(
      'INSERT INTO role (org_id, name, description, status, created_at) VALUES (?, ?, ?, ?, NOW())',
      [orgId, name, description, status || 1]
    );
    
    const roleId = result.insertId;
    
    if (permissions && permissions.length > 0) {
      for (const permission of permissions) {
        await pool.execute(
          'INSERT INTO role_permission (role_id, permission) VALUES (?, ?)',
          [roleId, permission]
        );
      }
    }
    
    res.json({ code: 200, message: 'Role created', data: { id: roleId } });
  } catch (error) {
    console.error('Create role error:', error);
    res.status(500).json({ code: 500, message: 'Failed to create role' });
  }
});

// PUT /api/role/:id - Update role
router.put('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, permissions, status } = req.body;
    const orgId = req.user.orgId;
    
    await pool.execute(
      'UPDATE role SET name = ?, description = ?, status = ?, updated_at = NOW() WHERE id = ? AND org_id = ?',
      [name, description, status, id, orgId]
    );
    
    if (permissions) {
      await pool.execute('DELETE FROM role_permission WHERE role_id = ?', [id]);
      for (const permission of permissions) {
        await pool.execute(
          'INSERT INTO role_permission (role_id, permission) VALUES (?, ?)',
          [id, permission]
        );
      }
    }
    
    res.json({ code: 200, message: 'Role updated' });
  } catch (error) {
    console.error('Update role error:', error);
    res.status(500).json({ code: 500, message: 'Failed to update role' });
  }
});

// DELETE /api/role/:id - Delete role
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;
    
    await pool.execute('DELETE FROM role_permission WHERE role_id = ?', [id]);
    await pool.execute('UPDATE role SET status = 0 WHERE id = ? AND org_id = ?', [id, orgId]);
    
    res.json({ code: 200, message: 'Role deleted' });
  } catch (error) {
    console.error('Delete role error:', error);
    res.status(500).json({ code: 500, message: 'Failed to delete role' });
  }
});

module.exports = router;
