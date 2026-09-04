const express = require('express');
const { bitToBool } = require('../utils/mysqlBit');
const router = express.Router();
const crypto = require('crypto');
const { authenticate, requireSuperAdmin, requirePermission } = require('../middleware/auth');
const { getMasterPool } = require('../config/poolRegistry');
const { logActivity } = require('../utils/activityLog');
const { loadChaseSettings, serialiseCategories, CHASE_DEFAULTS } = require('../utils/chaseSettings');
const genId = () => (BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000))).toString();


// ---------------------------------------------------------------------------
// Email Settings (whitelist)
// ---------------------------------------------------------------------------

// GET /api/user/setting/email - Get email whitelist settings
router.get('/setting/email', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const [[org]] = await req.pool.execute(
      'SELECT email_whitelist_enabled, email_whitelist FROM organization WHERE id = ?',
      [orgId]
    );
    if (!org) return res.json({ code: 404, message: 'Organization not found' });

    // Convert BIT to boolean
    const enabled = bitToBool(org.email_whitelist_enabled);

    res.json({
      code: 200,
      data: {
        email_whitelist_enabled: enabled,
        email_whitelist: org.email_whitelist || '',
      },
    });
  } catch (err) {
    console.error('Get email settings error:', err);
    res.status(500).json({ code: 500, message: err.message });
  }
});

// PUT /api/user/setting/email - Update email whitelist settings
router.put('/setting/email', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { email_whitelist_enabled, email_whitelist } = req.body;

    await req.pool.execute(
      'UPDATE organization SET email_whitelist_enabled = ?, email_whitelist = ? WHERE id = ?',
      [email_whitelist_enabled ? 1 : 0, email_whitelist || null, orgId]
    );

    res.json({ code: 200, message: 'Email settings updated' });
  } catch (err) {
    console.error('Update email settings error:', err);
    res.status(500).json({ code: 500, message: err.message });
  }
});

// ---------------------------------------------------------------------------
// WhatsApp Settings (whitelist) — mirrors email whitelist pattern
// ---------------------------------------------------------------------------

// GET /api/user/setting/whatsapp
// Returns per-org WhatsApp config + whitelist. API key is masked unless ?reveal=1.
router.get('/setting/whatsapp', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const [[org]] = await req.pool.execute(
      'SELECT whatsapp_api_url, whatsapp_api_key, whatsapp_whitelist_enabled, whatsapp_whitelist FROM organization WHERE id = ?',
      [orgId]
    );
    if (!org) return res.json({ code: 404, message: 'Organization not found' });

    const enabled = bitToBool(org.whatsapp_whitelist_enabled);

    // Mask API key — show only last 4 chars to confirm what's stored
    const rawKey = org.whatsapp_api_key || '';
    const maskedKey = rawKey ? '••••••••' + rawKey.slice(-4) : '';

    res.json({
      code: 200,
      data: {
        whatsapp_api_url: org.whatsapp_api_url || '',
        whatsapp_api_key_masked: maskedKey,
        whatsapp_api_key_set: !!rawKey,
        whatsapp_whitelist_enabled: enabled,
        whatsapp_whitelist: org.whatsapp_whitelist || '',
      },
    });
  } catch (err) {
    console.error('Get WhatsApp settings error:', err);
    res.status(500).json({ code: 500, message: err.message });
  }
});

// PUT /api/user/setting/whatsapp
// Accepts: whatsapp_api_url, whatsapp_api_key (optional — only updates if non-empty),
//          whatsapp_whitelist_enabled, whatsapp_whitelist
router.put('/setting/whatsapp', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const {
      whatsapp_api_url,
      whatsapp_api_key,
      whatsapp_whitelist_enabled,
      whatsapp_whitelist,
    } = req.body;

    // Only update the API key if a non-empty value was sent — lets the UI submit
    // the form without re-entering the key every time.
    if (typeof whatsapp_api_key === 'string' && whatsapp_api_key.trim() !== '') {
      await req.pool.execute(
        `UPDATE organization
            SET whatsapp_api_url = ?, whatsapp_api_key = ?,
                whatsapp_whitelist_enabled = ?, whatsapp_whitelist = ?
          WHERE id = ?`,
        [
          whatsapp_api_url || null,
          whatsapp_api_key.trim(),
          whatsapp_whitelist_enabled ? 1 : 0,
          whatsapp_whitelist || null,
          orgId,
        ]
      );
    } else {
      await req.pool.execute(
        `UPDATE organization
            SET whatsapp_api_url = ?,
                whatsapp_whitelist_enabled = ?, whatsapp_whitelist = ?
          WHERE id = ?`,
        [
          whatsapp_api_url || null,
          whatsapp_whitelist_enabled ? 1 : 0,
          whatsapp_whitelist || null,
          orgId,
        ]
      );
    }

    res.json({ code: 200, message: 'WhatsApp settings updated' });
  } catch (err) {
    console.error('Update WhatsApp settings error:', err);
    res.status(500).json({ code: 500, message: err.message });
  }
});

// DELETE /api/user/setting/whatsapp/key — clear the stored API key (e.g. rotating)
router.delete('/setting/whatsapp/key', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    await req.pool.execute(
      'UPDATE organization SET whatsapp_api_key = NULL WHERE id = ?',
      [orgId]
    );
    res.json({ code: 200, message: 'WhatsApp API key cleared' });
  } catch (err) {
    console.error('Clear WhatsApp key error:', err);
    res.status(500).json({ code: 500, message: err.message });
  }
});

// ---------------------------------------------------------------------------
// Overdue chasing policy (one row per org, defaults in utils/chaseSettings.js)
// ---------------------------------------------------------------------------

// GET /api/setting/payment-reminders
//
// Returns the policy AND the categories it can be applied to, so the screen can
// render every choice as a tick rather than hiding them behind a dropdown.
//
// `charge_count` separates the two groups on that screen. This org has 103
// enabled categories and 73 of them have never carried a charge to a tenant —
// Salaries, MPF, Petty Cash, the whole expense side of the ledger. Offering
// those as "charges to chase" is noise at best. There is no column marking a
// category as tenant-facing, so usage is the honest proxy: inflow invoices
// (type = 0) actually addressed to a tenant.
//
// Within each group the order is alphabetical, so a name can be found where it
// is expected rather than wherever its volume puts it. TRIM because the data is
// not clean: " Advertising" has a leading space and would otherwise sort above
// everything, and "Garbage disposal fee " carries a trailing one.
router.get('/setting/payment-reminders', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const data = await loadChaseSettings(req.pool, orgId);
    const [categories] = await req.pool.execute(
      `SELECT CAST(cs.id AS CHAR) AS id, cs.name,
              COUNT(i.id) AS charge_count
         FROM category_setting cs
         LEFT JOIN invoice i
           ON i.category = cs.id AND i.org_id = cs.org_id
          AND i.deleted_at IS NULL AND i.tenant_id IS NOT NULL AND i.type = 0
        WHERE cs.org_id = ? AND cs.enabled = 1
        GROUP BY cs.id, cs.name
        ORDER BY TRIM(cs.name)`,
      [orgId]
    );
    res.json({
      code: 200,
      data: {
        ...data,
        categories_available: categories.map((c) => ({
          id: String(c.id),
          name: c.name,
          charge_count: Number(c.charge_count) || 0,
        })),
      },
    });
  } catch (error) {
    console.error('Get payment reminder settings error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get payment reminder settings' });
  }
});

// PUT /api/setting/payment-reminders
// Gated on EMAIL_TEMPLATE_EDIT rather than plain authentication. Saving here can
// switch on a job that emails real tenants unattended, which is a bigger blast
// radius than any other row on the settings screen; anyone trusted to edit the
// wording of tenant email is the right audience for its schedule. The GET stays
// open so the screen can render for anyone who can reach it.
router.put('/setting/payment-reminders', authenticate, requirePermission('LANDLORD/EMAIL_TEMPLATE_EDIT'), async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { enabled, categories, days_after_due, days_after_issue, repeat_days } = req.body || {};

    // Day counts are clamped rather than trusted. A negative window would chase
    // invoices before they are due; repeat_days of 0 would re-send the same
    // demand every time the job ran.
    const clamp = (value, fallback, min, max) => {
      const n = Number(value);
      if (!Number.isFinite(n)) return fallback;
      return Math.min(max, Math.max(min, Math.trunc(n)));
    };

    const row = {
      enabled: Number(enabled) === 1 || enabled === true ? 1 : 0,
      categories: serialiseCategories(categories),
      days_after_due: clamp(days_after_due, CHASE_DEFAULTS.days_after_due, 0, 365),
      days_after_issue: clamp(days_after_issue, CHASE_DEFAULTS.days_after_issue, 0, 365),
      repeat_days: clamp(repeat_days, CHASE_DEFAULTS.repeat_days, 1, 365),
    };

    // Category ids are validated against this org before they are stored, so a
    // stale or hand-crafted id cannot silently widen who gets chased.
    if (row.categories) {
      const ids = row.categories.split(',');
      const [valid] = await req.pool.query(
        `SELECT id FROM category_setting WHERE org_id = ? AND id IN (${ids.map(() => '?').join(',')})`,
        [orgId, ...ids]
      );
      const allowed = new Set(valid.map((r) => String(r.id)));
      const kept = ids.filter((id) => allowed.has(id));
      if (kept.length !== ids.length) {
        return res.status(400).json({ code: 400, message: 'One or more categories do not belong to this organisation' });
      }
      row.categories = kept.join(',');
    }

    await req.pool.execute(
      `INSERT INTO chase_setting (org_id, enabled, categories, days_after_due, days_after_issue, repeat_days)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), categories = VALUES(categories),
         days_after_due = VALUES(days_after_due), days_after_issue = VALUES(days_after_issue),
         repeat_days = VALUES(repeat_days)`,
      [orgId, row.enabled, row.categories, row.days_after_due, row.days_after_issue, row.repeat_days]
    );

    // Turning this on wakes a job that mails tenants unattended, so it belongs
    // in the audit trail rather than only in the row's updated_at.
    await logActivity(req, 'UPDATE', 'settings', orgId, row.enabled
      ? `Enabled automatic overdue payment reminders (every ${row.repeat_days}d, from ${row.days_after_due}d past due)`
      : 'Disabled automatic overdue payment reminders');

    const data = await loadChaseSettings(req.pool, orgId);
    res.json({ code: 200, message: 'Saved', data });
  } catch (error) {
    console.error('Update payment reminder settings error:', error);
    res.status(500).json({ code: 500, message: 'Failed to save payment reminder settings' });
  }
});

// GET /api/setting/category/list - Get categories
router.get('/setting/category/list', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const [categories] = await req.pool.execute(
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
    const id = genId();
    await req.pool.execute(
      'INSERT INTO category_setting (id, org_id, name, enabled, updated_at) VALUES (?, ?, ?, 1, NOW())',
      [id, orgId, name]
    );
    res.json({ code: 200, message: 'Category created', data: { id } });
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
    await req.pool.execute(
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

    // In-use guard — don't delete a category referenced by live transactions or invoices.
    const [[{ acctCount }]] = await req.pool.execute(
      'SELECT COUNT(*) AS acctCount FROM accounting WHERE category = ? AND org_id = ? AND deleted_at IS NULL',
      [id, orgId]
    );
    const [[{ invCount }]] = await req.pool.execute(
      'SELECT COUNT(*) AS invCount FROM invoice WHERE category = ? AND org_id = ? AND deleted_at IS NULL',
      [id, orgId]
    );
    const used = Number(acctCount) + Number(invCount);
    if (used > 0) {
      return res.status(400).json({ code: 400, message: `Cannot delete this category — it is used by ${used} transaction(s)/invoice(s). Reassign or remove them first.` });
    }

    await req.pool.execute(
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
    const [payments] = await req.pool.execute(
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
    const id = genId();
    await req.pool.execute(
      'INSERT INTO payment_method_setting (id, org_id, payment_method, enabled, updated_at) VALUES (?, ?, ?, 1, NOW())',
      [id, orgId, name]
    );
    res.json({ code: 200, message: 'Payment method created', data: { id } });
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
    await req.pool.execute(
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

    // In-use guard — don't delete a payment method referenced by live transactions.
    const [[{ count }]] = await req.pool.execute(
      'SELECT COUNT(*) AS count FROM accounting WHERE payment_setting_id = ? AND org_id = ? AND deleted_at IS NULL',
      [id, orgId]
    );
    if (Number(count) > 0) {
      return res.status(400).json({ code: 400, message: `Cannot delete this payment method — it is used by ${count} transaction(s). Reassign or remove them first.` });
    }

    await req.pool.execute(
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

    const [categories] = await req.pool.execute(
      'SELECT * FROM category_setting WHERE ' + whereClause + ' ORDER BY name LIMIT ' + limit + ' OFFSET ' + offset,
      params
    );
    const [[{ total }]] = await req.pool.execute(
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
    const [categories] = await req.pool.execute(
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
    const [orgs] = await req.pool.execute(
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

    await req.pool.execute(
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
    const [orgs] = await req.pool.execute('SELECT currency FROM organization WHERE id = ?', [orgId]);
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
    const [orgs] = await req.pool.execute('SELECT currency, exchange_rate FROM organization WHERE id = ?', [orgId]);
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
    await req.pool.execute(
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
    const [sequences] = await req.pool.execute(
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
    await req.pool.execute(
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
    const [accounts] = await req.pool.execute(
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

    const [accounts] = await req.pool.execute(
      'SELECT * FROM account_setting WHERE org_id = ? AND enabled = 1 ORDER BY name LIMIT ' + limit + ' OFFSET ' + offset,
      [orgId]
    );
    const [[{ total }]] = await req.pool.execute(
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
    const id = (BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000))).toString();
    await req.pool.execute(
      'INSERT INTO account_setting (id, org_id, name, enabled) VALUES (?, ?, ?, 1)',
      [id, orgId, name]
    );
    res.json({ code: 200, message: 'Account setting created', data: { id } });
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
    await req.pool.execute(
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

    // Check if any accounting transactions use this account
    const [[{ count }]] = await req.pool.execute(
      'SELECT COUNT(*) as count FROM accounting WHERE account_setting_id = ? AND org_id = ? AND deleted_at IS NULL',
      [id, orgId]
    );
    if (Number(count) > 0) {
      return res.status(400).json({ code: 400, message: `Cannot delete this account — it is used by ${count} accounting transaction(s). Remove or reassign them first.` });
    }

    await req.pool.execute(
      'UPDATE account_setting SET enabled = 0 WHERE id = ? AND org_id = ?',
      [id, orgId]
    );
    res.json({ code: 200, message: 'Account setting deleted' });
  } catch (error) {
    console.error('Delete account setting error:', error);
    res.status(500).json({ code: 500, message: 'Failed to delete account setting' });
  }
});

// ─── API KEY MANAGEMENT (Super Admin only) ──────────────────────────────────

// GET /api/user/setting/api-keys/enabled - Check if public API is enabled for this org
router.get('/setting/api-keys/enabled', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const masterPool = getMasterPool();
    const [[org]] = await masterPool.execute(
      'SELECT public_api_enabled FROM organizations WHERE id = ?',
      [orgId]
    );
    res.json({ code: 200, data: { enabled: org ? Number(org.public_api_enabled) === 1 : false } });
  } catch (err) {
    console.error('Check API enabled error:', err);
    res.status(500).json({ code: 500, message: err.message });
  }
});

// GET /api/user/setting/api-keys - List API keys for this org
router.get('/setting/api-keys', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const masterPool = getMasterPool();
    const [keys] = await masterPool.execute(
      'SELECT id, api_key, name, status, read_only, created_at, last_used_at FROM api_keys WHERE org_id = ? ORDER BY created_at DESC',
      [orgId]
    );
    res.json({ code: 200, data: keys });
  } catch (err) {
    console.error('List API keys error:', err);
    res.status(500).json({ code: 500, message: err.message });
  }
});

// POST /api/user/setting/api-keys - Create API key for this org
router.post('/setting/api-keys', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { name } = req.body;
    const readOnly = req.body.read_only ? 1 : 0;
    const masterPool = getMasterPool();

    // Check if public API is enabled
    const [[org]] = await masterPool.execute(
      'SELECT public_api_enabled FROM organizations WHERE id = ?',
      [orgId]
    );
    if (!org || Number(org.public_api_enabled) !== 1) {
      return res.status(403).json({ code: 403, message: 'Public API is not enabled for your organization. Contact master admin.' });
    }

    const id = (BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000))).toString();
    const apiKey = 'pk_' + crypto.randomBytes(32).toString('hex');

    await masterPool.execute(
      'INSERT INTO api_keys (id, org_id, api_key, name, status, read_only, created_at) VALUES (?, ?, ?, ?, 1, ?, NOW())',
      [id, orgId, apiKey, name || 'Default', readOnly]
    );

    res.json({ code: 200, data: { id, api_key: apiKey, name: name || 'Default', read_only: readOnly } });
  } catch (err) {
    console.error('Create API key error:', err);
    res.status(500).json({ code: 500, message: err.message });
  }
});

// PUT /api/user/setting/api-keys/:id - Update API key (name, status)
router.put('/setting/api-keys/:id', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;
    const { name, status } = req.body;
    const masterPool = getMasterPool();

    const updates = [];
    const params = [];
    if (name !== undefined) { updates.push('name = ?'); params.push(name); }
    if (status !== undefined) { updates.push('status = ?'); params.push(status); }

    if (!updates.length) return res.status(400).json({ code: 400, message: 'Nothing to update' });

    // Ensure key belongs to this org
    params.push(id, orgId);
    await masterPool.execute(`UPDATE api_keys SET ${updates.join(', ')} WHERE id = ? AND org_id = ?`, params);

    res.json({ code: 200, message: 'API key updated' });
  } catch (err) {
    console.error('Update API key error:', err);
    res.status(500).json({ code: 500, message: err.message });
  }
});

// DELETE /api/user/setting/api-keys/:id - Delete API key
router.delete('/setting/api-keys/:id', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;
    const masterPool = getMasterPool();

    // Ensure key belongs to this org
    await masterPool.execute('DELETE FROM api_keys WHERE id = ? AND org_id = ?', [id, orgId]);

    res.json({ code: 200, message: 'API key deleted' });
  } catch (err) {
    console.error('Delete API key error:', err);
    res.status(500).json({ code: 500, message: err.message });
  }
});

// ─── LEAD SOURCE SETTINGS ───────────────────────────────────────────────────

// GET /api/setting/lead-source/list
router.get('/setting/lead-source/list', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const [rows] = await req.pool.execute(
      'SELECT id, name, org_id, CAST(enabled AS UNSIGNED) as enabled, updated_at FROM lead_source_setting WHERE org_id = ? AND enabled = 1 ORDER BY name',
      [orgId]
    );
    res.json({ code: 200, data: rows });
  } catch (error) {
    console.error('Get lead sources error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get lead sources' });
  }
});

// POST /api/setting/lead-source/add
router.post('/setting/lead-source/add', authenticate, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ code: 400, message: 'Name is required' });
    const orgId = req.user.orgId;
    const id = genId();
    await req.pool.execute(
      'INSERT INTO lead_source_setting (id, org_id, name, enabled, updated_at) VALUES (?, ?, ?, 1, NOW())',
      [id, orgId, name.trim()]
    );
    res.json({ code: 200, message: 'Lead source created', data: { id } });
  } catch (error) {
    console.error('Create lead source error:', error);
    res.status(500).json({ code: 500, message: 'Failed to create lead source' });
  }
});

// PUT /api/setting/lead-source/update/:id
router.put('/setting/lead-source/update/:id', authenticate, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ code: 400, message: 'Name is required' });
    const { id } = req.params;
    const orgId = req.user.orgId;
    await req.pool.execute(
      'UPDATE lead_source_setting SET name = ?, updated_at = NOW() WHERE id = ? AND org_id = ?',
      [name.trim(), id, orgId]
    );
    res.json({ code: 200, message: 'Lead source updated' });
  } catch (error) {
    console.error('Update lead source error:', error);
    res.status(500).json({ code: 500, message: 'Failed to update lead source' });
  }
});

// DELETE /api/setting/lead-source/delete/:id
router.delete('/setting/lead-source/delete/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;
    // Check if any tenants reference this lead source
    const [[{ tenantCount }]] = await req.pool.execute(
      'SELECT COUNT(*) as tenantCount FROM tenant WHERE lead_source_id = ? AND org_id = ? AND status != 0',
      [id, orgId]
    );
    if (Number(tenantCount) > 0) {
      return res.status(400).json({
        code: 400,
        message: `Cannot delete — ${tenantCount} contact(s) are using this lead source.`
      });
    }
    await req.pool.execute(
      'UPDATE lead_source_setting SET enabled = 0 WHERE id = ? AND org_id = ?',
      [id, orgId]
    );
    res.json({ code: 200, message: 'Lead source deleted' });
  } catch (error) {
    console.error('Delete lead source error:', error);
    res.status(500).json({ code: 500, message: 'Failed to delete lead source' });
  }
});

module.exports = router;