const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const pool = require('../config/database');

// GET /api/setting/category/list - Get categories
router.get('/setting/category/list', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const [categories] = await pool.execute(
      'SELECT id, name, org_id, CAST(enabled AS UNSIGNED) as enabled, updated_at FROM category_setting WHERE org_id = ? AND enabled = 1 ORDER BY name',
      [orgId]
    );
    res.json({ code: 200, data: categories });
  } catch (error) {
    console.error('Get categories error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get categories' });
  }
});

// POST /api/setting/category/add - Create category
router.post('/setting/category/add', authenticate, async (req, res) => {
  try {
    const { name } = req.body;
    const orgId = req.user.orgId;
    const [result] = await pool.execute(
      'INSERT INTO category_setting (org_id, name, enabled, updated_at) VALUES (?, ?, 1, NOW())',
      [orgId, name]
    );
    res.json({ code: 200, message: 'Category created', data: { id: result.insertId } });
  } catch (error) {
    console.error('Create category error:', error);
    res.status(500).json({ code: 500, message: 'Failed to create category' });
  }
});

// PUT /api/setting/category/update/:id - Update category
router.put('/setting/category/update/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { name } = req.body;
    const orgId = req.user.orgId;
    await pool.execute(
      'UPDATE category_setting SET name = ?, updated_at = NOW() WHERE id = ? AND org_id = ?',
      [name, id, orgId]
    );
    res.json({ code: 200, message: 'Category updated' });
  } catch (error) {
    console.error('Update category error:', error);
    res.status(500).json({ code: 500, message: 'Failed to update category' });
  }
});

// DELETE /api/setting/category/delete/:id - Delete category
router.delete('/setting/category/delete/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;
    await pool.execute(
      'UPDATE category_setting SET enabled = 0 WHERE id = ? AND org_id = ?',
      [id, orgId]
    );
    res.json({ code: 200, message: 'Category deleted' });
  } catch (error) {
    console.error('Delete category error:', error);
    res.status(500).json({ code: 500, message: 'Failed to delete category' });
  }
});

// GET /api/setting/payment/list - Get payment methods
router.get('/setting/payment/list', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const [payments] = await pool.execute(
      'SELECT id, payment_method as name, org_id, enabled, updated_at FROM payment_method_setting WHERE org_id = ? AND enabled = 1 ORDER BY payment_method',
      [orgId]
    );
    res.json({ code: 200, data: payments });
  } catch (error) {
    console.error('Get payment methods error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get payment methods' });
  }
});

// POST /api/setting/payment/add - Create payment method
router.post('/setting/payment/add', authenticate, async (req, res) => {
  try {
    const { name } = req.body;
    const orgId = req.user.orgId;
    const [result] = await pool.execute(
      'INSERT INTO payment_method_setting (org_id, payment_method, enabled, updated_at) VALUES (?, ?, 1, NOW())',
      [orgId, name]
    );
    res.json({ code: 200, message: 'Payment method created', data: { id: result.insertId } });
  } catch (error) {
    console.error('Create payment method error:', error);
    res.status(500).json({ code: 500, message: 'Failed to create payment method' });
  }
});

// PUT /api/setting/payment/update/:id - Update payment method
router.put('/setting/payment/update/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { name } = req.body;
    const orgId = req.user.orgId;
    await pool.execute(
      'UPDATE payment_method_setting SET payment_method = ?, updated_at = NOW() WHERE id = ? AND org_id = ?',
      [name, id, orgId]
    );
    res.json({ code: 200, message: 'Payment method updated' });
  } catch (error) {
    console.error('Update payment method error:', error);
    res.status(500).json({ code: 500, message: 'Failed to update payment method' });
  }
});

// DELETE /api/setting/payment/delete/:id - Delete payment method
router.delete('/setting/payment/delete/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;
    await pool.execute(
      'UPDATE payment_method_setting SET enabled = 0 WHERE id = ? AND org_id = ?',
      [id, orgId]
    );
    res.json({ code: 200, message: 'Payment method deleted' });
  } catch (error) {
    console.error('Delete payment method error:', error);
    res.status(500).json({ code: 500, message: 'Failed to delete payment method' });
  }
});

// GET /api/setting/category/page/list - Get categories with paging
router.get('/setting/category/page/list', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { search } = req.query;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    let whereClause = 'org_id = ? AND enabled = 1';
    const params = [orgId];
    if (search) {
      whereClause += ' AND name LIKE ?';
      params.push('%' + search + '%');
    }

    const [categories] = await pool.execute(
      'SELECT * FROM category_setting WHERE ' + whereClause + ' ORDER BY name LIMIT ' + limit + ' OFFSET ' + offset,
      params
    );
    const [[{ total }]] = await pool.execute(
      'SELECT COUNT(*) as total FROM category_setting WHERE ' + whereClause,
      params
    );
    res.json({ code: 200, data: { content: categories, totalElements: total } });
  } catch (error) {
    console.error('Get categories paginated error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get categories' });
  }
});

// GET /api/setting/category/list/tenant - Get tenant-specific categories
router.get('/setting/category/list/tenant', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const [categories] = await pool.execute(
      "SELECT * FROM category_setting WHERE org_id = ? AND enabled = 1 AND type = 'tenant' ORDER BY name",
      [orgId]
    );
    res.json({ code: 200, data: categories });
  } catch (error) {
    console.error('Get tenant categories error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get categories' });
  }
});

// ─── LANDLORD / ORGANIZATION SETTINGS ────────────────────────────────────────

// GET /api/setting/landlord - Get landlord/org info
router.get('/setting/landlord', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const [orgs] = await pool.execute(
      'SELECT * FROM organization WHERE id = ?',
      [orgId]
    );
    if (orgs.length === 0) {
      return res.status(404).json({ code: 404, message: 'Organization not found' });
    }
    res.json({ code: 200, data: orgs[0] });
  } catch (error) {
    console.error('Get landlord error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get landlord info' });
  }
});

// PUT /api/setting/landlord/update - Update landlord/org general info
router.put('/setting/landlord/update', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { display_name, address, city, state, country, zip_code, phone, email, currency, invoice_prefix, tax_id } = req.body;

    await pool.execute(
      `UPDATE organization SET display_name = ?, address = ?, city = ?, state = ?, country = ?,
       zip_code = ?, phone = ?, email = ?, currency = ?, invoice_prefix = ?, tax_id = ?, updated_at = NOW()
       WHERE id = ?`,
      [display_name, address, city, state, country, zip_code, phone, email, currency, invoice_prefix, tax_id, orgId]
    );
    res.json({ code: 200, message: 'Organization updated' });
  } catch (error) {
    console.error('Update landlord error:', error);
    res.status(500).json({ code: 500, message: 'Failed to update organization' });
  }
});

// GET /api/setting/currency - Get currency settings
router.get('/setting/currency', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const [orgs] = await pool.execute('SELECT currency FROM organization WHERE id = ?', [orgId]);
    const currency = orgs.length > 0 ? orgs[0].currency : 'USD';
    res.json({ code: 200, data: { currency } });
  } catch (error) {
    console.error('Get currency error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get currency' });
  }
});

// GET /api/setting/country - Get country list
router.get('/setting/country', authenticate, async (req, res) => {
  try {
    const countries = [
      { code: 'US', name: 'United States' },
      { code: 'GB', name: 'United Kingdom' },
      { code: 'AU', name: 'Australia' },
      { code: 'SG', name: 'Singapore' },
      { code: 'MY', name: 'Malaysia' },
      { code: 'ID', name: 'Indonesia' },
      { code: 'TH', name: 'Thailand' },
      { code: 'PH', name: 'Philippines' },
      { code: 'VN', name: 'Vietnam' },
      { code: 'CN', name: 'China' },
      { code: 'JP', name: 'Japan' },
      { code: 'KR', name: 'South Korea' },
      { code: 'IN', name: 'India' },
      { code: 'CA', name: 'Canada' },
      { code: 'NZ', name: 'New Zealand' },
    ];
    res.json({ code: 200, data: countries });
  } catch (error) {
    console.error('Get countries error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get countries' });
  }
});

// GET /api/setting/exchange-rate - Get exchange rate
router.get('/setting/exchange-rate', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const [orgs] = await pool.execute('SELECT currency, exchange_rate FROM organization WHERE id = ?', [orgId]);
    res.json({ code: 200, data: orgs[0] || { currency: 'USD', exchange_rate: 1 } });
  } catch (error) {
    console.error('Get exchange rate error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get exchange rate' });
  }
});

// PUT /api/setting/landlord/exchange-rate/update - Update exchange rate
router.put('/setting/landlord/exchange-rate/update', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { exchange_rate } = req.query;
    await pool.execute(
      'UPDATE organization SET exchange_rate = ?, updated_at = NOW() WHERE id = ?',
      [exchange_rate, orgId]
    );
    res.json({ code: 200, message: 'Exchange rate updated' });
  } catch (error) {
    console.error('Update exchange rate error:', error);
    res.status(500).json({ code: 500, message: 'Failed to update exchange rate' });
  }
});

// GET /api/setting/landlord/exchange-rate/history - Exchange rate history
router.get('/setting/landlord/exchange-rate/history', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    // Return empty list for now - exchange rate history would need a separate table
    res.json({ code: 200, data: { content: [], totalElements: 0 } });
  } catch (error) {
    console.error('Get exchange rate history error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get exchange rate history' });
  }
});

// ─── SEQUENCE SETTINGS ────────────────────────────────────────────────────────

// GET /api/setting/sequences - Get sequence list
router.get('/setting/sequences', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const [sequences] = await pool.execute(
      'SELECT id, org_id, `key`, name, pattern, seq_start, seq_next, seq_reset_cycle, updated_at FROM sequence WHERE org_id = ? ORDER BY name',
      [orgId]
    );
    res.json({ code: 200, data: sequences });
  } catch (error) {
    console.error('Get sequences error:', error);
    // Return defaults if table query fails
    res.json({ code: 200, data: [
      { id: 1, name: 'Invoice Code', key: 'invoice_code', pattern: 'INV{#,010}', seq_next: 1 },
      { id: 2, name: 'Lease Code', key: 'leasing_code', pattern: 'LSE{#,010}', seq_next: 1 },
      { id: 3, name: 'Transaction Code', key: 'transaction_code', pattern: 'TXN{#,010}', seq_next: 1 },
    ]});
  }
});

// PUT /api/setting/sequence/:id - Update sequence
router.put('/setting/sequence/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;
    const { pattern, seq_next } = req.body;
    await pool.execute(
      'UPDATE sequence SET pattern = ?, seq_next = ?, updated_at = NOW() WHERE id = ? AND org_id = ?',
      [pattern, seq_next, id, orgId]
    );
    res.json({ code: 200, message: 'Sequence updated' });
  } catch (error) {
    console.error('Update sequence error:', error);
    res.status(500).json({ code: 500, message: 'Failed to update sequence' });
  }
});

// ─── ACCOUNT SETTINGS ────────────────────────────────────────────────────────

// GET /api/setting/account/list - Get account settings list
router.get('/setting/account/list', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const [accounts] = await pool.execute(
      'SELECT * FROM account_setting WHERE org_id = ? AND enabled = 1 ORDER BY name',
      [orgId]
    );
    res.json({ code: 200, data: accounts });
  } catch (error) {
    console.error('Get account settings error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get account settings' });
  }
});

// GET /api/setting/account/page/list - Get account settings with paging
router.get('/setting/account/page/list', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    const [accounts] = await pool.execute(
      'SELECT * FROM account_setting WHERE org_id = ? AND enabled = 1 ORDER BY name LIMIT ' + limit + ' OFFSET ' + offset,
      [orgId]
    );
    const [[{ total }]] = await pool.execute(
      'SELECT COUNT(*) as total FROM account_setting WHERE org_id = ? AND enabled = 1',
      [orgId]
    );
    res.json({ code: 200, data: { content: accounts, totalElements: total } });
  } catch (error) {
    console.error('Get account settings paginated error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get account settings' });
  }
});

// POST /api/setting/account/add - Create account setting
router.post('/setting/account/add', authenticate, async (req, res) => {
  try {
    const { name } = req.body;
    const orgId = req.user.orgId;
    const [result] = await pool.execute(
      'INSERT INTO account_setting (org_id, name, enabled, created_at) VALUES (?, ?, 1, NOW())',
      [orgId, name]
    );
    res.json({ code: 200, message: 'Account setting created', data: { id: result.insertId } });
  } catch (error) {
    console.error('Create account setting error:', error);
    res.status(500).json({ code: 500, message: 'Failed to create account setting' });
  }
});

// PUT /api/setting/account/update/:id - Update account setting
router.put('/setting/account/update/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { name } = req.body;
    const orgId = req.user.orgId;
    await pool.execute(
      'UPDATE account_setting SET name = ?, updated_at = NOW() WHERE id = ? AND org_id = ?',
      [name, id, orgId]
    );
    res.json({ code: 200, message: 'Account setting updated' });
  } catch (error) {
    console.error('Update account setting error:', error);
    res.status(500).json({ code: 500, message: 'Failed to update account setting' });
  }
});

// DELETE /api/setting/account/delete/:id - Delete account setting
router.delete('/setting/account/delete/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;
    await pool.execute(
      'UPDATE account_setting SET enabled = 0 WHERE id = ? AND org_id = ?',
      [id, orgId]
    );
    res.json({ code: 200, message: 'Account setting deleted' });
  } catch (error) {
    console.error('Delete account setting error:', error);
    res.status(500).json({ code: 500, message: 'Failed to delete account setting' });
  }
});

module.exports = router;