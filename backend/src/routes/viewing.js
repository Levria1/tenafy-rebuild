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
const { deleteViewingEvent } = require('../services/googleCalendar');
const { sendWhatsApp } = require('../services/whatsappService');
const { sendViewingMail } = require('../services/viewingNotify');
const { mintInvite } = require('../services/viewingInvite');
const viewingNegotiation = require('../services/viewingNegotiation');

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
function escapeHtml(str) {
  if (str == null) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function formatWhen(dt) {
  try {
    return new Date(dt).toLocaleString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  } catch { return String(dt); }
}
function employeeDisplay(b) {
  return [b.employee_first_name, b.employee_last_name].filter(Boolean).join(' ') || b.employee_email || '';
}

// Load a booking with everything cancel / reschedule need: host (gcal),
// tenant (email + phone), unit/property. Org-scoped.
async function loadBookingForAction(pool, orgId, id) {
  const [rows] = await pool.execute(
    `SELECT vb.*, u.name AS unit_name,
            p.display_name AS property_name, p.street_address, p.city, p.state,
            usr.email AS employee_email, usr.google_calendar_id AS employee_google_calendar_id,
            usr.first_name AS employee_first_name, usr.last_name AS employee_last_name,
            t.email AS tenant_email, t.phone AS tenant_phone,
            t.first_name AS tenant_first_name, t.last_name AS tenant_last_name
     FROM viewing_booking vb
     JOIN unit u ON vb.unit_id = u.id
     JOIN property p ON vb.property_id = p.id
     JOIN user usr ON vb.employee_id = usr.id
     LEFT JOIN tenant t ON vb.tenant_id = t.id
     WHERE vb.id = ? AND p.org_id = ? LIMIT 1`,
    [id, orgId]
  );
  return rows[0] || null;
}

// Mark a booking cancelled: release tentative candidates, drop the Google
// Calendar event (if confirmed), set status=3. Notifications are separate.
async function cancelBookingRow(pool, b) {
  await pool.execute(`UPDATE viewing_candidate SET status = 0 WHERE booking_id = ? AND status = 1`, [b.id]);
  await pool.execute(`UPDATE viewing_booking SET status = 3, awaiting = NULL WHERE id = ?`, [b.id]);
  if (b.gcal_event_id && b.employee_google_calendar_id) {
    deleteViewingEvent({ calendarId: b.employee_google_calendar_id, gcalEventId: b.gcal_event_id })
      .catch(e => console.error('[viewing] gcal delete failed:', e.message));
  }
}

// Notify prospect + tenant that a viewing was cancelled (email + WhatsApp).
function notifyCancelled(pool, orgId, b) {
  const when = formatWhen(b.proposed_datetime);
  const vars = {
    '%Viewer Name%': b.viewer_name || '', '%Viewing Date%': when,
    '%Unit Name%': b.unit_name || '', '%Property Name%': b.property_name || '',
    '%Property Address%': [b.street_address, b.city, b.state].filter(Boolean).join(', '),
    '%Host Name%': employeeDisplay(b),
  };
  const html = `<p>The viewing of <strong>${escapeHtml(b.unit_name)}</strong> at
    <strong>${escapeHtml(b.property_name)}</strong> on <strong>${escapeHtml(when)}</strong>
    has been cancelled by the property team.</p>`;
  for (const to of [b.viewer_email, b.tenant_email].filter(Boolean)) {
    sendViewingMail(pool, orgId, {
      templateType: 'Viewing-Cancelled', variables: vars,
      fallback: { subject: `Viewing cancelled: ${b.unit_name}`, html },
      mailOpts: { to },
    }).catch(e => console.error('[viewing] cancel email failed:', e.message));
  }
  const waText = `Your viewing of ${b.unit_name} at ${b.property_name} on ${when} has been cancelled by the property team.`;
  for (const ph of [b.viewer_phone, b.tenant_phone].filter(Boolean)) {
    sendWhatsApp(pool, orgId, ph, waText).catch(e => console.error('[viewing] cancel WhatsApp failed:', e.message));
  }
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
       JOIN unit u ON vl.unit_id = u.id
       JOIN property p ON u.property_id = p.id
       LEFT JOIN user usr ON vl.employee_id = usr.id
       WHERE vl.unit_id = ?
         AND p.org_id = ?
       ORDER BY vl.created_at DESC`,
      [unitId, req.user.orgId]
    );
    ok(res, rows.map(r => ({
      id: String(r.id),
      token: r.token,
      status: r.status,
      note: r.note,
      created_at: r.created_at,
      revoked_at: r.revoked_at,
      employee: r.employee_id ? {
        id: String(r.employee_id),
        first_name: r.employee_first_name,
        last_name: r.employee_last_name,
        email: r.employee_email,
      } : null,
      booking_count: Number(r.booking_count || 0),
    })));
  } catch (err) {
    console.error('[viewing] list links error:', err);
    fail(res, 'Failed to list links');
  }
});

// ---------------------------------------------------------------------------
// POST /unit/:unitId/links — create a shareable link
// body: { employee_id? (optional), note? }
//
// The employee is optional at create time. Until an employee is assigned via
// PATCH /link/:id/employee, the public endpoints will refuse submissions and
// show a "not ready" state to viewers.
// ---------------------------------------------------------------------------
router.post('/unit/:unitId/links', async (req, res) => {
  try {
    const { unitId } = req.params;
    const { employee_id, note } = req.body || {};

    // Verify unit exists and is active under this org. Org isolation is
    // enforced by req.pool (per-org DB).
    const [units] = await req.pool.execute(
      `SELECT u.id, u.property_id FROM unit u
       JOIN property p ON u.property_id = p.id
       WHERE u.id = ?
         AND p.org_id = ?
         AND p.status = 1 AND p.deleted_at IS NULL
         AND u.active_status = 1 AND u.deleted_at IS NULL
       LIMIT 1`,
      [unitId, req.user.orgId]
    );
    if (!units.length) return fail(res, 'Unit not found or no longer active', 404);

    // If employee_id was supplied, validate it belongs to this org.
    if (employee_id) {
      const [users] = await req.pool.execute(
        'SELECT id FROM user WHERE id = ? AND status = 1 LIMIT 1',
        [employee_id]
      );
      if (!users.length) return fail(res, 'Employee not found or inactive', 400);
    }

    const id = newId();
    const token = newLinkToken();
    const propertyId = units[0].property_id;

    // Insert into the org DB first
    await req.pool.execute(
      `INSERT INTO viewing_link
         (id, token, property_id, unit_id, employee_id, created_by, note, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, NOW())`,
      [id, token, propertyId, unitId, employee_id || null, req.user.id, note || null]
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
// PATCH /link/:id/employee — assign or change which employee handles this link
// body: { employee_id }  (pass null to unassign)
// ---------------------------------------------------------------------------
router.patch('/link/:id/employee', async (req, res) => {
  try {
    const { id } = req.params;
    const { employee_id } = req.body || {};

    // Verify the link belongs to this org.
    const [rows] = await req.pool.execute(
      `SELECT vl.id FROM viewing_link vl
       JOIN unit u ON vl.unit_id = u.id
       JOIN property p ON u.property_id = p.id
       WHERE vl.id = ? AND p.org_id = ? LIMIT 1`,
      [id, req.user.orgId]
    );
    if (!rows.length) return fail(res, 'Link not found', 404);

    if (employee_id) {
      const [users] = await req.pool.execute(
        'SELECT id FROM user WHERE id = ? AND status = 1 LIMIT 1',
        [employee_id]
      );
      if (!users.length) return fail(res, 'Employee not found or inactive', 400);
    }

    await req.pool.execute(
      'UPDATE viewing_link SET employee_id = ? WHERE id = ?',
      [employee_id || null, id]
    );

    ok(res, { id: String(id), employee_id: employee_id || null });
  } catch (err) {
    console.error('[viewing] assign employee error:', err);
    fail(res, 'Failed to update employee');
  }
});

// ---------------------------------------------------------------------------
// PATCH /link/:id/revoke — revoke a shareable link
// ---------------------------------------------------------------------------
router.patch('/link/:id/revoke', async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await req.pool.execute(
      `SELECT vl.token, vl.status FROM viewing_link vl
       JOIN unit u ON vl.unit_id = u.id
       JOIN property p ON u.property_id = p.id
       WHERE vl.id = ? AND p.org_id = ? LIMIT 1`,
      [id, req.user.orgId]
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
       JOIN property p ON vb.property_id = p.id
       JOIN user usr ON vb.employee_id = usr.id
       WHERE vb.unit_id = ?
         AND p.org_id = ?
       ORDER BY vb.created_at DESC`,
      [unitId, req.user.orgId]
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
// GET /bookings — list bookings across all units (staff dashboard)
//   Query params (all optional):
//     status       one of 0,1,2,3 (or CSV like "0,1") — booking status filter
//     employee_id  bigint-string — filter by assigned employee
//     property_id  bigint-string
//     unit_id      bigint-string
//     from         YYYY-MM-DD — proposed_datetime >=
//     to           YYYY-MM-DD — proposed_datetime <=
//     limit        default 100
// ---------------------------------------------------------------------------
router.get('/bookings', async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { status, employee_id, property_id, unit_id, from, to, awaiting, source, q } = req.query;
    const limit = Math.min(parseInt(req.query.limit || '100', 10) || 100, 500);

    const where = ['p.org_id = ?'];
    const params = [orgId];

    if (status !== undefined && status !== '') {
      const statuses = String(status).split(',').map(s => parseInt(s, 10)).filter(n => !isNaN(n));
      if (statuses.length === 1) {
        where.push('vb.status = ?');
        params.push(statuses[0]);
      } else if (statuses.length > 1) {
        where.push(`vb.status IN (${statuses.map(() => '?').join(',')})`);
        params.push(...statuses);
      }
    }
    if (employee_id) { where.push('vb.employee_id = ?'); params.push(employee_id); }
    if (property_id) { where.push('vb.property_id = ?'); params.push(property_id); }
    if (unit_id)     { where.push('vb.unit_id = ?');     params.push(unit_id); }
    if (from)        { where.push('vb.proposed_datetime >= ?'); params.push(from); }
    if (to)          { where.push('vb.proposed_datetime <= ?'); params.push(to + ' 23:59:59'); }
    if (awaiting)    { where.push('vb.awaiting = ?'); params.push(awaiting); }
    if (source)      { where.push('vb.source = ?');   params.push(source); }
    if (q) {
      where.push('(vb.viewer_name LIKE ? OR vb.viewer_email LIKE ? OR vb.viewer_phone LIKE ?)');
      const like = `%${q}%`;
      params.push(like, like, like);
    }

    const [rows] = await req.pool.execute(
      `SELECT vb.id, vb.viewer_name, vb.viewer_email, vb.viewer_phone, vb.viewer_message,
              vb.proposed_datetime, vb.duration_minutes, vb.created_at,
              vb.tenant_decision, vb.employee_decision, vb.status, vb.source, vb.awaiting,
              vb.unit_id, vb.property_id, vb.employee_id,
              u.name AS unit_name,
              p.display_name AS property_name,
              usr.first_name AS employee_first_name,
              usr.last_name AS employee_last_name,
              (SELECT GROUP_CONCAT(vc.proposed_datetime ORDER BY vc.proposed_datetime SEPARATOR '|')
                 FROM viewing_candidate vc
                WHERE vc.booking_id = vb.id AND vc.status IN (1, 2)) AS candidate_times
       FROM viewing_booking vb
       JOIN unit u     ON vb.unit_id = u.id
       JOIN property p ON vb.property_id = p.id
       JOIN user usr   ON vb.employee_id = usr.id
       WHERE ${where.join(' AND ')}
       ORDER BY vb.proposed_datetime DESC
       LIMIT ${limit}`,
      params
    );

    ok(res, rows.map(r => ({
      id: String(r.id),
      viewer_name: r.viewer_name,
      viewer_email: r.viewer_email,
      viewer_phone: r.viewer_phone,
      viewer_message: r.viewer_message,
      proposed_datetime: r.proposed_datetime,
      duration_minutes: r.duration_minutes,
      created_at: r.created_at,
      tenant_decision: r.tenant_decision,
      employee_decision: r.employee_decision,
      status: r.status,
      source: r.source,
      awaiting: r.awaiting || null,
      candidate_times: r.candidate_times ? String(r.candidate_times).split('|') : [],
      unit: { id: String(r.unit_id), name: r.unit_name },
      property: { id: String(r.property_id), name: r.property_name },
      employee: {
        id: String(r.employee_id),
        first_name: r.employee_first_name,
        last_name: r.employee_last_name,
      },
    })));
  } catch (err) {
    console.error('[viewing] list all bookings error:', err);
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
       WHERE vb.id = ? AND p.org_id = ? LIMIT 1`,
      [id, req.user.orgId]
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
// PATCH /bookings/:id/cancel — staff-side cancel
//
// Releases any tentative candidates, removes the Google Calendar event (if
// confirmed), sets status=3, and notifies the prospect + tenant (email + WA).
// ---------------------------------------------------------------------------
router.patch('/bookings/:id/cancel', async (req, res) => {
  try {
    const { id } = req.params;
    const booking = await loadBookingForAction(req.pool, req.user.orgId, id);
    if (!booking) return fail(res, 'Booking not found', 404);
    if (Number(booking.status) === 3) return ok(res, { already: true });

    await cancelBookingRow(req.pool, booking);
    notifyCancelled(req.pool, req.user.orgId, booking);

    ok(res, { id: String(id), status: 3 });
  } catch (err) {
    console.error('[viewing] cancel booking error:', err);
    fail(res, 'Failed to cancel booking');
  }
});

// ---------------------------------------------------------------------------
// POST /bookings/:id/reschedule — staff cancel + re-issue a fresh prospect link
//
// Cancels the current booking (releasing candidates + calendar) WITHOUT the
// generic "cancelled" blast, then mints a new per-prospect invite (same unit,
// host, prospect) and sends the prospect a "let's find a new time" message with
// the link. The tenant is told the previous time was cancelled. Returns the URL
// so staff can also copy/send it manually.
// ---------------------------------------------------------------------------
router.post('/bookings/:id/reschedule', async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;
    const booking = await loadBookingForAction(req.pool, orgId, id);
    if (!booking) return fail(res, 'Booking not found', 404);
    if (Number(booking.status) === 3) return fail(res, 'Booking is already cancelled', 409);

    // Cancel the existing booking (release candidates + drop calendar event).
    await cancelBookingRow(req.pool, booking);

    // Mint a fresh invite for the same prospect/unit/host.
    const prefillDate = booking.proposed_datetime
      ? new Date(booking.proposed_datetime).toISOString().slice(0, 10) : null;
    const invite = await mintInvite(req.pool, orgId, {
      unitId: booking.unit_id,
      propertyId: booking.property_id,
      employeeId: booking.employee_id,
      leasingId: booking.leasing_id,
      prospect: { name: booking.viewer_name, phone: booking.viewer_phone, email: booking.viewer_email },
      prefillDate,
      ttlDays: 7,
    });

    // Prospect: invite to re-pick (email + WhatsApp).
    const vars = {
      '%Viewer Name%': booking.viewer_name || '',
      '%Unit Name%': booking.unit_name || '',
      '%Property Name%': booking.property_name || '',
      '%Booking URL%': invite.url,
    };
    const html = `<p>Hi ${escapeHtml(booking.viewer_name)},</p>
      <p>We need to reschedule your viewing of <strong>${escapeHtml(booking.unit_name)}</strong> at
      <strong>${escapeHtml(booking.property_name)}</strong>. Please pick new times here:</p>
      <p><a href="${invite.url}">${invite.url}</a></p>`;
    if (booking.viewer_email) {
      sendViewingMail(req.pool, orgId, {
        templateType: 'Viewing-Reschedule', variables: vars,
        fallback: { subject: `Let's reschedule your viewing — ${booking.unit_name}`, html },
        mailOpts: { to: booking.viewer_email },
      }).catch(e => console.error('[viewing] reschedule email failed:', e.message));
    }
    if (booking.viewer_phone) {
      const waText = `Hi ${booking.viewer_name}, we need to reschedule your viewing of ${booking.unit_name} at ${booking.property_name}. Please pick new times here:\n${invite.url}`;
      sendWhatsApp(req.pool, orgId, booking.viewer_phone, waText)
        .catch(e => console.error('[viewing] reschedule WhatsApp failed:', e.message));
    }

    // Tenant: the previous time is cancelled (no link — the prospect re-picks).
    if (booking.tenant_email || booking.tenant_phone) {
      const when = formatWhen(booking.proposed_datetime);
      const tHtml = `<p>The viewing of <strong>${escapeHtml(booking.unit_name)}</strong> previously set for
        <strong>${escapeHtml(when)}</strong> has been cancelled. We'll be in touch with a new time shortly.</p>`;
      if (booking.tenant_email) {
        sendViewingMail(req.pool, orgId, {
          templateType: 'Viewing-Cancelled',
          variables: { '%Unit Name%': booking.unit_name || '', '%Viewing Date%': when, '%Property Name%': booking.property_name || '' },
          fallback: { subject: `Viewing rescheduled: ${booking.unit_name}`, html: tHtml },
          mailOpts: { to: booking.tenant_email },
        }).catch(e => console.error('[viewing] reschedule tenant email failed:', e.message));
      }
      if (booking.tenant_phone) {
        sendWhatsApp(req.pool, orgId, booking.tenant_phone,
          `The viewing of ${booking.unit_name} set for ${when} has been cancelled — a new time will follow shortly.`)
          .catch(e => console.error('[viewing] reschedule tenant WhatsApp failed:', e.message));
      }
    }

    ok(res, { id: String(id), status: 3, invite_url: invite.url, invite_token: invite.token });
  } catch (err) {
    console.error('[viewing] reschedule booking error:', err);
    fail(res, 'Failed to reschedule booking');
  }
});

// ---------------------------------------------------------------------------
// GET /overview — every unit in the org with current active link status
//
// Drives the top-level "Properties → Viewings" page. One row per unit.
// If a unit has multiple active links, we return the most-recently-created one
// (staff rarely need multiple, and the page offers a "Regenerate" to replace).
// ---------------------------------------------------------------------------
router.get('/overview', async (req, res) => {
  try {
    // Only show units the staff would actually want to generate viewings for:
    // active property + active, non-deleted unit. Org isolation is enforced by
    // req.pool (per-org DB) — no explicit org_id filter needed.
    const [rows] = await req.pool.execute(
      `SELECT u.id AS unit_id, u.name AS unit_name, u.type AS unit_type,
              u.status AS unit_status, u.active_status,
              p.id AS property_id, p.display_name AS property_name,
              p.street_address, p.city, p.state,
              vl.id AS link_id, vl.token AS link_token, vl.status AS link_status,
              vl.employee_id, vl.note AS link_note, vl.created_at AS link_created_at,
              usr.first_name AS employee_first_name,
              usr.last_name AS employee_last_name,
              usr.email AS employee_email,
              (SELECT COUNT(*) FROM viewing_booking vb WHERE vb.unit_id = u.id) AS total_bookings,
              (SELECT COUNT(*) FROM viewing_booking vb WHERE vb.unit_id = u.id AND vb.status = 0) AS pending_bookings
       FROM unit u
       JOIN property p ON u.property_id = p.id
       LEFT JOIN viewing_link vl ON vl.id = (
         SELECT vl2.id FROM viewing_link vl2
         WHERE vl2.unit_id = u.id AND vl2.status = 1
         ORDER BY vl2.created_at DESC LIMIT 1
       )
       LEFT JOIN user usr ON vl.employee_id = usr.id
       WHERE p.org_id = ?
         AND p.status = 1
         AND p.deleted_at IS NULL
         AND u.active_status = 1
         AND u.deleted_at IS NULL
       ORDER BY p.display_name, u.name`,
      [req.user.orgId]
    );
    ok(res, rows.map(r => ({
      unit: {
        id: String(r.unit_id),
        name: r.unit_name,
        type: r.unit_type,
        status: r.unit_status,
        active_status: r.active_status,
      },
      property: {
        id: String(r.property_id),
        name: r.property_name,
        street_address: r.street_address,
        city: r.city,
        state: r.state,
      },
      link: r.link_id ? {
        id: String(r.link_id),
        token: r.link_token,
        status: r.link_status,
        note: r.link_note,
        created_at: r.link_created_at,
      } : null,
      employee: r.employee_id ? {
        id: String(r.employee_id),
        first_name: r.employee_first_name,
        last_name: r.employee_last_name,
        email: r.employee_email,
      } : null,
      total_bookings: Number(r.total_bookings || 0),
      pending_bookings: Number(r.pending_bookings || 0),
    })));
  } catch (err) {
    console.error('[viewing] overview error:', err);
    fail(res, 'Failed to load viewings overview');
  }
});

// ---------------------------------------------------------------------------
// POST /auto-generate — create an active link for every unit that doesn't
// have one yet. Idempotent.
// ---------------------------------------------------------------------------
router.post('/auto-generate', async (req, res) => {
  try {
    // Find all ACTIVE units in this org with NO active viewing_link.
    // Matches the filter set used by /overview so auto-generate doesn't mint
    // links for retired or deleted units.
    const [units] = await req.pool.execute(
      `SELECT u.id AS unit_id, u.property_id
       FROM unit u
       JOIN property p ON u.property_id = p.id
       WHERE p.org_id = ?
         AND p.status = 1
         AND p.deleted_at IS NULL
         AND u.active_status = 1
         AND u.deleted_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM viewing_link vl
           WHERE vl.unit_id = u.id AND vl.status = 1
         )`,
      [req.user.orgId]
    );

    if (!units.length) return ok(res, { created: 0 });

    const master = getMasterPool();
    const rowsForOrg = [];
    const rowsForMaster = [];
    const now = new Date();
    for (const u of units) {
      const id = newId();
      const token = newLinkToken();
      rowsForOrg.push([id, token, u.property_id, u.unit_id, null, req.user.id, null, 1, now]);
      rowsForMaster.push([token, String(req.user.orgId), KIND_LINK, 1]);
    }

    // Bulk insert into the org DB
    await req.pool.query(
      `INSERT INTO viewing_link
         (id, token, property_id, unit_id, employee_id, created_by, note, status, created_at)
       VALUES ?`,
      [rowsForOrg]
    );
    // Bulk insert into the master registry
    await master.query(
      `INSERT INTO viewing_link_registry (token, org_id, kind, status) VALUES ?`,
      [rowsForMaster]
    );

    ok(res, { created: units.length });
  } catch (err) {
    console.error('[viewing] auto-generate error:', err);
    fail(res, 'Failed to auto-generate links');
  }
});

// ---------------------------------------------------------------------------
// POST /unit/:unitId/regenerate — revoke the current active link for a unit
// (if any) and create a fresh one. Returns the new link.
// ---------------------------------------------------------------------------
router.post('/unit/:unitId/regenerate', async (req, res) => {
  try {
    const { unitId } = req.params;

    const [units] = await req.pool.execute(
      `SELECT u.id, u.property_id FROM unit u
       JOIN property p ON u.property_id = p.id
       WHERE u.id = ?
         AND p.org_id = ?
         AND p.status = 1 AND p.deleted_at IS NULL
         AND u.active_status = 1 AND u.deleted_at IS NULL
       LIMIT 1`,
      [unitId, req.user.orgId]
    );
    if (!units.length) return fail(res, 'Unit not found or no longer active', 404);

    // Revoke existing active links
    const [existing] = await req.pool.execute(
      'SELECT token FROM viewing_link WHERE unit_id = ? AND status = 1',
      [unitId]
    );
    if (existing.length) {
      const tokens = existing.map(e => e.token);
      await req.pool.query(
        'UPDATE viewing_link SET status = 0, revoked_at = NOW() WHERE unit_id = ? AND status = 1',
        [unitId]
      );
      const master = getMasterPool();
      await master.query(
        'UPDATE viewing_link_registry SET status = 0 WHERE token IN (?)',
        [tokens]
      );
    }

    // Create a fresh one (unassigned — staff will pick an employee afterward)
    const id = newId();
    const token = newLinkToken();
    await req.pool.execute(
      `INSERT INTO viewing_link
         (id, token, property_id, unit_id, employee_id, created_by, note, status, created_at)
       VALUES (?, ?, ?, ?, NULL, ?, NULL, 1, NOW())`,
      [id, token, units[0].property_id, unitId, req.user.id]
    );
    const master = getMasterPool();
    await master.execute(
      'INSERT INTO viewing_link_registry (token, org_id, kind, status) VALUES (?, ?, ?, 1)',
      [token, String(req.user.orgId), KIND_LINK]
    );

    ok(res, { id: String(id), token });
  } catch (err) {
    console.error('[viewing] regenerate error:', err);
    fail(res, 'Failed to regenerate link');
  }
});

// ---------------------------------------------------------------------------
// POST /bookings/manual — staff-created booking (no public flow, no approvals)
//
// Used when staff schedules a viewing directly from an inquiry. The booking
// is created in confirmed state (status=1, both decisions=approved). If
// `inquiry_id` is provided, it's stamped on the booking so the inquiry
// detail page can show it under "Linked Viewings".
//
// Body: {
//   inquiry_id?, unit_id, employee_id, proposed_datetime,
//   duration_minutes?, viewer_name, viewer_email, viewer_phone, viewer_message?
// }
// ---------------------------------------------------------------------------
router.post('/bookings/manual', async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const {
      inquiry_id, unit_id, employee_id,
      proposed_datetime, duration_minutes,
      viewer_name, viewer_email, viewer_phone, viewer_message,
    } = req.body || {};

    if (!unit_id || !employee_id || !proposed_datetime || !viewer_name) {
      return fail(res, 'unit_id, employee_id, proposed_datetime, and viewer_name are required', 400);
    }

    // Verify unit belongs to this org and pull property_id.
    const [units] = await req.pool.execute(
      `SELECT u.id, u.property_id FROM unit u
       JOIN property p ON u.property_id = p.id
       WHERE u.id = ? AND p.org_id = ? LIMIT 1`,
      [unit_id, orgId]
    );
    if (!units.length) return fail(res, 'Unit not found', 404);

    // Verify employee belongs to this org.
    const [users] = await req.pool.execute(
      'SELECT id FROM user WHERE id = ? AND status = 1 LIMIT 1',
      [employee_id]
    );
    if (!users.length) return fail(res, 'Employee not found', 400);

    // If inquiry_id provided, verify it belongs to this org.
    if (inquiry_id) {
      const [inq] = await req.pool.execute(
        'SELECT id FROM inquiry WHERE id = ? AND org_id = ? AND deleted_at IS NULL LIMIT 1',
        [inquiry_id, orgId]
      );
      if (!inq.length) return fail(res, 'Inquiry not found', 400);
    }

    const bookingId = newId();
    const icsUid = `${bookingId}@tenafy-viewing`;
    const durationMin = Number(duration_minutes) || 30;

    await req.pool.execute(
      `INSERT INTO viewing_booking (
         id, link_id, unit_id, property_id, employee_id,
         viewer_contact_id, inquiry_id,
         viewer_name, viewer_email, viewer_phone, viewer_message,
         proposed_datetime, duration_minutes,
         tenant_decision, employee_decision, status, source, ics_uid,
         tenant_decided_at, employee_decided_at, created_at
       ) VALUES (?, NULL, ?, ?, ?,  NULL, ?,  ?, ?, ?, ?,  ?, ?,  3, 1, 1, 'manual', ?,  NOW(), NOW(), NOW())`,
      [
        bookingId, unit_id, units[0].property_id, employee_id,
        inquiry_id || null,
        viewer_name, viewer_email || null, viewer_phone || null, viewer_message || null,
        new Date(proposed_datetime), durationMin,
        icsUid,
      ]
    );

    ok(res, { id: bookingId });
  } catch (err) {
    console.error('[viewing] manual booking error:', err);
    fail(res, 'Failed to create booking');
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// VIEWING RELAY SCHEDULER — staff dashboard, roster, settings
// (org-scoped via property.org_id — viewing_negotiation has no org_id column)
// ═══════════════════════════════════════════════════════════════════════════

// Load a negotiation and confirm it belongs to the caller's org.
async function loadNegotiationOrg(pool, orgId, id) {
  // Self-scoped by org_id (a resolution-phase row has no property yet, so a
  // property join would drop it). Older rows were backfilled in migration 028.
  const [[row]] = await pool.execute(
    `SELECT * FROM viewing_negotiation WHERE id = ? AND org_id = ? LIMIT 1`,
    [id, orgId]
  );
  return row || null;
}

// GET /api/viewing/negotiations?state=&awaiting=&q=
router.get('/negotiations', async (req, res) => {
  try {
    const orgId = req.user.orgId;
    // Scope by n.org_id and LEFT JOIN unit/property so resolution-phase rows (no
    // unit/property pinned yet) still appear on the dashboard.
    const where = ['n.org_id = ?'];
    const params = [orgId];
    if (req.query.state) { where.push('n.state = ?'); params.push(req.query.state); }
    if (req.query.awaiting) { where.push('n.awaiting = ?'); params.push(req.query.awaiting); }
    if (req.query.q) {
      where.push('(n.prospect_name LIKE ? OR u.name LIKE ? OR p.display_name LIKE ? OR n.pending_unit_text LIKE ?)');
      const like = `%${req.query.q}%`;
      params.push(like, like, like, like);
    }
    const [rows] = await req.pool.execute(
      `SELECT n.id, n.state, n.awaiting, n.round_count, n.current_proposed_datetime,
              n.prospect_name, n.prospect_phone, n.pending_unit_text, n.needs_staff_reason,
              n.created_at, n.updated_at,
              u.name AS unit_name, p.display_name AS property_name
         FROM viewing_negotiation n
         LEFT JOIN unit u ON u.id = n.unit_id
         LEFT JOIN property p ON p.id = n.property_id
        WHERE ${where.join(' AND ')}
        ORDER BY n.updated_at DESC LIMIT 300`,
      params
    );
    ok(res, rows.map(r => ({ ...r, id: String(r.id) })));
  } catch (err) {
    console.error('[viewing] list negotiations error:', err);
    fail(res, 'Failed to load negotiations');
  }
});

// GET /api/viewing/negotiations/:id  → negotiation + full event log
router.get('/negotiations/:id', async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const neg = await loadNegotiationOrg(req.pool, orgId, req.params.id);
    if (!neg) return fail(res, 'Negotiation not found', 404);
    const ctx = await viewingNegotiation.loadContext(req.pool, neg);
    const [events] = await req.pool.execute(
      `SELECT id, direction, party, to_phone, template_type, body, status, created_at, sent_at
         FROM viewing_negotiation_event WHERE negotiation_id = ? ORDER BY created_at ASC, id ASC`,
      [req.params.id]
    );
    ok(res, {
      negotiation: { ...neg, id: String(neg.id),
        unit_name: ctx.unit_name, property_name: ctx.property_name,
        tenant_phone: ctx.tenant_phone, has_tenant: ctx.hasTenant },
      events: events.map(e => ({ ...e, id: String(e.id) })),
    });
  } catch (err) {
    console.error('[viewing] get negotiation error:', err);
    fail(res, 'Failed to load negotiation');
  }
});

// POST /api/viewing/negotiations/:id/approve  Body: { event_id }
// Release a queued draft outbound (manual mode) — sends it via WhatsApp.
router.post('/negotiations/:id/approve', async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { event_id } = req.body || {};
    if (!event_id) return fail(res, 'event_id is required', 400);
    const neg = await loadNegotiationOrg(req.pool, orgId, req.params.id);
    if (!neg) return fail(res, 'Negotiation not found', 404);
    // Ensure the draft belongs to this negotiation.
    const [[ev]] = await req.pool.execute(
      `SELECT id FROM viewing_negotiation_event WHERE id = ? AND negotiation_id = ? LIMIT 1`,
      [event_id, req.params.id]
    );
    if (!ev) return fail(res, 'Draft not found', 404);
    const r = await viewingNegotiation.approveDraft(req.pool, orgId, event_id);
    if (!r.ok) return fail(res, r.error || 'Failed to send', 400);
    ok(res, { sent: true });
  } catch (err) {
    console.error('[viewing] approve draft error:', err);
    fail(res, 'Failed to approve message');
  }
});

// POST /api/viewing/negotiations/:id/message  Body: { party:'prospect'|'tenant', text }
// Staff takeover — send a free-form message into either chat.
router.post('/negotiations/:id/message', async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { party, text } = req.body || {};
    if (!['prospect', 'tenant'].includes(party)) return fail(res, "party must be 'prospect' or 'tenant'", 400);
    if (!text || !String(text).trim()) return fail(res, 'text is required', 400);
    const neg = await loadNegotiationOrg(req.pool, orgId, req.params.id);
    if (!neg) return fail(res, 'Negotiation not found', 404);
    const r = await viewingNegotiation.staffMessage(req.pool, orgId, neg, party, String(text).trim());
    ok(res, r);
  } catch (err) {
    console.error('[viewing] staff message error:', err);
    fail(res, 'Failed to send message');
  }
});

// POST /api/viewing/negotiations/:id/cancel
router.post('/negotiations/:id/cancel', async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const neg = await loadNegotiationOrg(req.pool, orgId, req.params.id);
    if (!neg) return fail(res, 'Negotiation not found', 404);
    await viewingNegotiation.cancelNegotiation(req.pool, orgId, neg);
    ok(res, { cancelled: true });
  } catch (err) {
    console.error('[viewing] cancel negotiation error:', err);
    fail(res, 'Failed to cancel negotiation');
  }
});

// POST /api/viewing/negotiations/:id/proceed — "Start viewing anyway" on a
// NEEDS_STAFF request (e.g. an off-window hold): resume the prospect day-ask.
router.post('/negotiations/:id/proceed', async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const neg = await loadNegotiationOrg(req.pool, orgId, req.params.id);
    if (!neg) return fail(res, 'Negotiation not found', 404);
    const out = await viewingNegotiation.proceedNegotiation(req.pool, orgId, neg);
    if (!out.ok) return fail(res, out.message || 'Cannot start this request', 409);
    ok(res, out);
  } catch (err) {
    console.error('[viewing] proceed negotiation error:', err);
    fail(res, 'Failed to start viewing');
  }
});

// GET /api/viewing/roster  → property × weekday assignments (+ properties + staff for the editor)
router.get('/roster', async (req, res) => {
  try {
    const orgId = req.user.orgId;
    let entries = [];
    try {
      const [rows] = await req.pool.execute(
        `SELECT r.id, r.property_id, r.weekday, r.employee_id
           FROM viewing_staff_roster r
           JOIN property p ON p.id = r.property_id
          WHERE p.org_id = ? AND r.active = 1`,
        [orgId]
      );
      entries = rows.map(r => ({ ...r, id: String(r.id), property_id: String(r.property_id), employee_id: String(r.employee_id) }));
    } catch { entries = []; } // table not migrated yet
    const [props] = await req.pool.execute(
      `SELECT id, display_name FROM property WHERE org_id = ? AND (status IS NULL OR status != 0) ORDER BY display_name`,
      [orgId]
    );
    const [staff] = await req.pool.execute(
      `SELECT id, first_name, last_name, email FROM user WHERE org_id = ? AND (status IS NULL OR status = 1) ORDER BY first_name, last_name`,
      [orgId]
    );
    ok(res, {
      entries,
      properties: props.map(p => ({ id: String(p.id), name: p.display_name })),
      staff: staff.map(s => ({ id: String(s.id), name: [s.first_name, s.last_name].filter(Boolean).join(' ') || s.email })),
    });
  } catch (err) {
    console.error('[viewing] get roster error:', err);
    fail(res, 'Failed to load roster');
  }
});

// PUT /api/viewing/roster  Body: { entries:[{property_id, weekday, employee_id}] }  — full rebuild
router.put('/roster', async (req, res) => {
  const conn = await req.pool.getConnection();
  try {
    const orgId = req.user.orgId;
    const entries = Array.isArray(req.body && req.body.entries) ? req.body.entries : [];
    // Validate every property belongs to the org.
    const [props] = await conn.execute('SELECT id FROM property WHERE org_id = ?', [orgId]);
    const orgProps = new Set(props.map(p => String(p.id)));
    const clean = entries.filter(e =>
      e && orgProps.has(String(e.property_id)) && e.employee_id != null &&
      Number(e.weekday) >= 0 && Number(e.weekday) <= 6);

    await conn.beginTransaction();
    // Rebuild only this org's rows.
    await conn.execute(
      `DELETE r FROM viewing_staff_roster r JOIN property p ON p.id = r.property_id WHERE p.org_id = ?`,
      [orgId]
    );
    for (const e of clean) {
      await conn.execute(
        `INSERT INTO viewing_staff_roster (id, property_id, weekday, employee_id, active)
         VALUES (?, ?, ?, ?, 1)`,
        [newId(), String(e.property_id), Number(e.weekday), String(e.employee_id)]
      );
    }
    await conn.commit();
    ok(res, { saved: clean.length });
  } catch (err) {
    try { await conn.rollback(); } catch {}
    console.error('[viewing] put roster error:', err);
    fail(res, 'Failed to save roster');
  } finally {
    conn.release();
  }
});

// GET /api/viewing/settings
router.get('/settings', async (req, res) => {
  try {
    const s = await viewingNegotiation.getSetting(req.pool, req.user.orgId);
    ok(res, s);
  } catch (err) {
    console.error('[viewing] get settings error:', err);
    fail(res, 'Failed to load settings');
  }
});

// PUT /api/viewing/settings  — partial upsert
router.put('/settings', async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const b = req.body || {};
    const fields = [];
    const params = [];
    const nextValues = {};
    if (b.relay_mode !== undefined) {
      if (!['manual', 'auto'].includes(b.relay_mode)) return fail(res, 'relay_mode must be manual or auto', 400);
      fields.push('relay_mode'); params.push(b.relay_mode); nextValues.relay_mode = b.relay_mode;
    }
    if (b.max_rounds !== undefined) {
      const n = Number(b.max_rounds);
      if (!Number.isInteger(n) || n < 1 || n > 10) return fail(res, 'max_rounds must be 1–10', 400);
      fields.push('max_rounds'); params.push(n); nextValues.max_rounds = n;
    }
    if (b.read_back !== undefined) {
      const n = b.read_back ? 1 : 0;
      fields.push('read_back'); params.push(n); nextValues.read_back = n;
    }
    for (const key of ['lead_days_nr', 'lead_days_other']) {
      if (b[key] !== undefined) {
        const n = Number(b[key]);
        if (!Number.isInteger(n) || n < 1 || n > 365) return fail(res, `${key} must be 1–365 days`, 400);
        fields.push(key); params.push(n); nextValues[key] = n;
      }
    }
    const cadenceLimits = {
      customer_nudge_1_hours: [1, 168],
      customer_nudge_2_hours: [1, 168],
      customer_nudge_cap: [0, 5],
      customer_timeout_hours: [1, 336],
      tenant_opt_out_hours: [1, 168],
      tenant_explicit_timeout_hours: [1, 336],
      tenant_nudge_cap: [0, 5],
    };
    for (const [key, [min, max]] of Object.entries(cadenceLimits)) {
      if (b[key] !== undefined) {
        const n = Number(b[key]);
        if (!Number.isInteger(n) || n < min || n > max) return fail(res, `${key} must be ${min}–${max}`, 400);
        fields.push(key); params.push(n); nextValues[key] = n;
      }
    }
    for (const key of ['auto_send_nudges', 'respect_quiet_hours']) {
      if (b[key] !== undefined) {
        const n = b[key] ? 1 : 0;
        fields.push(key); params.push(n); nextValues[key] = n;
      }
    }
    if (b.viewing_days !== undefined) { const v = String(b.viewing_days); fields.push('viewing_days'); params.push(v); nextValues.viewing_days = v; }
    if (b.viewing_start !== undefined) { const v = String(b.viewing_start); fields.push('viewing_start'); params.push(v); nextValues.viewing_start = v; }
    if (b.viewing_end !== undefined) { const v = String(b.viewing_end); fields.push('viewing_end'); params.push(v); nextValues.viewing_end = v; }

    const current = await viewingNegotiation.getSetting(req.pool, orgId);
    if (!fields.length) return ok(res, current);

    const merged = { ...current, ...nextValues };
    if (Number(merged.customer_nudge_1_hours) > Number(merged.customer_nudge_2_hours)) {
      return fail(res, 'customer_nudge_1_hours must be less than or equal to customer_nudge_2_hours so nudge 1 is not scheduled after nudge 2', 400);
    }
    if (Number(merged.customer_nudge_2_hours) >= Number(merged.customer_timeout_hours)) {
      return fail(res, 'customer_nudge_2_hours must be less than customer_timeout_hours so the second nudge can happen before escalation moves the negotiation to NEEDS_STAFF and stops nudging', 400);
    }

    // Upsert the single row for this org.
    const cols = ['org_id', ...fields];
    const placeholders = cols.map(() => '?').join(', ');
    const updates = fields.map(f => `${f} = VALUES(${f})`).join(', ');
    await req.pool.execute(
      `INSERT INTO viewing_setting (${cols.join(', ')}) VALUES (${placeholders})
       ON DUPLICATE KEY UPDATE ${updates}`,
      [orgId, ...params]
    );
    ok(res, await viewingNegotiation.getSetting(req.pool, orgId));
  } catch (err) {
    console.error('[viewing] put settings error:', err);
    fail(res, 'Failed to save settings');
  }
});

module.exports = router;
