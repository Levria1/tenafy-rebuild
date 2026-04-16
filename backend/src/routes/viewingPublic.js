/**
 * Public (no-auth) viewing booking routes.
 *
 * Mounted at: /api/viewing-public
 *
 * Every route derives its org context from the URL token via
 * middleware/viewingTokenAuth.js. A JWT cookie or API key is NEVER accepted
 * here — a logged-in staff session must not leak org context.
 */

const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const router = express.Router();

const config = require('../config');
const { getMasterPool } = require('../config/poolRegistry');
const { sendMail } = require('../config/mailer');
const { buildViewingIcs } = require('../utils/ics');
const {
  resolveOrgByViewingToken,
  resolveOrgByActionToken,
  resolveOrgByManageToken,
  KIND_ACTION,
  KIND_MANAGE,
} = require('../middleware/viewingTokenAuth');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ok(res, data) {
  return res.json({ code: 200, data });
}
function fail(res, message, status = 500) {
  return res.status(status).json({ code: status, message });
}
function newId() {
  return (BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000))).toString();
}
function newActionToken() {
  return crypto.randomBytes(24).toString('hex');
}
function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function formatWhen(dt) {
  try {
    return new Date(dt).toLocaleString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric',
      year: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  } catch {
    return String(dt);
  }
}
function buildUrl(path) {
  const base = (config.appUrl || 'http://localhost:3000').replace(/\/+$/, '');
  return `${base}${path}`;
}

// Rate limiter for the three public POST endpoints.
// 20 requests per 10 minutes per IP is generous for a human but blocks bots.
const postLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { code: 429, message: 'Too many requests. Please try again later.' },
});

// ---------------------------------------------------------------------------
// Email bodies (fallback HTML when no matching template is configured in org)
// ---------------------------------------------------------------------------

function bodyViewerReceipt({ viewer_name, property_name, unit_name, proposed_datetime, manage_url }) {
  return `
    <p>Hi ${escapeHtml(viewer_name)},</p>
    <p>We received your viewing request for <strong>${escapeHtml(unit_name)}</strong> at
       <strong>${escapeHtml(property_name)}</strong> on
       <strong>${escapeHtml(formatWhen(proposed_datetime))}</strong>.</p>
    <p>We've sent it to the team for approval. You'll receive a confirmation email
       once it's approved.</p>
    <p>If you need to cancel, use this link:<br>
       <a href="${manage_url}">${manage_url}</a></p>
  `;
}
function bodyApprovalRequest({ role, viewer_name, viewer_email, viewer_phone, viewer_message,
                              property_name, unit_name, proposed_datetime, approve_url, decline_url }) {
  const phoneLine = viewer_phone ? `<br><strong>Phone:</strong> ${escapeHtml(viewer_phone)}` : '';
  const msgLine = viewer_message
    ? `<p><strong>Message:</strong><br>${escapeHtml(viewer_message).replace(/\n/g, '<br>')}</p>`
    : '';
  return `
    <p>Hi,</p>
    <p>A prospective viewer has requested a viewing of
       <strong>${escapeHtml(unit_name)}</strong> at <strong>${escapeHtml(property_name)}</strong>.</p>
    <p><strong>Viewer:</strong> ${escapeHtml(viewer_name)}<br>
       <strong>Email:</strong> ${escapeHtml(viewer_email)}${phoneLine}<br>
       <strong>Requested time:</strong> ${escapeHtml(formatWhen(proposed_datetime))}</p>
    ${msgLine}
    <p>${role === 'tenant' ? 'As the current tenant, your approval is needed before we confirm.' :
                              'Please approve or decline to continue.'}</p>
    <p style="margin:24px 0;">
      <a href="${approve_url}"
         style="background:#52c41a;color:#fff;padding:10px 20px;border-radius:4px;
                text-decoration:none;display:inline-block;margin-right:8px;">Approve</a>
      <a href="${decline_url}"
         style="background:#ff4d4f;color:#fff;padding:10px 20px;border-radius:4px;
                text-decoration:none;display:inline-block;">Decline</a>
    </p>
    <p style="color:#8c8c8c;font-size:12px;">If the buttons don't work, copy these links into your browser:<br>
      Approve: ${approve_url}<br>Decline: ${decline_url}</p>
  `;
}
function bodyConfirmation({ viewer_name, property_name, unit_name, proposed_datetime, employee_name }) {
  return `
    <p>Great news — the viewing is confirmed.</p>
    <p><strong>Unit:</strong> ${escapeHtml(unit_name)} &middot; ${escapeHtml(property_name)}<br>
       <strong>When:</strong> ${escapeHtml(formatWhen(proposed_datetime))}<br>
       <strong>Viewer:</strong> ${escapeHtml(viewer_name)}<br>
       <strong>Coordinator:</strong> ${escapeHtml(employee_name || '')}</p>
    <p>A calendar invite is attached.</p>
  `;
}
function bodyDeclined({ viewer_name, property_name, unit_name, proposed_datetime }) {
  return `
    <p>Hi ${escapeHtml(viewer_name)},</p>
    <p>Unfortunately, the viewing request for <strong>${escapeHtml(unit_name)}</strong>
       at <strong>${escapeHtml(property_name)}</strong>
       on <strong>${escapeHtml(formatWhen(proposed_datetime))}</strong> has been declined.</p>
    <p>You're welcome to propose a different time.</p>
  `;
}
function bodyCancelled({ viewer_name, property_name, unit_name, proposed_datetime }) {
  return `
    <p>The viewing of <strong>${escapeHtml(unit_name)}</strong>
       at <strong>${escapeHtml(property_name)}</strong>
       on <strong>${escapeHtml(formatWhen(proposed_datetime))}</strong>
       was cancelled by ${escapeHtml(viewer_name)}.</p>
  `;
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

async function findLinkByToken(pool, token) {
  const [rows] = await pool.execute(
    `SELECT vl.*, p.display_name AS property_name, p.street_address, p.city, p.state,
            p.country, p.zip_code, u.name AS unit_name, u.type AS unit_type,
            u.beds, u.baths, u.rent_price_min, u.rent_price_max,
            usr.first_name AS employee_first_name, usr.last_name AS employee_last_name,
            usr.email AS employee_email
     FROM viewing_link vl
     JOIN property p ON vl.property_id = p.id
     JOIN unit u     ON vl.unit_id = u.id
     JOIN user usr   ON vl.employee_id = usr.id
     WHERE vl.token = ? LIMIT 1`,
    [token]
  );
  return rows[0] || null;
}

async function findBookingByToken(pool, token, column) {
  const [rows] = await pool.execute(
    `SELECT vb.*, p.display_name AS property_name, p.street_address, p.city, p.state,
            u.name AS unit_name,
            usr.first_name AS employee_first_name, usr.last_name AS employee_last_name,
            usr.email AS employee_email,
            t.first_name AS tenant_first_name, t.last_name AS tenant_last_name, t.email AS tenant_email
     FROM viewing_booking vb
     JOIN property p ON vb.property_id = p.id
     JOIN unit u     ON vb.unit_id = u.id
     JOIN user usr   ON vb.employee_id = usr.id
     LEFT JOIN tenant t ON vb.tenant_id = t.id
     WHERE vb.${column} = ? LIMIT 1`,
    [token]
  );
  return rows[0] || null;
}

async function findActiveLeaseForUnit(pool, unitId) {
  const [rows] = await pool.execute(
    `SELECT l.id AS leasing_id, l.tenant_id,
            t.first_name, t.last_name, t.email, t.company_name
     FROM leasing l
     LEFT JOIN tenant t ON l.tenant_id = t.id
     WHERE l.unit_id = ? AND l.deleted_at IS NULL
       AND l.start_date <= CURDATE() AND (l.end_date >= CURDATE() OR l.end_date IS NULL)
     ORDER BY l.start_date DESC LIMIT 1`,
    [unitId]
  );
  return rows[0] || null;
}

function employeeDisplayName(row) {
  return [row.employee_first_name, row.employee_last_name].filter(Boolean).join(' ') || row.employee_email;
}
function tenantDisplayName(row) {
  return [row.tenant_first_name, row.tenant_last_name].filter(Boolean).join(' ')
      || row.company_name || row.tenant_email;
}

// ---------------------------------------------------------------------------
// GET /link/:token — public booking-form data
// ---------------------------------------------------------------------------
router.get('/link/:token', resolveOrgByViewingToken, async (req, res) => {
  try {
    const link = await findLinkByToken(req.pool, req.viewingToken);
    if (!link || link.status !== 1) return fail(res, 'Link not found or no longer active', 404);

    // Soft warning: is there another confirmed viewing near this unit soon?
    const [[nearby]] = await req.pool.execute(
      `SELECT COUNT(*) AS n FROM viewing_booking
       WHERE unit_id = ? AND status = 1
         AND proposed_datetime >= NOW()
         AND proposed_datetime <= DATE_ADD(NOW(), INTERVAL 14 DAY)`,
      [link.unit_id]
    );

    ok(res, {
      unit: {
        id: String(link.unit_id),
        name: link.unit_name,
        type: link.unit_type,
        beds: link.beds,
        baths: link.baths,
        rent_price_min: link.rent_price_min,
        rent_price_max: link.rent_price_max,
      },
      property: {
        id: String(link.property_id),
        name: link.property_name,
        street_address: link.street_address,
        city: link.city,
        state: link.state,
      },
      employee: {
        name: employeeDisplayName(link),
      },
      upcoming_viewings: nearby ? Number(nearby.n) : 0,
    });
  } catch (err) {
    console.error('[viewing-public] GET /link/:token error:', err);
    fail(res, 'Failed to load viewing details');
  }
});

// ---------------------------------------------------------------------------
// POST /link/:token/bookings — create a booking request
// ---------------------------------------------------------------------------
router.post('/link/:token/bookings', postLimiter, resolveOrgByViewingToken, async (req, res) => {
  try {
    const {
      viewer_name, viewer_email, viewer_phone, viewer_message,
      proposed_datetime, duration_minutes,
    } = req.body || {};

    if (!viewer_name || !viewer_email || !proposed_datetime) {
      return fail(res, 'Name, email, and date/time are required', 400);
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(viewer_email))) {
      return fail(res, 'A valid email address is required', 400);
    }
    const when = new Date(proposed_datetime);
    if (isNaN(when.getTime())) return fail(res, 'Invalid date/time', 400);

    const link = await findLinkByToken(req.pool, req.viewingToken);
    if (!link || link.status !== 1) return fail(res, 'Link not found or no longer active', 404);

    // Determine occupancy
    const lease = await findActiveLeaseForUnit(req.pool, link.unit_id);
    const hasTenant = Boolean(lease && lease.tenant_id && lease.email);

    // Generate IDs / tokens
    const bookingId = newId();
    const employeeTok = newActionToken();
    const manageTok = newActionToken();
    const tenantTok = hasTenant ? newActionToken() : null;
    const icsUid = `${bookingId}@tenafy-viewing`;
    const durationMin = Number(duration_minutes) || 30;

    // Register action/manage tokens in master so public routes can resolve them later.
    const master = getMasterPool();
    const registryRows = [
      [employeeTok, String(req.orgId), KIND_ACTION, 1],
      [manageTok, String(req.orgId), KIND_MANAGE, 1],
    ];
    if (tenantTok) registryRows.push([tenantTok, String(req.orgId), KIND_ACTION, 1]);
    await master.query(
      'INSERT INTO viewing_link_registry (token, org_id, kind, status) VALUES ?',
      [registryRows]
    );

    // Insert booking
    await req.pool.execute(
      `INSERT INTO viewing_booking (
        id, link_id, unit_id, property_id, employee_id,
        leasing_id, tenant_id,
        viewer_name, viewer_email, viewer_phone, viewer_message,
        proposed_datetime, duration_minutes,
        tenant_action_token, employee_action_token, viewer_manage_token,
        tenant_decision, employee_decision, status, ics_uid
       ) VALUES (?, ?, ?, ?, ?,  ?, ?,  ?, ?, ?, ?,  ?, ?,  ?, ?, ?,  ?, 0, 0, ?)`,
      [
        bookingId, link.id, link.unit_id, link.property_id, link.employee_id,
        lease ? lease.leasing_id : null,
        lease ? lease.tenant_id : null,
        viewer_name, viewer_email, viewer_phone || null, viewer_message || null,
        when, durationMin,
        tenantTok, employeeTok, manageTok,
        hasTenant ? 0 : 3, // tenant_decision: 3=skipped when vacant
        icsUid,
      ]
    );

    // Dispatch emails (fire-and-forget beyond this point — log failures but still return 200)
    const manageUrl = buildUrl(`/book/viewing/manage/${manageTok}`);
    const employeeApprove = buildUrl(`/book/viewing/action/${employeeTok}?decision=approve`);
    const employeeDecline = buildUrl(`/book/viewing/action/${employeeTok}?decision=decline`);
    const propertyName = link.property_name;
    const unitName = link.unit_name;

    // 1. Viewer receipt
    sendMail({
      to: viewer_email,
      subject: `Viewing request received: ${unitName} at ${propertyName}`,
      html: bodyViewerReceipt({
        viewer_name, property_name: propertyName, unit_name: unitName,
        proposed_datetime: when, manage_url: manageUrl,
      }),
    }).catch(e => console.error('[viewing-public] viewer email failed:', e.message));

    // 2. Employee approval request
    sendMail({
      to: link.employee_email,
      subject: `Viewing request — ${unitName} (${formatWhen(when)})`,
      html: bodyApprovalRequest({
        role: 'employee', viewer_name, viewer_email, viewer_phone, viewer_message,
        property_name: propertyName, unit_name: unitName, proposed_datetime: when,
        approve_url: employeeApprove, decline_url: employeeDecline,
      }),
    }).catch(e => console.error('[viewing-public] employee email failed:', e.message));

    // 3. Tenant approval request (only if occupied)
    if (hasTenant && tenantTok) {
      const tenantApprove = buildUrl(`/book/viewing/action/${tenantTok}?decision=approve`);
      const tenantDecline = buildUrl(`/book/viewing/action/${tenantTok}?decision=decline`);
      sendMail({
        to: lease.email,
        subject: `Viewing request for your unit — ${unitName} (${formatWhen(when)})`,
        html: bodyApprovalRequest({
          role: 'tenant', viewer_name, viewer_email, viewer_phone, viewer_message,
          property_name: propertyName, unit_name: unitName, proposed_datetime: when,
          approve_url: tenantApprove, decline_url: tenantDecline,
        }),
      }).catch(e => console.error('[viewing-public] tenant email failed:', e.message));
    }

    ok(res, { booking_id: bookingId, manage_token: manageTok, manage_url: manageUrl });
  } catch (err) {
    console.error('[viewing-public] POST /link/:token/bookings error:', err);
    fail(res, 'Failed to submit viewing request');
  }
});

// ---------------------------------------------------------------------------
// GET /action/:token — data for the approve/decline landing page
// ---------------------------------------------------------------------------
router.get('/action/:token', resolveOrgByActionToken, async (req, res) => {
  try {
    const byTenant = await findBookingByToken(req.pool, req.viewingToken, 'tenant_action_token');
    const booking = byTenant || await findBookingByToken(req.pool, req.viewingToken, 'employee_action_token');
    if (!booking) return fail(res, 'Link not found', 404);

    const role = byTenant ? 'tenant' : 'employee';
    ok(res, {
      role,
      booking: {
        id: String(booking.id),
        status: booking.status,
        tenant_decision: booking.tenant_decision,
        employee_decision: booking.employee_decision,
        viewer_name: booking.viewer_name,
        viewer_email: booking.viewer_email,
        viewer_phone: booking.viewer_phone,
        viewer_message: booking.viewer_message,
        proposed_datetime: booking.proposed_datetime,
        duration_minutes: booking.duration_minutes,
      },
      unit: { name: booking.unit_name },
      property: {
        name: booking.property_name,
        street_address: booking.street_address,
        city: booking.city,
        state: booking.state,
      },
    });
  } catch (err) {
    console.error('[viewing-public] GET /action/:token error:', err);
    fail(res, 'Failed to load booking');
  }
});

// ---------------------------------------------------------------------------
// POST /action/:token — write the tenant or employee decision
// ---------------------------------------------------------------------------
router.post('/action/:token', postLimiter, resolveOrgByActionToken, async (req, res) => {
  const { decision } = req.body || {};
  if (decision !== 'approve' && decision !== 'decline') {
    return fail(res, 'Decision must be "approve" or "decline"', 400);
  }

  const conn = await req.pool.getConnection();
  try {
    await conn.beginTransaction();

    // Look up which party this token belongs to AND lock the booking row.
    const [rows] = await conn.execute(
      `SELECT * FROM viewing_booking
       WHERE tenant_action_token = ? OR employee_action_token = ?
       LIMIT 1 FOR UPDATE`,
      [req.viewingToken, req.viewingToken]
    );
    if (!rows.length) {
      await conn.rollback();
      return fail(res, 'Link not found', 404);
    }
    const booking = rows[0];

    if (booking.status !== 0) {
      await conn.rollback();
      return res.status(410).json({ code: 410, message: 'This booking is already finalised' });
    }

    const isTenant = booking.tenant_action_token === req.viewingToken;
    const decisionValue = decision === 'approve' ? 1 : 2;

    if (isTenant) {
      await conn.execute(
        `UPDATE viewing_booking
           SET tenant_decision = ?, tenant_decided_at = NOW()
         WHERE id = ?`,
        [decisionValue, booking.id]
      );
      booking.tenant_decision = decisionValue;
    } else {
      await conn.execute(
        `UPDATE viewing_booking
           SET employee_decision = ?, employee_decided_at = NOW()
         WHERE id = ?`,
        [decisionValue, booking.id]
      );
      booking.employee_decision = decisionValue;
    }

    // Derive new status
    let newStatus = 0;
    if (booking.tenant_decision === 2 || booking.employee_decision === 2) {
      newStatus = 2; // declined
    } else if (
      (booking.tenant_decision === 1 || booking.tenant_decision === 3) &&
      booking.employee_decision === 1
    ) {
      newStatus = 1; // confirmed
    }

    if (newStatus !== 0) {
      await conn.execute('UPDATE viewing_booking SET status = ? WHERE id = ?', [newStatus, booking.id]);
      booking.status = newStatus;
    }

    await conn.commit();

    // --- Email notifications (outside the transaction) ---
    // Re-fetch with display fields
    const full = await findBookingByToken(req.pool, req.viewingToken,
      isTenant ? 'tenant_action_token' : 'employee_action_token');

    if (newStatus === 1) {
      // Confirmed — send ICS to viewer + employee (+ tenant if any)
      const attendees = [
        { name: full.viewer_name, email: full.viewer_email },
        { name: employeeDisplayName(full), email: full.employee_email },
      ];
      if (full.tenant_id && full.tenant_email) {
        attendees.push({ name: tenantDisplayName(full), email: full.tenant_email });
      }

      let ics;
      try {
        ics = buildViewingIcs({
          uid: full.ics_uid,
          startDateTime: full.proposed_datetime,
          durationMinutes: full.duration_minutes,
          summary: `Viewing: ${full.unit_name} @ ${full.property_name}`,
          description: `Viewing request from ${full.viewer_name} (${full.viewer_email})`,
          location: [full.street_address, full.city, full.state].filter(Boolean).join(', '),
          organizer: { name: employeeDisplayName(full), email: full.employee_email },
          attendees,
          method: 'REQUEST',
          sequence: 0,
        });
      } catch (e) {
        console.error('[viewing-public] ICS build failed:', e.message);
      }

      const html = bodyConfirmation({
        viewer_name: full.viewer_name,
        property_name: full.property_name,
        unit_name: full.unit_name,
        proposed_datetime: full.proposed_datetime,
        employee_name: employeeDisplayName(full),
      });

      const recipients = [full.viewer_email, full.employee_email]
        .concat(full.tenant_email ? [full.tenant_email] : [])
        .filter(Boolean);

      for (const to of recipients) {
        sendMail({
          to,
          subject: `Viewing confirmed: ${full.unit_name} — ${formatWhen(full.proposed_datetime)}`,
          html,
          attachments: ics ? [ics] : undefined,
        }).catch(e => console.error('[viewing-public] confirmation email failed:', e.message));
      }
    } else if (newStatus === 2) {
      // Declined — notify viewer (+ the party that had approved, if any)
      const recipients = [full.viewer_email];
      if (full.tenant_decision === 1 && full.tenant_email) recipients.push(full.tenant_email);
      if (full.employee_decision === 1) recipients.push(full.employee_email);
      const html = bodyDeclined({
        viewer_name: full.viewer_name,
        property_name: full.property_name,
        unit_name: full.unit_name,
        proposed_datetime: full.proposed_datetime,
      });
      for (const to of recipients) {
        sendMail({
          to,
          subject: `Viewing declined: ${full.unit_name}`,
          html,
        }).catch(e => console.error('[viewing-public] declined email failed:', e.message));
      }
    }

    ok(res, {
      decision,
      role: isTenant ? 'tenant' : 'employee',
      booking_status: booking.status,
    });
  } catch (err) {
    try { await conn.rollback(); } catch {}
    console.error('[viewing-public] POST /action/:token error:', err);
    fail(res, 'Failed to record decision');
  } finally {
    conn.release();
  }
});

// ---------------------------------------------------------------------------
// GET /manage/:token — data for the viewer's manage page
// ---------------------------------------------------------------------------
router.get('/manage/:token', resolveOrgByManageToken, async (req, res) => {
  try {
    const booking = await findBookingByToken(req.pool, req.viewingToken, 'viewer_manage_token');
    if (!booking) return fail(res, 'Link not found', 404);
    ok(res, {
      booking: {
        id: String(booking.id),
        status: booking.status,
        viewer_name: booking.viewer_name,
        viewer_email: booking.viewer_email,
        proposed_datetime: booking.proposed_datetime,
        duration_minutes: booking.duration_minutes,
      },
      unit: { name: booking.unit_name },
      property: {
        name: booking.property_name,
        street_address: booking.street_address,
        city: booking.city,
        state: booking.state,
      },
    });
  } catch (err) {
    console.error('[viewing-public] GET /manage/:token error:', err);
    fail(res, 'Failed to load booking');
  }
});

// ---------------------------------------------------------------------------
// POST /manage/:token/cancel — viewer self-cancel
// ---------------------------------------------------------------------------
router.post('/manage/:token/cancel', postLimiter, resolveOrgByManageToken, async (req, res) => {
  const conn = await req.pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.execute(
      `SELECT * FROM viewing_booking WHERE viewer_manage_token = ? LIMIT 1 FOR UPDATE`,
      [req.viewingToken]
    );
    if (!rows.length) {
      await conn.rollback();
      return fail(res, 'Link not found', 404);
    }
    const booking = rows[0];
    if (booking.status === 3) {
      await conn.rollback();
      return ok(res, { status: 3, already: true });
    }
    await conn.execute('UPDATE viewing_booking SET status = 3 WHERE id = ?', [booking.id]);
    await conn.commit();

    const full = await findBookingByToken(req.pool, req.viewingToken, 'viewer_manage_token');

    let ics;
    try {
      const attendees = [
        { name: full.viewer_name, email: full.viewer_email },
        { name: employeeDisplayName(full), email: full.employee_email },
      ];
      if (full.tenant_id && full.tenant_email) {
        attendees.push({ name: tenantDisplayName(full), email: full.tenant_email });
      }
      ics = buildViewingIcs({
        uid: full.ics_uid,
        startDateTime: full.proposed_datetime,
        durationMinutes: full.duration_minutes,
        summary: `Viewing: ${full.unit_name} @ ${full.property_name}`,
        organizer: { name: employeeDisplayName(full), email: full.employee_email },
        attendees,
        method: 'CANCEL',
        sequence: 1,
      });
    } catch (e) {
      console.error('[viewing-public] cancel ICS build failed:', e.message);
    }

    const html = bodyCancelled({
      viewer_name: full.viewer_name,
      property_name: full.property_name,
      unit_name: full.unit_name,
      proposed_datetime: full.proposed_datetime,
    });
    const recipients = [full.viewer_email, full.employee_email]
      .concat(full.tenant_email ? [full.tenant_email] : [])
      .filter(Boolean);
    for (const to of recipients) {
      sendMail({
        to,
        subject: `Viewing cancelled: ${full.unit_name}`,
        html,
        attachments: ics ? [ics] : undefined,
      }).catch(e => console.error('[viewing-public] cancel email failed:', e.message));
    }

    ok(res, { status: 3 });
  } catch (err) {
    try { await conn.rollback(); } catch {}
    console.error('[viewing-public] POST /manage/:token/cancel error:', err);
    fail(res, 'Failed to cancel booking');
  } finally {
    conn.release();
  }
});

module.exports = router;
