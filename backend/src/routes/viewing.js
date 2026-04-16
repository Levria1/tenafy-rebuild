/**
 * Authed viewing management routes for staff.
 *
 * Mounted at: /api/viewing
 *
 * These endpoints let an org admin / property manager generate public share
 * links for a unit, revoke leaked links, and review incoming bookings. All
 * routes go through the standard `authenticate` middleware, so `req.pool` is
 * scoped to the logged-in user's org.
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const { authenticate } = require('../middleware/auth');
const { getMasterPool } = require('../config/poolRegistry');
const { KIND_LINK } = require('../middleware/viewingTokenAuth');

router.use(authenticate);

function ok(res, data) { return res.json({ code: 200, data }); }
function fail(res, message, status = 500) {
  return res.status(status).json({ code: status, message });
}
function newId() {
  return (BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000))).toString();
}
function newLinkToken() {
  return 'vbk_' + crypto.randomBytes(24).toString('hex');
}

// ---------------------------------------------------------------------------
// GET /unit/:unitId/links — list shareable links for a unit
// ---------------------------------------------------------------------------
router.get('/unit/:unitId/links', async (req, res) => {
  try {
    const { unitId } = req.params;
    const [rows] = await req.pool.execute(
      `SELECT vl.id, vl.token, vl.status, vl.note, vl.created_at, vl.revoked_at,
              vl.employee_id,
              usr.first_name AS employee_first_name,
              usr.last_name AS employee_last_name,
              usr.email AS employee_email,
              (SELECT COUNT(*) FROM viewing_booking vb WHERE vb.link_id = vl.id) AS booking_count
       FROM viewing_link vl
       JOIN user usr ON vl.employee_id = usr.id
       WHERE vl.unit_id = ?
       ORDER BY vl.created_at DESC`,
      [unitId]
    );
    ok(res, rows.map(r => ({
      id: String(r.id),
      token: r.token,
      status: r.status,
      note: r.note,
      created_at: r.created_at,
      revoked_at: r.revoked_at,
      employee: {
        id: String(r.employee_id),
        first_name: r.employee_first_name,
        last_name: r.employee_last_name,
        email: r.employee_email,
      },
      booking_count: Number(r.booking_count || 0),
    })));
  } catch (err) {
    console.error('[viewing] list links error:', err);
    fail(res, 'Failed to list links');
  }
});

// ---------------------------------------------------------------------------
// POST /unit/:unitId/links — create a shareable link
// body: { employee_id, note? }
// ---------------------------------------------------------------------------
router.post('/unit/:unitId/links', async (req, res) => {
  try {
    const { unitId } = req.params;
    const { employee_id, note } = req.body || {};
    if (!employee_id) return fail(res, 'employee_id is required', 400);

    // Verify unit exists under this org (JOIN property for org filter).
    const [units] = await req.pool.execute(
      `SELECT u.id, u.property_id FROM unit u
       JOIN property p ON u.property_id = p.id
       WHERE u.id = ? AND p.deleted_at IS NULL LIMIT 1`,
      [unitId]
    );
    if (!units.length) return fail(res, 'Unit not found', 404);

    // Verify employee belongs to same org DB (shared pool => same org).
    const [users] = await req.pool.execute(
      'SELECT id FROM user WHERE id = ? AND status = 1 LIMIT 1',
      [employee_id]
    );
    if (!users.length) return fail(res, 'Employee not found or inactive', 400);

    const id = newId();
    const token = newLinkToken();
    const propertyId = units[0].property_id;

    // Insert into the org DB first
    await req.pool.execute(
      `INSERT INTO viewing_link
         (id, token, property_id, unit_id, employee_id, created_by, note, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, NOW())`,
      [id, token, propertyId, unitId, employee_id, req.user.id, note || null]
    );

    // Register in master token registry so the public middleware can resolve it.
    const master = getMasterPool();
    await master.execute(
      `INSERT INTO viewing_link_registry (token, org_id, kind, status) VALUES (?, ?, ?, 1)`,
      [token, String(req.user.orgId), KIND_LINK]
    );

    ok(res, { id: String(id), token });
  } catch (err) {
    console.error('[viewing] create link error:', err);
    fail(res, 'Failed to create link');
  }
});

// ---------------------------------------------------------------------------
// PATCH /link/:id/revoke — revoke a shareable link
// ---------------------------------------------------------------------------
router.patch('/link/:id/revoke', async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await req.pool.execute(
      'SELECT token, status FROM viewing_link WHERE id = ? LIMIT 1',
      [id]
    );
    if (!rows.length) return fail(res, 'Link not found', 404);
    if (rows[0].status === 0) return ok(res, { already_revoked: true });

    await req.pool.execute(
      'UPDATE viewing_link SET status = 0, revoked_at = NOW() WHERE id = ?',
      [id]
    );
    const master = getMasterPool();
    await master.execute(
      'UPDATE viewing_link_registry SET status = 0 WHERE token = ?',
      [rows[0].token]
    );
    ok(res, { id: String(id) });
  } catch (err) {
    console.error('[viewing] revoke link error:', err);
    fail(res, 'Failed to revoke link');
  }
});

// ---------------------------------------------------------------------------
// GET /unit/:unitId/bookings — list bookings for a unit
// ---------------------------------------------------------------------------
router.get('/unit/:unitId/bookings', async (req, res) => {
  try {
    const { unitId } = req.params;
    const [rows] = await req.pool.execute(
      `SELECT vb.id, vb.viewer_name, vb.viewer_email, vb.viewer_phone,
              vb.proposed_datetime, vb.duration_minutes,
              vb.tenant_decision, vb.employee_decision, vb.status,
              vb.created_at, vb.link_id,
              usr.first_name AS employee_first_name,
              usr.last_name AS employee_last_name
       FROM viewing_booking vb
       JOIN user usr ON vb.employee_id = usr.id
       WHERE vb.unit_id = ?
       ORDER BY vb.created_at DESC`,
      [unitId]
    );
    ok(res, rows.map(r => ({
      id: String(r.id),
      viewer_name: r.viewer_name,
      viewer_email: r.viewer_email,
      viewer_phone: r.viewer_phone,
      proposed_datetime: r.proposed_datetime,
      duration_minutes: r.duration_minutes,
      tenant_decision: r.tenant_decision,
      employee_decision: r.employee_decision,
      status: r.status,
      created_at: r.created_at,
      link_id: String(r.link_id),
      employee: {
        first_name: r.employee_first_name,
        last_name: r.employee_last_name,
      },
    })));
  } catch (err) {
    console.error('[viewing] list bookings error:', err);
    fail(res, 'Failed to list bookings');
  }
});

// ---------------------------------------------------------------------------
// GET /bookings/:id — booking detail
// ---------------------------------------------------------------------------
router.get('/bookings/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await req.pool.execute(
      `SELECT vb.*,
              u.name AS unit_name, p.display_name AS property_name,
              usr.first_name AS employee_first_name, usr.last_name AS employee_last_name,
              usr.email AS employee_email,
              t.first_name AS tenant_first_name, t.last_name AS tenant_last_name,
              t.company_name AS tenant_company, t.email AS tenant_email
       FROM viewing_booking vb
       JOIN unit u ON vb.unit_id = u.id
       JOIN property p ON vb.property_id = p.id
       JOIN user usr ON vb.employee_id = usr.id
       LEFT JOIN tenant t ON vb.tenant_id = t.id
       WHERE vb.id = ? LIMIT 1`,
      [id]
    );
    if (!rows.length) return fail(res, 'Booking not found', 404);
    const r = rows[0];
    // Do not leak action/manage tokens to staff UI — they are only for email recipients.
    delete r.tenant_action_token;
    delete r.employee_action_token;
    delete r.viewer_manage_token;
    ok(res, { ...r, id: String(r.id), unit_id: String(r.unit_id), link_id: String(r.link_id) });
  } catch (err) {
    console.error('[viewing] get booking error:', err);
    fail(res, 'Failed to load booking');
  }
});

// ---------------------------------------------------------------------------
// PATCH /bookings/:id/cancel — staff-side cancel (for bookings in pending state)
// ---------------------------------------------------------------------------
router.patch('/bookings/:id/cancel', async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await req.pool.execute(
      'SELECT status FROM viewing_booking WHERE id = ? LIMIT 1', [id]
    );
    if (!rows.length) return fail(res, 'Booking not found', 404);
    if (rows[0].status === 3) return ok(res, { already: true });
    await req.pool.execute('UPDATE viewing_booking SET status = 3 WHERE id = ?', [id]);
    ok(res, { id: String(id), status: 3 });
  } catch (err) {
    console.error('[viewing] cancel booking error:', err);
    fail(res, 'Failed to cancel booking');
  }
});

module.exports = router;
