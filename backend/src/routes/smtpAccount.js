const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');

const nodemailer = require('nodemailer');

// POST /api/smtp-account/list - List SMTP accounts (passwords masked)
router.post('/list', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const [rows] = await req.pool.execute(
      `SELECT id, email, display_name, host, port, is_secure, is_default, status, created_at
       FROM smtp_account WHERE org_id = ? ORDER BY is_default DESC, created_at ASC`,
      [orgId]
    );

    // Convert BIT fields
    const accounts = rows.map(r => ({
      ...r,
      is_secure: Buffer.isBuffer(r.is_secure) ? r.is_secure[0] === 1 : Boolean(r.is_secure),
      is_default: Buffer.isBuffer(r.is_default) ? r.is_default[0] === 1 : Boolean(r.is_default),
    }));

    res.json({ code: 200, data: accounts });
  } catch (error) {
    console.error('List SMTP accounts error:', error);
    res.status(500).json({ code: 500, message: 'Failed to list SMTP accounts' });
  }
});

// POST /api/smtp-account - Create SMTP account
router.post('/', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { email, password, display_name, host, port, is_secure, is_default } = req.body;

    if (!email || !password) {
      return res.status(400).json({ code: 400, message: 'Email and password are required' });
    }

    const id = BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000));

    // If setting as default, unset other defaults
    if (is_default) {
      await req.pool.execute(
        'UPDATE smtp_account SET is_default = 0 WHERE org_id = ?',
        [orgId]
      );
    }

    await req.pool.execute(
      `INSERT INTO smtp_account (id, org_id, email, password, display_name, host, port, is_secure, is_default, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        id.toString(), orgId, email, password,
        display_name || null,
        host || 'smtp.titan.email',
        port || 465,
        is_secure !== false ? 1 : 0,
        is_default ? 1 : 0,
      ]
    );

    res.json({ code: 200, message: 'SMTP account created', data: { id: id.toString() } });
  } catch (error) {
    console.error('Create SMTP account error:', error);
    res.status(500).json({ code: 500, message: 'Failed to create SMTP account' });
  }
});

// PUT /api/smtp-account/:id - Update SMTP account
router.put('/:id', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { id } = req.params;
    const { email, password, display_name, host, port, is_secure, is_default } = req.body;

    // If setting as default, unset other defaults
    if (is_default) {
      await req.pool.execute(
        'UPDATE smtp_account SET is_default = 0 WHERE org_id = ? AND id != ?',
        [orgId, id]
      );
    }

    // Build dynamic update — only update password if provided
    const fields = [];
    const params = [];

    if (email !== undefined) { fields.push('email = ?'); params.push(email); }
    if (password) { fields.push('password = ?'); params.push(password); }
    if (display_name !== undefined) { fields.push('display_name = ?'); params.push(display_name || null); }
    if (host !== undefined) { fields.push('host = ?'); params.push(host || 'smtp.titan.email'); }
    if (port !== undefined) { fields.push('port = ?'); params.push(port || 465); }
    if (is_secure !== undefined) { fields.push('is_secure = ?'); params.push(is_secure ? 1 : 0); }
    if (is_default !== undefined) { fields.push('is_default = ?'); params.push(is_default ? 1 : 0); }

    if (fields.length === 0) {
      return res.status(400).json({ code: 400, message: 'No fields to update' });
    }

    params.push(id, orgId);
    await req.pool.execute(
      `UPDATE smtp_account SET ${fields.join(', ')} WHERE id = ? AND org_id = ?`,
      params
    );

    res.json({ code: 200, message: 'SMTP account updated' });
  } catch (error) {
    console.error('Update SMTP account error:', error);
    res.status(500).json({ code: 500, message: 'Failed to update SMTP account' });
  }
});

// DELETE /api/smtp-account/:id - Delete SMTP account
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { id } = req.params;

    await req.pool.execute(
      'DELETE FROM smtp_account WHERE id = ? AND org_id = ?',
      [id, orgId]
    );

    res.json({ code: 200, message: 'SMTP account deleted' });
  } catch (error) {
    console.error('Delete SMTP account error:', error);
    res.status(500).json({ code: 500, message: 'Failed to delete SMTP account' });
  }
});

// POST /api/smtp-account/test - Test SMTP connection (doesn't save)
router.post('/test', authenticate, async (req, res) => {
  try {
    const { email, password, host, port, is_secure } = req.body;

    if (!email || !password) {
      return res.status(400).json({ code: 400, message: 'Email and password are required' });
    }

    const transport = nodemailer.createTransport({
      host: host || 'smtp.titan.email',
      port: parseInt(port) || 465,
      secure: is_secure !== false,
      auth: { user: email, pass: password },
      connectionTimeout: 10000,
    });

    await transport.verify();
    transport.close();

    res.json({ code: 200, message: 'Connection successful' });
  } catch (error) {
    console.error('SMTP test error:', error.message);
    res.status(400).json({ code: 400, message: `Connection failed: ${error.message}` });
  }
});

module.exports = router;
