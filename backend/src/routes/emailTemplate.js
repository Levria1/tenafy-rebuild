const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const pool = require('../config/database');

// POST /api/email-template/list - List email templates with paging
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
      whereClause += ' AND (template_name LIKE ? OR subject LIKE ?)';
      params.push('%' + search + '%', '%' + search + '%');
    }
    if (type) {
      whereClause += ' AND template_type = ?';
      params.push(type);
    }

    const [templates] = await pool.execute(
      'SELECT id, template_name as name, subject, template_type as type, template_content as body, status, bcc, cc, reply_to, `from`, is_default_template, created_time FROM email_template WHERE ' + whereClause + ' ORDER BY template_name LIMIT ' + limit + ' OFFSET ' + offset,
      params
    );
    const [[{ total }]] = await pool.execute(
      'SELECT COUNT(*) as total FROM email_template WHERE ' + whereClause,
      params
    );

    res.json({ code: 200, data: { content: templates, totalElements: total, totalPages: Math.ceil(total / limit), currentPage: page } });
  } catch (error) {
    console.error('List email templates error:', error);
    res.status(500).json({ code: 500, message: 'Failed to list email templates' });
  }
});

// GET /api/email-template/all - Get all active email templates (for dropdowns)
router.get('/all', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { type } = req.query;

    let whereClause = 'org_id = ? AND status = 1';
    const params = [orgId];

    if (type) {
      whereClause += ' AND template_type = ?';
      params.push(type);
    }

    const [templates] = await pool.execute(
      'SELECT id, template_name as name, subject, template_type as type FROM email_template WHERE ' + whereClause + ' ORDER BY template_name',
      params
    );

    res.json({ code: 200, data: templates });
  } catch (error) {
    console.error('Get all email templates error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get email templates' });
  }
});

// GET /api/email-template/types/get - Get email template types
router.get('/types/get', authenticate, async (req, res) => {
  try {
    const types = [
      { value: 'lease', label: 'Lease' },
      { value: 'invoice', label: 'Invoice' },
      { value: 'payment', label: 'Payment' },
      { value: 'maintenance', label: 'Maintenance' },
      { value: 'general', label: 'General' },
    ];
    res.json({ code: 200, data: types });
  } catch (error) {
    console.error('Get email template types error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get types' });
  }
});

// GET /api/email-template/variable/get - Get email template variables
router.get('/variable/get', authenticate, async (req, res) => {
  try {
    const variables = [
      { key: '{{tenant_name}}', description: 'Tenant full name' },
      { key: '{{tenant_email}}', description: 'Tenant email address' },
      { key: '{{property_name}}', description: 'Property name' },
      { key: '{{unit_name}}', description: 'Unit name' },
      { key: '{{lease_start}}', description: 'Lease start date' },
      { key: '{{lease_end}}', description: 'Lease end date' },
      { key: '{{rent_amount}}', description: 'Monthly rent amount' },
      { key: '{{invoice_number}}', description: 'Invoice number' },
      { key: '{{invoice_amount}}', description: 'Invoice amount' },
      { key: '{{invoice_due_date}}', description: 'Invoice due date' },
      { key: '{{organization_name}}', description: 'Organization name' },
    ];
    res.json({ code: 200, data: variables });
  } catch (error) {
    console.error('Get email template variables error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get variables' });
  }
});

// GET /api/email-template/:id - Get email template detail
router.get('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;

    const [templates] = await pool.execute(
      'SELECT id, template_name as name, subject, template_type as type, template_content as body, status, bcc, cc, reply_to, `from`, is_default_template, before_date, date_first, date_second FROM email_template WHERE id = ? AND org_id = ?',
      [id, orgId]
    );

    if (templates.length === 0) {
      return res.status(404).json({ code: 404, message: 'Email template not found' });
    }

    res.json({ code: 200, data: templates[0] });
  } catch (error) {
    console.error('Get email template error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get email template' });
  }
});

// POST /api/email-template - Create email template
router.post('/', authenticate, async (req, res) => {
  try {
    const { name, subject, body, type } = req.body;
    const orgId = req.user.orgId;

    const [result] = await pool.execute(
      'INSERT INTO email_template (org_id, template_name, subject, template_content, template_type, status, created_time) VALUES (?, ?, ?, ?, ?, 1, NOW())',
      [orgId, name, subject, body, type]
    );

    res.json({ code: 200, message: 'Email template created', data: { id: result.insertId } });
  } catch (error) {
    console.error('Create email template error:', error);
    res.status(500).json({ code: 500, message: 'Failed to create email template' });
  }
});

// PUT /api/email-template/:id - Update email template
router.put('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, subject, body, type, status } = req.body;
    const orgId = req.user.orgId;

    await pool.execute(
      'UPDATE email_template SET template_name = ?, subject = ?, template_content = ?, template_type = ?, status = ?, updated_time = NOW() WHERE id = ? AND org_id = ?',
      [name, subject, body, type, status, id, orgId]
    );

    res.json({ code: 200, message: 'Email template updated' });
  } catch (error) {
    console.error('Update email template error:', error);
    res.status(500).json({ code: 500, message: 'Failed to update email template' });
  }
});

// DELETE /api/email-template/:id - Delete email template
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;
    await pool.execute('UPDATE email_template SET status = 0 WHERE id = ? AND org_id = ?', [id, orgId]);
    res.json({ code: 200, message: 'Email template deleted' });
  } catch (error) {
    console.error('Delete email template error:', error);
    res.status(500).json({ code: 500, message: 'Failed to delete email template' });
  }
});

module.exports = router;
