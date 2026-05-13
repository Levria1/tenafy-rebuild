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

    // httpOnly:false so the frontend MasterLayout can read the cookie via
    // js-cookie to gate access — same quirk as the regular org-admin login.
    res.cookie('__s_t', token, {
      httpOnly: false,
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
      'SELECT id, display_name, admin_username, db_name, status, public_api_enabled, created_at, updated_at FROM organizations ORDER BY created_at DESC'
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
    if (req.body.public_api_enabled !== undefined) { updates.push('public_api_enabled = ?'); params.push(req.body.public_api_enabled ? 1 : 0); }

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
    const [[leaseCount]] = await orgPool.execute('SELECT COUNT(*) as count FROM leasing WHERE deleted_at IS NULL AND start_date <= CURDATE() AND (end_date >= CURDATE() OR end_date IS NULL)');

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

// ─── API Key Management ─────────────────────────────────

const crypto = require('crypto');

// GET /api/master/api-keys - List all API keys (with org name)
router.get('/api-keys', authenticateMaster, async (req, res) => {
  try {
    const masterPool = getMasterPool();
    const [keys] = await masterPool.execute(
      `SELECT k.id, k.org_id, k.api_key, k.name, k.status, k.created_at, k.last_used_at,
              o.display_name AS org_name
       FROM api_keys k
       LEFT JOIN organizations o ON k.org_id = o.id
       ORDER BY k.created_at DESC`
    );
    res.json({ code: 200, data: keys });
  } catch (error) {
    console.error('List API keys error:', error);
    res.status(500).json({ code: 500, message: 'Server error' });
  }
});

// POST /api/master/api-keys - Create a new API key
router.post('/api-keys', authenticateMaster, async (req, res) => {
  try {
    const { org_id, name } = req.body;
    if (!org_id) {
      return res.status(400).json({ code: 400, message: 'org_id is required' });
    }

    const masterPool = getMasterPool();

    // Verify org exists
    const [orgs] = await masterPool.execute('SELECT id FROM organizations WHERE id = ?', [org_id]);
    if (!orgs.length) {
      return res.status(404).json({ code: 404, message: 'Organization not found' });
    }

    const id = (BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000))).toString();
    const apiKey = 'pk_' + crypto.randomBytes(32).toString('hex');

    await masterPool.execute(
      'INSERT INTO api_keys (id, org_id, api_key, name, status, created_at) VALUES (?, ?, ?, ?, 1, NOW())',
      [id, org_id, apiKey, name || 'Default']
    );

    res.json({ code: 200, data: { id, api_key: apiKey, name: name || 'Default' } });
  } catch (error) {
    console.error('Create API key error:', error);
    res.status(500).json({ code: 500, message: 'Server error' });
  }
});

// PUT /api/master/api-keys/:id - Update API key (name, status)
router.put('/api-keys/:id', authenticateMaster, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, status } = req.body;
    const masterPool = getMasterPool();

    const updates = [];
    const params = [];
    if (name !== undefined) { updates.push('name = ?'); params.push(name); }
    if (status !== undefined) { updates.push('status = ?'); params.push(status); }

    if (!updates.length) return res.status(400).json({ code: 400, message: 'Nothing to update' });

    params.push(id);
    await masterPool.execute(`UPDATE api_keys SET ${updates.join(', ')} WHERE id = ?`, params);

    res.json({ code: 200, message: 'API key updated' });
  } catch (error) {
    console.error('Update API key error:', error);
    res.status(500).json({ code: 500, message: 'Server error' });
  }
});

// DELETE /api/master/api-keys/:id - Delete API key
router.delete('/api-keys/:id', authenticateMaster, async (req, res) => {
  try {
    const { id } = req.params;
    const masterPool = getMasterPool();
    await masterPool.execute('DELETE FROM api_keys WHERE id = ?', [id]);
    res.json({ code: 200, message: 'API key deleted' });
  } catch (error) {
    console.error('Delete API key error:', error);
    res.status(500).json({ code: 500, message: 'Server error' });
  }
});

module.exports = router;
