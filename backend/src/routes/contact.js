const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const pool = require('../config/database');
const { sendMail } = require('../config/mailer');

// ─── PROPERTY OWNER ROUTES ───────────────────────────────────────────────────

// POST /api/contact/contacts/property-owner - List property owners with paging
router.post('/contacts/property-owner', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { search, status } = req.body || {};
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    let whereClause = 'org_id = ?';
    const params = [orgId];

    if (search) {
      whereClause += ' AND (first_name LIKE ? OR last_name LIKE ? OR email LIKE ? OR company_name LIKE ?)';
      const s = '%' + search + '%';
      params.push(s, s, s, s);
    }
    if (status !== undefined && status !== null) {
      whereClause += ' AND status = ?';
      params.push(status);
    }

    const [owners] = await pool.execute(
      'SELECT * FROM property_owner WHERE ' + whereClause + ' ORDER BY first_name, last_name LIMIT ' + limit + ' OFFSET ' + offset + '',
      [...params]
    );
    const [[{ total }]] = await pool.execute(
      'SELECT COUNT(*) as total FROM property_owner WHERE ' + whereClause,
      params
    );

    res.json({ code: 200, data: { content: owners, totalElements: total, totalPages: Math.ceil(total / limit), currentPage: page } });
  } catch (error) {
    console.error('List property owners error:', error);
    res.status(500).json({ code: 500, message: 'Failed to list property owners' });
  }
});

// GET /api/contact/contacts/property-owner/all - Get all property owners (for dropdowns)
router.get('/contacts/property-owner/all', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const [owners] = await pool.execute(
      'SELECT id, first_name, last_name, email, company_name FROM property_owner WHERE org_id = ? AND status = 1 ORDER BY first_name, last_name',
      [orgId]
    );
    res.json({ code: 200, data: owners });
  } catch (error) {
    console.error('Get all property owners error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get property owners' });
  }
});

// ─── SERVICE VENDOR ROUTES ───────────────────────────────────────────────────

// POST /api/contact/contacts/service-vendor - List service vendors with paging
router.post('/contacts/service-vendor', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { search, searchFields, status } = req.body || {};
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    let whereClause = 'org_id = ? AND deleted_at IS NULL';
    const params = [orgId];

    if (search) {
      // Column-specific search via searchFields array (default: name)
      const fields = Array.isArray(searchFields) && searchFields.length > 0
        ? searchFields
        : ['name'];
      const conditions = [];
      const s = '%' + search + '%';
      for (const f of fields) {
        if (f === 'name') {
          conditions.push('(first_name LIKE ? OR last_name LIKE ? OR CONCAT(COALESCE(first_name,\'\'), \' \', COALESCE(last_name,\'\')) LIKE ?)');
          params.push(s, s, s);
        } else if (f === 'email') {
          conditions.push('email LIKE ?');
          params.push(s);
        } else if (f === 'phone') {
          conditions.push('phone LIKE ?');
          params.push(s);
        } else if (f === 'idCard') {
          conditions.push('id_card LIKE ?');
          params.push(s);
        }
      }
      if (conditions.length > 0) {
        whereClause += ' AND (' + conditions.join(' OR ') + ')';
      }
    }
    if (status !== undefined && status !== null) {
      whereClause += ' AND status = ?';
      params.push(status);
    }

    const [vendors] = await pool.execute(
      `SELECT *, CONCAT(COALESCE(first_name,''), ' ', COALESCE(last_name,'')) AS display_name
       FROM service_vendor WHERE ${whereClause}
       ORDER BY COALESCE(first_name, '') ASC, COALESCE(last_name, '') ASC
       LIMIT ${limit} OFFSET ${offset}`,
      [...params]
    );
    const [[{ total }]] = await pool.execute(
      'SELECT COUNT(*) as total FROM service_vendor WHERE ' + whereClause,
      params
    );

    res.json({ code: 200, data: { content: vendors, totalElements: total, totalPages: Math.ceil(total / limit), currentPage: page } });
  } catch (error) {
    console.error('List service vendors error:', error);
    res.status(500).json({ code: 500, message: 'Failed to list service vendors' });
  }
});

// ─── PAYEE ROUTES ────────────────────────────────────────────────────────────

// POST /api/contact/contacts/payee - List payees with paging
// Payees are stored in the tenant table with category = 2
router.post('/contacts/payee', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { search } = req.body || {};
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    let whereClause = 't.org_id = ? AND t.category = 2';
    const params = [orgId];

    if (search) {
      whereClause += ' AND (t.first_name LIKE ? OR t.last_name LIKE ? OR t.company_name LIKE ? OR t.email LIKE ? OR t.phone LIKE ?)';
      const s = '%' + search + '%';
      params.push(s, s, s, s, s);
    }

    const [payees] = await pool.execute(
      `SELECT t.*,
              COALESCE(inv.outstanding, 0) AS outstanding_amount
       FROM tenant t
       LEFT JOIN (
         SELECT tenant_id, SUM(amount) AS outstanding
         FROM invoice WHERE org_id = ? AND status = 0
         GROUP BY tenant_id
       ) inv ON inv.tenant_id = t.id
       WHERE ${whereClause}
       ORDER BY t.first_name, t.last_name
       LIMIT ${limit} OFFSET ${offset}`,
      [orgId, ...params]
    );
    const [[{ total }]] = await pool.execute(
      `SELECT COUNT(*) as total FROM tenant t WHERE ${whereClause}`,
      params
    );

    res.json({ code: 200, data: { content: payees, totalElements: total, totalPages: Math.ceil(total / limit), currentPage: page } });
  } catch (error) {
    console.error('List payees error:', error);
    res.status(500).json({ code: 500, message: 'Failed to list payees' });
  }
});

// ─── EMAIL GROUP ROUTES ──────────────────────────────────────────────────────

// POST /api/contact/email/groups - List email groups with paging
router.post('/email/groups', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { search } = req.body || {};
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    let whereClause = 'eg.org_id = ?';
    const params = [orgId];

    if (search) {
      whereClause += ' AND eg.name LIKE ?';
      params.push('%' + search + '%');
    }

    const [groups] = await pool.execute(
      `SELECT eg.*, (SELECT COUNT(*) FROM email_group_member egm WHERE egm.group_id = eg.id) as member_count
       FROM email_group eg WHERE ` + whereClause + ` ORDER BY eg.name LIMIT ${limit} OFFSET ${offset}`,
      [...params]
    );
    const [[{ total }]] = await pool.execute(
      'SELECT COUNT(*) as total FROM email_group eg WHERE ' + whereClause,
      params
    );

    res.json({ code: 200, data: { content: groups, totalElements: total, totalPages: Math.ceil(total / limit), currentPage: page } });
  } catch (error) {
    console.error('List email groups error:', error);
    res.status(500).json({ code: 500, message: 'Failed to list email groups' });
  }
});

// GET /api/contact/email/groups/emails - Get all email group email addresses
router.get('/email/groups/emails', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { search } = req.query;
    let query = `SELECT t.email FROM tenant t
                 JOIN email_group_member egm ON egm.tenant_id = t.id
                 JOIN email_group eg ON eg.id = egm.group_id
                 WHERE eg.org_id = ? AND t.status = 1`;
    const params = [orgId];
    if (search) {
      query += ' AND (eg.name LIKE ? OR t.email LIKE ?)';
      params.push('%' + search + '%', '%' + search + '%');
    }
    query += ' GROUP BY t.email';
    const [emails] = await pool.execute(query, params);
    res.json({ code: 200, data: emails.map(e => e.email) });
  } catch (error) {
    console.error('Get group emails error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get emails' });
  }
});

// GET /api/contact/email/groups/emails/:id - Get email group emails by group id
router.get('/email/groups/emails/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const [emails] = await pool.execute(
      `SELECT t.email, t.first_name, t.last_name FROM tenant t
       JOIN email_group_member egm ON egm.tenant_id = t.id
       WHERE egm.group_id = ? AND t.status = 1`,
      [id]
    );
    res.json({ code: 200, data: emails });
  } catch (error) {
    console.error('Get group emails by id error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get emails' });
  }
});

// GET /api/contact/email/group/:id - Get email group with members
router.get('/email/group/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const [groups] = await pool.execute(
      `SELECT eg.*, GROUP_CONCAT(t.email SEPARATOR ',') as emails,
       GROUP_CONCAT(egm.tenant_id SEPARATOR ',') as member_ids
       FROM email_group eg
       LEFT JOIN email_group_member egm ON eg.id = egm.group_id
       LEFT JOIN tenant t ON egm.tenant_id = t.id
       WHERE eg.id = ? GROUP BY eg.id`,
      [id]
    );
    if (groups.length === 0) {
      return res.status(404).json({ code: 404, message: 'Email group not found' });
    }
    const group = groups[0];
    group.member_ids = group.member_ids ? group.member_ids.split(',').map(Number) : [];
    res.json({ code: 200, data: group });
  } catch (error) {
    console.error('Get email group error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get email group' });
  }
});

// POST /api/contact/email/group - Create email group
router.post('/email/group', authenticate, async (req, res) => {
  try {
    const { name, description, member_ids } = req.body;
    const orgId = req.user.orgId;

    const [result] = await pool.execute(
      'INSERT INTO email_group (org_id, name, description, created_at) VALUES (?, ?, ?, NOW())',
      [orgId, name, description]
    );
    const groupId = result.insertId;

    if (member_ids && member_ids.length > 0) {
      for (const tenantId of member_ids) {
        await pool.execute('INSERT INTO email_group_member (group_id, tenant_id) VALUES (?, ?)', [groupId, tenantId]);
      }
    }

    res.json({ code: 200, message: 'Email group created', data: { id: groupId } });
  } catch (error) {
    console.error('Create email group error:', error);
    res.status(500).json({ code: 500, message: 'Failed to create email group' });
  }
});

// PUT /api/contact/email/group/:id - Update email group
router.put('/email/group/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, member_ids } = req.body;
    const orgId = req.user.orgId;

    await pool.execute(
      'UPDATE email_group SET name = ?, description = ?, updated_at = NOW() WHERE id = ? AND org_id = ?',
      [name, description, id, orgId]
    );

    if (member_ids !== undefined) {
      await pool.execute('DELETE FROM email_group_member WHERE group_id = ?', [id]);
      for (const tenantId of member_ids) {
        await pool.execute('INSERT INTO email_group_member (group_id, tenant_id) VALUES (?, ?)', [id, tenantId]);
      }
    }

    res.json({ code: 200, message: 'Email group updated' });
  } catch (error) {
    console.error('Update email group error:', error);
    res.status(500).json({ code: 500, message: 'Failed to update email group' });
  }
});

// DELETE /api/contact/email/group/:id - Delete email group
router.delete('/email/group/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;
    await pool.execute('DELETE FROM email_group_member WHERE group_id = ?', [id]);
    await pool.execute('UPDATE email_group SET status = 0 WHERE id = ? AND org_id = ?', [id, orgId]);
    res.json({ code: 200, message: 'Email group deleted' });
  } catch (error) {
    console.error('Delete email group error:', error);
    res.status(500).json({ code: 500, message: 'Failed to delete email group' });
  }
});

// POST /api/contact/email/send - Send email
router.post('/email/send', authenticate, async (req, res) => {
  try {
    const { to, cc, subject, body, group_id } = req.body;
    const orgId = req.user.orgId;

    let recipients = to || [];

    if (group_id) {
      const [groupEmails] = await pool.execute(
        `SELECT t.email FROM tenant t
         JOIN email_group_member egm ON egm.tenant_id = t.id
         WHERE egm.group_id = ? AND t.status = 1`,
        [group_id]
      );
      recipients = [...recipients, ...groupEmails.map(e => e.email)];
    }

    if (recipients.length === 0) {
      return res.status(400).json({ code: 400, message: 'No recipients specified' });
    }

    const result = await sendMail({
      to: recipients,
      ...(cc && cc.length ? { cc: Array.isArray(cc) ? cc.join(', ') : cc } : {}),
      subject,
      html: body,
    });

    console.log('Email sent:', result.messageId, result.previewUrl || '');
    res.json({ code: 200, message: 'Email sent successfully', data: { messageId: result.messageId, previewUrl: result.previewUrl } });
  } catch (error) {
    console.error('Send email error:', error);
    res.status(500).json({ code: 500, message: 'Failed to send email' });
  }
});

// ─── PROPERTY OWNER TAGS ──────────────────────────────────────────────────────

// GET /api/contact/contacts/property-owner/tag/all - Get all tags for org
router.get('/contacts/property-owner/tag/all', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const [tags] = await pool.execute(
      'SELECT * FROM property_owner_tag WHERE org_id = ? AND status = 1 ORDER BY name',
      [orgId]
    );
    res.json({ code: 200, data: tags });
  } catch (error) {
    console.error('Get all tags error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get tags' });
  }
});

// POST /api/contact/contacts/property-owner/tag - Create a new tag
router.post('/contacts/property-owner/tag', authenticate, async (req, res) => {
  try {
    const { name, color } = req.body;
    const orgId = req.user.orgId;
    const [result] = await pool.execute(
      'INSERT INTO property_owner_tag (org_id, name, color, status, created_at) VALUES (?, ?, ?, 1, NOW())',
      [orgId, name, color || '#1890ff']
    );
    res.json({ code: 200, message: 'Tag created', data: { id: result.insertId } });
  } catch (error) {
    console.error('Create tag error:', error);
    res.status(500).json({ code: 500, message: 'Failed to create tag' });
  }
});

// DELETE /api/contact/contacts/property-owner/tag/:id - Delete a tag
router.delete('/contacts/property-owner/tag/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;
    await pool.execute('UPDATE property_owner_tag SET status = 0 WHERE id = ? AND org_id = ?', [id, orgId]);
    res.json({ code: 200, message: 'Tag deleted' });
  } catch (error) {
    console.error('Delete tag error:', error);
    res.status(500).json({ code: 500, message: 'Failed to delete tag' });
  }
});

// GET /api/contact/property-owner/tag/:id - Get tags for a specific property owner
router.get('/property-owner/tag/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;
    const [tags] = await pool.execute(
      'SELECT t.* FROM property_owner_tag t JOIN property_owner_tag_map m ON m.tag_id = t.id WHERE m.property_owner_id = ? AND t.org_id = ? AND t.status = 1',
      [id, orgId]
    );
    res.json({ code: 200, data: tags });
  } catch (error) {
    console.error('Get owner tags error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get owner tags' });
  }
});

// POST /api/contact/property-owner/tag/:id - Add a tag to a property owner
router.post('/property-owner/tag/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, color } = req.body;
    const orgId = req.user.orgId;
    // Create tag and assign
    const [tagResult] = await pool.execute(
      'INSERT INTO property_owner_tag (org_id, name, color, status, created_at) VALUES (?, ?, ?, 1, NOW())',
      [orgId, name, color || '#1890ff']
    );
    await pool.execute(
      'INSERT INTO property_owner_tag_map (property_owner_id, tag_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE tag_id = tag_id',
      [id, tagResult.insertId]
    );
    res.json({ code: 200, message: 'Tag added', data: { id: tagResult.insertId } });
  } catch (error) {
    console.error('Add owner tag error:', error);
    res.status(500).json({ code: 500, message: 'Failed to add tag' });
  }
});

// ─── USER INVITATION ──────────────────────────────────────────────────────────

// POST /api/contact/tenant/check/user - Check if tenant has portal account
router.post('/tenant/check/user', authenticate, async (req, res) => {
  try {
    const { tenant_id } = req.body;
    const orgId = req.user.orgId;
    const [tenants] = await pool.execute(
      'SELECT t.id, t.first_name, t.last_name, t.email, t.user_id FROM tenant t WHERE t.id = ? AND t.org_id = ?',
      [tenant_id, orgId]
    );
    if (tenants.length === 0) return res.status(404).json({ code: 404, message: 'Tenant not found' });
    const hasAccount = tenants[0].user_id ? true : false;
    res.json({ code: 200, data: { ...tenants[0], has_account: hasAccount } });
  } catch (error) {
    console.error('Check tenant user error:', error);
    res.status(500).json({ code: 500, message: 'Failed to check tenant user' });
  }
});

// POST /api/contact/tenant/create/user - Invite tenant to create portal account
router.post('/tenant/create/user', authenticate, async (req, res) => {
  try {
    const { tenant_id, email } = req.body;
    const orgId = req.user.orgId;
    const inviteCode = Math.random().toString(36).substring(2, 10).toUpperCase();

    // Create a user record for the tenant
    const [userResult] = await pool.execute(
      'INSERT INTO user (username, email, password, org_id, status, created_at) VALUES (?, ?, ?, ?, 0, NOW())',
      [email, email, '', orgId]
    );
    const newUserId = userResult.insertId;

    // Link tenant to user and store verification token
    await pool.execute('UPDATE tenant SET user_id = ? WHERE id = ? AND org_id = ?', [newUserId, tenant_id, orgId]);
    await pool.execute(
      'INSERT INTO user_verification_token (user_id, token, created_at) VALUES (?, ?, NOW()) ON DUPLICATE KEY UPDATE token = ?, created_at = NOW()',
      [newUserId, inviteCode, inviteCode]
    );

    // Send invite email
    try {
      const { sendMail } = require('../config/mailer');
      await sendMail({
        to: email,
        subject: 'You have been invited to the tenant portal',
        html: `<p>You have been invited to access your tenant portal. Your invite code is: <strong>${inviteCode}</strong></p>`,
      });
    } catch (emailError) {
      console.error('Failed to send invite email:', emailError);
    }
    res.json({ code: 200, message: 'Invitation sent successfully', data: { inviteCode } });
  } catch (error) {
    console.error('Create tenant user error:', error);
    res.status(500).json({ code: 500, message: 'Failed to create tenant user invite' });
  }
});

// POST /api/contact/property-owner/check/user - Check if property owner has portal account
router.post('/property-owner/check/user', authenticate, async (req, res) => {
  try {
    const { owner_id } = req.body;
    const orgId = req.user.orgId;
    const [owners] = await pool.execute(
      'SELECT po.id, po.first_name, po.last_name, po.email, po.user_id FROM property_owner po WHERE po.id = ? AND po.org_id = ?',
      [owner_id, orgId]
    );
    if (owners.length === 0) return res.status(404).json({ code: 404, message: 'Property owner not found' });
    const hasAccount = owners[0].user_id ? true : false;
    res.json({ code: 200, data: { ...owners[0], has_account: hasAccount } });
  } catch (error) {
    console.error('Check owner user error:', error);
    res.status(500).json({ code: 500, message: 'Failed to check owner user' });
  }
});

// POST /api/contact/property-owner/create/user - Invite property owner to portal
router.post('/property-owner/create/user', authenticate, async (req, res) => {
  try {
    const { owner_id, email } = req.body;
    const orgId = req.user.orgId;
    const inviteCode = Math.random().toString(36).substring(2, 10).toUpperCase();

    // Create a user record for the owner
    const [userResult] = await pool.execute(
      'INSERT INTO user (username, email, password, org_id, status, created_at) VALUES (?, ?, ?, ?, 0, NOW())',
      [email, email, '', orgId]
    );
    const newUserId = userResult.insertId;

    // Link owner to user and store verification token
    await pool.execute('UPDATE property_owner SET user_id = ? WHERE id = ? AND org_id = ?', [newUserId, owner_id, orgId]);
    await pool.execute(
      'INSERT INTO user_verification_token (user_id, token, created_at) VALUES (?, ?, NOW()) ON DUPLICATE KEY UPDATE token = ?, created_at = NOW()',
      [newUserId, inviteCode, inviteCode]
    );
    try {
      const { sendMail } = require('../config/mailer');
      await sendMail({
        to: email,
        subject: 'You have been invited to the property owner portal',
        html: `<p>You have been invited to access your property owner portal. Your invite code is: <strong>${inviteCode}</strong></p>`,
      });
    } catch (emailError) {
      console.error('Failed to send owner invite email:', emailError);
    }
    res.json({ code: 200, message: 'Invitation sent successfully', data: { inviteCode } });
  } catch (error) {
    console.error('Create owner user error:', error);
    res.status(500).json({ code: 500, message: 'Failed to create owner user invite' });
  }
});

module.exports = router;
