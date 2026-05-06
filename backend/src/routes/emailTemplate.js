const express = require('express');
const router = express.Router();
const { authenticate, requirePermission } = require('../middleware/auth');

const {
  TEMPLATE_TYPES,
  TEMPLATE_VARIABLES,
  sendTemplateEmail,
  previewTemplate,
  findSmtpAccount,
} = require('../services/emailService');

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

    const [templates] = await req.pool.execute(
      'SELECT id, template_name as name, subject, template_type as type, template_content as body, status, bcc, cc, reply_to, `from`, to_address, is_default_template, created_time FROM email_template WHERE ' + whereClause + ' ORDER BY template_name LIMIT ' + limit + ' OFFSET ' + offset,
      params
    );
    const [[{ total }]] = await req.pool.execute(
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

    const [templates] = await req.pool.execute(
      'SELECT id, template_name as name, subject, template_type as type, is_default_template FROM email_template WHERE ' + whereClause + ' ORDER BY template_name',
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
    res.json({ code: 200, data: TEMPLATE_TYPES });
  } catch (error) {
    console.error('Get email template types error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get types' });
  }
});

// GET /api/email-template/variable/get - Get email template variables
router.get('/variable/get', authenticate, async (req, res) => {
  try {
    res.json({ code: 200, data: TEMPLATE_VARIABLES });
  } catch (error) {
    console.error('Get email template variables error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get variables' });
  }
});

// POST /api/email-template/send - Send a template email (supports multi-recipient)
router.post('/send', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const {
      templateId, templateType, leaseId, category, dueDate,
      invoiceId, invoiceCode, toOverride,
      // Manual compose fields (override template content)
      subject: manualSubject, body: manualBody, cc, bcc, replyTo,
    } = req.body;

    console.log(`[email-template/send] templateId=${templateId} templateType=${templateType} toOverride=${toOverride} cc=${cc || '(none)'} bcc=${bcc || '(none)'} hasManualSubject=${!!manualSubject} hasManualBody=${!!manualBody}`);

    // Parse toOverride — could be comma/semicolon-separated list
    let recipients = [];
    if (toOverride) {
      recipients = toOverride.split(/[;,\n]/).map(e => e.trim()).filter(Boolean);
    }

    // If manual subject/body provided, send directly without template lookup
    if (manualSubject && manualBody && recipients.length > 0) {
      const { sendMail, sendMailWithAccount } = require('../config/mailer');
      const { resolveVariables, substituteVariables, getSampleVariables } = require('../services/emailService');

      let variables = getSampleVariables();
      if (leaseId) {
        variables = await resolveVariables(orgId, leaseId, {
          category, dueDate: dueDate ? new Date(dueDate) : undefined,
          invoiceCode, invoiceId,
        });
      }

      const results = [];
      for (const recipient of recipients) {
        try {
          const renderedSubject = substituteVariables(manualSubject, variables);
          const bodyIsHtml = /<[a-z][\s\S]*>/i.test(manualBody);
          let renderedBody = substituteVariables(manualBody, variables, bodyIsHtml);
          if (!bodyIsHtml) {
            renderedBody = renderedBody.replace(/\n/g, '<br>\n');
          }
          const { from: manualFrom } = req.body;
          const mailOpts = {
            to: recipient,
            subject: renderedSubject,
            html: renderedBody,
            from: manualFrom || undefined,
          };
          if (cc) mailOpts.cc = cc;
          if (bcc) mailOpts.bcc = bcc;
          if (replyTo) mailOpts.replyTo = replyTo;

          // Use matching SMTP account if available
          const smtpAccount = await findSmtpAccount(req.pool, orgId, mailOpts.from);
          const result = smtpAccount
            ? await sendMailWithAccount(smtpAccount, mailOpts)
            : await sendMail(mailOpts);
          results.push({ email: recipient, status: 'sent', messageId: result.messageId });

          // Log
          try {
            await req.pool.execute(
              `INSERT INTO email_log (org_id, to_email, subject, type, template_id, lease_id, status, sent_at, created_at)
               VALUES (?, ?, ?, ?, ?, ?, 'sent', NOW(), NOW())`,
              [orgId, recipient, renderedSubject, templateType || 'manual', templateId || null, leaseId || null]
            );
          } catch (logErr) { /* ignore */ }
        } catch (err) {
          results.push({ email: recipient, status: 'failed', error: err.message });
        }
      }

      return res.json({ code: 200, message: `Email sent to ${results.filter(r => r.status === 'sent').length} recipient(s)`, data: results });
    }

    // Template-based send (single or multi-recipient)
    if (recipients.length > 1) {
      // Multi-recipient: send to each via template
      const results = [];
      for (const email of recipients) {
        try {
          const result = await sendTemplateEmail(req.pool, orgId, {
            templateType, templateId, leaseId, category,
            dueDate: dueDate ? new Date(dueDate) : undefined,
            invoiceCode, invoiceId,
            toOverride: email,
          });
          results.push({ email, status: result ? 'sent' : 'skipped' });
        } catch (err) {
          results.push({ email, status: 'failed', error: err.message });
        }
      }
      return res.json({ code: 200, message: `Email sent to ${results.filter(r => r.status === 'sent').length} recipient(s)`, data: results });
    }

    // Single recipient (or auto-resolve from lease)
    const result = await sendTemplateEmail(req.pool, orgId, {
      templateType, templateId, leaseId, category,
      dueDate: dueDate ? new Date(dueDate) : undefined,
      invoiceCode, invoiceId,
      toOverride: recipients[0] || undefined,
    });

    if (!result) {
      return res.status(400).json({ code: 400, message: 'Could not send email. Check that a template exists and a recipient is available.' });
    }

    res.json({ code: 200, message: 'Email sent', data: result });
  } catch (error) {
    console.error('Send template email error:', error);
    res.status(500).json({ code: 500, message: 'Failed to send email' });
  }
});

// POST /api/email-template/preview - Preview a rendered template
router.post('/preview', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { templateId, templateType, leaseId, category, dueDate } = req.body;

    const result = await previewTemplate(req.pool, orgId, {
      templateId,
      templateType,
      leaseId,
      category,
      dueDate: dueDate ? new Date(dueDate) : undefined,
    });

    res.json({ code: 200, data: result });
  } catch (error) {
    console.error('Preview template error:', error);
    res.status(500).json({ code: 500, message: 'Failed to preview template' });
  }
});

// GET /api/email-template/:id - Get email template detail
router.get('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;

    const [templates] = await req.pool.execute(
      'SELECT id, template_name as name, subject, template_type as type, template_content as body, status, bcc, cc, reply_to, `from`, to_address, is_default_template, before_date, date_first, date_second FROM email_template WHERE id = ? AND org_id = ?',
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
router.post('/', authenticate, requirePermission('LANDLORD/EMAIL_TEMPLATE_CREATE'), async (req, res) => {
  try {
    const {
      name, subject, body, type,
      bcc, cc, reply_to, from: fromAddr, to_address,
      is_default_template,
      before_date, date_first, date_second,
    } = req.body;
    const orgId = req.user.orgId;

    // If marking as default, unset other defaults for this type
    if (is_default_template === 1 || is_default_template === true) {
      await req.pool.execute(
        'UPDATE email_template SET is_default_template = 2 WHERE org_id = ? AND template_type = ? AND is_default_template = 1',
        [orgId, type]
      );
    }

    const id = BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000));

    await req.pool.execute(
      `INSERT INTO email_template
       (id, org_id, template_name, subject, template_content, template_type, status,
        bcc, cc, reply_to, \`from\`, to_address, is_default_template, before_date, date_first, date_second, created_time)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        id.toString(), orgId, name, subject, body, type,
        bcc || null, cc || null, reply_to || null, fromAddr || null, to_address || null,
        (is_default_template === 1 || is_default_template === true) ? 1 : 2,
        before_date != null ? (before_date ? 1 : 0) : 1,
        date_first || null, date_second || null,
      ]
    );

    res.json({ code: 200, message: 'Email template created', data: { id: id.toString() } });
  } catch (error) {
    console.error('Create email template error:', error);
    res.status(500).json({ code: 500, message: 'Failed to create email template' });
  }
});

// PUT /api/email-template/:id - Update email template
router.put('/:id', authenticate, requirePermission('LANDLORD/EMAIL_TEMPLATE_EDIT'), async (req, res) => {
  try {
    const { id } = req.params;
    const {
      name, subject, body, type, status,
      bcc, cc, reply_to, from: fromAddr, to_address,
      is_default_template,
      before_date, date_first, date_second,
    } = req.body;
    const orgId = req.user.orgId;

    // If marking as default, unset other defaults for this type
    if (is_default_template === 1 || is_default_template === true) {
      await req.pool.execute(
        'UPDATE email_template SET is_default_template = 2 WHERE org_id = ? AND template_type = ? AND is_default_template = 1 AND id != ?',
        [orgId, type, id]
      );
    }

    await req.pool.execute(
      `UPDATE email_template SET
         template_name = ?, subject = ?, template_content = ?, template_type = ?, status = ?,
         bcc = ?, cc = ?, reply_to = ?, \`from\` = ?, to_address = ?,
         is_default_template = ?,
         before_date = ?, date_first = ?, date_second = ?,
         updated_time = NOW()
       WHERE id = ? AND org_id = ?`,
      [
        name, subject, body, type, status ?? 1,
        bcc || null, cc || null, reply_to || null, fromAddr || null, to_address || null,
        (is_default_template === 1 || is_default_template === true) ? 1 : 2,
        before_date != null ? (before_date ? 1 : 0) : 1,
        date_first || null, date_second || null,
        id, orgId,
      ]
    );

    res.json({ code: 200, message: 'Email template updated' });
  } catch (error) {
    console.error('Update email template error:', error);
    res.status(500).json({ code: 500, message: 'Failed to update email template' });
  }
});

// DELETE /api/email-template/:id - Delete email template
router.delete('/:id', authenticate, requirePermission('LANDLORD/EMAIL_TEMPLATE_DELETE'), async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;
    await req.pool.execute('UPDATE email_template SET status = 0 WHERE id = ? AND org_id = ?', [id, orgId]);
    res.json({ code: 200, message: 'Email template deleted' });
  } catch (error) {
    console.error('Delete email template error:', error);
    res.status(500).json({ code: 500, message: 'Failed to delete email template' });
  }
});

module.exports = router;
