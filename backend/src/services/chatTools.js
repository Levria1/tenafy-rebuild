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
          city: { type: 'string', description: 'Location name to filter by. Fuzzy-matched against city, district, state, AND street_address. Good for city names ("Hong Kong"), neighborhoods ("Mong Kok", "Causeway Bay"), or street names.' },
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
    if (args.city) {
      // Fuzzy match across city/state/district/address so neighborhood names
      // like "Mong Kok" or street names match even if property.city is "Hong Kong".
      where.push(`(
        LOWER(p.city)           LIKE LOWER(?) OR
        LOWER(p.state)          LIKE LOWER(?) OR
        LOWER(p.district)       LIKE LOWER(?) OR
        LOWER(p.street_address) LIKE LOWER(?) OR
        LOWER(p.display_name)   LIKE LOWER(?)
      )`);
      const needle = '%' + String(args.city).trim() + '%';
      params.push(needle, needle, needle, needle, needle);
    }
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
              p.street_address, p.city, p.state, p.district, p.country, p.currency,
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
          state: r.state,
          district: r.district,
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
        'List properties with their location and available-unit counts. Use when the prospect ' +
        'asks a broad question like "what buildings do you have?" or "do you have anything in Mong Kok?". ' +
        'Pass `location` to fuzzy-filter across city/district/address/name.',
      parameters: {
        type: 'object',
        properties: {
          location: { type: 'string', description: 'Fuzzy filter — matches city/district/state/street_address/display_name.' },
        },
      },
    },
  },
  cap: 'can_search',
  async execute(ctx, args = {}) {
    const { pool } = ctx;
    const today = new Date().toISOString().split('T')[0];
    const where = ['p.org_id = ?', 'p.status = 1', 'p.deleted_at IS NULL'];
    const params = [today, today, ctx.orgId];
    if (args.location) {
      where.push(`(
        LOWER(p.city)           LIKE LOWER(?) OR
        LOWER(p.state)          LIKE LOWER(?) OR
        LOWER(p.district)       LIKE LOWER(?) OR
        LOWER(p.street_address) LIKE LOWER(?) OR
        LOWER(p.display_name)   LIKE LOWER(?)
      )`);
      const needle = '%' + String(args.location).trim() + '%';
      params.push(needle, needle, needle, needle, needle);
    }
    const [rows] = await pool.execute(
      `SELECT p.id, p.display_name, p.street_address, p.city, p.state, p.country, p.district,
              COUNT(u.id) AS total_units,
              SUM(CASE WHEN u.active_status = 1 AND NOT EXISTS (
                SELECT 1 FROM leasing l WHERE l.unit_id = u.id AND l.deleted_at IS NULL
                  AND l.start_date <= ? AND (l.end_date >= ? OR l.end_date IS NULL)
              ) THEN 1 ELSE 0 END) AS available_units
       FROM property p
       LEFT JOIN unit u ON u.property_id = p.id
       WHERE ${where.join(' AND ')}
       GROUP BY p.id
       ORDER BY p.display_name`,
      params
    );
    return {
      count: rows.length,
      properties: rows.map(p => ({
        id: str(p.id),
        name: p.display_name,
        address: p.street_address,
        city: p.city,
        state: p.state,
        district: p.district,
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

// ---------------------------------------------------------------------------
// Tool: search_inquiries
//
// Lets staff ask the bot questions like:
//   "Who showed interest in unit B302?"
//   "Anyone still open with budget around 25k?"
//   "Show me inquiries from this month that mentioned parking"
//
// Searches across the inquiry table including the notes field (which holds
// the WhatsApp diff log — "Budget updated to $10,000", "Wants 2BR", etc.),
// optionally filtered by unit/property and inquiry status.
// ---------------------------------------------------------------------------
const search_inquiries = {
  cap: 'can_search_inquiries',
  definition: {
    type: 'function',
    function: {
      name: 'search_inquiries',
      description:
        "Search rental inquiries (prospect leads). Use when staff asks about who's interested in " +
        'a unit/property, prospects matching a budget/preference, or any lead-tracking question. ' +
        'Returns inquiry rows with first/last name, phone, email, budget, desired start date, ' +
        'status (0=Open, 1=Converted, 2=Closed), source, and the FULL notes field which contains ' +
        "the chat's auto-extracted updates (e.g. 'Budget updated to $10,000', 'Wants 2BR'). When " +
        'the user asks about a specific unit, pass `unit_id` or `property_id`. When the user asks ' +
        "about a topic mentioned in conversations (parking, neighbourhood, pets), pass the keyword " +
        'as `keyword` — it will search inside notes too.',
      parameters: {
        type: 'object',
        properties: {
          keyword:      { type: 'string',  description: 'Free-text search across name, email, phone, AND notes. Use the topic word the user asked about.' },
          unit_id:      { type: 'string',  description: 'Restrict to inquiries linked to this unit id.' },
          property_id:  { type: 'string',  description: 'Restrict to inquiries linked to this property id.' },
          status:       { type: 'integer', description: 'Filter by inquiry status: 0=Open, 1=Converted, 2=Closed. Default: any.' },
          source:       { type: 'string',  description: "Filter by where the inquiry came from. e.g. 'whatsapp', 'manual'." },
          limit:        { type: 'integer', description: 'Max rows to return. Default 20, max 50.' },
        },
      },
    },
  },
  async execute(ctx, args) {
    const orgId = ctx.orgId;
    const limit = clampLimit(args.limit, 20, 50);

    let where = 'i.org_id = ? AND i.deleted_at IS NULL';
    const params = [orgId];

    if (args.keyword) {
      const s = '%' + String(args.keyword).trim() + '%';
      where += ` AND (i.first_name LIKE ? OR i.last_name LIKE ?
                     OR i.email LIKE ? OR i.phone LIKE ?
                     OR i.notes LIKE ?)`;
      params.push(s, s, s, s, s);
    }
    if (args.unit_id)     { where += ' AND i.unit_id = ?';     params.push(str(args.unit_id)); }
    if (args.property_id) { where += ' AND i.property_id = ?'; params.push(str(args.property_id)); }
    if (Number.isInteger(args.status)) { where += ' AND i.status = ?'; params.push(args.status); }
    if (args.source)      { where += ' AND i.source = ?';      params.push(String(args.source)); }

    const [rows] = await ctx.pool.execute(
      `SELECT i.id, i.first_name, i.last_name, i.email, i.phone, i.budget,
              DATE_FORMAT(i.inquiry_date, '%Y-%m-%d') AS inquiry_date,
              DATE_FORMAT(i.desired_start_date, '%Y-%m-%d') AS desired_start_date,
              i.status, i.source, i.notes,
              p.display_name AS property_name, un.name AS unit_name
         FROM inquiry i
         LEFT JOIN property p ON i.property_id = p.id
         LEFT JOIN unit un    ON i.unit_id = un.id
        WHERE ${where}
        ORDER BY i.inquiry_date DESC
        LIMIT ${limit}`,
      params
    );

    const STATUS = { 0: 'Open', 1: 'Converted', 2: 'Closed' };
    return {
      count: rows.length,
      inquiries: rows.map(r => ({
        id: String(r.id),
        name: [r.first_name, r.last_name].filter(Boolean).join(' ') || '(no name)',
        phone: r.phone || null,
        email: r.email || null,
        budget: r.budget != null ? Number(r.budget) : null,
        inquiry_date: r.inquiry_date,
        desired_start_date: r.desired_start_date,
        status: STATUS[r.status] || String(r.status),
        source: r.source,
        property_name: r.property_name || null,
        unit_name: r.unit_name || null,
        notes: r.notes || '',
      })),
    };
  },
};

// ---------------------------------------------------------------------------
// Tool: search_leases
// Find leases (current, upcoming, or past) by tenant name, unit, property, or
// status. The status here is DATE-DERIVED, not the unreliable `leasing.status`
// column — see bd351ce. Internal staff bot only (tenant PII).
// ---------------------------------------------------------------------------
const search_leases = {
  cap: 'can_search_leases',
  definition: {
    type: 'function',
    function: {
      name: 'search_leases',
      description:
        'Search current/past/upcoming leases. Use when staff asks who is renting a unit, ' +
        "when a lease expires, who's on a month-to-month, leases for a specific tenant or " +
        'property, or anything lease-related. Returns lease_no, tenant name, unit, ' +
        'property, dates, rent, deposit, contract type, and computed lease_status ' +
        '(active / upcoming / past). The contract_type field is the lease intent ' +
        '(1=MR may-renew, 2=MTM month-to-month, 3=NR not-renewing, 4=UC unconfirmed). ' +
        'Pair with `expiring_within_days` to triage renewals.',
      parameters: {
        type: 'object',
        properties: {
          keyword:              { type: 'string',  description: 'Free-text across tenant first/last/company name, lease_no, and lease note.' },
          unit_id:              { type: 'string',  description: 'Restrict to leases on this unit id.' },
          property_id:          { type: 'string',  description: 'Restrict to leases on units within this property id.' },
          tenant_id:            { type: 'string',  description: 'Restrict to leases for this tenant id.' },
          status:               { type: 'string',  description: "Date-derived: 'active' (today is inside the lease span), 'upcoming' (start is future), 'past' (end is past). Default: any." },
          lease_type:           { type: 'integer', description: '0=fixed, 1=month-to-month. Default: any.' },
          contract_type:        { type: 'integer', description: '1=MR, 2=MTM, 3=NR, 4=UC. Default: any.' },
          expiring_within_days: { type: 'integer', description: "Only leases whose end_date falls within the next N days from today (for renewal triage)." },
          limit:                { type: 'integer', description: 'Max rows. Default 20, max 50.' },
        },
      },
    },
  },
  async execute(ctx, args) {
    const orgId = ctx.orgId;
    const limit = clampLimit(args.limit, 20, 50);

    let where = "l.deleted_at IS NULL AND p.org_id = ?";
    const params = [orgId];

    if (args.keyword) {
      const s = '%' + String(args.keyword).trim() + '%';
      where += ` AND (t.first_name LIKE ? OR t.last_name LIKE ?
                     OR t.company_name LIKE ? OR l.lease_no LIKE ?
                     OR l.note LIKE ?)`;
      params.push(s, s, s, s, s);
    }
    if (args.unit_id)     { where += ' AND l.unit_id = ?';     params.push(str(args.unit_id)); }
    if (args.property_id) { where += ' AND u.property_id = ?'; params.push(str(args.property_id)); }
    if (args.tenant_id)   { where += ' AND l.tenant_id = ?';   params.push(str(args.tenant_id)); }
    if (Number.isInteger(args.lease_type))    { where += ' AND l.type = ?';          params.push(args.lease_type); }
    if (Number.isInteger(args.contract_type)) { where += ' AND l.contract_type = ?'; params.push(args.contract_type); }

    // Date-derived status filter — keeps the LLM honest about what "active" means
    if (args.status === 'active') {
      where += ' AND l.start_date <= CURDATE() AND (l.end_date IS NULL OR l.end_date >= CURDATE())';
    } else if (args.status === 'upcoming') {
      where += ' AND l.start_date > CURDATE()';
    } else if (args.status === 'past') {
      where += ' AND l.end_date IS NOT NULL AND l.end_date < CURDATE()';
    }
    if (Number.isInteger(args.expiring_within_days)) {
      where += ' AND l.end_date IS NOT NULL AND l.end_date BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL ? DAY)';
      params.push(args.expiring_within_days);
    }

    const [rows] = await ctx.pool.execute(
      `SELECT l.id, l.lease_no, l.amount AS rent, l.deposit, l.type, l.contract_type, l.note,
              l.invoicing,
              DATE_FORMAT(l.start_date, '%Y-%m-%d') AS start_date,
              DATE_FORMAT(l.end_date,   '%Y-%m-%d') AS end_date,
              DATEDIFF(l.end_date, CURDATE()) AS days_until_end,
              CASE
                WHEN l.start_date > CURDATE() THEN 'upcoming'
                WHEN l.end_date IS NOT NULL AND l.end_date < CURDATE() THEN 'past'
                ELSE 'active'
              END AS lease_status,
              t.id AS tenant_id,
              CASE WHEN t.type = 1 THEN t.company_name
                   ELSE CONCAT(COALESCE(t.first_name,''), ' ', COALESCE(t.last_name,''))
              END AS tenant_name,
              t.phone AS tenant_phone, t.email AS tenant_email,
              u.id AS unit_id, u.name AS unit_name,
              p.id AS property_id, p.display_name AS property_name
         FROM leasing l
         LEFT JOIN tenant   t ON l.tenant_id = t.id
         LEFT JOIN unit     u ON l.unit_id = u.id
         LEFT JOIN property p ON u.property_id = p.id
        WHERE ${where}
        ORDER BY l.start_date DESC
        LIMIT ${limit}`,
      params
    );

    const TYPE = { 0: 'fixed', 1: 'month-to-month' };
    const CONTRACT = { 1: 'MR (may renew)', 2: 'MTM (month-to-month)', 3: 'NR (not renewing)', 4: 'UC (unconfirmed)' };
    return {
      count: rows.length,
      leases: rows.map(r => ({
        id: String(r.id),
        lease_no: r.lease_no,
        tenant_id: r.tenant_id ? String(r.tenant_id) : null,
        tenant_name: r.tenant_name?.trim() || '(no tenant)',
        tenant_phone: r.tenant_phone,
        tenant_email: r.tenant_email,
        property_id: r.property_id ? String(r.property_id) : null,
        property_name: r.property_name,
        unit_id: r.unit_id ? String(r.unit_id) : null,
        unit_name: r.unit_name,
        start_date: r.start_date,
        end_date: r.end_date,
        days_until_end: r.days_until_end,
        lease_status: r.lease_status,
        lease_type: TYPE[r.type] || String(r.type),
        contract_type: CONTRACT[r.contract_type] || (r.contract_type != null ? String(r.contract_type) : null),
        rent: r.rent != null ? Number(r.rent) : null,
        deposit: r.deposit != null ? Number(r.deposit) : null,
        invoicing: r.invoicing,
        note: r.note,
      })),
    };
  },
};

// ---------------------------------------------------------------------------
// Tool: search_invoices
// Outstanding rent, payment history, overdue. Internal staff bot only.
// ---------------------------------------------------------------------------
const search_invoices = {
  cap: 'can_search_invoices',
  definition: {
    type: 'function',
    function: {
      name: 'search_invoices',
      description:
        "Search invoices. Use when staff asks who's behind on rent, what's outstanding, " +
        'overdue invoices, payment history, or invoices for a specific tenant/unit/property/' +
        'date range. Returns invoice_code, amount, due_on, status, days_overdue, and ' +
        'category. Status: 0=Open, 1=Paid, 2=Overdue. Pair `overdue_only=true` for the ' +
        '"who owes us money" question.',
      parameters: {
        type: 'object',
        properties: {
          keyword:        { type: 'string',  description: 'Free-text across tenant name, invoice_code, and invoice note.' },
          tenant_id:      { type: 'string',  description: 'Restrict to one tenant.' },
          unit_id:        { type: 'string',  description: 'Restrict to one unit.' },
          property_id:    { type: 'string',  description: 'Restrict to one property.' },
          leasing_id:     { type: 'string',  description: 'Restrict to one lease.' },
          status:         { type: 'integer', description: '0=Open, 1=Paid, 2=Overdue. Default: any.' },
          overdue_only:   { type: 'boolean', description: 'true → only invoices that are open AND past due (regardless of stored status).' },
          due_from:       { type: 'string',  description: 'Earliest due_on (YYYY-MM-DD inclusive).' },
          due_to:         { type: 'string',  description: 'Latest due_on (YYYY-MM-DD inclusive).' },
          min_amount:     { type: 'number',  description: 'Only invoices with amount >= this.' },
          category_name:  { type: 'string',  description: 'Category name substring (e.g. "Rental", "Deposit", "Stamp").' },
          limit:          { type: 'integer', description: 'Max rows. Default 20, max 50.' },
        },
      },
    },
  },
  async execute(ctx, args) {
    const orgId = ctx.orgId;
    const limit = clampLimit(args.limit, 20, 50);

    let where = 'i.org_id = ? AND i.deleted_at IS NULL';
    const params = [orgId];

    if (args.keyword) {
      const s = '%' + String(args.keyword).trim() + '%';
      where += ` AND (t.first_name LIKE ? OR t.last_name LIKE ?
                     OR t.company_name LIKE ? OR i.invoice_code LIKE ?
                     OR i.note LIKE ?)`;
      params.push(s, s, s, s, s);
    }
    if (args.tenant_id)   { where += ' AND i.tenant_id = ?';   params.push(str(args.tenant_id)); }
    if (args.unit_id)     { where += ' AND i.unit_id = ?';     params.push(str(args.unit_id)); }
    if (args.property_id) { where += ' AND i.property_id = ?'; params.push(str(args.property_id)); }
    if (args.leasing_id)  { where += ' AND i.leasing_id = ?';  params.push(str(args.leasing_id)); }
    if (Number.isInteger(args.status)) { where += ' AND i.status = ?'; params.push(args.status); }
    if (args.overdue_only) {
      where += ' AND i.status != 1 AND i.due_on < CURDATE()';
    }
    if (args.due_from) { where += ' AND i.due_on >= ?'; params.push(args.due_from); }
    if (args.due_to)   { where += ' AND i.due_on <= ?'; params.push(args.due_to); }
    if (typeof args.min_amount === 'number') { where += ' AND i.amount >= ?'; params.push(args.min_amount); }
    if (args.category_name) {
      where += ' AND c.name LIKE ?';
      params.push('%' + String(args.category_name).trim() + '%');
    }

    const [rows] = await ctx.pool.execute(
      `SELECT i.id, i.invoice_code, i.amount, i.note, i.status, i.type,
              DATE_FORMAT(i.due_on, '%Y-%m-%d') AS due_on,
              DATEDIFF(CURDATE(), i.due_on) AS days_overdue,
              c.name AS category_name,
              t.id AS tenant_id,
              CASE WHEN t.type = 1 THEN t.company_name
                   ELSE CONCAT(COALESCE(t.first_name,''), ' ', COALESCE(t.last_name,''))
              END AS tenant_name,
              u.id AS unit_id, u.name AS unit_name,
              p.id AS property_id, p.display_name AS property_name,
              l.lease_no
         FROM invoice i
         LEFT JOIN tenant   t ON i.tenant_id = t.id
         LEFT JOIN unit     u ON i.unit_id = u.id
         LEFT JOIN property p ON i.property_id = p.id
         LEFT JOIN leasing  l ON i.leasing_id = l.id
         LEFT JOIN category_setting c ON i.category = c.id
        WHERE ${where}
        ORDER BY i.due_on DESC
        LIMIT ${limit}`,
      params
    );

    const STATUS = { 0: 'Open', 1: 'Paid', 2: 'Overdue' };
    const FLOW = { 0: 'Inflow', 1: 'Outflow' };
    return {
      count: rows.length,
      invoices: rows.map(r => ({
        id: String(r.id),
        invoice_code: r.invoice_code,
        amount: r.amount != null ? Number(r.amount) : null,
        due_on: r.due_on,
        days_overdue: r.days_overdue > 0 && r.status !== 1 ? r.days_overdue : 0,
        status: STATUS[r.status] || String(r.status),
        flow: FLOW[r.type] || String(r.type),
        category: r.category_name,
        tenant_id: r.tenant_id ? String(r.tenant_id) : null,
        tenant_name: r.tenant_name?.trim() || '(no tenant)',
        property_name: r.property_name,
        unit_name: r.unit_name,
        lease_no: r.lease_no,
        note: r.note,
      })),
    };
  },
};

// ---------------------------------------------------------------------------
// Tool: search_services
// Maintenance/service requests. Internal staff bot only.
// ---------------------------------------------------------------------------
const search_services = {
  cap: 'can_search_services',
  definition: {
    type: 'function',
    function: {
      name: 'search_services',
      description:
        'Search maintenance/service requests. Use when staff asks about open jobs, ' +
        'open repairs, who is fixing what, AC issues, plumbing, things broken at unit X, ' +
        'or pending vendor work. Returns service code, unit/property, category, note, ' +
        'status, priority, assignee name, dates. Searches inside `note` and `additional_info` ' +
        'when `keyword` is passed.',
      parameters: {
        type: 'object',
        properties: {
          keyword:      { type: 'string',  description: 'Free-text across code, note, and additional_info.' },
          unit_id:      { type: 'string',  description: 'Restrict to one unit.' },
          property_id:  { type: 'string',  description: 'Restrict to one property (joined through unit).' },
          category:     { type: 'string',  description: 'Service category name (substring match), e.g. "AC", "Plumbing".' },
          status:       { type: 'integer', description: 'Filter by service status code. Omit for any.' },
          open_only:    { type: 'boolean', description: 'true → exclude completed/closed (status != 2 and != 3).' },
          priority:     { type: 'string',  description: 'Priority value (e.g. "high", "low", "urgent" — matches stored value).' },
          since:        { type: 'string',  description: 'Only services created on/after this date (YYYY-MM-DD).' },
          limit:        { type: 'integer', description: 'Max rows. Default 20, max 50.' },
        },
      },
    },
  },
  async execute(ctx, args) {
    const orgId = ctx.orgId;
    const limit = clampLimit(args.limit, 20, 50);

    let where = 's.org_id = ? AND s.deleted_at IS NULL';
    const params = [orgId];

    if (args.keyword) {
      const s = '%' + String(args.keyword).trim() + '%';
      where += ` AND (s.code LIKE ? OR s.note LIKE ? OR s.additional_info LIKE ? OR s.sub_category LIKE ?)`;
      params.push(s, s, s, s);
    }
    if (args.unit_id)     { where += ' AND s.unit_id = ?';     params.push(str(args.unit_id)); }
    if (args.property_id) { where += ' AND u.property_id = ?'; params.push(str(args.property_id)); }
    if (args.category)    { where += ' AND s.category LIKE ?'; params.push('%' + String(args.category).trim() + '%'); }
    if (Number.isInteger(args.status)) { where += ' AND s.status = ?'; params.push(args.status); }
    if (args.open_only)   { where += ' AND s.status NOT IN (2, 3)'; }
    if (args.priority)    { where += ' AND s.priority = ?'; params.push(String(args.priority)); }
    if (args.since)       { where += ' AND s.created_at >= ?'; params.push(args.since); }

    const [rows] = await ctx.pool.execute(
      `SELECT s.id, s.code, s.category, s.sub_category, s.note, s.additional_info,
              s.status, s.priority,
              DATE_FORMAT(s.created_at, '%Y-%m-%d') AS created_on,
              DATE_FORMAT(s.service_date_start, '%Y-%m-%d') AS service_date_start,
              DATE_FORMAT(s.service_date_end,   '%Y-%m-%d') AS service_date_end,
              u.id AS unit_id, u.name AS unit_name,
              p.id AS property_id, p.display_name AS property_name,
              CONCAT(COALESCE(sv.first_name,''), ' ', COALESCE(sv.last_name,'')) AS assignee_name,
              sv.phone AS assignee_phone
         FROM service s
         LEFT JOIN unit     u  ON s.unit_id = u.id
         LEFT JOIN property p  ON u.property_id = p.id
         LEFT JOIN service_vendor sv ON s.assignee = sv.id
        WHERE ${where}
        ORDER BY s.created_at DESC
        LIMIT ${limit}`,
      params
    );

    return {
      count: rows.length,
      services: rows.map(r => ({
        id: String(r.id),
        code: r.code,
        category: r.category,
        sub_category: r.sub_category,
        property_name: r.property_name,
        unit_name: r.unit_name,
        status: r.status,
        priority: r.priority,
        assignee_name: r.assignee_name?.trim() || null,
        assignee_phone: r.assignee_phone,
        created_on: r.created_on,
        service_date_start: r.service_date_start,
        service_date_end: r.service_date_end,
        note: r.note,
        additional_info: r.additional_info,
      })),
    };
  },
};

// ---------------------------------------------------------------------------
// Tool: search_documents
// Lease templates + signature requests + signed leases. Internal staff only.
// ---------------------------------------------------------------------------
const search_documents = {
  cap: 'can_search_documents',
  definition: {
    type: 'function',
    function: {
      name: 'search_documents',
      description:
        'Search lease documents and e-signature requests. Use when staff asks about ' +
        'unsigned leases, what templates exist, who has signed, which leases are ' +
        "pending tenant signature, or 'is this lease signed yet'. The `kind` param " +
        'switches between three views: "signature_requests" (per-lease signature state), ' +
        '"templates" (lease template library), or "all" (default — both).',
      parameters: {
        type: 'object',
        properties: {
          keyword:           { type: 'string',  description: 'Free-text across tenant name, lease_no, template name.' },
          kind:              { type: 'string',  description: '"signature_requests" | "templates" | "all". Default "all".' },
          tenant_id:         { type: 'string',  description: 'Restrict signature_requests to this tenant.' },
          leasing_id:        { type: 'string',  description: 'Restrict signature_requests to this lease.' },
          signature_status:  { type: 'string',  description: "Filter signature_requests by lease.signature_status: 'none'|'pending'|'signed'|'declined'." },
          template_id:       { type: 'string',  description: 'Restrict to one lease template.' },
          limit:             { type: 'integer', description: 'Max rows per section. Default 20, max 50.' },
        },
      },
    },
  },
  async execute(ctx, args) {
    const orgId = ctx.orgId;
    const limit = clampLimit(args.limit, 20, 50);
    const kind = args.kind || 'all';

    const result = {};

    // --- Signature requests / lease signing state ---------------------------
    if (kind === 'signature_requests' || kind === 'all') {
      let where = "l.deleted_at IS NULL AND p.org_id = ?";
      const params = [orgId];

      if (args.keyword) {
        const s = '%' + String(args.keyword).trim() + '%';
        where += ` AND (t.first_name LIKE ? OR t.last_name LIKE ?
                       OR t.company_name LIKE ? OR l.lease_no LIKE ?)`;
        params.push(s, s, s, s);
      }
      if (args.tenant_id)        { where += ' AND l.tenant_id = ?';        params.push(str(args.tenant_id)); }
      if (args.leasing_id)       { where += ' AND l.id = ?';               params.push(str(args.leasing_id)); }
      if (args.signature_status) { where += ' AND l.signature_status = ?'; params.push(String(args.signature_status)); }

      try {
        const [rows] = await ctx.pool.execute(
          `SELECT l.id, l.lease_no, l.signature_status,
                  DATE_FORMAT(l.signed_at, '%Y-%m-%d %H:%i') AS signed_at,
                  l.template_id, l.template_version_used, l.signed_file_id,
                  CASE WHEN t.type = 1 THEN t.company_name
                       ELSE CONCAT(COALESCE(t.first_name,''), ' ', COALESCE(t.last_name,''))
                  END AS tenant_name,
                  u.name AS unit_name, p.display_name AS property_name,
                  lt.name AS template_name
             FROM leasing l
             LEFT JOIN tenant   t  ON l.tenant_id = t.id
             LEFT JOIN unit     u  ON l.unit_id = u.id
             LEFT JOIN property p  ON u.property_id = p.id
             LEFT JOIN lease_template lt ON l.template_id = lt.id
            WHERE ${where} AND l.signature_status IS NOT NULL
            ORDER BY l.signed_at DESC, l.id DESC
            LIMIT ${limit}`,
          params
        );
        result.signature_requests = rows.map(r => ({
          lease_id: String(r.id),
          lease_no: r.lease_no,
          tenant_name: r.tenant_name?.trim() || '(no tenant)',
          property_name: r.property_name,
          unit_name: r.unit_name,
          signature_status: r.signature_status,
          signed_at: r.signed_at,
          template_id: r.template_id ? String(r.template_id) : null,
          template_name: r.template_name,
          template_version_used: r.template_version_used,
          signed_file_id: r.signed_file_id ? String(r.signed_file_id) : null,
        }));
      } catch (e) {
        // If the org's DB hasn't run the e-sign migration yet, just return [].
        result.signature_requests = [];
        result._signature_requests_error = 'e-signature tables not present on this org';
      }
    }

    // --- Lease templates library --------------------------------------------
    if (kind === 'templates' || kind === 'all') {
      let where = 'org_id = ?';
      const params = [orgId];
      if (args.template_id) { where += ' AND id = ?'; params.push(str(args.template_id)); }
      if (args.keyword) {
        const s = '%' + String(args.keyword).trim() + '%';
        where += ' AND name LIKE ?';
        params.push(s);
      }

      try {
        const [rows] = await ctx.pool.execute(
          `SELECT id, name, current_version, status,
                  DATE_FORMAT(created_at, '%Y-%m-%d') AS created_on,
                  DATE_FORMAT(updated_at, '%Y-%m-%d') AS updated_on
             FROM lease_template
            WHERE ${where}
            ORDER BY updated_at DESC, name
            LIMIT ${limit}`,
          params
        );
        result.templates = rows.map(r => ({
          id: String(r.id),
          name: r.name,
          current_version: r.current_version,
          status: r.status,
          created_on: r.created_on,
          updated_on: r.updated_on,
        }));
      } catch (e) {
        result.templates = [];
        result._templates_error = 'lease_template table not present on this org';
      }
    }

    return result;
  },
};

const ALL_TOOLS = [
  search_available_units,
  get_unit_details,
  list_properties,
  capture_lead,
  request_viewing,
  search_inquiries,
  search_leases,
  search_invoices,
  search_services,
  search_documents,
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
