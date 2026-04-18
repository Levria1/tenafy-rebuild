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
const { sendMail, sendMailWithAccount } = require('../config/mailer');
const {
  findSmtpAccount,
  loadTemplate,
  substituteVariables,
  wrapEmailHtml,
} = require('../services/emailService');
const { buildViewingIcs } = require('../utils/ics');
const { createViewingEvent, deleteViewingEvent } = require('../services/googleCalendar');

/**
 * Send a viewing-related email.
 *
 * If a template of the given `templateType` exists in the org's email_template
 * table, its subject + body are used (with variables substituted). If not, the
 * provided `fallback` { subject, html } is used.
 *
 * In both cases the email is sent via the org's default SMTP account when one
 * is configured; otherwise it falls back to the env-based sendMail.
 *
 * Returns a Promise — caller should .catch() for fire-and-forget.
 */
async function sendViewingMail(pool, orgId, { templateType, variables, fallback, mailOpts }) {
  let subject = fallback.subject;
  let html    = fallback.html;

  if (templateType) {
    try {
      const template = await loadTemplate(pool, orgId, templateType);
      if (template && template.template_content) {
        subject = substituteVariables(template.subject || subject, variables || {});
        let body = substituteVariables(template.template_content, variables || {});
        // If the stored body is plain text, convert newlines to <br>
        if (!/<[a-z][\s\S]*>/i.test(body)) body = body.replace(/\n/g, '<br>\n');
        html = wrapEmailHtml(body);
        if (template.from && !mailOpts.from) mailOpts.from = template.from;
      }
    } catch (e) {
      console.error(`[viewing-public] template load failed (${templateType}):`, e.message);
    }
  }

  const finalOpts = { ...mailOpts, subject, html };
  const smtpAccount = await findSmtpAccount(pool, orgId, finalOpts.from);
  if (smtpAccount) {
    return sendMailWithAccount(smtpAccount, finalOpts);
  }
  return sendMail(finalOpts);
}
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

// ---------------------------------------------------------------------------
// Availability window (keep in sync with frontend /book/viewing/[token]/page.js)
//
// Viewings: Monday–Saturday, 11:00 AM – 7:00 PM. Sunday is closed.
// The "7 PM" boundary is the END of the viewing, so the latest start time
// for a 30-min slot is 18:30.
//
// We intentionally parse the submitted datetime as a literal wall-clock value
// (what the viewer picked in the UI) rather than going through Date's timezone
// coercion, so the rule applies consistently regardless of server TZ.
// ---------------------------------------------------------------------------
const VIEWING_OPEN_MIN = 11 * 60;   // 11:00
const VIEWING_CLOSE_MIN = 19 * 60;  // 19:00 (7 PM) — last end time

function validateBookingSlot(datetimeStr, durationMinutes = 30) {
  const m = String(datetimeStr).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (!m) return 'Invalid date/time format';
  const [, yyyy, mm, dd, HH, MM] = m;
  // Compute day-of-week in UTC to avoid server-TZ shifts on the calendar date.
  const dow = new Date(Date.UTC(+yyyy, +mm - 1, +dd)).getUTCDay(); // 0=Sun
  if (dow === 0) return 'Viewings are not available on Sundays';
  const startMin = +HH * 60 + +MM;
  if (startMin < VIEWING_OPEN_MIN) return 'Viewings start from 11:00 AM';
  if (startMin + durationMinutes > VIEWING_CLOSE_MIN) {
    return 'Viewings must end by 7:00 PM';
  }
  return null;
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
  // LEFT JOIN user so unassigned links (employee_id IS NULL) still resolve.
  const [rows] = await pool.execute(
    `SELECT vl.*, p.display_name AS property_name, p.street_address, p.city, p.state,
            p.country, p.zip_code, u.name AS unit_name, u.type AS unit_type,
            u.beds, u.baths, u.rent_price_min, u.rent_price_max,
            usr.first_name AS employee_first_name, usr.last_name AS employee_last_name,
            usr.email AS employee_email
     FROM viewing_link vl
     JOIN property p ON vl.property_id = p.id
     JOIN unit u     ON vl.unit_id = u.id
     LEFT JOIN user usr ON vl.employee_id = usr.id
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
            usr.email AS employee_email, usr.google_calendar_id AS employee_google_calendar_id,
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

// Upsert a `tenant` contact for the prospective viewer.
//
// - If a non-deleted contact with the same email already exists in this org,
//   we reuse it (updating blank name/phone fields) so we don't duplicate leads.
// - Otherwise we insert a new row with category=3 ("prospect"), status=0
//   (pending), and a note identifying where the lead came from.
//
// Return the contact id (string, bigint-safe).
async function upsertViewerContact(pool, orgId, { name, email, phone, unitName, propertyName }) {
  const contactId = newId();
  const normalizedEmail = String(email).trim().toLowerCase();
  const [firstName, ...rest] = String(name).trim().split(/\s+/);
  const lastName = rest.join(' ') || null;
  const sourceNote = `Lead — submitted via public viewing request for ${unitName || 'unit'}` +
                     (propertyName ? ` at ${propertyName}` : '') +
                     ` on ${new Date().toISOString().slice(0, 10)}.`;

  // Look for an existing contact with this email in this org.
  const [existing] = await pool.execute(
    `SELECT id, first_name, last_name, phone, notes
     FROM tenant
     WHERE org_id = ? AND email = ? AND deleted_at IS NULL
     LIMIT 1`,
    [orgId, normalizedEmail]
  );

  if (existing.length) {
    const e = existing[0];
    // Fill in any missing fields without overwriting what staff may have edited.
    const updates = [];
    const params = [];
    if (!e.first_name && firstName) { updates.push('first_name = ?'); params.push(firstName); }
    if (!e.last_name && lastName)   { updates.push('last_name = ?');  params.push(lastName); }
    if (!e.phone && phone)          { updates.push('phone = ?');      params.push(phone); }
    // Append, don't overwrite, the notes.
    const mergedNotes = (e.notes ? e.notes.trim() + '\n\n' : '') + sourceNote;
    updates.push('notes = ?'); params.push(mergedNotes);
    params.push(e.id);
    await pool.execute(`UPDATE tenant SET ${updates.join(', ')} WHERE id = ?`, params);
    return String(e.id);
  }

  // Brand-new lead — insert with category=3 (prospect).
  await pool.execute(
    `INSERT INTO tenant
       (id, org_id, first_name, last_name, email, phone, notes,
        type, status, category, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?,  0, 0, 3, NOW(), NOW())`,
    [contactId, orgId, firstName || null, lastName, normalizedEmail, phone || null, sourceNote]
  );
  return contactId;
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

    // Link is active, but if no employee has been assigned yet we surface a
    // friendly "not ready" state instead of the booking form. Staff generate
    // the link first, then assign an employee before sharing.
    if (!link.employee_id) {
      return res.status(200).json({
        code: 200,
        data: {
          ready: false,
          property: { name: link.property_name, city: link.city },
          unit: { name: link.unit_name },
        },
      });
    }

    // Soft warning: is there another confirmed viewing near this unit soon?
    const [[nearby]] = await req.pool.execute(
      `SELECT COUNT(*) AS n FROM viewing_booking
       WHERE unit_id = ? AND status = 1
         AND proposed_datetime >= NOW()
         AND proposed_datetime <= DATE_ADD(NOW(), INTERVAL 14 DAY)`,
      [link.unit_id]
    );

    ok(res, {
      ready: true,
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

    if (!viewer_name || !viewer_email || !viewer_phone || !proposed_datetime) {
      return fail(res, 'Name, email, phone, and date/time are required', 400);
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(viewer_email))) {
      return fail(res, 'A valid email address is required', 400);
    }
    if (String(viewer_phone).trim().length < 7) {
      return fail(res, 'A valid phone number is required', 400);
    }
    const when = new Date(proposed_datetime);
    if (isNaN(when.getTime())) return fail(res, 'Invalid date/time', 400);
    const durationMin = Number(duration_minutes) || 30;

    // Enforce the viewing window (Mon–Sat, 11:00–19:00). This must happen on
    // the server too; the frontend picker only guides UX.
    const slotError = validateBookingSlot(proposed_datetime, durationMin);
    if (slotError) return fail(res, slotError, 400);

    const link = await findLinkByToken(req.pool, req.viewingToken);
    if (!link || link.status !== 1) return fail(res, 'Link not found or no longer active', 404);
    if (!link.employee_id || !link.employee_email) {
      return fail(res, 'This link is not ready yet. The property team has not assigned a host — please try again shortly.', 409);
    }

    // Determine occupancy
    const lease = await findActiveLeaseForUnit(req.pool, link.unit_id);
    const hasTenant = Boolean(lease && lease.tenant_id && lease.email);

    // Upsert the viewer into the org's contacts list (category=3 prospect).
    // Best-effort — if this fails we still want to accept the booking, so log
    // and continue with a null contact id.
    let viewerContactId = null;
    try {
      viewerContactId = await upsertViewerContact(req.pool, req.orgId, {
        name: viewer_name,
        email: viewer_email,
        phone: viewer_phone,
        unitName: link.unit_name,
        propertyName: link.property_name,
      });
    } catch (e) {
      console.error('[viewing-public] contact upsert failed:', e.message);
    }

    // Generate IDs / tokens
    const bookingId = newId();
    const employeeTok = newActionToken();
    const manageTok = newActionToken();
    const tenantTok = hasTenant ? newActionToken() : null;
    const icsUid = `${bookingId}@tenafy-viewing`;

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
        leasing_id, tenant_id, viewer_contact_id,
        viewer_name, viewer_email, viewer_phone, viewer_message,
        proposed_datetime, duration_minutes,
        tenant_action_token, employee_action_token, viewer_manage_token,
        tenant_decision, employee_decision, status, source, ics_uid
       ) VALUES (?, ?, ?, ?, ?,  ?, ?, ?,  ?, ?, ?, ?,  ?, ?,  ?, ?, ?,  ?, 0, 0, 'web', ?)`,
      [
        bookingId, link.id, link.unit_id, link.property_id, link.employee_id,
        lease ? lease.leasing_id : null,
        lease ? lease.tenant_id : null,
        viewerContactId,
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
    const hostName = [link.employee_first_name, link.employee_last_name].filter(Boolean).join(' ') || link.employee_email;
    const propertyAddress = [link.street_address, link.city, link.state, link.country].filter(Boolean).join(', ');

    // Shared variables available to any Viewing-* template
    const baseVars = {
      '%Viewer Name%':    viewer_name || '',
      '%Viewer Email%':   viewer_email || '',
      '%Viewer Phone%':   viewer_phone || '',
      '%Viewer Message%': viewer_message || '',
      '%Viewing Date%':   formatWhen(when),
      '%Unit Name%':      unitName || '',
      '%Property Name%':  propertyName || '',
      '%Property Address%': propertyAddress,
      '%Host Name%':      hostName,
    };

    // 1. Viewer receipt
    sendViewingMail(req.pool, req.orgId, {
      templateType: 'Viewing-Receipt',
      variables: { ...baseVars, '%Manage URL%': manageUrl },
      fallback: {
        subject: `Viewing request received: ${unitName} at ${propertyName}`,
        html: bodyViewerReceipt({
          viewer_name, property_name: propertyName, unit_name: unitName,
          proposed_datetime: when, manage_url: manageUrl,
        }),
      },
      mailOpts: { to: viewer_email },
    }).catch(e => console.error('[viewing-public] viewer email failed:', e.message));

    // 2. Employee approval request
    sendViewingMail(req.pool, req.orgId, {
      templateType: 'Viewing-Employee-Request',
      variables: { ...baseVars, '%Approve URL%': employeeApprove, '%Decline URL%': employeeDecline },
      fallback: {
        subject: `Viewing request — ${unitName} (${formatWhen(when)})`,
        html: bodyApprovalRequest({
          role: 'employee', viewer_name, viewer_email, viewer_phone, viewer_message,
          property_name: propertyName, unit_name: unitName, proposed_datetime: when,
          approve_url: employeeApprove, decline_url: employeeDecline,
        }),
      },
      mailOpts: { to: link.employee_email },
    }).catch(e => console.error('[viewing-public] employee email failed:', e.message));

    // 3. Tenant approval request (only if occupied)
    if (hasTenant && tenantTok) {
      const tenantApprove = buildUrl(`/book/viewing/action/${tenantTok}?decision=approve`);
      const tenantDecline = buildUrl(`/book/viewing/action/${tenantTok}?decision=decline`);
      sendViewingMail(req.pool, req.orgId, {
        templateType: 'Viewing-Tenant-Request',
        variables: { ...baseVars, '%Approve URL%': tenantApprove, '%Decline URL%': tenantDecline },
        fallback: {
          subject: `Viewing request for your unit — ${unitName} (${formatWhen(when)})`,
          html: bodyApprovalRequest({
            role: 'tenant', viewer_name, viewer_email, viewer_phone, viewer_message,
            property_name: propertyName, unit_name: unitName, proposed_datetime: when,
            approve_url: tenantApprove, decline_url: tenantDecline,
          }),
        },
        mailOpts: { to: lease.email },
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
      // Push to the assigned employee's Google Calendar (fire-and-forget)
      createViewingEvent({
        calendarId: full.employee_google_calendar_id,
        booking: {
          proposed_datetime: full.proposed_datetime,
          duration_minutes: full.duration_minutes,
          viewer_name: full.viewer_name,
          viewer_email: full.viewer_email,
          viewer_phone: full.viewer_phone,
          viewer_message: full.viewer_message,
        },
        unit: { name: full.unit_name },
        property: {
          name: full.property_name,
          street_address: full.street_address,
          city: full.city,
          state: full.state,
        },
        employee: {
          name: employeeDisplayName(full),
          email: full.employee_email,
        },
      }).then(gcalEventId => {
        if (gcalEventId) {
          req.pool.execute(
            'UPDATE viewing_booking SET gcal_event_id = ? WHERE id = ?',
            [gcalEventId, booking.id]
          ).catch(e => console.error('[viewing-public] save gcal_event_id failed:', e.message));
        }
      }).catch(e => console.error('[viewing-public] Google Calendar create failed:', e.message));

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

      const fallbackConfirmHtml = bodyConfirmation({
        viewer_name: full.viewer_name,
        property_name: full.property_name,
        unit_name: full.unit_name,
        proposed_datetime: full.proposed_datetime,
        employee_name: employeeDisplayName(full),
      });

      const recipients = [full.viewer_email, full.employee_email]
        .concat(full.tenant_email ? [full.tenant_email] : [])
        .filter(Boolean);

      const confirmVars = {
        '%Viewer Name%':    full.viewer_name || '',
        '%Viewer Email%':   full.viewer_email || '',
        '%Viewer Phone%':   full.viewer_phone || '',
        '%Viewer Message%': full.viewer_message || '',
        '%Viewing Date%':   formatWhen(full.proposed_datetime),
        '%Unit Name%':      full.unit_name || '',
        '%Property Name%':  full.property_name || '',
        '%Property Address%': [full.street_address, full.city, full.state].filter(Boolean).join(', '),
        '%Host Name%':      employeeDisplayName(full),
      };

      for (const to of recipients) {
        sendViewingMail(req.pool, req.orgId, {
          templateType: 'Viewing-Confirmation',
          variables: confirmVars,
          fallback: {
            subject: `Viewing confirmed: ${full.unit_name} — ${formatWhen(full.proposed_datetime)}`,
            html: fallbackConfirmHtml,
          },
          mailOpts: { to, attachments: ics ? [ics] : undefined },
        }).catch(e => console.error('[viewing-public] confirmation email failed:', e.message));
      }
    } else if (newStatus === 2) {
      // Declined — notify viewer (+ the party that had approved, if any)
      const recipients = [full.viewer_email];
      if (full.tenant_decision === 1 && full.tenant_email) recipients.push(full.tenant_email);
      if (full.employee_decision === 1) recipients.push(full.employee_email);

      const fallbackDeclinedHtml = bodyDeclined({
        viewer_name: full.viewer_name,
        property_name: full.property_name,
        unit_name: full.unit_name,
        proposed_datetime: full.proposed_datetime,
      });

      const declineVars = {
        '%Viewer Name%':   full.viewer_name || '',
        '%Viewer Email%':  full.viewer_email || '',
        '%Viewer Phone%':  full.viewer_phone || '',
        '%Viewing Date%':  formatWhen(full.proposed_datetime),
        '%Unit Name%':     full.unit_name || '',
        '%Property Name%': full.property_name || '',
        '%Property Address%': [full.street_address, full.city, full.state].filter(Boolean).join(', '),
        '%Host Name%':     employeeDisplayName(full),
      };

      for (const to of recipients) {
        sendViewingMail(req.pool, req.orgId, {
          templateType: 'Viewing-Declined',
          variables: declineVars,
          fallback: {
            subject: `Viewing declined: ${full.unit_name}`,
            html: fallbackDeclinedHtml,
          },
          mailOpts: { to },
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

    // Remove from the employee's Google Calendar (fire-and-forget)
    if (full.gcal_event_id && full.employee_google_calendar_id) {
      deleteViewingEvent({
        calendarId: full.employee_google_calendar_id,
        gcalEventId: full.gcal_event_id,
      }).catch(e => console.error('[viewing-public] Google Calendar delete failed:', e.message));
    }

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

    const fallbackCancelledHtml = bodyCancelled({
      viewer_name: full.viewer_name,
      property_name: full.property_name,
      unit_name: full.unit_name,
      proposed_datetime: full.proposed_datetime,
    });
    const recipients = [full.viewer_email, full.employee_email]
      .concat(full.tenant_email ? [full.tenant_email] : [])
      .filter(Boolean);

    const cancelVars = {
      '%Viewer Name%':   full.viewer_name || '',
      '%Viewer Email%':  full.viewer_email || '',
      '%Viewer Phone%':  full.viewer_phone || '',
      '%Viewing Date%':  formatWhen(full.proposed_datetime),
      '%Unit Name%':     full.unit_name || '',
      '%Property Name%': full.property_name || '',
      '%Property Address%': [full.street_address, full.city, full.state].filter(Boolean).join(', '),
      '%Host Name%':     employeeDisplayName(full),
    };

    for (const to of recipients) {
      sendViewingMail(req.pool, req.orgId, {
        templateType: 'Viewing-Cancelled',
        variables: cancelVars,
        fallback: {
          subject: `Viewing cancelled: ${full.unit_name}`,
          html: fallbackCancelledHtml,
        },
        mailOpts: { to, attachments: ics ? [ics] : undefined },
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

// ---------------------------------------------------------------------------
// POST /lead — general inquiry / lead capture WITHOUT a specific unit/time.
//
// Used by:
//   - The WordPress "Message us" form (after we build it)
//   - The chatbot widget as a fallback when the prospect isn't ready to book
//
// Requires an org token because we have no other way to route the lead. We
// reuse the KIND_LINK token infrastructure — any active link token identifies
// the org safely. (Open question: should we add a dedicated KIND_LEAD token
// per-org? For now, any of the org's active viewing links works.)
// ---------------------------------------------------------------------------
router.post('/lead/:token', postLimiter, resolveOrgByViewingToken, async (req, res) => {
  try {
    const { name, email, phone, message } = req.body || {};
    if (!name || !email || !phone) {
      return fail(res, 'Name, email, and phone are required', 400);
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email))) {
      return fail(res, 'A valid email address is required', 400);
    }
    const contactId = await upsertViewerContact(req.pool, req.orgId, {
      name, email, phone,
      unitName: 'general inquiry',
      propertyName: null,
    });

    // Append the free-form message to the contact notes so staff see context.
    if (message) {
      await req.pool.execute(
        `UPDATE tenant SET notes = CONCAT(COALESCE(notes, ''), '\n\nInquiry: ', ?)
         WHERE id = ?`,
        [String(message).slice(0, 2000), contactId]
      );
    }
    ok(res, { contact_id: contactId });
  } catch (err) {
    console.error('[viewing-public] lead error:', err);
    fail(res, 'Failed to capture lead');
  }
});

module.exports = router;
