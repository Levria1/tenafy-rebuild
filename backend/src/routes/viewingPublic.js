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
const { createViewingEvent, deleteViewingEvent, getFreeBusy } = require('../services/googleCalendar');
const { sendWhatsApp } = require('../services/whatsappService');
const { sendViewingMail } = require('../services/viewingNotify');

const {
  resolveOrgByViewingToken,
  resolveOrgByActionToken,
  resolveOrgByManageToken,
  resolveOrgByInviteToken,
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

// Create an `inquiry` row for the prospective viewer.
//
// Public viewers never get auto-promoted into the contacts (tenant) table —
// staff must explicitly click "Create Contact" on the inquiry. This keeps
// Contacts clean. The viewing_booking row links back via inquiry_id.
//
// Return the inquiry id (string, bigint-safe).
async function createInquiryForViewer(pool, orgId, { name, email, phone, message, unitId, propertyId, unitName, propertyName, source = 'web' }) {
  const inquiryId = newId();
  const normalizedEmail = String(email).trim().toLowerCase();
  const [firstName, ...rest] = String(name || '').trim().split(/\s+/);
  const lastName = rest.join(' ') || null;
  const sourceNote =
    `Submitted via public viewing request for ${unitName || 'unit'}` +
    (propertyName ? ` at ${propertyName}` : '') +
    ` on ${new Date().toISOString().slice(0, 10)}.` +
    (message ? `\n\nMessage: ${String(message).slice(0, 2000)}` : '');

  await pool.execute(
    `INSERT INTO inquiry
       (id, org_id, inquiry_date, first_name, last_name, email, phone, notes,
        unit_id, property_id, source, status)
     VALUES (?, ?, NOW(), ?, ?, ?, ?, ?,  ?, ?, ?, 0)`,
    [
      inquiryId, orgId,
      firstName || null, lastName, normalizedEmail,
      phone || null, sourceNote,
      unitId || null, propertyId || null, source,
    ]
  );
  return inquiryId;
}

/**
 * Fetch all bookings that block a proposed slot for a given employee + unit.
 *
 * A "blocking" booking is one that:
 *   - is still active (status 0 pending or 1 confirmed)
 *   - belongs to the same employee OR the same unit
 *   - overlaps the [rangeStart, rangeEnd] window
 *
 * The employee's `viewing_buffer_minutes` is applied: existing bookings are
 * widened by (buffer) on each side when checking. So if Dennis has a 30-min
 * buffer and a viewing at 14:00-14:30, the window [13:30, 15:00] is blocked
 * from new bookings assigned to Dennis.
 *
 * @returns { conflicts: [ {id, proposed_datetime, duration_minutes, employee_id, unit_id} ], bufferMin }
 */
async function findBlockingBookings(pool, { employeeId, unitId, rangeStart, rangeEnd }) {
  // Look up employee's buffer + Google calendar id
  let bufferMin = 30;
  let calendarId = null;
  try {
    const [[row]] = await pool.execute(
      'SELECT viewing_buffer_minutes AS b, google_calendar_id AS gcal FROM user WHERE id = ?',
      [employeeId]
    );
    if (row && row.b != null) bufferMin = Number(row.b) || 0;
    if (row && row.gcal) calendarId = String(row.gcal).trim() || null;
  } catch {
    // Columns may not exist yet — keep defaults
  }

  // Pad the query range by the buffer so MySQL filter catches near-misses too.
  const padStart = new Date(new Date(rangeStart).getTime() - bufferMin * 60 * 1000);
  const padEnd   = new Date(new Date(rangeEnd).getTime()   + bufferMin * 60 * 1000);

  const [rows] = await pool.execute(
    `SELECT id, proposed_datetime, duration_minutes, employee_id, unit_id
     FROM viewing_booking
     WHERE status IN (0, 1)
       AND (employee_id = ? OR unit_id = ?)
       AND proposed_datetime >= ? AND proposed_datetime <= ?`,
    [employeeId, unitId, padStart, padEnd]
  );

  // Staff's real availability from Google Calendar (free/busy). Empty array
  // when the employee has no calendar linked or Google isn't configured —
  // so this gracefully no-ops and falls back to the Tenafy-only check.
  const googleBusy = calendarId
    ? await getFreeBusy({ calendarId, timeMin: padStart, timeMax: padEnd })
    : [];

  return { conflicts: rows, bufferMin, googleBusy };
}

/** True if [propStart, propEnd) overlaps any {start,end} busy window. */
function intersectsBusy(propStart, propEnd, busyWindows) {
  const ps = new Date(propStart).getTime();
  const pe = new Date(propEnd).getTime();
  return (busyWindows || []).some(w => ps < new Date(w.end).getTime() && pe > new Date(w.start).getTime());
}

/**
 * Return true if a proposed slot overlaps an existing booking (with buffer).
 * Pass `excludeBookingId` to ignore a specific booking (e.g. when updating).
 */
function overlapsWithBuffer(proposedStart, proposedEnd, existing, bufferMin) {
  const existStart = new Date(existing.proposed_datetime).getTime() - bufferMin * 60 * 1000;
  const existEnd   = new Date(existing.proposed_datetime).getTime()
                   + (Number(existing.duration_minutes) || 30) * 60 * 1000
                   + bufferMin * 60 * 1000;
  const propStart = new Date(proposedStart).getTime();
  const propEnd   = new Date(proposedEnd).getTime();
  return propStart < existEnd && propEnd > existStart;
}

async function findActiveLeaseForUnit(pool, unitId) {
  const [rows] = await pool.execute(
    `SELECT l.id AS leasing_id, l.tenant_id,
            t.first_name, t.last_name, t.email, t.phone, t.company_name
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
// GET /link/:token/availability — returns busy slots for the next N days
//
// The frontend calls this when the form loads so it can grey out already-taken
// time slots in the picker. Returns a flat list of {start, end} windows that
// should be treated as unavailable (includes the buffer).
//
// Query: ?from=YYYY-MM-DD&to=YYYY-MM-DD (optional; defaults to today..+60d)
// ---------------------------------------------------------------------------
router.get('/link/:token/availability', resolveOrgByViewingToken, async (req, res) => {
  try {
    const link = await findLinkByToken(req.pool, req.viewingToken);
    if (!link || link.status !== 1 || !link.employee_id) {
      return fail(res, 'Link not available', 404);
    }

    const now = new Date();
    const defaultEnd = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000);
    const rangeStart = req.query.from ? new Date(req.query.from) : now;
    const rangeEnd   = req.query.to   ? new Date(req.query.to)   : defaultEnd;

    const { conflicts, bufferMin, googleBusy } = await findBlockingBookings(req.pool, {
      employeeId: link.employee_id,
      unitId:     link.unit_id,
      rangeStart,
      rangeEnd,
    });

    // Widen each booking by the buffer so the frontend can treat them as
    // single "no-go" windows without needing to know the buffer itself.
    const busy = conflicts.map(b => {
      const start = new Date(new Date(b.proposed_datetime).getTime() - bufferMin * 60 * 1000);
      const end   = new Date(new Date(b.proposed_datetime).getTime()
                           + (Number(b.duration_minutes) || 30) * 60 * 1000
                           + bufferMin * 60 * 1000);
      return { start: start.toISOString(), end: end.toISOString() };
    });

    // Also grey out times the assigned staffer is busy on their own calendar.
    for (const w of googleBusy) {
      busy.push({ start: new Date(w.start).toISOString(), end: new Date(w.end).toISOString() });
    }

    ok(res, {
      buffer_minutes: bufferMin,
      busy,
    });
  } catch (err) {
    console.error('[viewing-public] GET /availability error:', err);
    fail(res, 'Failed to load availability');
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

    // Conflict check — reject if another pending/confirmed booking overlaps
    // (either same employee or same unit). Applies the employee's buffer.
    const proposedStart = new Date(proposed_datetime);
    const proposedEnd   = new Date(proposedStart.getTime() + durationMin * 60 * 1000);
    const { conflicts, bufferMin, googleBusy } = await findBlockingBookings(req.pool, {
      employeeId: link.employee_id,
      unitId: link.unit_id,
      rangeStart: proposedStart,
      rangeEnd: proposedEnd,
    });
    const hit = conflicts.find(b => overlapsWithBuffer(proposedStart, proposedEnd, b, bufferMin))
      || intersectsBusy(proposedStart, proposedEnd, googleBusy);
    if (hit) {
      return fail(
        res,
        'That time is no longer available. Please pick a different slot.',
        409
      );
    }

    // Determine occupancy
    const lease = await findActiveLeaseForUnit(req.pool, link.unit_id);
    const hasTenant = Boolean(lease && lease.tenant_id && lease.email);

    // Create an inquiry row for this lead (NOT a tenant — staff must
    // explicitly promote later). Best-effort — if this fails we still want to
    // accept the booking, so log and continue with a null inquiry id.
    let inquiryId = null;
    try {
      inquiryId = await createInquiryForViewer(req.pool, req.orgId, {
        name: viewer_name,
        email: viewer_email,
        phone: viewer_phone,
        message: viewer_message,
        unitId: link.unit_id,
        propertyId: link.property_id,
        unitName: link.unit_name,
        propertyName: link.property_name,
        source: 'web',
      });
    } catch (e) {
      console.error('[viewing-public] inquiry create failed:', e.message);
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

    // Insert booking — viewer_contact_id stays null (no tenant created here);
    // inquiry_id is the new linkage back to the lead row.
    await req.pool.execute(
      `INSERT INTO viewing_booking (
        id, link_id, unit_id, property_id, employee_id,
        leasing_id, tenant_id, viewer_contact_id, inquiry_id,
        viewer_name, viewer_email, viewer_phone, viewer_message,
        proposed_datetime, duration_minutes,
        tenant_action_token, employee_action_token, viewer_manage_token,
        tenant_decision, employee_decision, status, source, ics_uid
       ) VALUES (?, ?, ?, ?, ?,  ?, ?, ?, ?,  ?, ?, ?, ?,  ?, ?,  ?, ?, ?,  ?, 0, 0, 'web', ?)`,
      [
        bookingId, link.id, link.unit_id, link.property_id, link.employee_id,
        lease ? lease.leasing_id : null,
        lease ? lease.tenant_id : null,
        null,
        inquiryId,
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
    const inquiryId = await createInquiryForViewer(req.pool, req.orgId, {
      name, email, phone, message,
      unitName: 'general inquiry',
      propertyName: null,
      source: 'web',
    });
    ok(res, { inquiry_id: inquiryId });
  } catch (err) {
    console.error('[viewing-public] lead error:', err);
    fail(res, 'Failed to capture lead');
  }
});

// ===========================================================================
// PROSPECT-LED INVITE FLOW (Phase B slice 2 + tenant pick)
//
// A prospect receives a per-prospect, prefilled, expiring link (minted by
// POST /api/public/viewing-link). They open it, propose up to 3 candidate
// times, and submit. We create ONE pending viewing_booking + one
// viewing_candidate per time, then prompt the tenant (or host, if vacant) to
// tap the time that works. Tapping confirms the booking and releases the rest.
// ===========================================================================

const INVITE_MAX_CANDIDATES = 3;

async function findInviteByToken(pool, token) {
  const [rows] = await pool.execute(
    `SELECT vi.*, p.display_name AS property_name, p.street_address, p.city, p.state,
            p.country, p.zip_code, u.name AS unit_name, u.type AS unit_type,
            u.beds, u.baths, u.rent_price_min, u.rent_price_max,
            usr.first_name AS employee_first_name, usr.last_name AS employee_last_name,
            usr.email AS employee_email
     FROM viewing_invite vi
     JOIN property p ON vi.property_id = p.id
     JOIN unit u     ON vi.unit_id = u.id
     LEFT JOIN user usr ON vi.employee_id = usr.id
     WHERE vi.token = ? LIMIT 1`,
    [token]
  );
  return rows[0] || null;
}

async function findCandidateByToken(pool, token) {
  const [rows] = await pool.execute(
    `SELECT vc.id AS candidate_id, vc.booking_id, vc.proposed_datetime AS candidate_datetime,
            vc.duration_minutes AS candidate_duration, vc.confirm_token, vc.status AS candidate_status,
            vb.status AS booking_status,
            p.display_name AS property_name, p.street_address, p.city, p.state,
            u.name AS unit_name
     FROM viewing_candidate vc
     JOIN viewing_booking vb ON vc.booking_id = vb.id
     JOIN property p ON vb.property_id = p.id
     JOIN unit u     ON vb.unit_id = u.id
     WHERE vc.confirm_token = ? LIMIT 1`,
    [token]
  );
  return rows[0] || null;
}

async function findBookingById(pool, id) {
  const [rows] = await pool.execute(
    `SELECT vb.*, p.display_name AS property_name, p.street_address, p.city, p.state,
            p.country, p.zip_code, u.name AS unit_name,
            usr.first_name AS employee_first_name, usr.last_name AS employee_last_name,
            usr.email AS employee_email, usr.google_calendar_id AS employee_google_calendar_id,
            t.first_name AS tenant_first_name, t.last_name AS tenant_last_name,
            t.email AS tenant_email, t.company_name
     FROM viewing_booking vb
     JOIN property p ON vb.property_id = p.id
     JOIN unit u     ON vb.unit_id = u.id
     JOIN user usr   ON vb.employee_id = usr.id
     LEFT JOIN tenant t ON vb.tenant_id = t.id
     WHERE vb.id = ? LIMIT 1`,
    [id]
  );
  return rows[0] || null;
}

// Fire the confirmation side-effects for a now-confirmed booking: push to the
// host's Google Calendar, then email an .ics to viewer + host (+ tenant).
// Modelled on the POST /action/:token confirmed branch. Fire-and-forget.
function sendViewingConfirmation(pool, orgId, full) {
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
      name: full.property_name, street_address: full.street_address,
      city: full.city, state: full.state,
    },
    employee: { name: employeeDisplayName(full), email: full.employee_email },
  }).then(gcalEventId => {
    if (gcalEventId) {
      pool.execute('UPDATE viewing_booking SET gcal_event_id = ? WHERE id = ?', [gcalEventId, full.id])
        .catch(e => console.error('[viewing-public] save gcal_event_id failed:', e.message));
    }
  }).catch(e => console.error('[viewing-public] Google Calendar create failed:', e.message));

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

  const confirmVars = {
    '%Viewer Name%':    full.viewer_name || '',
    '%Viewer Email%':   full.viewer_email || '',
    '%Viewer Phone%':   full.viewer_phone || '',
    '%Viewing Date%':   formatWhen(full.proposed_datetime),
    '%Unit Name%':      full.unit_name || '',
    '%Property Name%':  full.property_name || '',
    '%Property Address%': [full.street_address, full.city, full.state].filter(Boolean).join(', '),
    '%Host Name%':      employeeDisplayName(full),
  };
  const fallbackHtml = bodyConfirmation({
    viewer_name: full.viewer_name, property_name: full.property_name,
    unit_name: full.unit_name, proposed_datetime: full.proposed_datetime,
    employee_name: employeeDisplayName(full),
  });
  const recipients = [full.viewer_email, full.employee_email]
    .concat(full.tenant_email ? [full.tenant_email] : [])
    .filter(Boolean);
  for (const to of recipients) {
    sendViewingMail(pool, orgId, {
      templateType: 'Viewing-Confirmation',
      variables: confirmVars,
      fallback: {
        subject: `Viewing confirmed: ${full.unit_name} — ${formatWhen(full.proposed_datetime)}`,
        html: fallbackHtml,
      },
      mailOpts: { to, attachments: ics ? [ics] : undefined },
    }).catch(e => console.error('[viewing-public] confirmation email failed:', e.message));
  }
}

// ---------------------------------------------------------------------------
// GET /invite/:token — resolve a prefilled prospect invite
// ---------------------------------------------------------------------------
router.get('/invite/:token', resolveOrgByInviteToken, async (req, res) => {
  try {
    const invite = await findInviteByToken(req.pool, req.viewingToken);
    if (!invite) return fail(res, 'Link not found or no longer active', 404);
    if (Number(invite.status) !== 1 || (invite.booking_id != null)) {
      return res.status(200).json({ code: 200, data: { state: 'used' } });
    }
    if (invite.expires_at && new Date(invite.expires_at).getTime() < Date.now()) {
      return res.status(200).json({ code: 200, data: { state: 'expired' } });
    }
    // Re-check the unit is still open for viewings (lease may have been re-let).
    const [[lease]] = await req.pool.execute(
      `SELECT viewing_enabled FROM leasing WHERE id = ? LIMIT 1`, [invite.leasing_id]
    );
    if (lease && !Number(lease.viewing_enabled)) {
      return res.status(200).json({ code: 200, data: { state: 'closed' } });
    }
    if (!invite.employee_id) {
      return res.status(200).json({
        code: 200,
        data: { ready: false, property: { name: invite.property_name, city: invite.city }, unit: { name: invite.unit_name } },
      });
    }

    // Busy windows (Tenafy bookings + host Google free/busy) for the next 21 days
    // so the picker can grey out unavailable slots.
    const now = new Date();
    const rangeEnd = new Date(now.getTime() + 21 * 24 * 60 * 60 * 1000);
    const { conflicts, bufferMin, googleBusy } = await findBlockingBookings(req.pool, {
      employeeId: invite.employee_id, unitId: invite.unit_id, rangeStart: now, rangeEnd,
    });
    const busy = conflicts.map(b => ({
      start: new Date(new Date(b.proposed_datetime).getTime() - bufferMin * 60 * 1000).toISOString(),
      end: new Date(new Date(b.proposed_datetime).getTime() + (Number(b.duration_minutes) || 30) * 60 * 1000 + bufferMin * 60 * 1000).toISOString(),
    }));
    for (const w of googleBusy) busy.push({ start: new Date(w.start).toISOString(), end: new Date(w.end).toISOString() });

    ok(res, {
      ready: true,
      state: 'active',
      prefill_date: invite.prefill_date ? toDateString(new Date(invite.prefill_date)) : null,
      max_candidates: INVITE_MAX_CANDIDATES,
      prospect: {
        name: invite.prospect_name || '',
        phone: invite.prospect_phone || '',
        email: invite.prospect_email || '',
      },
      unit: {
        id: String(invite.unit_id), name: invite.unit_name, type: invite.unit_type,
        beds: invite.beds, baths: invite.baths,
        rent_price_min: invite.rent_price_min, rent_price_max: invite.rent_price_max,
      },
      property: {
        id: String(invite.property_id), name: invite.property_name,
        street_address: invite.street_address, city: invite.city, state: invite.state,
      },
      employee: { name: [invite.employee_first_name, invite.employee_last_name].filter(Boolean).join(' ') || invite.employee_email },
      buffer_minutes: bufferMin,
      busy,
    });
  } catch (err) {
    console.error('[viewing-public] GET /invite/:token error:', err);
    fail(res, 'Failed to load invite');
  }
});

// ---------------------------------------------------------------------------
// POST /invite/:token/submit — prospect proposes up to 3 candidate times
// ---------------------------------------------------------------------------
router.post('/invite/:token/submit', postLimiter, resolveOrgByInviteToken, async (req, res) => {
  try {
    const { prospect_name, prospect_email, prospect_phone, message, candidates } = req.body || {};

    if (!prospect_name || !prospect_email || !prospect_phone) {
      return fail(res, 'Name, email, and phone are required', 400);
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(prospect_email))) {
      return fail(res, 'A valid email address is required', 400);
    }
    if (!Array.isArray(candidates) || candidates.length === 0) {
      return fail(res, 'Please propose at least one time', 400);
    }

    // Normalise + dedupe candidate datetimes, cap at the max.
    const seen = new Set();
    const times = [];
    for (const c of candidates) {
      const s = String(c).slice(0, 19); // YYYY-MM-DDTHH:mm:ss
      if (seen.has(s)) continue;
      seen.add(s);
      const slotErr = validateBookingSlot(s, 30);
      if (slotErr) return fail(res, `${s.replace('T', ' ')}: ${slotErr}`, 400);
      const when = new Date(s);
      if (isNaN(when.getTime())) return fail(res, 'Invalid date/time', 400);
      if (when.getTime() < Date.now()) return fail(res, 'Please propose a future time', 400);
      times.push({ raw: s, when });
    }
    if (times.length > INVITE_MAX_CANDIDATES) {
      return fail(res, `Please propose at most ${INVITE_MAX_CANDIDATES} times`, 400);
    }
    times.sort((a, b) => a.when - b.when);

    const invite = await findInviteByToken(req.pool, req.viewingToken);
    if (!invite || Number(invite.status) !== 1 || invite.booking_id != null) {
      return fail(res, 'This link is no longer active', 410);
    }
    if (invite.expires_at && new Date(invite.expires_at).getTime() < Date.now()) {
      return fail(res, 'This link has expired', 410);
    }
    if (!invite.employee_id) {
      return fail(res, 'This link is not ready yet — no host has been assigned. Please try again shortly.', 409);
    }

    // Conflict-check every candidate against the host's bookings + Google calendar.
    const rangeStart = times[0].when;
    const rangeEnd = new Date(times[times.length - 1].when.getTime() + 30 * 60 * 1000);
    const { conflicts, bufferMin, googleBusy } = await findBlockingBookings(req.pool, {
      employeeId: invite.employee_id, unitId: invite.unit_id, rangeStart, rangeEnd,
    });
    const clashes = [];
    for (const t of times) {
      const end = new Date(t.when.getTime() + 30 * 60 * 1000);
      const hit = conflicts.find(b => overlapsWithBuffer(t.when, end, b, bufferMin))
        || intersectsBusy(t.when, end, googleBusy);
      if (hit) clashes.push(formatWhen(t.when));
    }
    if (clashes.length) {
      return fail(res, `These times are no longer available: ${clashes.join('; ')}. Please pick others.`, 409);
    }

    // Occupancy — prompt the tenant if occupied, else the host.
    const lease = await findActiveLeaseForUnit(req.pool, invite.unit_id);
    const hasTenant = Boolean(lease && lease.tenant_id && lease.email);

    // Capture this prospect as an inquiry (best-effort).
    let inquiryId = null;
    try {
      inquiryId = await createInquiryForViewer(req.pool, req.orgId, {
        name: prospect_name, email: prospect_email, phone: prospect_phone, message,
        unitId: invite.unit_id, propertyId: invite.property_id,
        unitName: invite.unit_name, propertyName: invite.property_name, source: 'chatbot',
      });
    } catch (e) {
      console.error('[viewing-public] invite inquiry create failed:', e.message);
    }

    const bookingId = newId();
    const employeeTok = newActionToken();
    const manageTok = newActionToken();
    const icsUid = `${bookingId}@tenafy-viewing`;
    const firstWhen = times[0].when;

    // Build candidate rows + confirm tokens up front so we can register them all.
    const candidateRows = times.map(t => ({ id: newId(), token: newActionToken(), when: t.when }));

    // Register employee/manage + every candidate confirm token in master.
    const registryRows = [
      [employeeTok, String(req.orgId), KIND_ACTION, 1],
      [manageTok, String(req.orgId), KIND_MANAGE, 1],
      ...candidateRows.map(c => [c.token, String(req.orgId), KIND_ACTION, 1]),
    ];
    await getMasterPool().query(
      'INSERT INTO viewing_link_registry (token, org_id, kind, status) VALUES ?', [registryRows]
    );

    const conn = await req.pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.execute(
        `INSERT INTO viewing_booking (
          id, link_id, unit_id, property_id, employee_id,
          leasing_id, tenant_id, viewer_contact_id, inquiry_id, invite_id,
          viewer_name, viewer_email, viewer_phone, viewer_message,
          proposed_datetime, duration_minutes,
          tenant_action_token, employee_action_token, viewer_manage_token,
          tenant_decision, employee_decision, status, awaiting, source, ics_uid
         ) VALUES (?, NULL, ?, ?, ?,  ?, ?, NULL, ?, ?,  ?, ?, ?, ?,  ?, 30,  NULL, ?, ?,  ?, 0, 0, ?, 'invite', ?)`,
        [
          bookingId, invite.unit_id, invite.property_id, invite.employee_id,
          lease ? lease.leasing_id : null, lease ? lease.tenant_id : null,
          inquiryId, invite.id,
          prospect_name, prospect_email, prospect_phone, message || null,
          firstWhen,
          employeeTok, manageTok,
          hasTenant ? 0 : 3,
          hasTenant ? 'tenant' : 'prospect',
          icsUid,
        ]
      );
      for (const c of candidateRows) {
        await conn.execute(
          `INSERT INTO viewing_candidate (id, booking_id, proposed_datetime, duration_minutes, confirm_token, status)
           VALUES (?, ?, ?, 30, ?, 1)`,
          [c.id, bookingId, c.when, c.token]
        );
      }
      // Burn the invite so the link can't be reused.
      await conn.execute(
        `UPDATE viewing_invite SET status = 0, booking_id = ? WHERE id = ?`,
        [bookingId, invite.id]
      );
      await conn.commit();
    } catch (e) {
      try { await conn.rollback(); } catch {}
      throw e;
    } finally {
      conn.release();
    }

    // --- Prompt the tenant (or host) to pick a time (fire-and-forget) ---
    const propertyName = invite.property_name;
    const unitName = invite.unit_name;
    const candidateLinks = candidateRows.map(c => ({
      when: c.when,
      label: formatWhen(c.when),
      url: buildUrl(`/book/viewing/confirm/${c.token}`),
    }));

    const buttonsHtml = candidateLinks.map(c =>
      `<a href="${c.url}" style="background:#1677ff;color:#fff;padding:10px 18px;border-radius:4px;
        text-decoration:none;display:inline-block;margin:4px 0;">${escapeHtml(c.label)}</a>`
    ).join('<br>');
    const fallbackPromptHtml = `
      <p>Hi,</p>
      <p><strong>${escapeHtml(prospect_name)}</strong> would like to view
         <strong>${escapeHtml(unitName)}</strong> at <strong>${escapeHtml(propertyName)}</strong>.</p>
      <p>Please tap the time that works best for you — the others will be released automatically:</p>
      <p>${buttonsHtml}</p>
      <p style="color:#8c8c8c;font-size:12px;">If the buttons don't work, copy a link into your browser:<br>
        ${candidateLinks.map(c => `${escapeHtml(c.label)}: ${c.url}`).join('<br>')}</p>`;

    const promptVars = {
      '%Viewer Name%':   prospect_name || '',
      '%Unit Name%':     unitName || '',
      '%Property Name%': propertyName || '',
      '%Property Address%': [invite.street_address, invite.city, invite.state].filter(Boolean).join(', '),
      '%Candidate Buttons%': buttonsHtml,
      '%Candidate Times%': candidateLinks.map(c => c.label).join(', '),
    };

    const promptEmail = hasTenant ? lease.email : invite.employee_email;
    if (promptEmail) {
      sendViewingMail(req.pool, req.orgId, {
        templateType: 'Viewing-Tenant-Confirm',
        variables: promptVars,
        fallback: {
          subject: `Choose a viewing time — ${unitName}`,
          html: fallbackPromptHtml,
        },
        mailOpts: { to: promptEmail },
      }).catch(e => console.error('[viewing-public] tenant-confirm email failed:', e.message));
    }

    // WhatsApp the tenant (plain text with links). Silent no-op if unconfigured.
    const promptPhone = hasTenant ? (lease.phone || null) : null;
    if (promptPhone) {
      const waText =
        `${prospect_name} would like to view ${unitName} at ${propertyName}.\n\n` +
        `Please tap the time that works best for you — the others are released automatically:\n` +
        candidateLinks.map(c => `• ${c.label}\n${c.url}`).join('\n');
      sendWhatsApp(req.pool, req.orgId, promptPhone, waText)
        .catch(e => console.error('[viewing-public] tenant-confirm WhatsApp failed:', e.message));
    }

    ok(res, {
      booking_id: bookingId,
      status: 'awaiting_tenant',
      has_tenant: hasTenant,
      candidates: candidateLinks.map(c => ({ when: c.when, label: c.label })),
    });
  } catch (err) {
    console.error('[viewing-public] POST /invite/:token/submit error:', err);
    fail(res, 'Failed to submit your viewing request');
  }
});

// ---------------------------------------------------------------------------
// GET /confirm/:token — data for the tenant's candidate-confirm page
// ---------------------------------------------------------------------------
router.get('/confirm/:token', resolveOrgByActionToken, async (req, res) => {
  try {
    const cand = await findCandidateByToken(req.pool, req.viewingToken);
    if (!cand) return fail(res, 'Link not found', 404);

    // Sibling candidate times (for context on the page).
    const [siblings] = await req.pool.execute(
      `SELECT proposed_datetime, status FROM viewing_candidate WHERE booking_id = ? ORDER BY proposed_datetime ASC`,
      [cand.booking_id]
    );

    let state = 'pending';
    if (Number(cand.booking_status) === 1) state = Number(cand.candidate_status) === 2 ? 'picked' : 'already_confirmed';
    else if ([2, 3].includes(Number(cand.booking_status))) state = 'closed';

    ok(res, {
      state,
      candidate: {
        proposed_datetime: cand.candidate_datetime,
        duration_minutes: cand.candidate_duration,
        status: cand.candidate_status,
      },
      all_candidates: siblings.map(s => ({ proposed_datetime: s.proposed_datetime, status: s.status })),
      unit: { name: cand.unit_name },
      property: {
        name: cand.property_name, street_address: cand.street_address,
        city: cand.city, state: cand.state,
      },
    });
  } catch (err) {
    console.error('[viewing-public] GET /confirm/:token error:', err);
    fail(res, 'Failed to load confirmation');
  }
});

// ---------------------------------------------------------------------------
// POST /confirm/:token/pick — tenant locks in one candidate time
// ---------------------------------------------------------------------------
router.post('/confirm/:token/pick', postLimiter, resolveOrgByActionToken, async (req, res) => {
  const conn = await req.pool.getConnection();
  try {
    await conn.beginTransaction();

    // Lock the candidate + its booking.
    const [candRows] = await conn.execute(
      `SELECT * FROM viewing_candidate WHERE confirm_token = ? LIMIT 1 FOR UPDATE`,
      [req.viewingToken]
    );
    if (!candRows.length) {
      await conn.rollback();
      return fail(res, 'Link not found', 404);
    }
    const cand = candRows[0];
    const [bookingRows] = await conn.execute(
      `SELECT * FROM viewing_booking WHERE id = ? LIMIT 1 FOR UPDATE`, [cand.booking_id]
    );
    const booking = bookingRows[0];
    if (!booking) {
      await conn.rollback();
      return fail(res, 'Booking not found', 404);
    }
    if (Number(booking.status) !== 0) {
      await conn.rollback();
      return res.status(410).json({ code: 410, message: 'This request has already been finalised.' });
    }

    // Confirm: this candidate picked, others released, booking → confirmed.
    await conn.execute(`UPDATE viewing_candidate SET status = 2 WHERE id = ?`, [cand.id]);
    await conn.execute(
      `UPDATE viewing_candidate SET status = 0 WHERE booking_id = ? AND id <> ?`,
      [cand.booking_id, cand.id]
    );
    await conn.execute(
      `UPDATE viewing_booking
          SET proposed_datetime = ?, status = 1, awaiting = NULL,
              tenant_decision = 1, tenant_decided_at = NOW(),
              employee_decision = 1, employee_decided_at = NOW()
        WHERE id = ?`,
      [cand.proposed_datetime, cand.booking_id]
    );
    await conn.commit();

    // Fire calendar + .ics + confirmation emails outside the transaction.
    const full = await findBookingById(req.pool, cand.booking_id);
    if (full) sendViewingConfirmation(req.pool, req.orgId, full);

    ok(res, { status: 'confirmed', proposed_datetime: cand.proposed_datetime });
  } catch (err) {
    try { await conn.rollback(); } catch {}
    console.error('[viewing-public] POST /confirm/:token/pick error:', err);
    fail(res, 'Failed to confirm the time');
  } finally {
    conn.release();
  }
});

module.exports = router;
