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

module.exports = router;
