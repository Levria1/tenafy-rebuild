/**
 * Tool definitions + execution handlers for the chatbot.
 *
 * Each tool has two parts:
 *   1. `definition` — JSON Schema passed to the LLM so it knows when/how to
 *      call the tool. Same shape as OpenAI/MiniMax function-calling.
 *   2. `execute(ctx, args)` — the actual implementation, runs when the LLM
 *      returns a matching tool_call. Receives a context with req.pool + org
 *      info so multi-tenant isolation is preserved.
 *
 * Tools are filtered per-session based on the org's `bot_settings.capabilities`
 * so we don't expose write tools to a read-only org.
 */

const crypto = require('crypto');
const { buildViewingIcs } = require('../utils/ics');
const { sendMail } = require('../config/mailer');
const { getMasterPool } = require('../config/poolRegistry');

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function newId() {
  return (BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000))).toString();
}
function newActionToken() {
  return crypto.randomBytes(24).toString('hex');
}
function str(v) { return v == null ? null : String(v); }
function clampLimit(n, def = 20, max = 50) {
  const parsed = parseInt(n);
  if (!Number.isFinite(parsed) || parsed <= 0) return def;
  return Math.min(parsed, max);
}

// ---------------------------------------------------------------------------
// Tool: search_available_units
// ---------------------------------------------------------------------------

const search_available_units = {
  definition: {
    type: 'function',
    function: {
      name: 'search_available_units',
      description:
        'Search for SPECIFIC UNITS available on a specific date. This is the PRIMARY way to ' +
        'answer a prospect — always prefer returning individual units over listing properties. ' +
        "Use this whenever a prospect mentions criteria like bedrooms, budget, location, or a " +
        "target move-in date. Pass `available_on` for future dates (format YYYY-MM-DD). Omit " +
        "`available_on` to search today's availability. Returns units whose lease does NOT cover " +
        'the target date. Each result includes a `listing_url` pointing to the unit page (or the ' +
        'property page if no unit-level URL is set) — INCLUDE that link in your reply so the ' +
        'prospect can see photos.',
      parameters: {
        type: 'object',
        properties: {
          beds: { type: 'integer', description: 'Minimum number of bedrooms. Pass 0 to search for studios (no separate bedroom).' },
          max_price: { type: 'number', description: 'Maximum monthly rent the prospect is willing to pay' },
          min_price: { type: 'number', description: 'Minimum monthly rent (optional, rarely useful)' },
          city: { type: 'string', description: 'City name to filter by (matched against property.city)' },
          property_id: { type: 'string', description: 'If the prospect named a specific property, its id' },
          available_on: { type: 'string', description: 'Target availability date in YYYY-MM-DD format. Omit to use today.' },
          limit: { type: 'integer', description: 'Maximum number of units to return (default 10, max 25)' },
        },
      },
    },
  },
  cap: 'can_search',
  async execute(ctx, args) {
    const { pool } = ctx;
    const limit = clampLimit(args.limit, 10, 25);

    // Validate and resolve the availability date. Accept YYYY-MM-DD; reject past
    // dates for future-search (today is always fine).
    let targetDate = new Date().toISOString().split('T')[0];
    if (args.available_on) {
      const m = String(args.available_on).match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (!m) {
        return { error: 'available_on must be formatted as YYYY-MM-DD' };
      }
      targetDate = args.available_on;
    }

    const where = [
      'p.org_id = ?', // explicit org filter — tena_prod contains legacy multi-tenant data
      'p.status = 1',
      'p.deleted_at IS NULL',
      'u.active_status = 1',
      'u.deleted_at IS NULL',
    ];
    const params = [ctx.orgId];
    if (args.property_id) { where.push('p.id = ?'); params.push(args.property_id); }
    if (args.city)        { where.push('LOWER(p.city) = LOWER(?)'); params.push(args.city); }
    if (args.beds != null){ where.push('u.beds >= ?'); params.push(Number(args.beds)); }
    if (args.max_price != null) {
      where.push('(u.rent_price_min IS NULL OR u.rent_price_min <= ?)');
      params.push(Number(args.max_price));
    }
    if (args.min_price != null) {
      where.push('(u.rent_price_max IS NULL OR u.rent_price_max >= ?)');
      params.push(Number(args.min_price));
    }

    // A unit is "available on targetDate" when NO lease's date range covers it.
    // COALESCE prefers unit-level listing_url; falls back to property-level.
    const [rows] = await pool.execute(
      `SELECT u.id AS unit_id, u.name AS unit_name, u.type AS unit_type,
              u.beds, u.baths, u.rent_price_min, u.rent_price_max,
              COALESCE(u.listing_url, p.listing_url) AS listing_url,
              p.id AS property_id, p.display_name AS property_name,
              p.street_address, p.city, p.country, p.currency,
              vl.token AS booking_token,
              next_end.next_available_on
       FROM unit u
       JOIN property p ON u.property_id = p.id
       LEFT JOIN leasing active_lease
         ON active_lease.unit_id = u.id AND active_lease.deleted_at IS NULL
         AND active_lease.start_date <= ? AND (active_lease.end_date >= ? OR active_lease.end_date IS NULL)
       LEFT JOIN (
         SELECT l.unit_id, DATE_ADD(MIN(l.end_date), INTERVAL 1 DAY) AS next_available_on
         FROM leasing l
         WHERE l.deleted_at IS NULL AND l.end_date IS NOT NULL AND l.end_date >= ?
         GROUP BY l.unit_id
       ) next_end ON next_end.unit_id = u.id
       LEFT JOIN viewing_link vl ON vl.id = (
         SELECT vl2.id FROM viewing_link vl2
         WHERE vl2.unit_id = u.id AND vl2.status = 1 AND vl2.employee_id IS NOT NULL
         ORDER BY vl2.created_at DESC LIMIT 1
       )
       WHERE ${where.join(' AND ')} AND active_lease.id IS NULL
       ORDER BY u.rent_price_min ASC
       LIMIT ${limit}`,
      [targetDate, targetDate, targetDate, ...params]
    );

    return {
      count: rows.length,
      available_on: targetDate,
      units: rows.map(r => ({
        unit_id: str(r.unit_id),
        unit_name: r.unit_name,
        unit_type: r.unit_type,
        beds: r.beds,
        baths: r.baths,
        price: {
          min: r.rent_price_min,
          max: r.rent_price_max,
          currency: r.currency || 'USD',
        },
        listing_url: r.listing_url || null, // unit-level preferred, else property-level, else null
        property: {
          id: str(r.property_id),
          name: r.property_name,
          address: r.street_address,
          city: r.city,
          country: r.country,
        },
        can_book: Boolean(r.booking_token),
        next_available_on: r.next_available_on
          ? new Date(r.next_available_on).toISOString().split('T')[0]
          : null,
      })),
    };
  },
};

// ---------------------------------------------------------------------------
// Tool: get_unit_details
// ---------------------------------------------------------------------------

const get_unit_details = {
  definition: {
    type: 'function',
    function: {
      name: 'get_unit_details',
      description:
        'Get the full details of a specific unit including amenities and price range. ' +
        'Call this after the user has narrowed down to a specific unit from search results.',
      parameters: {
        type: 'object',
        properties: {
          unit_id: { type: 'string', description: 'Unit id returned by search_available_units' },
        },
        required: ['unit_id'],
      },
    },
  },
  cap: 'can_show_details',
  async execute(ctx, args) {
    const { pool } = ctx;
    const [rows] = await pool.execute(
      `SELECT u.*, p.display_name AS property_name, p.street_address, p.city,
              p.state, p.country, p.zip_code, p.currency,
              COALESCE(u.listing_url, p.listing_url) AS effective_listing_url,
              vl.token AS booking_token
       FROM unit u
       JOIN property p ON u.property_id = p.id
       LEFT JOIN viewing_link vl ON vl.id = (
         SELECT vl2.id FROM viewing_link vl2
         WHERE vl2.unit_id = u.id AND vl2.status = 1 AND vl2.employee_id IS NOT NULL
         ORDER BY vl2.created_at DESC LIMIT 1
       )
       WHERE u.id = ?
         AND p.org_id = ?
         AND u.active_status = 1 AND u.deleted_at IS NULL
         AND p.status = 1 AND p.deleted_at IS NULL
       LIMIT 1`,
      [args.unit_id, ctx.orgId]
    );
    if (!rows.length) return { error: 'Unit not found or no longer available' };
    const u = rows[0];

    const [amens] = await pool.execute(
      `SELECT a.id, a.name FROM unit_amenity ua
       JOIN amenity a ON ua.amenity_id = a.id
       WHERE ua.unit_id = ?`,
      [args.unit_id]
    );

    return {
      unit_id: str(u.id),
      name: u.name,
      type: u.type,
      beds: u.beds,
      baths: u.baths,
      price: { min: u.rent_price_min, max: u.rent_price_max, currency: u.currency || 'USD' },
      listing_url: u.effective_listing_url || null,
      property: {
        name: u.property_name,
        address: u.street_address,
        city: u.city,
        state: u.state,
      },
      amenities: amens.map(a => a.name),
      can_book: Boolean(u.booking_token),
    };
  },
};

// ---------------------------------------------------------------------------
// Tool: list_properties
// ---------------------------------------------------------------------------

const list_properties = {
  definition: {
    type: 'function',
    function: {
      name: 'list_properties',
      description:
        'List all active properties with their city and available-unit counts. Use when the ' +
        'prospect asks a broad question like "what buildings do you have?" or "do you have anything in Nairobi?".',
      parameters: { type: 'object', properties: {} },
    },
  },
  cap: 'can_search',
  async execute(ctx) {
    const { pool } = ctx;
    const today = new Date().toISOString().split('T')[0];
    const [rows] = await pool.execute(
      `SELECT p.id, p.display_name, p.street_address, p.city, p.state, p.country,
              COUNT(u.id) AS total_units,
              SUM(CASE WHEN u.active_status = 1 AND NOT EXISTS (
                SELECT 1 FROM leasing l WHERE l.unit_id = u.id AND l.deleted_at IS NULL
                  AND l.start_date <= ? AND (l.end_date >= ? OR l.end_date IS NULL)
              ) THEN 1 ELSE 0 END) AS available_units
       FROM property p
       LEFT JOIN unit u ON u.property_id = p.id
       WHERE p.org_id = ? AND p.status = 1 AND p.deleted_at IS NULL
       GROUP BY p.id
       ORDER BY p.display_name`,
      [today, today, ctx.orgId]
    );
    return {
      count: rows.length,
      properties: rows.map(p => ({
        id: str(p.id),
        name: p.display_name,
        address: p.street_address,
        city: p.city,
        country: p.country,
        total_units: Number(p.total_units) || 0,
        available_units: Number(p.available_units) || 0,
      })),
    };
  },
};

// ---------------------------------------------------------------------------
// Tool: capture_lead
// ---------------------------------------------------------------------------

const capture_lead = {
  definition: {
    type: 'function',
    function: {
      name: 'capture_lead',
      description:
        "Save the prospect's contact details so the team can follow up. Use this when the " +
        "prospect shares their name / email / phone but isn't ready to book a specific viewing yet.",
      parameters: {
        type: 'object',
        properties: {
          name:  { type: 'string' },
          email: { type: 'string' },
          phone: { type: 'string' },
          notes: { type: 'string', description: 'What the prospect is looking for (budget, beds, area, etc.)' },
        },
        required: ['name', 'email', 'phone'],
      },
    },
  },
  cap: 'can_capture_leads',
  async execute(ctx, args) {
    const { pool, orgId, session } = ctx;
    const normalizedEmail = String(args.email).trim().toLowerCase();
    const [first, ...rest] = String(args.name).trim().split(/\s+/);
    const last = rest.join(' ') || null;
    const noteBody = (args.notes || '').trim();
    const ts = new Date().toISOString().slice(0, 10);
    const fullNote = `Lead captured via chatbot on ${ts}.` + (noteBody ? `\nRequirements: ${noteBody}` : '');

    const [existing] = await pool.execute(
      'SELECT id, first_name, last_name, phone, notes FROM tenant WHERE org_id = ? AND email = ? AND deleted_at IS NULL LIMIT 1',
      [orgId, normalizedEmail]
    );

    let contactId;
    if (existing.length) {
      const e = existing[0];
      const updates = [];
      const params = [];
      if (!e.first_name && first) { updates.push('first_name = ?'); params.push(first); }
      if (!e.last_name && last)   { updates.push('last_name = ?');  params.push(last); }
      if (!e.phone && args.phone) { updates.push('phone = ?');      params.push(args.phone); }
      updates.push('notes = ?');
      params.push((e.notes ? e.notes.trim() + '\n\n' : '') + fullNote);
      params.push(e.id);
      await pool.execute(`UPDATE tenant SET ${updates.join(', ')} WHERE id = ?`, params);
      contactId = String(e.id);
    } else {
      contactId = newId();
      await pool.execute(
        `INSERT INTO tenant
           (id, org_id, first_name, last_name, email, phone, notes,
            type, status, category, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 3, NOW(), NOW())`,
        [contactId, orgId, first || null, last, normalizedEmail, args.phone || null, fullNote]
      );
    }

    // Cache on the session so subsequent tool calls (e.g. request_viewing) can reuse details.
    if (session) {
      session.viewer_name  = args.name;
      session.viewer_email = normalizedEmail;
      session.viewer_phone = args.phone;
      session.contact_id   = contactId;
      session.lead_captured = true;
    }

    return { ok: true, contact_id: contactId };
  },
};

// ---------------------------------------------------------------------------
// Tool: request_viewing
// ---------------------------------------------------------------------------
//
// This is the ONLY write tool that creates a booking. Two guardrails:
//   1. `user_confirmed` must be literally true — the system prompt forbids the
//      LLM from setting this unless the user has said yes in plain words.
//   2. session.booking_count is capped by bot_settings.max_bookings_per_session
//      (enforced in routes/chat.js before the tool runs).

const request_viewing = {
  definition: {
    type: 'function',
    function: {
      name: 'request_viewing',
      description:
        'Create a viewing booking request. ONLY call this tool AFTER the user has explicitly ' +
        "confirmed the unit, date, time, and their contact details in their last message. " +
        'If any of those are missing or unclear, ask a follow-up question INSTEAD of calling this tool.',
      parameters: {
        type: 'object',
        properties: {
          unit_id:            { type: 'string' },
          viewer_name:        { type: 'string' },
          viewer_email:       { type: 'string' },
          viewer_phone:       { type: 'string' },
          proposed_datetime:  { type: 'string', description: 'ISO-ish local date/time: YYYY-MM-DDTHH:mm (Mon-Sat, 11:00-19:00)' },
          viewer_message:     { type: 'string' },
          user_confirmed:     { type: 'boolean', description: 'Must be true. Set only if the user has explicitly said yes in their last message.' },
        },
        required: ['unit_id', 'viewer_name', 'viewer_email', 'viewer_phone', 'proposed_datetime', 'user_confirmed'],
      },
    },
  },
  cap: 'can_book_viewings',
  async execute(ctx, args) {
    const { pool, orgId, session } = ctx;
    if (args.user_confirmed !== true) {
      return { error: 'user_confirmed must be true. Ask the user to confirm in their own words first.' };
    }

    // Re-check the viewing window (defence-in-depth; matches viewingPublic.js)
    const m = String(args.proposed_datetime).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
    if (!m) return { error: 'proposed_datetime must be formatted YYYY-MM-DDTHH:mm' };
    const [, yyyy, mm, dd, HH, MM] = m;
    const dow = new Date(Date.UTC(+yyyy, +mm - 1, +dd)).getUTCDay();
    if (dow === 0) return { error: 'Viewings are not available on Sundays.' };
    const startMin = +HH * 60 + +MM;
    if (startMin < 11 * 60) return { error: 'Viewings start from 11:00 AM.' };
    if (startMin + 30 > 19 * 60) return { error: 'Viewings must end by 7:00 PM.' };

    // Verify a bookable link exists for this unit — AND that the unit belongs to this org.
    const [[link]] = await pool.execute(
      `SELECT vl.*, p.display_name AS property_name, u.name AS unit_name,
              usr.email AS employee_email, usr.first_name AS e_first, usr.last_name AS e_last
       FROM viewing_link vl
       JOIN property p ON vl.property_id = p.id
       JOIN unit u     ON vl.unit_id = u.id
       JOIN user usr   ON vl.employee_id = usr.id
       WHERE vl.unit_id = ?
         AND p.org_id = ?
         AND vl.status = 1 AND vl.employee_id IS NOT NULL
       ORDER BY vl.created_at DESC LIMIT 1`,
      [args.unit_id, orgId]
    );
    if (!link) return { error: 'This unit is not currently bookable. Ask the team to generate a link.' };

    // Active lease → we need the tenant's approval too
    const [[lease]] = await pool.execute(
      `SELECT l.id AS leasing_id, l.tenant_id, t.email AS tenant_email, t.first_name AS t_first, t.last_name AS t_last
       FROM leasing l LEFT JOIN tenant t ON l.tenant_id = t.id
       WHERE l.unit_id = ? AND l.deleted_at IS NULL
         AND l.start_date <= CURDATE() AND (l.end_date >= CURDATE() OR l.end_date IS NULL)
       ORDER BY l.start_date DESC LIMIT 1`,
      [args.unit_id]
    );
    const hasTenant = Boolean(lease && lease.tenant_id && lease.tenant_email);

    // Upsert contact (reuses the lead-capture path logic inline)
    let contactId = session?.contact_id || null;
    if (!contactId) {
      const leadRes = await capture_lead.execute(ctx, {
        name: args.viewer_name,
        email: args.viewer_email,
        phone: args.viewer_phone,
        notes: `Booked viewing for ${link.unit_name}`,
      });
      contactId = leadRes.contact_id;
    }

    // Generate tokens + booking
    const bookingId = newId();
    const employeeTok = newActionToken();
    const manageTok = newActionToken();
    const tenantTok = hasTenant ? newActionToken() : null;
    const icsUid = `${bookingId}@tenafy-viewing`;

    const master = getMasterPool();
    const rows = [
      [employeeTok, String(orgId), 2, 1],
      [manageTok, String(orgId), 3, 1],
    ];
    if (tenantTok) rows.push([tenantTok, String(orgId), 2, 1]);
    await master.query(
      'INSERT INTO viewing_link_registry (token, org_id, kind, status) VALUES ?',
      [rows]
    );

    await pool.execute(
      `INSERT INTO viewing_booking (
        id, link_id, unit_id, property_id, employee_id,
        leasing_id, tenant_id, viewer_contact_id,
        viewer_name, viewer_email, viewer_phone, viewer_message,
        proposed_datetime, duration_minutes,
        tenant_action_token, employee_action_token, viewer_manage_token,
        tenant_decision, employee_decision, status, source, ics_uid
       ) VALUES (?, ?, ?, ?, ?,  ?, ?, ?,  ?, ?, ?, ?,  ?, 30,  ?, ?, ?,  ?, 0, 0, 'bot', ?)`,
      [
        bookingId, link.id, args.unit_id, link.property_id, link.employee_id,
        lease ? lease.leasing_id : null,
        lease ? lease.tenant_id : null,
        contactId,
        args.viewer_name, args.viewer_email, args.viewer_phone, args.viewer_message || null,
        new Date(args.proposed_datetime),
        tenantTok, employeeTok, manageTok,
        hasTenant ? 0 : 3, // tenant_decision: 3=skipped when vacant
        icsUid,
      ]
    );

    // Dispatch emails (best-effort)
    const base = (require('../config').appUrl || 'http://localhost:3000').replace(/\/+$/, '');
    const manageUrl = `${base}/book/viewing/manage/${manageTok}`;
    const empApprove = `${base}/book/viewing/action/${employeeTok}?decision=approve`;
    const empDecline = `${base}/book/viewing/action/${employeeTok}?decision=decline`;

    const niceTime = new Date(args.proposed_datetime).toLocaleString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric',
      year: 'numeric', hour: 'numeric', minute: '2-digit',
    });

    sendMail({
      to: args.viewer_email,
      subject: `🤖 Viewing request received: ${link.unit_name}`,
      html: `<p>Hi ${args.viewer_name},</p><p>We've received your viewing request for <b>${link.unit_name}</b>
             at <b>${link.property_name}</b> on <b>${niceTime}</b>. The team will confirm shortly.</p>
             <p>Manage / cancel: <a href="${manageUrl}">${manageUrl}</a></p>`,
    }).catch(e => console.error('[chat] viewer email failed:', e.message));

    sendMail({
      to: link.employee_email,
      subject: `🤖 Bot-generated viewing request: ${link.unit_name} (${niceTime})`,
      html: `<p><b>Bot-generated booking</b> — please review before approving.</p>
             <p><b>Unit:</b> ${link.unit_name} at ${link.property_name}<br>
                <b>Viewer:</b> ${args.viewer_name} &middot; ${args.viewer_email} &middot; ${args.viewer_phone}<br>
                <b>When:</b> ${niceTime}</p>
             <p><a href="${empApprove}" style="background:#52c41a;color:#fff;padding:8px 16px;text-decoration:none;border-radius:4px;">Approve</a>
                &nbsp;
                <a href="${empDecline}" style="background:#ff4d4f;color:#fff;padding:8px 16px;text-decoration:none;border-radius:4px;">Decline</a></p>`,
    }).catch(e => console.error('[chat] employee email failed:', e.message));

    if (hasTenant && tenantTok) {
      const tenApprove = `${base}/book/viewing/action/${tenantTok}?decision=approve`;
      const tenDecline = `${base}/book/viewing/action/${tenantTok}?decision=decline`;
      sendMail({
        to: lease.tenant_email,
        subject: `Viewing request for your unit — ${link.unit_name}`,
        html: `<p>A prospective tenant has requested to view your unit on <b>${niceTime}</b>.</p>
               <p><a href="${tenApprove}">Approve</a> &middot; <a href="${tenDecline}">Decline</a></p>`,
      }).catch(e => console.error('[chat] tenant email failed:', e.message));
    }

    if (session) {
      session.booking_count = (session.booking_count || 0) + 1;
    }

    return {
      ok: true,
      booking_id: bookingId,
      manage_url: manageUrl,
      unit_name: link.unit_name,
      property_name: link.property_name,
      scheduled: niceTime,
    };
  },
};

// ---------------------------------------------------------------------------
// Registry + accessors
// ---------------------------------------------------------------------------

const ALL_TOOLS = [
  search_available_units,
  get_unit_details,
  list_properties,
  capture_lead,
  request_viewing,
];

const ALL_BY_NAME = Object.fromEntries(
  ALL_TOOLS.map(t => [t.definition.function.name, t])
);

/**
 * Return tool definitions + executor map filtered by the org's capabilities.
 * @param {object} capabilities  e.g. { can_search: true, can_book_viewings: false, ... }
 */
function toolsForCapabilities(capabilities) {
  const caps = capabilities || {};
  const allowed = ALL_TOOLS.filter(t => !t.cap || caps[t.cap] !== false);
  return {
    definitions: allowed.map(t => t.definition),
    byName: Object.fromEntries(allowed.map(t => [t.definition.function.name, t])),
  };
}

module.exports = { toolsForCapabilities, ALL_BY_NAME };
