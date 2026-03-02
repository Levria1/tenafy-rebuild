const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const pool = require('../config/database');
const config = require('../config');

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    const [users] = await pool.execute(
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

    const [[org]] = await pool.execute('SELECT type FROM organization WHERE id = ?', [user.org_id]);

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

    res.json({ code: 200, message: 'Login successful', data: { token, orgType: org?.type } });
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

// POST /api/auth/register
router.post('/register', async (req, res) => {
  try {
    const { username, email, password, firstName, lastName, orgName, orgSubdomain } = req.body;
    
    const [existing] = await pool.execute(
      'SELECT id FROM user WHERE username = ? OR email = ?',
      [username, email]
    );
    
    if (existing.length > 0) {
      return res.status(400).json({ code: 9001, message: 'Username or email already exists' });
    }
    
    const hashedPassword = await bcrypt.hash(password, 10);
    
    const [orgResult] = await pool.execute(
      'INSERT INTO organization (display_name, subdomain, type, created_at) VALUES (?, ?, ?, NOW())',
      [orgName || username, orgSubdomain || username, 1]
    );
    
    const orgId = orgResult.insertId;
    
    const [userResult] = await pool.execute(
      'INSERT INTO user (org_id, username, password, email, first_name, last_name, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, NOW())',
      [orgId, username, '{bcrypt}' + hashedPassword, email, firstName || username, lastName || username]
    );
    
    res.json({ code: 200, message: 'Registration successful', data: { userId: userResult.insertId, orgId } });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ code: 500, message: 'Registration failed' });
  }
});

// POST /api/auth/forget-password/initialize
router.post('/forget-password/initialize', async (req, res) => {
  try {
    const { email } = req.body;
    
    const [users] = await pool.execute('SELECT id, status FROM user WHERE email = ?', [email]);
    
    if (users.length === 0) {
      return res.status(404).json({ code: 4001, message: 'Invalid mailbox' });
    }
    
    if (users[0].status !== 1) {
      return res.status(400).json({ code: 4002, message: 'The user status is invalid' });
    }
    
    const resetCode = Math.floor(100000 + Math.random() * 900000);
    
    await pool.execute(
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
    const { code } = req.body;
    
    const [tokens] = await pool.execute(
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
    const { code, password } = req.body;
    
    const [tokens] = await pool.execute(
      'SELECT user_id FROM password_reset_token WHERE code = ? AND expires_at > NOW() AND used = 0',
      [code]
    );
    
    if (tokens.length === 0) {
      return res.status(400).json({ code: 4003, message: 'Invalid or expired code' });
    }
    
    const hashedPassword = await bcrypt.hash(password, 10);
    
    await pool.execute(
      'UPDATE user SET password = ? WHERE id = ?',
      ['{bcrypt}' + hashedPassword, tokens[0].user_id]
    );
    
    await pool.execute('UPDATE password_reset_token SET used = 1 WHERE code = ?', [code]);
    
    res.json({ code: 200, message: 'Password reset successful' });
  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({ code: 500, message: 'Failed to reset password' });
  }
});

// POST /api/auth/password/change - Change password (authenticated)
router.post('/password/change', async (req, res) => {
  try {
    const { currentPassword, newPassword, userId } = req.body;

    const [users] = await pool.execute('SELECT id, password FROM user WHERE id = ?', [userId]);
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
    await pool.execute('UPDATE user SET password = ?, updated_at = NOW() WHERE id = ?', ['{bcrypt}' + hashedPassword, userId]);

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
    const newCode = Math.random().toString(36).substring(2, 8).toUpperCase();
    await pool.execute('UPDATE user SET activation_code = ? WHERE email = ? OR username = ?', [newCode, account, account]);
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
    const [users] = await pool.execute('SELECT * FROM user WHERE activation_code = ? AND status = 0', [code]);
    if (users.length === 0) return res.status(400).json({ code: 400, message: 'Invalid or expired activation code' });
    await pool.execute('UPDATE user SET status = 1, activation_code = NULL WHERE activation_code = ?', [code]);
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
    const [users] = await pool.execute('SELECT id, username, email FROM user WHERE invite_code = ? AND status = 0', [code]);
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
    const { code, password } = req.body;
    const bcrypt = require('bcryptjs');
    const hashed = await bcrypt.hash(password, 10);
    const [result] = await pool.execute(
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