const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const config = require('../config');
const { getMasterPool, getOrgPool } = require('../config/poolRegistry');
const { authenticateMaster } = require('../middleware/masterAuth');
const { provisionOrg } = require('../services/orgProvisioner');

// POST /api/master/login
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ code: 400, message: 'Username and password are required' });
    }

    const masterPool = getMasterPool();
    const [users] = await masterPool.execute(
      'SELECT * FROM master_admin WHERE username = ? AND status = 1',
      [username]
    );

    if (!users.length) {
      return res.status(401).json({ code: 401, message: 'Invalid credentials' });
    }

    const user = users[0];
    let storedHash = user.password;
    if (storedHash.startsWith('{bcrypt}')) storedHash = storedHash.substring(8);
    storedHash = storedHash.replace('$2a$', '$2b$');

    const isMatch = await bcrypt.compare(password, storedHash);
    if (!isMatch) {
      return res.status(401).json({ code: 401, message: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { id: user.id, username: user.username, isMasterAdmin: true },
      config.jwtSecret,
      { expiresIn: config.jwtExpiresIn }
    );

    res.cookie('__s_t', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 24 * 60 * 60 * 1000
    });

    res.json({ code: 200, data: { token, isMasterAdmin: true } });
  } catch (error) {
    console.error('Master login error:', error);
    res.status(500).json({ code: 500, message: 'Server error' });
  }
});

// GET /api/master/profile
router.get('/profile', authenticateMaster, async (req, res) => {
  try {
    const masterPool = getMasterPool();
    const [users] = await masterPool.execute(
      'SELECT id, username, email, first_name, last_name FROM master_admin WHERE id = ?',
      [req.user.id]
    );
    if (!users.length) return res.status(404).json({ code: 404, message: 'User not found' });
    res.json({ code: 200, data: { ...users[0], isMasterAdmin: true } });
  } catch (error) {
    console.error('Master profile error:', error);
    res.status(500).json({ code: 500, message: 'Server error' });
  }
});

// GET /api/master/organizations
router.get('/organizations', authenticateMaster, async (req, res) => {
  try {
    const masterPool = getMasterPool();
    const [orgs] = await masterPool.execute(
      'SELECT id, display_name, db_name, status, created_at, updated_at FROM organizations ORDER BY created_at DESC'
    );
    res.json({ code: 200, data: orgs });
  } catch (error) {
    console.error('List orgs error:', error);
    res.status(500).json({ code: 500, message: 'Server error' });
  }
});

// POST /api/master/organizations
router.post('/organizations', authenticateMaster, async (req, res) => {
  try {
    const { display_name, admin_username, admin_password, admin_email, admin_first_name, admin_last_name } = req.body;

    if (!display_name || !admin_username || !admin_password) {
      return res.status(400).json({ code: 400, message: 'Organization name, admin username, and admin password are required' });
    }

    // Check if username already exists in org_user_map
    const masterPool = getMasterPool();
    const [existing] = await masterPool.execute(
      'SELECT username FROM org_user_map WHERE username = ?',
      [admin_username]
    );
    if (existing.length) {
      return res.status(400).json({ code: 400, message: 'Username already exists in another organization' });
    }

    const orgId = (BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000))).toString();

    await provisionOrg({
      orgId,
      displayName: display_name,
      adminUsername: admin_username,
      adminPassword: admin_password,
      adminEmail: admin_email || admin_username,
      adminFirstName: admin_first_name || 'Admin',
      adminLastName: admin_last_name || ''
    });

    res.json({ code: 200, data: { id: orgId, display_name, message: 'Organization created successfully' } });
  } catch (error) {
    console.error('Create org error:', error);
    res.status(500).json({ code: 500, message: error.message || 'Failed to create organization' });
  }
});

// PUT /api/master/organizations/:id
router.put('/organizations/:id', authenticateMaster, async (req, res) => {
  try {
    const { id } = req.params;
    const { display_name, status } = req.body;
    const masterPool = getMasterPool();

    const updates = [];
    const params = [];
    if (display_name !== undefined) { updates.push('display_name = ?'); params.push(display_name); }
    if (status !== undefined) { updates.push('status = ?'); params.push(status); }

    if (!updates.length) return res.status(400).json({ code: 400, message: 'Nothing to update' });

    params.push(id);
    await masterPool.execute(`UPDATE organizations SET ${updates.join(', ')} WHERE id = ?`, params);

    res.json({ code: 200, message: 'Organization updated' });
  } catch (error) {
    console.error('Update org error:', error);
    res.status(500).json({ code: 500, message: 'Server error' });
  }
});

// GET /api/master/organizations/:id/stats
router.get('/organizations/:id/stats', authenticateMaster, async (req, res) => {
  try {
    const { id } = req.params;
    const orgPool = await getOrgPool(id);

    const [[userCount]] = await orgPool.execute('SELECT COUNT(*) as count FROM user WHERE org_id = ?', [id]);
    const [[propertyCount]] = await orgPool.execute('SELECT COUNT(*) as count FROM property WHERE org_id = ?', [id]);
    const [[tenantCount]] = await orgPool.execute('SELECT COUNT(*) as count FROM tenant WHERE org_id = ? AND category = 1', [id]);
    const [[leaseCount]] = await orgPool.execute('SELECT COUNT(*) as count FROM leasing WHERE status = 1');

    res.json({
      code: 200,
      data: {
        users: Number(userCount.count),
        properties: Number(propertyCount.count),
        tenants: Number(tenantCount.count),
        active_leases: Number(leaseCount.count)
      }
    });
  } catch (error) {
    console.error('Org stats error:', error);
    res.status(500).json({ code: 500, message: 'Server error' });
  }
});

module.exports = router;
