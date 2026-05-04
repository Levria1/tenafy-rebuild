/**
 * Inquiry routes — lead capture separate from the contacts/tenant table.
 *
 * An inquiry is a prospective viewer/lead. Staff can either dismiss it,
 * promote it to a contact (tenant row), or schedule a viewing from it.
 *
 * Mounted at: /api/inquiry
 */

const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { logActivity } = require('../utils/activityLog');

router.use(authenticate);

function ok(res, data) { return res.json({ code: 200, data }); }
function fail(res, message, status = 500) {
  return res.status(status).json({ code: status, message });
}
function newId() {
  return (BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000))).toString();
}

// ---------------------------------------------------------------------------
// GET /list — paged list with optional search + filters
// ---------------------------------------------------------------------------
router.get('/list', async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { search, status, leadSourceId, source } = req.query;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    let where = 'i.org_id = ? AND i.deleted_at IS NULL';
    const params = [orgId];

    if (search) {
      where += ` AND (i.first_name LIKE ? OR i.last_name LIKE ?
                     OR CONCAT(COALESCE(i.first_name,''),' ',COALESCE(i.last_name,'')) LIKE ?
                     OR i.email LIKE ? OR i.phone LIKE ?)`;
      const s = '%' + search + '%';
      params.push(s, s, s, s, s);
    }
    if (status !== undefined && status !== '' && status !== null) {
      where += ' AND i.status = ?';
      params.push(parseInt(status));
    }
    if (leadSourceId) {
      where += ' AND i.lead_source_id = ?';
      params.push(leadSourceId);
    }
    if (source) {
      where += ' AND i.source = ?';
      params.push(source);
    }

    const [rows] = await req.pool.execute(
      `SELECT i.*,
              ls.name AS lead_source_name,
              CONCAT(COALESCE(u.first_name,''),' ',COALESCE(u.last_name,'')) AS created_by_name,
              u.email AS created_by_email,
              p.display_name AS property_name,
              un.name AS unit_name
       FROM inquiry i
       LEFT JOIN lead_source_setting ls ON i.lead_source_id = ls.id
       LEFT JOIN user u ON i.created_by_user_id = u.id
       LEFT JOIN property p ON i.property_id = p.id
       LEFT JOIN unit un ON i.unit_id = un.id
       WHERE ${where}
       ORDER BY i.inquiry_date DESC
       LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    const [[{ total }]] = await req.pool.execute(
      `SELECT COUNT(*) AS total FROM inquiry i WHERE ${where}`,
      params
    );

    ok(res, { content: rows, totalElements: total, totalPages: Math.ceil(total / limit), currentPage: page });
  } catch (err) {
    console.error('[inquiry] list error:', err);
    fail(res, 'Failed to list inquiries');
  }
});

// ---------------------------------------------------------------------------
// GET /:id
// ---------------------------------------------------------------------------
router.get('/:id', async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const [rows] = await req.pool.execute(
      `SELECT i.*,
              ls.name AS lead_source_name,
              CONCAT(COALESCE(u.first_name,''),' ',COALESCE(u.last_name,'')) AS created_by_name,
              u.email AS created_by_email,
              p.display_name AS property_name,
              un.name AS unit_name
       FROM inquiry i
       LEFT JOIN lead_source_setting ls ON i.lead_source_id = ls.id
       LEFT JOIN user u ON i.created_by_user_id = u.id
       LEFT JOIN property p ON i.property_id = p.id
       LEFT JOIN unit un ON i.unit_id = un.id
       WHERE i.id = ? AND i.org_id = ? AND i.deleted_at IS NULL
       LIMIT 1`,
      [req.params.id, orgId]
    );
    if (!rows.length) return fail(res, 'Inquiry not found', 404);

    // Linked viewings
    const [viewings] = await req.pool.execute(
      `SELECT vb.id, vb.proposed_datetime, vb.duration_minutes, vb.status,
              vb.tenant_decision, vb.employee_decision,
              p.display_name AS property_name, un.name AS unit_name
       FROM viewing_booking vb
       LEFT JOIN property p ON vb.property_id = p.id
       LEFT JOIN unit un ON vb.unit_id = un.id
       WHERE vb.inquiry_id = ?
       ORDER BY vb.proposed_datetime DESC`,
      [req.params.id]
    );

    ok(res, { ...rows[0], viewings });
  } catch (err) {
    console.error('[inquiry] get error:', err);
    fail(res, 'Failed to load inquiry');
  }
});

// ---------------------------------------------------------------------------
// POST / — create an inquiry (manual entry by staff)
// ---------------------------------------------------------------------------
router.post('/', async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const userId = req.user.id;
    const {
      inquiry_date, lead_source_id, first_name, last_name,
      email, phone, notes, unit_id, property_id, source,
    } = req.body || {};

    if (!first_name && !last_name && !email && !phone) {
      return fail(res, 'At least one of name, email, or phone is required', 400);
    }

    const id = newId();
    await req.pool.execute(
      `INSERT INTO inquiry
         (id, org_id, inquiry_date, lead_source_id,
          first_name, last_name, email, phone, notes,
          unit_id, property_id, created_by_user_id, source, status)
       VALUES (?, ?, COALESCE(?, NOW()), ?,  ?, ?, ?, ?, ?,  ?, ?, ?, ?, 0)`,
      [
        id, orgId, inquiry_date || null, lead_source_id || null,
        first_name || null, last_name || null,
        email ? String(email).trim().toLowerCase() : null,
        phone || null, notes || null,
        unit_id || null, property_id || null,
        userId, source || 'manual',
      ]
    );

    logActivity(req, { action: 'CREATE', entityType: 'INQUIRY', entityId: id }).catch(() => {});
    ok(res, { id });
  } catch (err) {
    console.error('[inquiry] create error:', err);
    fail(res, 'Failed to create inquiry');
  }
});

// ---------------------------------------------------------------------------
// PUT /:id — update
// ---------------------------------------------------------------------------
router.put('/:id', async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const fields = [
      'inquiry_date', 'lead_source_id', 'first_name', 'last_name',
      'email', 'phone', 'notes', 'unit_id', 'property_id', 'status',
    ];
    const sets = [];
    const params = [];
    for (const f of fields) {
      if (req.body[f] !== undefined) {
        sets.push(`${f} = ?`);
        params.push(
          f === 'email' && req.body[f] ? String(req.body[f]).trim().toLowerCase() : req.body[f] || null
        );
      }
    }
    if (!sets.length) return fail(res, 'No fields to update', 400);
    params.push(req.params.id, orgId);

    const [r] = await req.pool.execute(
      `UPDATE inquiry SET ${sets.join(', ')} WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
      params
    );
    if (!r.affectedRows) return fail(res, 'Inquiry not found', 404);

    logActivity(req, { action: 'UPDATE', entityType: 'INQUIRY', entityId: req.params.id }).catch(() => {});
    ok(res, { updated: true });
  } catch (err) {
    console.error('[inquiry] update error:', err);
    fail(res, 'Failed to update inquiry');
  }
});

// ---------------------------------------------------------------------------
// DELETE /:id — soft delete
// ---------------------------------------------------------------------------
router.delete('/:id', async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const [r] = await req.pool.execute(
      'UPDATE inquiry SET deleted_at = NOW() WHERE id = ? AND org_id = ?',
      [req.params.id, orgId]
    );
    if (!r.affectedRows) return fail(res, 'Inquiry not found', 404);
    logActivity(req, { action: 'DELETE', entityType: 'INQUIRY', entityId: req.params.id }).catch(() => {});
    ok(res, { deleted: true });
  } catch (err) {
    console.error('[inquiry] delete error:', err);
    fail(res, 'Failed to delete inquiry');
  }
});

// ---------------------------------------------------------------------------
// POST /:id/link-contact
//
// Links an EXISTING tenant id to this inquiry. Used by the tenant-create
// flow when the inquiry's "Create Contact" button routes to the tenant
// create form (rather than auto-creating a tenant): once the user submits
// the form and the tenant exists, the frontend calls this endpoint to
// stamp the inquiry.tenant_id and flip status to 1 (converted).
//
// Body: { tenant_id }
// ---------------------------------------------------------------------------
router.post('/:id/link-contact', async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { tenant_id } = req.body || {};
    if (!tenant_id) return fail(res, 'tenant_id is required', 400);

    // Verify tenant belongs to this org.
    const [t] = await req.pool.execute(
      'SELECT id FROM tenant WHERE id = ? AND org_id = ? AND deleted_at IS NULL LIMIT 1',
      [tenant_id, orgId]
    );
    if (!t.length) return fail(res, 'Tenant not found', 404);

    const [r] = await req.pool.execute(
      'UPDATE inquiry SET tenant_id = ?, status = 1 WHERE id = ? AND org_id = ? AND deleted_at IS NULL',
      [tenant_id, req.params.id, orgId]
    );
    if (!r.affectedRows) return fail(res, 'Inquiry not found', 404);

    logActivity(req, { action: 'LINK_CONTACT', entityType: 'INQUIRY', entityId: req.params.id }).catch(() => {});
    ok(res, { tenant_id: String(tenant_id) });
  } catch (err) {
    console.error('[inquiry] link-contact error:', err);
    fail(res, 'Failed to link contact');
  }
});

module.exports = router;
