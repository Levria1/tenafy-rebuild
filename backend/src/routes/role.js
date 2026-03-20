const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');


// Full permission list matching original Tenafy
const LANDLORD_PERMISSIONS = [
  { key: 'LANDLORD/DASHBOARD', label: 'Dashboard', group: 'Dashboard' },
  // Properties
  { key: 'LANDLORD/PROPERTY_LIST', label: 'Property List', group: 'Properties' },
  { key: 'LANDLORD/PROPERTY_CREATE', label: 'Property Create', group: 'Properties' },
  { key: 'LANDLORD/PROPERTY_EDIT', label: 'Property Edit', group: 'Properties' },
  { key: 'LANDLORD/PROPERTY_DETAIL', label: 'Property Detail', group: 'Properties' },
  { key: 'LANDLORD/PROPERTY_DELETE', label: 'Property Delete', group: 'Properties' },
  { key: 'LANDLORD/PROPERTY_CLONE', label: 'Property Clone', group: 'Properties' },
  // Units
  { key: 'LANDLORD/UNIT_LIST', label: 'Unit List', group: 'Units' },
  { key: 'LANDLORD/UNIT_CREATE', label: 'Unit Create', group: 'Units' },
  { key: 'LANDLORD/UNIT_DETAIL', label: 'Unit Detail', group: 'Units' },
  { key: 'LANDLORD/UNIT_EDIT', label: 'Unit Edit', group: 'Units' },
  { key: 'LANDLORD/UNIT_DELETE', label: 'Unit Delete', group: 'Units' },
  { key: 'LANDLORD/UNIT_CLONE', label: 'Unit Clone', group: 'Units' },
  // Tenants
  { key: 'LANDLORD/TENANT_LIST', label: 'Tenant List', group: 'Tenants' },
  { key: 'LANDLORD/TENANT_CREATE', label: 'Tenant Create', group: 'Tenants' },
  { key: 'LANDLORD/TENANT_EDIT', label: 'Tenant Edit', group: 'Tenants' },
  { key: 'LANDLORD/TENANT_DELETE', label: 'Tenant Delete', group: 'Tenants' },
  { key: 'LANDLORD/TENANT_DETAIL', label: 'Tenant Detail', group: 'Tenants' },
  // Payees
  { key: 'LANDLORD/PAYEE_LIST', label: 'Payee List', group: 'Payees' },
  { key: 'LANDLORD/PAYEE_CREATE', label: 'Payee Create', group: 'Payees' },
  { key: 'LANDLORD/PAYEE_EDIT', label: 'Payee Edit', group: 'Payees' },
  { key: 'LANDLORD/PAYEE_DELETE', label: 'Payee Delete', group: 'Payees' },
  { key: 'LANDLORD/PAYEE_DETAIL', label: 'Payee Detail', group: 'Payees' },
  // Leasing
  { key: 'LANDLORD/LEASING_LIST', label: 'Leasing List', group: 'Leasing' },
  { key: 'LANDLORD/LEASING_CREATE', label: 'Leasing Create', group: 'Leasing' },
  { key: 'LANDLORD/LEASING_DETAIL', label: 'Leasing Detail', group: 'Leasing' },
  { key: 'LANDLORD/LEASING_EDIT', label: 'Leasing Edit', group: 'Leasing' },
  { key: 'LANDLORD/LEASING_DELETE', label: 'Leasing Delete', group: 'Leasing' },
  // Accounting
  { key: 'LANDLORD/ACCOUNTING_LIST', label: 'Accounting List', group: 'Accounting' },
  { key: 'LANDLORD/ACCOUNTING_CREATE', label: 'Accounting Create', group: 'Accounting' },
  { key: 'LANDLORD/ACCOUNTING_EDIT', label: 'Accounting Edit', group: 'Accounting' },
  { key: 'LANDLORD/ACCOUNTING_DETAIL', label: 'Accounting Detail', group: 'Accounting' },
  { key: 'LANDLORD/ACCOUNTING_DELETE', label: 'Accounting Delete', group: 'Accounting' },
  // Invoices
  { key: 'LANDLORD/INVOICE_LIST', label: 'Invoice List', group: 'Invoices' },
  { key: 'LANDLORD/INVOICE_CREATE', label: 'Invoice Create', group: 'Invoices' },
  { key: 'LANDLORD/INVOICE_EDIT', label: 'Invoice Edit', group: 'Invoices' },
  { key: 'LANDLORD/INVOICE_DETAIL', label: 'Invoice Detail', group: 'Invoices' },
  { key: 'LANDLORD/INVOICE_DELETE', label: 'Invoice Delete', group: 'Invoices' },
  { key: 'LANDLORD/INVOICE_CREATE_MULTIPLE_PAY', label: 'Invoice Create Multiple Pay', group: 'Invoices' },
  { key: 'LANDLORD/INVOICE_CREATE_MULTIPLE_RECEIVE', label: 'Invoice Create Multiple Receive', group: 'Invoices' },
  // Users
  { key: 'LANDLORD/USER_LIST', label: 'User List', group: 'Users' },
  { key: 'LANDLORD/USER_CREATE', label: 'User Create', group: 'Users' },
  { key: 'LANDLORD/USER_EDIT', label: 'User Edit', group: 'Users' },
  { key: 'LANDLORD/USER_DETAIL', label: 'User Detail', group: 'Users' },
  { key: 'LANDLORD/USER_DELETE', label: 'User Delete', group: 'Users' },
  { key: 'LANDLORD/USER_ROLE_ASSIGN', label: 'User Role Assign', group: 'Users' },
  // Settings
  { key: 'LANDLORD/SETTING_PERSONAL', label: 'Personal Setting', group: 'Settings' },
  { key: 'LANDLORD/SETTING_CURRENCY', label: 'Currency Setting', group: 'Settings' },
  { key: 'LANDLORD/SETTING_AMENITY', label: 'Amenity Setting', group: 'Settings' },
  { key: 'LANDLORD/AMENITY_CREATE', label: 'Amenity Create', group: 'Settings' },
  { key: 'LANDLORD/AMENITY_EDIT', label: 'Amenity Edit', group: 'Settings' },
  { key: 'LANDLORD/AMENITY_DELETE', label: 'Amenity Delete', group: 'Settings' },
  { key: 'LANDLORD/SETTING_LANDLORD', label: 'Landlord Setting', group: 'Settings' },
  { key: 'LANDLORD/SETTING_ACCOUNT', label: 'Account Setting', group: 'Settings' },
  { key: 'LANDLORD/SETTING_PAYMENT_METHODS', label: 'Payment Methods Setting', group: 'Settings' },
  { key: 'LANDLORD/SETTING_CATEGORY', label: 'Category Setting', group: 'Settings' },
  { key: 'LANDLORD/SETTING_SEQUENCE', label: 'Sequence Setting', group: 'Settings' },
  // Roles
  { key: 'LANDLORD/ROLE_LIST', label: 'Role List', group: 'Roles' },
  { key: 'LANDLORD/ROLE_CREATE', label: 'Role Create', group: 'Roles' },
  { key: 'LANDLORD/ROLE_EDIT', label: 'Role Edit', group: 'Roles' },
  { key: 'LANDLORD/ROLE_DELETE', label: 'Role Delete', group: 'Roles' },
  { key: 'LANDLORD/ROLE_DETAIL', label: 'Role Detail', group: 'Roles' },
  // Email Templates
  { key: 'LANDLORD/SETTING_EMAIL_TEMPLATE', label: 'Email Template Setting', group: 'Email' },
  { key: 'LANDLORD/EMAIL_TEMPLATE_CREATE', label: 'Email Template Create', group: 'Email' },
  { key: 'LANDLORD/EMAIL_TEMPLATE_EDIT', label: 'Email Template Edit', group: 'Email' },
  { key: 'LANDLORD/EMAIL_TEMPLATE_DETAIL', label: 'Email Template Detail', group: 'Email' },
  { key: 'LANDLORD/EMAIL_TEMPLATE_DELETE', label: 'Email Template Delete', group: 'Email' },
  // Email Groups
  { key: 'LANDLORD/EMAIL_GROUP_LIST', label: 'Email Group List', group: 'Email' },
  { key: 'LANDLORD/EMAIL_GROUP_CREATE', label: 'Email Group Create', group: 'Email' },
  { key: 'LANDLORD/EMAIL_GROUP_EDIT', label: 'Email Group Edit', group: 'Email' },
  // Services
  { key: 'LANDLORD/SERVICE_LIST', label: 'Service List', group: 'Services' },
  { key: 'LANDLORD/SERVICE_DETAIL', label: 'Service Detail', group: 'Services' },
  { key: 'LANDLORD/SERVICE_CREATE', label: 'Service Create', group: 'Services' },
  { key: 'LANDLORD/SERVICE_EDIT', label: 'Service Edit', group: 'Services' },
  { key: 'LANDLORD/SERVICE_DELETE', label: 'Service Delete', group: 'Services' },
  // Service Vendors
  { key: 'LANDLORD/SERVICE_VENDOR_LIST', label: 'Service Vendor List', group: 'Service Vendors' },
  { key: 'LANDLORD/SERVICE_VENDOR_CREATE', label: 'Service Vendor Create', group: 'Service Vendors' },
  { key: 'LANDLORD/SERVICE_VENDOR_DETAIL', label: 'Service Vendor Detail', group: 'Service Vendors' },
  { key: 'LANDLORD/SERVICE_VENDOR_EDIT', label: 'Service Vendor Edit', group: 'Service Vendors' },
  { key: 'LANDLORD/SERVICE_VENDOR_DELETE', label: 'Service Vendor Delete', group: 'Service Vendors' },
  // Listings
  { key: 'LANDLORD/LISTING_LIST', label: 'Listing List', group: 'Listings' },
  { key: 'LANDLORD/LISTING_CREATE', label: 'Listing Create', group: 'Listings' },
  { key: 'LANDLORD/LISTING_DETAIL', label: 'Listing Detail', group: 'Listings' },
  { key: 'LANDLORD/LISTING_EDIT', label: 'Listing Edit', group: 'Listings' },
  { key: 'LANDLORD/LISTING_DELETE', label: 'Listing Delete', group: 'Listings' },
];

// POST /api/role/list - List roles
router.post('/list', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { search } = req.body || {};
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    let whereClause = 'org_id = ?';
    const params = [orgId];

    if (search) {
      whereClause += ' AND (display_name LIKE ? OR description LIKE ?)';
      params.push('%' + search + '%', '%' + search + '%');
    }

    const [roles] = await req.pool.execute(
      'SELECT * FROM role WHERE ' + whereClause + ' ORDER BY display_name LIMIT ' + limit + ' OFFSET ' + offset,
      params
    );

    const [countResult] = await req.pool.execute(
      'SELECT COUNT(*) as total FROM role WHERE ' + whereClause,
      params
    );

    res.json({ code: 200, data: { content: roles, totalElements: countResult[0].total } });
  } catch (error) {
    console.error('List roles error:', error);
    res.status(500).json({ code: 500, message: 'Failed to list roles' });
  }
});

// GET /api/role/all - Get all active roles
router.get('/all', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const [roles] = await req.pool.execute(
      'SELECT * FROM role WHERE org_id = ? AND status = 1 ORDER BY display_name',
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
  res.json({ code: 200, data: LANDLORD_PERMISSIONS });
});

// GET /api/role/:id - Get role with permissions
router.get('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;

    const [roles] = await req.pool.execute(
      'SELECT * FROM role WHERE id = ? AND org_id = ?',
      [id, orgId]
    );

    if (roles.length === 0) {
      return res.status(404).json({ code: 404, message: 'Role not found' });
    }

    const role = roles[0];

    // Fetch permissions separately to avoid GROUP_CONCAT truncation
    const [permRows] = await req.pool.execute(
      'SELECT permission_code FROM role_permission WHERE role_id = ?',
      [id]
    );
    role.permissions = permRows.map(r => r.permission_code);

    res.json({ code: 200, data: role });
  } catch (error) {
    console.error('Get role error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get role' });
  }
});

// POST /api/role - Create role
router.post('/', authenticate, async (req, res) => {
  try {
    const { display_name, description, permissions, status } = req.body;
    const orgId = req.user.orgId;
    const roleId = BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000));

    await req.pool.execute(
      'INSERT INTO role (id, org_id, display_name, description, type, status) VALUES (?, ?, ?, ?, 0, ?)',
      [roleId.toString(), orgId, display_name, description || null, status ?? 1]
    );

    // Insert permissions
    const permList = Array.isArray(permissions) ? permissions : (permissions ? permissions.split(',').filter(Boolean) : []);
    for (const perm of permList) {
      await req.pool.execute(
        'INSERT INTO role_permission (role_id, permission_code) VALUES (?, ?)',
        [roleId.toString(), perm.trim()]
      );
    }

    res.json({ code: 200, message: 'Role created', data: { id: roleId.toString() } });
  } catch (error) {
    console.error('Create role error:', error);
    res.status(500).json({ code: 500, message: 'Failed to create role' });
  }
});

// PUT /api/role/:id - Update role
router.put('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { display_name, description, permissions, status } = req.body;
    const orgId = req.user.orgId;

    await req.pool.execute(
      'UPDATE role SET display_name = ?, description = ?, status = ? WHERE id = ? AND org_id = ?',
      [display_name, description, status ?? 1, id, orgId]
    );

    if (permissions !== undefined) {
      await req.pool.execute('DELETE FROM role_permission WHERE role_id = ?', [id]);
      const permList = Array.isArray(permissions) ? permissions : (permissions ? permissions.split(',').filter(Boolean) : []);
      for (const perm of permList) {
        await req.pool.execute(
          'INSERT INTO role_permission (role_id, permission_code) VALUES (?, ?)',
          [id, perm.trim()]
        );
      }
    }

    res.json({ code: 200, message: 'Role updated' });
  } catch (error) {
    console.error('Update role error:', error);
    res.status(500).json({ code: 500, message: 'Failed to update role' });
  }
});

// DELETE /api/role/:id - Delete role (soft delete)
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;

    await req.pool.execute('DELETE FROM role_permission WHERE role_id = ?', [id]);
    await req.pool.execute('UPDATE role SET status = 0 WHERE id = ? AND org_id = ?', [id, orgId]);

    res.json({ code: 200, message: 'Role deleted' });
  } catch (error) {
    console.error('Delete role error:', error);
    res.status(500).json({ code: 500, message: 'Failed to delete role' });
  }
});

module.exports = router;
