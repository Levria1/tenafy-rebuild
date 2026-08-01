/**
 * Candidate-booking core for the prospect-led viewing flow.
 *
 * A "candidate booking" is one viewing_booking (status 0 = pending) plus 1–3
 * viewing_candidate rows. The current tenant (or the host, if vacant) taps a
 * candidate to confirm it. This module owns creating that booking and firing
 * the tenant "which time works?" prompt, so the three entry points stay in sync:
 *   - POST /api/viewing-public/invite/:token/submit  (prospect reviews on a page)
 *   - POST /api/public/viewing-request               (bot posts parsed times)
 *   - the supersede path (prospect edits after the tenant was already asked)
 *
 * Self-contained on purpose: it does NOT reuse viewingPublic.js's helpers, so
 * the older /link/* booking routes there stay untouched.
 */

const crypto = require('crypto');
const config = require('../config');
const { getMasterPool } = require('../config/poolRegistry');
const { getFreeBusy } = require('./googleCalendar');
const { sendViewingMail } = require('./viewingNotify');
const { sendWhatsApp } = require('./whatsappService');
const { KIND_ACTION, KIND_MANAGE } = require('../middleware/viewingTokenAuth');

function newId() {
  return (BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000))).toString();
}
function newActionToken() {
  return crypto.randomBytes(24).toString('hex');
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
function buildUrl(path) {
  const base = (config.appUrl || config.frontendUrl || 'http://localhost:3000').replace(/\/+$/, '');
  return `${base}${path}`;
}

// Find the active lease (+ tenant contact) for a unit, if occupied.
async function findActiveLeaseForUnit(pool, unitId) {
  const [rows] = await pool.execute(
    `SELECT l.id AS leasing_id, l.tenant_id, l.contract_type, l.viewing_enabled,
            DATE_FORMAT(l.end_date, '%Y-%m-%d') AS end_date, t.email, t.phone
     FROM leasing l LEFT JOIN tenant t ON l.tenant_id = t.id
     WHERE l.unit_id = ? AND l.deleted_at IS NULL
       AND l.start_date <= CURDATE() AND (l.end_date >= CURDATE() OR l.end_date IS NULL)
     ORDER BY l.start_date DESC LIMIT 1`,
    [unitId]
  );
  return rows[0] || null;
}

// Capture the prospect as an inquiry (lead). Best-effort; returns id or null.
async function createInquiryForViewer(pool, orgId, { name, email, phone, message, unitId, propertyId, unitName, propertyName, source = 'chatbot' }) {
  const inquiryId = newId();
  const normalizedEmail = String(email || '').trim().toLowerCase() || null;
  const [firstName, ...rest] = String(name || '').trim().split(/\s+/);
  const lastName = rest.join(' ') || null;
  const note = `Submitted via viewing request for ${unitName || 'unit'}` +
    (propertyName ? ` at ${propertyName}` : '') + ` on ${new Date().toISOString().slice(0, 10)}.` +
    (message ? `\n\nMessage: ${String(message).slice(0, 2000)}` : '');
  await pool.execute(
    `INSERT INTO inquiry (id, org_id, inquiry_date, first_name, last_name, email, phone, notes, unit_id, property_id, source, status)
     VALUES (?, ?, NOW(), ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    [inquiryId, orgId, firstName || null, lastName, normalizedEmail, phone || null, note, unitId || null, propertyId || null, source]
  );
  return inquiryId;
}

// Bookings (status pending/confirmed) + Google busy windows that block a slot
// for this host/unit in [rangeStart, rangeEnd] (padded by the host's buffer).
async function findBlocking(pool, { employeeId, unitId, rangeStart, rangeEnd }) {
  let bufferMin = 30, calendarId = null;
  try {
    const [[row]] = await pool.execute(
      'SELECT viewing_buffer_minutes AS b, google_calendar_id AS gcal FROM user WHERE id = ?', [employeeId]
    );
    if (row && row.b != null) bufferMin = Number(row.b) || 0;
    if (row && row.gcal) calendarId = String(row.gcal).trim() || null;
  } catch { /* columns may not exist — keep defaults */ }

  const padStart = new Date(new Date(rangeStart).getTime() - bufferMin * 60000);
  const padEnd = new Date(new Date(rangeEnd).getTime() + bufferMin * 60000);
  const [rows] = await pool.execute(
    `SELECT id, proposed_datetime, duration_minutes, employee_id, unit_id FROM viewing_booking
     WHERE status IN (0,1) AND (employee_id = ? OR unit_id = ?)
       AND proposed_datetime >= ? AND proposed_datetime <= ?`,
    [employeeId, unitId, padStart, padEnd]
  );
  const googleBusy = calendarId ? await getFreeBusy({ calendarId, timeMin: padStart, timeMax: padEnd }) : [];
  return { conflicts: rows, bufferMin, googleBusy };
}
function intersectsBusy(propStart, propEnd, busyWindows) {
  const ps = new Date(propStart).getTime(), pe = new Date(propEnd).getTime();
  return (busyWindows || []).some(w => ps < new Date(w.end).getTime() && pe > new Date(w.start).getTime());
}
function overlapsWithBuffer(propStart, propEnd, existing, bufferMin) {
  const eStart = new Date(existing.proposed_datetime).getTime() - bufferMin * 60000;
  const eEnd = new Date(existing.proposed_datetime).getTime() + (Number(existing.duration_minutes) || 30) * 60000 + bufferMin * 60000;
  return new Date(propStart).getTime() < eEnd && new Date(propEnd).getTime() > eStart;
}

// Mark a candidate booking cancelled: release its tentative candidates and set
// status=3 (+ optional superseded_by). Pending bookings have no calendar event.
async function cancelCandidateBookingRow(pool, bookingId, supersededBy = null) {
  await pool.execute(`UPDATE viewing_candidate SET status = 0 WHERE booking_id = ? AND status = 1`, [bookingId]);
  await pool.execute(
    `UPDATE viewing_booking SET status = 3, awaiting = NULL, superseded_by = ? WHERE id = ?`,
    [supersededBy, bookingId]
  );
}

/**
 * Create a pending candidate booking and prompt the tenant (or host) to pick.
 *
 * opts: {
 *   unitId, propertyId, unitName, propertyName, propertyAddress,
 *   employeeId, employeeEmail,
 *   lease,            // { leasing_id, tenant_id, email, phone } | null  (resolved by caller, or omit to auto-resolve)
 *   prospect,         // { name, email, phone }
 *   message,
 *   candidates,       // array of Date|ISO (already window-validated by the caller)
 *   inviteId,         // optional — stored on the booking
 *   onClash,          // 'reject' (default, page) | 'drop' (bot)
 * }
 * → { ok:true, bookingId, manageToken, hasTenant, candidates:[{when,label,url}], dropped:[labels] }
 * → { ok:false, clashes:[labels] }   // nothing bookable
 */
async function createCandidateBooking(pool, orgId, opts) {
  const {
    unitId, propertyId, unitName, propertyName, propertyAddress = '',
    employeeId, employeeEmail, prospect = {}, message, candidates,
    inviteId = null, onClash = 'reject',
  } = opts;

  const lease = opts.lease !== undefined ? opts.lease : await findActiveLeaseForUnit(pool, unitId);
  const hasTenant = Boolean(lease && lease.tenant_id && lease.email);

  // Normalise + sort candidate times.
  const whenList = candidates.map(c => new Date(c)).filter(d => !isNaN(d.getTime())).sort((a, b) => a - b);
  if (!whenList.length) return { ok: false, clashes: [] };

  // Conflict check against host bookings + Google busy.
  const rangeStart = whenList[0];
  const rangeEnd = new Date(whenList[whenList.length - 1].getTime() + 30 * 60000);
  const { conflicts, bufferMin, googleBusy } = await findBlocking(pool, { employeeId, unitId, rangeStart, rangeEnd });

  const free = [], clashes = [];
  for (const w of whenList) {
    const end = new Date(w.getTime() + 30 * 60000);
    const hit = conflicts.find(b => overlapsWithBuffer(w, end, b, bufferMin)) || intersectsBusy(w, end, googleBusy);
    if (hit) clashes.push(formatWhen(w)); else free.push(w);
  }
  if (onClash === 'reject' && clashes.length) return { ok: false, clashes };
  if (!free.length) return { ok: false, clashes };

  let inquiryId = null;
  try {
    inquiryId = await createInquiryForViewer(pool, orgId, {
      name: prospect.name, email: prospect.email, phone: prospect.phone, message,
      unitId, propertyId, unitName, propertyName, source: 'chatbot',
    });
  } catch (e) { console.error('[viewingBooking] inquiry create failed:', e.message); }

  const bookingId = newId();
  const employeeTok = newActionToken();
  const manageTok = newActionToken();
  const icsUid = `${bookingId}@tenafy-viewing`;
  const candidateRows = free.map(w => ({ id: newId(), token: newActionToken(), when: w }));

  const registryRows = [
    [employeeTok, String(orgId), KIND_ACTION, 1],
    [manageTok, String(orgId), KIND_MANAGE, 1],
    ...candidateRows.map(c => [c.token, String(orgId), KIND_ACTION, 1]),
  ];
  await getMasterPool().query('INSERT INTO viewing_link_registry (token, org_id, kind, status) VALUES ?', [registryRows]);

  const conn = await pool.getConnection();
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
        bookingId, unitId, propertyId, employeeId,
        lease ? lease.leasing_id : null, lease ? lease.tenant_id : null,
        inquiryId, inviteId,
        prospect.name || null, prospect.email || null, prospect.phone || null, message || null,
        candidateRows[0].when,
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
    await conn.commit();
  } catch (e) {
    try { await conn.rollback(); } catch {}
    throw e;
  } finally {
    conn.release();
  }

  // --- Prompt the tenant (or host) to pick a time (fire-and-forget) ---
  const candidateLinks = candidateRows.map(c => ({
    when: c.when, label: formatWhen(c.when), url: buildUrl(`/book/viewing/confirm/${c.token}`),
  }));
  const buttonsHtml = candidateLinks.map(c =>
    `<a href="${c.url}" style="background:#1677ff;color:#fff;padding:10px 18px;border-radius:4px;
      text-decoration:none;display:inline-block;margin:4px 0;">${escapeHtml(c.label)}</a>`).join('<br>');
  const fallbackPromptHtml = `
    <p>Hi,</p>
    <p><strong>${escapeHtml(prospect.name)}</strong> would like to view
       <strong>${escapeHtml(unitName)}</strong> at <strong>${escapeHtml(propertyName)}</strong>.</p>
    <p>Please tap the time that works best for you — the others will be released automatically:</p>
    <p>${buttonsHtml}</p>
    <p style="color:#8c8c8c;font-size:12px;">If the buttons don't work, copy a link into your browser:<br>
      ${candidateLinks.map(c => `${escapeHtml(c.label)}: ${c.url}`).join('<br>')}</p>`;
  const promptVars = {
    '%Viewer Name%': prospect.name || '', '%Unit Name%': unitName || '', '%Property Name%': propertyName || '',
    '%Property Address%': propertyAddress, '%Candidate Buttons%': buttonsHtml,
    '%Candidate Times%': candidateLinks.map(c => c.label).join(', '),
  };

  const promptEmail = hasTenant ? lease.email : employeeEmail;
  if (promptEmail) {
    sendViewingMail(pool, orgId, {
      templateType: 'Viewing-Tenant-Confirm', variables: promptVars,
      fallback: { subject: `Choose a viewing time — ${unitName}`, html: fallbackPromptHtml },
      mailOpts: { to: promptEmail },
    }).catch(e => console.error('[viewingBooking] tenant-confirm email failed:', e.message));
  }
  const promptPhone = hasTenant ? (lease.phone || null) : null;
  if (promptPhone) {
    const waText = `${prospect.name} would like to view ${unitName} at ${propertyName}.\n\n` +
      `Please tap the time that works best for you — the others are released automatically:\n` +
      candidateLinks.map(c => `• ${c.label}\n${c.url}`).join('\n');
    sendWhatsApp(pool, orgId, promptPhone, waText)
      .catch(e => console.error('[viewingBooking] tenant-confirm WhatsApp failed:', e.message));
  }

  return {
    ok: true, bookingId, manageToken: manageTok, hasTenant,
    candidates: candidateLinks.map(c => ({ when: c.when, label: c.label })),
    dropped: clashes,
  };
}

module.exports = {
  createCandidateBooking,
  cancelCandidateBookingRow,
  findActiveLeaseForUnit,
};
