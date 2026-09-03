const express = require('express');
const { bitToBool } = require('../utils/mysqlBit');
const router = express.Router();
const { authenticate, requirePermission } = require('../middleware/auth');

const { TEMPLATE_TYPES, TEMPLATE_VARIABLES } = require('../services/emailService');
const { sendTemplateWhatsApp, previewWhatsAppTemplate, sendWhatsApp, pingWhatsApp } = require('../services/whatsappService');

// POST /api/whatsapp-template/list
router.post('/list', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { search, type } = req.body || {};
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    let whereClause = 'org_id = ? AND status != 0';
    const params = [orgId];
    if (search) {
      whereClause += ' AND template_name LIKE ?';
      params.push('%' + search + '%');
    }
    if (type) {
      whereClause += ' AND template_type = ?';
      params.push(type);
    }
    const [rows] = await req.pool.execute(
      'SELECT id, template_name as name, template_type as type, template_content as body, status, is_default_template, before_date, date_first, date_second, created_time FROM whatsapp_template WHERE ' + whereClause + ' ORDER BY template_name LIMIT ' + limit + ' OFFSET ' + offset,
      params
    );
    const [[{ total }]] = await req.pool.execute(
      'SELECT COUNT(*) as total FROM whatsapp_template WHERE ' + whereClause,
      params
    );
    res.json({ code: 200, data: { content: rows, totalElements: total, totalPages: Math.ceil(total / limit), currentPage: page } });
  } catch (err) {
    console.error('List WA templates error:', err);
    res.status(500).json({ code: 500, message: 'Failed to list WhatsApp templates' });
  }
});

// GET /api/whatsapp-template/all
router.get('/all', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { type } = req.query;
    let whereClause = 'org_id = ? AND status = 1';
    const params = [orgId];
    if (type) { whereClause += ' AND template_type = ?'; params.push(type); }
    const [rows] = await req.pool.execute(
      'SELECT id, template_name as name, template_type as type, is_default_template FROM whatsapp_template WHERE ' + whereClause + ' ORDER BY template_name',
      params
    );
    res.json({ code: 200, data: rows });
  } catch (err) {
    console.error('Get all WA templates error:', err);
    res.status(500).json({ code: 500, message: 'Failed to get templates' });
  }
});

// GET /api/whatsapp-template/types/get
router.get('/types/get', authenticate, async (req, res) => {
  res.json({ code: 200, data: TEMPLATE_TYPES });
});

// GET /api/whatsapp-template/variable/get
router.get('/variable/get', authenticate, async (req, res) => {
  res.json({ code: 200, data: TEMPLATE_VARIABLES });
});

// POST /api/whatsapp-template/send — manual / test send
router.post('/send', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { templateId, templateType, leaseId, category, dueDate, invoiceId, invoiceCode, toOverride, body: manualBody } = req.body || {};

    // Manual override: just send a plain-text message to a phone number
    if (manualBody && toOverride) {
      const result = await sendWhatsApp(req.pool, orgId, toOverride, manualBody);
      if (!result.ok) return res.status(502).json({ code: 502, message: result.error || 'send failed' });
      return res.json({ code: 200, message: 'WhatsApp sent', data: result });
    }

    const result = await sendTemplateWhatsApp(req.pool, orgId, {
      templateId, templateType, leaseId, category,
      dueDate: dueDate ? new Date(dueDate) : undefined,
      invoiceId, invoiceCode, toOverride,
    });
    res.json({ code: 200, message: 'WhatsApp sent', data: result });
  } catch (err) {
    console.error('Send WA template error:', err);
    res.status(500).json({ code: 500, message: 'Failed to send WhatsApp' });
  }
});

// POST /api/whatsapp-template/preview
router.post('/preview', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { templateId, templateType, leaseId, category, dueDate } = req.body;
    const result = await previewWhatsAppTemplate(req.pool, orgId, {
      templateId, templateType, leaseId, category,
      dueDate: dueDate ? new Date(dueDate) : undefined,
    });
    res.json({ code: 200, data: result });
  } catch (err) {
    console.error('Preview WA template error:', err);
    res.status(500).json({ code: 500, message: 'Failed to preview' });
  }
});

// GET /api/whatsapp-template/:id
router.get('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;
    const [rows] = await req.pool.execute(
      'SELECT id, template_name as name, template_type as type, template_content as body, status, is_default_template, before_date, date_first, date_second FROM whatsapp_template WHERE id = ? AND org_id = ?',
      [id, orgId]
    );
    if (rows.length === 0) return res.status(404).json({ code: 404, message: 'WhatsApp template not found' });
    const row = rows[0];
    // bit(1) -> boolean here rather than in the browser. Two React edit pages were
    // parsing MySQL's wire format (`data.before_date.data[0] === 1`) to work around
    // this; they keep a Boolean() fallback, so a real boolean still works for them.
    // NULL is preserved, not coerced. scheduler.js and leasing.js both read an absent
    // before_date as "send BEFORE the end date", so answering `false` here would let an
    // edit form render it unticked and save that back as 0, flipping checkout email
    // timing with nobody having asked for it — the same shape as the lease-checkbox bug
    // this decoder was written for. No rows are NULL today; the guard is for the day one is.
    if (row.before_date != null) row.before_date = bitToBool(row.before_date);
    // is_default_template is deliberately NOT decoded here: it is a tinyint where 2 means
    // NON-default, so any boolean coercion reports every template as the default one.
    res.json({ code: 200, data: row });
  } catch (err) {
    console.error('Get WA template error:', err);
    res.status(500).json({ code: 500, message: 'Failed to get template' });
  }
});

// POST /api/whatsapp-template — create
router.post('/', authenticate, requirePermission('LANDLORD/EMAIL_TEMPLATE_CREATE'), async (req, res) => {
  try {
    const { name, body, type, is_default_template, before_date, date_first, date_second } = req.body;
    const orgId = req.user.orgId;
    if (is_default_template === 1 || is_default_template === true) {
      await req.pool.execute(
        'UPDATE whatsapp_template SET is_default_template = 2 WHERE org_id = ? AND template_type = ? AND is_default_template = 1',
        [orgId, type]
      );
    }
    const id = BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000));
    await req.pool.execute(
      `INSERT INTO whatsapp_template
        (id, org_id, template_name, template_content, template_type, status,
         is_default_template, before_date, date_first, date_second, created_time)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, NOW())`,
      [
        id.toString(), orgId, name, body, type,
        (is_default_template === 1 || is_default_template === true) ? 1 : 2,
        before_date != null ? (before_date ? 1 : 0) : 1,
        date_first || null, date_second || null,
      ]
    );
    res.json({ code: 200, message: 'WhatsApp template created', data: { id: id.toString() } });
  } catch (err) {
    console.error('Create WA template error:', err);
    res.status(500).json({ code: 500, message: 'Failed to create template' });
  }
});

// PUT /api/whatsapp-template/:id
router.put('/:id', authenticate, requirePermission('LANDLORD/EMAIL_TEMPLATE_EDIT'), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, body, type, status, is_default_template, before_date, date_first, date_second } = req.body;
    const orgId = req.user.orgId;
    if (is_default_template === 1 || is_default_template === true) {
      await req.pool.execute(
        'UPDATE whatsapp_template SET is_default_template = 2 WHERE org_id = ? AND template_type = ? AND is_default_template = 1 AND id != ?',
        [orgId, type, id]
      );
    }
    await req.pool.execute(
      `UPDATE whatsapp_template SET
         template_name = ?, template_content = ?, template_type = ?, status = ?,
         is_default_template = ?, before_date = ?, date_first = ?, date_second = ?,
         updated_time = NOW()
       WHERE id = ? AND org_id = ?`,
      [
        name, body, type, status ?? 1,
        (is_default_template === 1 || is_default_template === true) ? 1 : 2,
        before_date != null ? (before_date ? 1 : 0) : 1,
        date_first || null, date_second || null,
        id, orgId,
      ]
    );
    res.json({ code: 200, message: 'WhatsApp template updated' });
  } catch (err) {
    console.error('Update WA template error:', err);
    res.status(500).json({ code: 500, message: 'Failed to update template' });
  }
});

// DELETE /api/whatsapp-template/:id
router.delete('/:id', authenticate, requirePermission('LANDLORD/EMAIL_TEMPLATE_DELETE'), async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;
    await req.pool.execute('UPDATE whatsapp_template SET status = 0 WHERE id = ? AND org_id = ?', [id, orgId]);
    res.json({ code: 200, message: 'WhatsApp template deleted' });
  } catch (err) {
    console.error('Delete WA template error:', err);
    res.status(500).json({ code: 500, message: 'Failed to delete template' });
  }
});

// GET /api/whatsapp-template/connection/ping — ping THIS org's TaneChat instance
router.get('/connection/ping', authenticate, async (req, res) => {
  try {
    const result = await pingWhatsApp(req.pool, req.user.orgId);
    res.json({ code: 200, data: result });
  } catch (err) {
    res.json({ code: 200, data: { configured: false, ok: false, error: err.message } });
  }
});

module.exports = router;
