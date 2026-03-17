const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const config = require('../config');
const { getMasterPool, getOrgPool } = require('../config/poolRegistry');
const { authenticate } = require('../middleware/auth');

// Helper: look up org pool by username via master DB org_user_map
async function resolveOrgByUsername(username) {
  const masterPool = getMasterPool();
  const [rows] = await masterPool.execute(
    'SELECT org_id, db_name FROM org_user_map WHERE username = ?',
    [username]
  );
  if (!rows.length) return null;
  const orgPool = await getOrgPool(rows[0].org_id);
  return { orgId: rows[0].org_id, dbName: rows[0].db_name, pool: orgPool };
}

// Helper: look up org pool by email via master DB org_user_map
async function resolveOrgByEmail(email) {
  const masterPool = getMasterPool();
  const [rows] = await masterPool.execute(
    'SELECT org_id, db_name FROM org_user_map WHERE email = ?',
    [email]
  );
  if (!rows.length) return null;
  const orgPool = await getOrgPool(rows[0].org_id);
  return { orgId: rows[0].org_id, dbName: rows[0].db_name, pool: orgPool };
}

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    // 1. Resolve org from master DB
    const orgInfo = await resolveOrgByUsername(username);
    if (!orgInfo) {
      return res.status(401).json({ code: 9000, message: 'Login failed: Bad username or password' });
    }

    const orgPool = orgInfo.pool;

    // 2. Look up user in org database
    const [users] = await orgPool.execute(
      'SELECT id, username, password, email, org_id, first_name, last_name, status FROM user WHERE username = ?',
      [username]
    );

    if (users.length === 0) {
      return res.status(401).json({ code: 9000, message: 'Login failed: Bad username or password' });
    }

    const user = users[0];

    if (user.status !== 1) {
      return res.status(401).json({ code: 9010, message: 'The user status is invalid' });
    }

    let storedHash = user.password;
    if (storedHash.startsWith('{bcrypt}')) {
      storedHash = storedHash.replace('{bcrypt}', '');
    }
    if (storedHash.startsWith('$2a$')) {
      storedHash = storedHash.replace('$2a$', '$2b$');
    }

    const isValidPassword = await bcrypt.compare(password, storedHash);

    if (!isValidPassword) {
      return res.status(401).json({ code: 9000, message: 'Login failed: Bad username or password' });
    }

    const [[org]] = await orgPool.execute('SELECT type FROM organization WHERE id = ?', [user.org_id]);

    const token = jwt.sign(
      { id: user.id, username: user.username, orgId: user.org_id, orgType: org?.type },
      config.jwtSecret,
      { expiresIn: config.jwtExpiresIn }
    );

    res.cookie('__s_t', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      maxAge: 7200 * 1000
    });

    // Fetch user permissions
    let permissions = [];
    if (Number(org?.type) === 6) {
      permissions = ['*'];
    } else {
      const [perms] = await orgPool.execute(
        `SELECT rp.permission_code FROM role_permission rp
         JOIN user_role ur ON rp.role_id = ur.role_id
         WHERE ur.user_id = ?`,
        [user.id]
      );
      permissions = perms.map(p => p.permission_code);
    }

    res.json({ code: 200, message: 'Login successful', data: { token, orgType: org?.type, permissions } });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ code: 500, message: 'Login failed' });
  }
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  res.clearCookie('__s_t');
  res.json({ code: 200, message: 'Logged out successfully' });
});

// POST /api/auth/register — disabled in multi-org mode (orgs provisioned by master admin)
router.post('/register', async (req, res) => {
  res.status(403).json({ code: 403, message: 'Self-registration is disabled. Contact your administrator.' });
});

// POST /api/auth/forget-password/initialize
router.post('/forget-password/initialize', async (req, res) => {
  try {
    const { email } = req.body;

    const orgInfo = await resolveOrgByEmail(email);
    if (!orgInfo) {
      return res.status(404).json({ code: 4001, message: 'Invalid mailbox' });
    }

    const orgPool = orgInfo.pool;
    const [users] = await orgPool.execute('SELECT id, status FROM user WHERE email = ?', [email]);

    if (users.length === 0) {
      return res.status(404).json({ code: 4001, message: 'Invalid mailbox' });
    }

    if (users[0].status !== 1) {
      return res.status(400).json({ code: 4002, message: 'The user status is invalid' });
    }

    const resetCode = Math.floor(100000 + Math.random() * 900000);

    await orgPool.execute(
      'INSERT INTO password_reset_token (user_id, code, expires_at, created_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 1 HOUR), NOW())',
      [users[0].id, resetCode]
    );

    console.log(`Password reset code for ${email}: ${resetCode}`);

    res.json({ code: 200, message: 'Password reset code sent' });
  } catch (error) {
    console.error('Forget password error:', error);
    res.status(500).json({ code: 500, message: 'Failed to process request' });
  }
});

// POST /api/auth/forget-password/validate
router.post('/forget-password/validate', async (req, res) => {
  try {
    const { code, email } = req.body;

    // Need email to resolve org (code alone can't tell us which DB)
    if (!email) {
      return res.status(400).json({ code: 400, message: 'Email is required' });
    }

    const orgInfo = await resolveOrgByEmail(email);
    if (!orgInfo) {
      return res.status(400).json({ code: 4003, message: 'Invalid or expired code' });
    }

    const orgPool = orgInfo.pool;
    const [tokens] = await orgPool.execute(
      'SELECT user_id FROM password_reset_token WHERE code = ? AND expires_at > NOW() AND used = 0',
      [code]
    );

    if (tokens.length === 0) {
      return res.status(400).json({ code: 4003, message: 'Invalid or expired code' });
    }

    res.json({ code: 200, message: 'Code valid', data: { userId: tokens[0].user_id } });
  } catch (error) {
    console.error('Validate code error:', error);
    res.status(500).json({ code: 500, message: 'Failed to validate code' });
  }
});

// POST /api/auth/forget-password/reset
router.post('/forget-password/reset', async (req, res) => {
  try {
    const { code, password, email } = req.body;

    if (!email) {
      return res.status(400).json({ code: 400, message: 'Email is required' });
    }

    const orgInfo = await resolveOrgByEmail(email);
    if (!orgInfo) {
      return res.status(400).json({ code: 4003, message: 'Invalid or expired code' });
    }

    const orgPool = orgInfo.pool;
    const [tokens] = await orgPool.execute(
      'SELECT user_id FROM password_reset_token WHERE code = ? AND expires_at > NOW() AND used = 0',
      [code]
    );

    if (tokens.length === 0) {
      return res.status(400).json({ code: 4003, message: 'Invalid or expired code' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    await orgPool.execute(
      'UPDATE user SET password = ? WHERE id = ?',
      ['{bcrypt}' + hashedPassword, tokens[0].user_id]
    );

    await orgPool.execute('UPDATE password_reset_token SET used = 1 WHERE code = ?', [code]);

    res.json({ code: 200, message: 'Password reset successful' });
  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({ code: 500, message: 'Failed to reset password' });
  }
});

// POST /api/auth/password/change - Change password (authenticated, uses req.pool)
router.post('/password/change', authenticate, async (req, res) => {
  try {
    const { currentPassword, newPassword, userId } = req.body;

    const [users] = await req.pool.execute('SELECT id, password FROM user WHERE id = ?', [userId]);
    if (users.length === 0) {
      return res.status(404).json({ code: 404, message: 'User not found' });
    }

    let storedHash = users[0].password;
    if (storedHash.startsWith('{bcrypt}')) storedHash = storedHash.replace('{bcrypt}', '');
    if (storedHash.startsWith('$2a$')) storedHash = storedHash.replace('$2a$', '$2b$');

    const isValid = await bcrypt.compare(currentPassword, storedHash);
    if (!isValid) {
      return res.status(400).json({ code: 4004, message: 'Current password is incorrect' });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await req.pool.execute('UPDATE user SET password = ?, updated_at = NOW() WHERE id = ?', ['{bcrypt}' + hashedPassword, userId]);

    res.json({ code: 200, message: 'Password changed successfully' });
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({ code: 500, message: 'Failed to change password' });
  }
});

// POST /api/auth/activate/code/resend/:account - Resend verification email
router.post('/activate/code/resend/:account', async (req, res) => {
  try {
    const { account } = req.params;
    const orgInfo = await resolveOrgByUsername(account) || await resolveOrgByEmail(account);
    if (!orgInfo) return res.status(404).json({ code: 404, message: 'Account not found' });

    const orgPool = orgInfo.pool;
    const newCode = Math.random().toString(36).substring(2, 8).toUpperCase();
    await orgPool.execute('UPDATE user SET activation_code = ? WHERE email = ? OR username = ?', [newCode, account, account]);
    try {
      const { sendMail } = require('../config/mailer');
      await sendMail({ to: account, subject: 'Your activation code', html: `<p>Your new activation code is: <strong>${newCode}</strong></p>` });
    } catch (e) { console.error('Send activation email error:', e); }
    res.json({ code: 200, message: 'Activation code resent' });
  } catch (error) {
    console.error('Resend activation error:', error);
    res.status(500).json({ code: 500, message: 'Failed to resend activation code' });
  }
});

// POST /api/auth/activate/:code - Activate account by code
router.post('/activate/:code', async (req, res) => {
  try {
    const { code } = req.params;
    // We need to check all org databases — but since activation codes are unique, query master for user
    // For simplicity, try all active orgs (or require email in body)
    const { email } = req.body || {};
    if (!email) {
      return res.status(400).json({ code: 400, message: 'Email is required for activation' });
    }
    const orgInfo = await resolveOrgByEmail(email);
    if (!orgInfo) return res.status(400).json({ code: 400, message: 'Invalid activation' });

    const orgPool = orgInfo.pool;
    const [users] = await orgPool.execute('SELECT * FROM user WHERE activation_code = ? AND status = 0', [code]);
    if (users.length === 0) return res.status(400).json({ code: 400, message: 'Invalid or expired activation code' });
    await orgPool.execute('UPDATE user SET status = 1, activation_code = NULL WHERE activation_code = ?', [code]);
    res.json({ code: 200, message: 'Account activated successfully' });
  } catch (error) {
    console.error('Activate account error:', error);
    res.status(500).json({ code: 500, message: 'Failed to activate account' });
  }
});

// POST /api/auth/user/validate/:code - Validate sub-user invite code
router.post('/user/validate/:code', async (req, res) => {
  try {
    const { code } = req.params;
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ code: 400, message: 'Email is required' });

    const orgInfo = await resolveOrgByEmail(email);
    if (!orgInfo) return res.status(400).json({ code: 400, message: 'Invalid invite code' });

    const orgPool = orgInfo.pool;
    const [users] = await orgPool.execute('SELECT id, username, email FROM user WHERE invite_code = ? AND status = 0', [code]);
    if (users.length === 0) return res.status(400).json({ code: 400, message: 'Invalid invite code' });
    res.json({ code: 200, data: users[0] });
  } catch (error) {
    console.error('Validate sub-user code error:', error);
    res.status(500).json({ code: 500, message: 'Failed to validate code' });
  }
});

// POST /api/auth/user/activate - Activate sub-user with invite code + set password
router.post('/user/activate', async (req, res) => {
  try {
    const { code, password, email } = req.body;
    if (!email) return res.status(400).json({ code: 400, message: 'Email is required' });

    const orgInfo = await resolveOrgByEmail(email);
    if (!orgInfo) return res.status(400).json({ code: 400, message: 'Invalid invite code' });

    const orgPool = orgInfo.pool;
    const hashed = await bcrypt.hash(password, 10);
    const [result] = await orgPool.execute(
      'UPDATE user SET password = ?, status = 1, invite_code = NULL WHERE invite_code = ? AND status = 0',
      [hashed, code]
    );
    if (result.affectedRows === 0) return res.status(400).json({ code: 400, message: 'Invalid or already used invite code' });
    res.json({ code: 200, message: 'Account activated successfully' });
  } catch (error) {
    console.error('Activate sub-user error:', error);
    res.status(500).json({ code: 500, message: 'Failed to activate account' });
  }
});

module.exports = router;
