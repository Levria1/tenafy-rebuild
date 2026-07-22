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
const { searchUnits } = require('./unitSearch');
const { validateSelect, runReadOnly } = require('./askDataService');
const taneChatClient = require('./taneChatClient');
const { traceAmounts } = require('./paymentMatchService');

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
        'Search for SPECIFIC UNITS suitable for a prospect — always prefer returning individual units over properties. ' +
        'Results are ranked by best TIMING fit: units that free up closest to the move-in date (smallest vacancy gap) ' +
        'come first. Each result carries fit metadata: available_from, days_until_available (<=0 means vacant now), ' +
        'vacancy_gap_days, and over_budget_pct (when a budget is given). Units slightly over budget are INCLUDED and ' +
        'flagged so you can offer them with a note. ' +
        'IMPORTANT: before searching, make sure you have the prospect’s move-in date and budget — if either is missing, ' +
        'ask for it first (one question at a time). Pass move_in_date as YYYY-MM-DD; omit only if truly unknown. ' +
        'Each result includes a listing_url — INCLUDE that link so the prospect can see photos.',
      parameters: {
        type: 'object',
        properties: {
          beds: { type: 'integer', description: 'Exact number of BEDROOMS (not occupancy). Pass 0 for a studio. "For 2 people / 2 guests / a couple" is OCCUPANCY — do NOT set beds for that; only set beds when the prospect explicitly asks for N bedrooms / NBR / N rooms.' },
          baths: { type: 'integer', description: 'Exact number of bathrooms (optional).' },
          budget: { type: 'number', description: "The prospect's target monthly rent. Units up to ~15% over are included and flagged via over_budget_pct. Prefer this over max_price." },
          max_price: { type: 'number', description: 'Hard maximum monthly rent — use only if the prospect insists on a strict cap. Prefer `budget`.' },
          min_price: { type: 'number', description: 'Minimum monthly rent (rarely useful).' },
          city: { type: 'string', description: 'Region: "Hong Kong Island", "Kowloon", "New Territories". Comma-separate for multiple.' },
          district: { type: 'string', description: 'Neighbourhood: "Causeway Bay", "Tsim Sha Tsui", "Mong Kok". Comma-separate for multiple.' },
          amenities: { type: 'string', description: 'Comma-separated must-have amenities (e.g. "Gym, Parking"). ALL are required.' },
          property_id: { type: 'string', description: 'If the prospect named a specific property, its id.' },
          area_flexible: { type: 'boolean', description: 'Set true ONLY if the prospect explicitly says they are open / flexible on location — this satisfies the area requirement.' },
          budget_flexible: { type: 'boolean', description: 'Set true ONLY if the prospect explicitly says they have no fixed budget / are flexible on price (or asked you to "just show what you have") — this satisfies the budget requirement.' },
          move_in_date: { type: 'string', description: 'Target move-in date YYYY-MM-DD. Drives the timing-fit ranking. Omit to use today.' },
          move_out_date: { type: 'string', description: 'Intended move-out date YYYY-MM-DD (end of the reservation). Optional; sets reservation length.' },
          stay_months: { type: 'integer', description: 'Reservation length in months (alternative to move_out_date — e.g. "6 months" => 6). Used with move_in_date to derive the reservation length, which sets the acceptable vacancy gap (see lease_duration_days + forward_gap_days in results).' },
          limit: { type: 'integer', description: 'Maximum number of units to return (default 10, max 25).' },
        },
      },
    },
  },
  cap: 'can_search',
  async execute(ctx, args) {
    const { pool } = ctx;
    const limit = clampLimit(args.limit, 10, 25);

    let moveIn = new Date().toISOString().split('T')[0];
    const dateArg = args.move_in_date || args.available_on; // accept the legacy arg name too
    if (dateArg) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateArg))) {
        return { error: 'move_in_date must be formatted as YYYY-MM-DD' };
      }
      moveIn = String(dateArg);
    }

    // Reservation length (optional): explicit move_out_date, or derived from
    // stay_months. Drives lease_duration_days, which the gap-tolerance policy
    // pairs with forward_gap_days to pick the acceptable vacancy band.
    let moveOut = null;
    if (args.move_out_date && /^\d{4}-\d{2}-\d{2}$/.test(String(args.move_out_date))) {
      moveOut = String(args.move_out_date);
    } else if (Number.isFinite(Number(args.stay_months)) && Number(args.stay_months) > 0) {
      const d = new Date(moveIn);
      d.setMonth(d.getMonth() + Math.round(Number(args.stay_months)));
      moveOut = d.toISOString().split('T')[0];
    }

    const budget = args.budget != null ? Number(args.budget) : null;

    // ── "Qualify before showing" gate (Option B: gate the DATA, not just the
    //    prompt) ────────────────────────────────────────────────────────────
    // Return NO units until we know the prospect's move-in date, area, and
    // budget. A named property (property_id) short-circuits — its area & rent
    // are inferable, so only the move-in date is required. Because the tool
    // hands back zero units when unqualified, the model physically cannot dump
    // listings before qualifying.
    const hasDate = !!dateArg;
    const hasBudget = budget != null || args.max_price != null || !!args.budget_flexible;
    const hasArea = !!(args.property_id || args.city || args.district || args.area_flexible);
    if (args.property_id) {
      if (!hasDate) {
        return {
          needs_qualification: true, missing: ['move_in_date'], units: [],
          instruction: 'The prospect named a specific property/unit. Confirm its area and approximate rent back to them, then ask ONLY for their move-in date before showing availability or alternatives. Do not present units yet.',
        };
      }
    } else if (!(hasDate && hasBudget && hasArea)) {
      const missing = [];
      if (!hasDate) missing.push('move_in_date');
      if (!hasArea) missing.push('area');
      if (!hasBudget) missing.push('budget');
      return {
        needs_qualification: true, missing, units: [],
        instruction: `Before showing ANY units, ask the prospect for the missing detail(s): ${missing.join(', ')}. Ask ONE short question per message. Do not present or invent units until you have move-in date, area, and budget (or the prospect explicitly says they are flexible on area). If they named a unit, resolve it first with resolve_unit and confirm the inferred area + rent.`,
      };
    }
    // Shared engine — same ranking/enrichment the public API (TaneChat) uses.
    // budget => soft 15% ceiling (over-budget units flagged); max_price => hard cap.
    const { results, total } = await searchUnits(pool, {
      orgId: ctx.orgId,
      moveIn,
      moveOut,
      bedrooms: args.beds != null ? Number(args.beds) : null,
      bathrooms: args.baths != null ? Number(args.baths) : null,
      maxPrice: args.max_price != null ? Number(args.max_price) : (budget != null ? budget : null),
      budgetMarginPct: args.max_price != null ? 0 : 0.15,
      minPrice: args.min_price != null ? Number(args.min_price) : null,
      budget,
      propertyId: args.property_id || null,
      cityNames: String(args.city || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
      districtNames: String(args.district || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
      amenityNames: String(args.amenities || '').split(',').map(s => s.trim()).filter(Boolean),
      sortBy: 'vacancy_gap',
      limit,
    });

    // Booking tokens (can_book) + property-level listing_url fallback for the
    // returned units. Kept here so the shared engine stays generic.
    const unitIds = results.map(r => r.unit_id);
    const tokenByUnit = new Map();
    const propUrlById = new Map();
    if (unitIds.length) {
      const uph = unitIds.map(() => '?').join(',');
      const [tokRows] = await pool.execute(
        `SELECT vl.unit_id, vl.token FROM viewing_link vl
         WHERE vl.unit_id IN (${uph}) AND vl.status = 1 AND vl.employee_id IS NOT NULL`,
        unitIds
      );
      for (const t of tokRows) {
        if (!tokenByUnit.has(String(t.unit_id))) tokenByUnit.set(String(t.unit_id), t.token);
      }
      const propIds = [...new Set(results.map(r => r.property_id))];
      const pph = propIds.map(() => '?').join(',');
      const [propRows] = await pool.execute(
        `SELECT id, listing_url FROM property WHERE id IN (${pph})`,
        propIds
      );
      for (const p of propRows) propUrlById.set(String(p.id), p.listing_url);
    }

    return {
      count: results.length,
      total_matches: total,
      move_in_date: moveIn,
      // Units are pre-sorted by timing fit (best first).
      units: results.map(r => ({
        unit_id: r.unit_id,
        unit_name: r.unit_name,
        is_studio: r.bedrooms === 0,
        beds: r.bedrooms,
        baths: r.bathrooms,
        size: r.size,
        size_unit: r.size_unit,
        monthly_rent: r.monthly_rent,
        currency: r.currency || 'HKD',
        over_budget_pct: r.over_budget_pct, // >0 = over the stated budget (flag it); null = no budget given
        available_from: r.available_from,
        days_until_available: r.days_until_available, // <=0 vacant now; >0 = wait this many days
        vacancy_gap_days: r.vacancy_gap_days,        // historical (since last move-out)
        forward_gap_days: r.forward_gap_days,        // empty days from TODAY until move-in
        lease_duration_days: r.lease_duration_days,  // reservation length (when move_out/stay_months given)
        gap_band_days: r.gap_band_days,              // max tolerated gap for this reservation length (null if length unknown)
        gap_within_tolerance: r.gap_within_tolerance, // true=offer freely; false=offer only if nothing better; null=ask for stay length
        needs_manager_approval: r.needs_manager_approval, // 12-month+ → don't confirm, route to the team
        amenities: r.amenities,
        listing_url: r.listing_url || propUrlById.get(r.property_id) || null,
        property: {
          id: r.property_id,
          name: r.property_name,
          address: r.full_address || r.street_address,
          city: r.city,
          district: r.district,
        },
        can_book: Boolean(tokenByUnit.get(r.unit_id)),
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
// Tool: resolve_unit  (named-unit short-circuit for "qualify before showing")
// ---------------------------------------------------------------------------

const resolve_unit = {
  definition: {
    type: 'function',
    function: {
      name: 'resolve_unit',
      description:
        'Resolve a prospect\'s free-text reference to a specific unit when they NAME one — by property name, ' +
        'street address, district/area, or unit identifier (e.g. "Bonham Strand West Studio D", "7D at Pearl City", ' +
        '"the Mong Kok studio"). Tolerates partial wording and typos. Returns the matched unit with its area ' +
        '(district/city) and approximate rent so you can INFER area + budget and then only need to ask the move-in ' +
        'date. Returns candidates or no_match when the reference is weak/ambiguous — do NOT guess; ask the prospect ' +
        'to clarify. Call this FIRST whenever the prospect names a unit/property, before search_available_units.',
      parameters: {
        type: 'object',
        properties: {
          reference: { type: 'string', description: 'The prospect\'s words referring to the unit/property (the unit reference, not their whole sentence).' },
        },
        required: ['reference'],
      },
    },
  },
  cap: 'can_search',
  async execute(ctx, args) {
    const { pool } = ctx;
    const ref = String(args.reference || '').toLowerCase().trim();
    if (ref.length < 2) return { error: 'reference is required' };
    const tokens = [...new Set(ref.split(/[^a-z0-9]+/).filter(t => t.length >= 2))].slice(0, 10);
    if (!tokens.length) return { no_match: true, reason: 'reference too vague' };

    const [rows] = await pool.execute(
      `SELECT u.id AS unit_id, u.name AS unit_name, u.type AS unit_type, u.beds, u.baths,
              u.rent_price_min, u.rent_price_max,
              p.id AS property_id, p.display_name AS property_name,
              p.street_address, p.city, p.district, p.currency
       FROM unit u JOIN property p ON u.property_id = p.id
       WHERE p.org_id = ? AND p.status = 1 AND p.deleted_at IS NULL
         AND u.active_status = 1 AND u.deleted_at IS NULL`,
      [ctx.orgId]
    );

    const scored = rows.map(r => {
      const words = [r.property_name, r.street_address, r.district, r.city, r.unit_name, r.unit_type]
        .map(s => String(s || '').toLowerCase());
      const hay = words.join(' ');
      const hayWords = hay.split(/[^a-z0-9]+/).filter(Boolean);
      let score = 0;
      for (const t of tokens) {
        if (hay.includes(t)) score += 2;                                   // exact token present
        else if (hayWords.some(w => w.length >= 4 && (w.includes(t) || t.includes(w)))) score += 1; // fuzzy/partial
      }
      return { r, score };
    }).filter(s => s.score > 0).sort((a, b) => b.score - a.score);

    if (!scored.length) return { no_match: true };

    const fmt = (s) => ({
      unit_id: str(s.r.unit_id),
      unit_name: s.r.unit_name,
      property_id: str(s.r.property_id),
      property_name: s.r.property_name,
      area: s.r.district || s.r.city || null,
      district: s.r.district,
      city: s.r.city,
      address: s.r.street_address,
      approx_rent: s.r.rent_price_min != null ? Number(s.r.rent_price_min)
        : (s.r.rent_price_max != null ? Number(s.r.rent_price_max) : null),
      currency: s.r.currency || 'HKD',
      beds: s.r.beds,
      is_studio: s.r.beds === 0,
    });

    const top = scored[0];
    const second = scored[1];
    // Confident single match: a clear leader, well ahead of any runner-up.
    if (top.score >= 4 && (!second || top.score - second.score >= 2)) {
      return { matched: fmt(top), confidence: 'high' };
    }
    // Otherwise hand back candidates — never guess on weak/ambiguous signal.
    return {
      candidates: scored.slice(0, 3).map(fmt),
      note: 'Ambiguous reference — ask the prospect to confirm which one. Do NOT assume.',
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

// ---------------------------------------------------------------------------
// Tool: search_vacancies  (INTERNAL ONLY — staff data query, no prospect gate)
// ---------------------------------------------------------------------------
const search_vacancies = {
  cap: null, // internal-only; excluded from the prospect toolset via INTERNAL_ONLY
  definition: {
    type: 'function',
    function: {
      name: 'search_vacancies',
      description:
        'INTERNAL vacancy report (staff only, NO prospect qualification). Returns two lists: ' +
        'vacant_now (units with no active lease as of the reference date) and upcoming_vacant ' +
        '(units whose current lease ends within the horizon AND no new tenant moves in within ' +
        'min_gap_days of the last tenant leaving — i.e. a real gap). Use for "what is vacant now", ' +
        '"upcoming vacancies", "units with no one moving in within N days of the last tenant".',
      parameters: {
        type: 'object',
        properties: {
          as_of:        { type: 'string',  description: 'Reference date YYYY-MM-DD. Default: today.' },
          horizon_days: { type: 'integer', description: 'Look-ahead window for upcoming vacancies (days). Default 60.' },
          min_gap_days: { type: 'integer', description: 'For upcoming_vacant only: include a unit if its next tenant moves in at least N days after the last tenant leaves (or never). Default 15.' },
          property_id:  { type: 'string',  description: 'Restrict to one property id.' },
          limit:        { type: 'integer', description: 'Max units scanned. Default 500, max 1000.' },
        },
      },
    },
  },
  async execute(ctx, args) {
    const orgId = ctx.orgId;
    const asOf = /^\d{4}-\d{2}-\d{2}$/.test(String(args.as_of || '')) ? args.as_of : new Date().toISOString().split('T')[0];
    const horizon = clampLimit(args.horizon_days, 60, 3650);
    const minGap = Number.isInteger(args.min_gap_days) ? args.min_gap_days : 15;
    const limit = clampLimit(args.limit, 500, 1000);

    let where = 'p.org_id = ? AND p.status = 1 AND p.deleted_at IS NULL AND u.active_status = 1 AND u.deleted_at IS NULL';
    const params = [asOf, asOf, asOf, orgId];
    if (args.property_id) { where += ' AND p.id = ?'; params.push(str(args.property_id)); }

    const [rows] = await ctx.pool.execute(
      `SELECT u.id AS unit_id, u.name AS unit_name,
              p.display_name AS property_name, p.street_address, p.district, p.city,
              cur.id AS cur_lease_id, cur.end_date AS cur_end_date,
              nxt.start_date AS next_start_date
         FROM unit u
         JOIN property p ON u.property_id = p.id
         LEFT JOIN leasing cur
           ON cur.unit_id = u.id AND cur.deleted_at IS NULL
           AND cur.start_date <= ? AND (cur.end_date >= ? OR cur.end_date IS NULL)
         LEFT JOIN (
           SELECT unit_id, MIN(start_date) AS start_date FROM leasing
           WHERE deleted_at IS NULL AND start_date > ? GROUP BY unit_id
         ) nxt ON nxt.unit_id = u.id
        WHERE ${where}
        LIMIT ${limit}`,
      params
    );

    const d = (v) => (v ? String(v).slice(0, 10) : null);
    const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);
    const horizonEnd = d(new Date(new Date(asOf).getTime() + horizon * 86400000).toISOString());

    const vacant_now = [];
    const upcoming_vacant = [];
    const seen = new Set();
    for (const r of rows) {
      const uid = String(r.unit_id);
      if (seen.has(uid)) continue; // dedupe if >1 lease matched the "covering" join
      seen.add(uid);
      const base = {
        unit_id: uid, unit: r.unit_name, property: r.property_name,
        address: [r.street_address, r.district, r.city].filter(Boolean).join(', '),
        next_tenant_moves_in: d(r.next_start_date),
      };
      if (!r.cur_lease_id) {
        const gap = r.next_start_date ? daysBetween(asOf, r.next_start_date) : null;
        vacant_now.push({ ...base, gap_days_until_next: gap });
        continue;
      }
      const endStr = d(r.cur_end_date);
      if (endStr && endStr >= asOf && endStr <= horizonEnd) {
        const gap = r.next_start_date ? daysBetween(endStr, r.next_start_date) : null;
        if (gap == null || gap >= minGap) {
          upcoming_vacant.push({ ...base, becomes_vacant_on: endStr, gap_days_until_next: gap });
        }
      }
    }
    return {
      as_of: asOf, horizon_days: horizon, min_gap_days: minGap,
      vacant_now_count: vacant_now.length, upcoming_vacant_count: upcoming_vacant.length,
      vacant_now, upcoming_vacant,
    };
  },
};

// ---------------------------------------------------------------------------
// Tool: search_chats  (INTERNAL ONLY — search conversation transcripts)
//
// Searches chat_message.content across every logged conversation: TaneChat's
// WhatsApp/email prospect chats (mirrored into Tenafy via /api/public/chat/log)
// and the in-Tenafy staff assistants. Queries the DB directly, so it is NOT
// subject to the Sessions History page's 200-row display cap.
//
// Only 'user'/'assistant' turns are searched — 'system' rows hold the seeded
// system prompt (huge, and would leak the prompt) and 'tool' rows are raw JSON.
// ---------------------------------------------------------------------------
const CHAT_SOURCE_CHANNELS = {
  tenafy: ['staff-test', 'staff-internal'],
  tanechat: ['whatsapp', 'email', 'web'],
};

const search_chats = {
  cap: null, // internal-only
  definition: {
    type: 'function',
    function: {
      name: 'search_chats',
      description:
        'INTERNAL search of conversation transcripts (staff only). Finds what was actually SAID in ' +
        'WhatsApp/email prospect chats (logged from TaneChat) and the in-Tenafy assistants. ' +
        'Use for "find chats mentioning X", "what did <person> say about Y", "who asked about <unit>". ' +
        'Returns matching message snippets with the prospect, channel, date and session id. ' +
        'For the extracted prospect summary (name/budget/move-in) use search_inquiries instead.',
      parameters: {
        type: 'object',
        properties: {
          keyword:  { type: 'string',  description: 'Text to find inside message content (e.g. "Hollywood 3A", "deposit", "parking").' },
          prospect: { type: 'string',  description: 'Filter by who the conversation is with — matches viewer name, email, phone, or channel user id.' },
          source:   { type: 'string',  description: "'tanechat' (WhatsApp/email/web prospect chats) or 'tenafy' (the staff assistants). Default: both." },
          channel:  { type: 'string',  description: "Exact channel: whatsapp | email | web | staff-test | staff-internal. Overrides `source`." },
          since:    { type: 'string',  description: 'Only messages on/after this date (YYYY-MM-DD).' },
          until:    { type: 'string',  description: 'Only messages on/before this date (YYYY-MM-DD).' },
          limit:    { type: 'integer', description: 'Max messages. Default 25, max 100.' },
        },
      },
    },
  },
  async execute(ctx, args) {
    const limit = clampLimit(args.limit, 25, 100);
    let where = "m.role IN ('user','assistant') AND m.content IS NOT NULL AND m.content <> ''";
    const params = [];

    if (args.keyword) {
      where += ' AND m.content LIKE ?';
      params.push('%' + String(args.keyword).trim() + '%');
    }
    if (args.prospect) {
      const s = '%' + String(args.prospect).trim() + '%';
      where += ` AND (s.viewer_name LIKE ? OR s.viewer_email LIKE ? OR s.viewer_phone LIKE ?
                      OR s.channel_user_id LIKE ?)`;
      params.push(s, s, s, s);
    }
    if (args.channel) {
      where += ' AND s.channel = ?';
      params.push(String(args.channel).trim());
    } else if (args.source) {
      const chans = CHAT_SOURCE_CHANNELS[String(args.source).trim().toLowerCase()];
      if (chans) {
        where += ` AND s.channel IN (${chans.map(() => '?').join(',')})`;
        params.push(...chans);
      }
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(args.since || ''))) {
      where += ' AND m.created_at >= ?'; params.push(args.since + ' 00:00:00');
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(args.until || ''))) {
      where += ' AND m.created_at <= ?'; params.push(args.until + ' 23:59:59');
    }

    const [rows] = await ctx.pool.execute(
      `SELECT m.id, m.session_id, m.role, m.content, m.created_at,
              s.channel, s.viewer_name, s.viewer_email, s.viewer_phone, s.channel_user_id
         FROM chat_message m
         JOIN chat_session s ON s.id = m.session_id
        WHERE ${where}
        ORDER BY m.created_at DESC
        LIMIT ${limit}`,
      params
    );

    // Content is LONGTEXT — return a window around the match rather than the
    // whole message, so a few hits can't blow up the model's context.
    const snippet = (text, kw) => {
      const t = String(text).replace(/\s+/g, ' ').trim();
      if (!kw) return t.length > 300 ? t.slice(0, 300) + '…' : t;
      const i = t.toLowerCase().indexOf(String(kw).toLowerCase());
      if (i < 0) return t.length > 300 ? t.slice(0, 300) + '…' : t;
      const start = Math.max(0, i - 120);
      const end = Math.min(t.length, i + String(kw).length + 180);
      return (start > 0 ? '…' : '') + t.slice(start, end) + (end < t.length ? '…' : '');
    };

    return {
      count: rows.length,
      limit,
      messages: rows.map(r => ({
        session_id: String(r.session_id),
        source: CHAT_SOURCE_CHANNELS.tenafy.includes(r.channel) ? 'tenafy' : 'tanechat',
        channel: r.channel,
        prospect: r.viewer_name || r.viewer_email || r.viewer_phone || r.channel_user_id,
        who: r.role === 'user' ? 'prospect' : 'assistant',
        said: snippet(r.content, args.keyword),
        at: r.created_at,
      })),
    };
  },
};

// ---------------------------------------------------------------------------
// Tool: search_whatsapp  (INTERNAL ONLY — live TaneChat PII search)
// ---------------------------------------------------------------------------
const search_whatsapp = {
  cap: null, // internal-only; excluded from the prospect toolset via INTERNAL_ONLY
  definition: {
    type: 'function',
    function: {
      name: 'search_whatsapp',
      description:
        'INTERNAL live search of TaneChat WhatsApp/email history (staff only). This queries the LIVE ' +
        'TaneChat integration API, not the local Tenafy chat-session mirror used by search_chats. ' +
        'Use for "who paid this amount", matching bank-statement amounts to WhatsApp/email messages, ' +
        'or finding exact live message text with deep links back to TaneChat. ' +
        'REQUIRES a content filter — amount, amount_min/amount_max, or q. phone/from/to/direction only ' +
        'narrow the search and cannot be used alone. Amount search is tuned for recall and only matches ' +
        'amounts written literally in the text, so expect incidental hits: rank them by how close the ' +
        'message date is to the payment date (±14 days is high-signal) and cite the deep_link.',
      parameters: {
        type: 'object',
        properties: {
          amount:     { type: 'number',  description: 'Exact amount to search for, e.g. 13800 or 13800.50.' },
          amount_min: { type: 'number',  description: 'Inclusive minimum amount for range searches.' },
          amount_max: { type: 'number',  description: 'Inclusive maximum amount for range searches.' },
          q:          { type: 'string',  description: 'Case-insensitive substring to find in the message body.' },
          from:       { type: 'string',  description: 'Message timestamp lower bound: YYYY-MM-DD or ISO-8601.' },
          to:         { type: 'string',  description: 'Message timestamp upper bound: YYYY-MM-DD (whole day) or ISO-8601.' },
          phone:      { type: 'string',  description: 'Narrow to one contact phone, e.g. +85290001234 or 85290001234.' },
          direction:  { type: 'string',  description: 'Message direction: inbound or outbound.' },
          limit:      { type: 'integer', description: 'Max messages. Default 25, max 100.' },
        },
      },
    },
  },
  async execute(ctx, args = {}) {
    const has = (v) => v != null && String(v).trim() !== '';
    // TaneChat requires a CONTENT filter (amount / amount range / q). `phone`,
    // `from`, `to` and `direction` only narrow a search — on their own the API
    // answers 400. Reject here with actionable guidance instead of spending a
    // call (and a tool-loop iteration) on a known-bad request.
    if (![args.amount, args.amount_min, args.amount_max, args.q].some(has)) {
      return {
        error: has(args.phone)
          ? 'A phone number alone is not a searchable filter. Add a content filter: amount (e.g. 13800) ' +
            'or q (e.g. "transferred", "paid").'
          : 'Provide at least one search filter: amount, amount_min, amount_max, or q.',
      };
    }
    if (!taneChatClient.isConfigured()) {
      return {
        error: 'TaneChat search is not configured. Set TANECHAT_API_KEY to enable live WhatsApp/email search.',
      };
    }

    const limit = clampLimit(args.limit, 25, 100);
    const requested = {
      amount: args.amount,
      amount_min: args.amount_min,
      amount_max: args.amount_max,
      q: args.q,
      from: args.from,
      to: args.to,
      phone: args.phone,
      direction: args.direction,
      limit,
    };

    const truncate = (value) => {
      const text = String(value || '').replace(/\s+/g, ' ').trim();
      return text.length > 400 ? text.slice(0, 400) + '…' : text;
    };
    const coverageStart = '2026-03-01';
    const fromDate = has(args.from) ? String(args.from).slice(0, 10) : null;

    try {
      const resp = await taneChatClient.searchMessages(requested);
      const rows = Array.isArray(resp.results) ? resp.results : [];
      return {
        count: rows.length,
        results: rows.map(r => ({
          message_id: r.message_id,
          conversation_id: r.conversation_id,
          timestamp: r.timestamp,
          direction: r.direction,
          content: truncate(r.content),
          contact: r.contact ? {
            name: r.contact.name || null,
            phone: r.contact.phone || null,
            channel: r.contact.channel || null,
          } : null,
          deep_link: r.deep_link || null,
          context: Array.isArray(r.context) ? r.context.map(c => ({
            timestamp: c.timestamp,
            direction: c.direction,
            content: truncate(c.content),
          })) : [],
        })),
        note: fromDate && fromDate < coverageStart
          ? 'Searchable TaneChat history starts around 2026-03-01; older matching messages may not be available.'
          : null,
      };
    } catch (e) {
      return { error: e.message };
    }
  },
};

// ---------------------------------------------------------------------------
// Tool: trace_amount  (INTERNAL ONLY — reconciliation lead finder)
// ---------------------------------------------------------------------------
const trace_amount = {
  cap: null, // internal-only; excluded from the prospect toolset via INTERNAL_ONLY
  definition: {
    type: 'function',
    function: {
      name: 'trace_amount',
      description:
        'INTERNAL bank-line reconciliation helper (staff only). Given Xero bank statement lines ' +
        '(amount + date + Received/Spent), searches open invoices, leases, accounting history, and ' +
        'live TaneChat WhatsApp/email messages to identify likely leads. IMPORTANT: when the user ' +
        'pastes multiple statement lines or a screenshot, pass ALL parsed rows in ONE call to avoid ' +
        'spending the tool budget one row at a time.',
      parameters: {
        type: 'object',
        properties: {
          rows: {
            type: 'array',
            description: 'All parsed bank lines in one call. Each row is { amount, date, direction }. Use direction "received" for Xero Received and "spent" for Xero Spent.',
            items: {
              type: 'object',
              properties: {
                amount:    { type: 'number', description: 'Bank line amount.' },
                date:      { type: 'string', description: 'Bank line date YYYY-MM-DD.' },
                direction: { type: 'string', enum: ['received', 'spent'], description: 'Xero column: received or spent.' },
              },
              required: ['amount'],
            },
          },
          amount: { type: 'number', description: 'Single-line shortcut amount.' },
          date: { type: 'string', description: 'Single-line shortcut date YYYY-MM-DD.' },
          direction: { type: 'string', enum: ['received', 'spent'], description: 'Single-line shortcut direction.' },
          chat_window_days: { type: 'integer', description: 'WhatsApp search window around the bank date. Default 14.' },
          invoice_date_tolerance_days: { type: 'integer', description: 'Invoice date scoring tolerance. Default 30.' },
        },
      },
    },
  },
  async execute(ctx, args = {}) {
    const rows = Array.isArray(args.rows) ? args.rows : {
      amount: args.amount,
      date: args.date,
      direction: args.direction,
    };
    const result = await traceAmounts(
      { pool: ctx.pool, orgId: ctx.orgId, taneChat: taneChatClient },
      rows,
      {
        chatWindowDays: clampLimit(args.chat_window_days, 14, 90),
        invoiceDateToleranceDays: clampLimit(args.invoice_date_tolerance_days, 30, 365),
        perSourceLimit: 5,
      }
    );

    const notes = [];
    if (result.truncated) notes.push('Only the first 10 valid rows were processed; pass fewer rows for a focused trace.');
    if (result.rows.some(r => r.input.date && r.input.date < '2026-03-01')) {
      notes.push('Searchable TaneChat history starts around 2026-03-01; older matching messages may not be available.');
    }
    if (result.rows.some(r => r.whatsapp && r.whatsapp.available === false)) {
      notes.push('TaneChat search is not configured, so WhatsApp/email history was unavailable.');
    }

    return {
      rows: result.rows,
      note: notes.length ? notes.join(' ') : null,
    };
  },
};

// ---------------------------------------------------------------------------
// Tool: ask_data  (INTERNAL ONLY — read-only NL->SQL escape hatch)
// ---------------------------------------------------------------------------
const ask_data = {
  cap: null, // internal-only; excluded from the prospect toolset via INTERNAL_ONLY
  definition: {
    type: 'function',
    function: {
      name: 'ask_data',
      description:
        'INTERNAL read-only SQL against this organization\'s database, for questions the structured ' +
        'tools do not cover — aggregations, counts, sums, ad-hoc joins (e.g. "total rent collected in ' +
        'June", "how many leases expire in Q3", "average rent by district"). Provide ONE MySQL SELECT. ' +
        'Strictly read-only: writes/DDL are rejected and the connection has SELECT-only rights. ' +
        'Results are capped at 500 rows. PREFER the structured tools when they already answer the question.',
      parameters: {
        type: 'object',
        properties: {
          sql: {
            type: 'string',
            description: 'A single MySQL SELECT (or WITH ... SELECT). No semicolon chaining, no writes, no system schemas.',
          },
          purpose: {
            type: 'string',
            description: 'One short line on what this query answers (shown to staff for transparency).',
          },
        },
        required: ['sql'],
      },
    },
  },
  async execute(ctx, args) {
    const check = validateSelect(args.sql);
    if (!check.ok) return { error: `Query rejected: ${check.reason}`, sql: args.sql };
    try {
      const result = await runReadOnly(ctx.roPool, check.sql);
      return { ...result, purpose: args.purpose || null };
    } catch (e) {
      // Surface the DB error so the model can correct its SQL and retry.
      return { error: e.message, sql: check.sql };
    }
  },
};

const ALL_TOOLS = [
  search_available_units,
  resolve_unit,
  get_unit_details,
  list_properties,
  capture_lead,
  request_viewing,
  search_inquiries,
  search_leases,
  search_invoices,
  search_services,
  search_documents,
  search_vacancies,
  search_chats,
  search_whatsapp,
  trace_amount,
  ask_data,
];

const ALL_BY_NAME = Object.fromEntries(
  ALL_TOOLS.map(t => [t.definition.function.name, t])
);

// Tools that must NEVER reach the prospect-facing bot, even if their `cap` is
// unset. The internal endpoint assembles these explicitly via toolsForInternal().
const INTERNAL_ONLY = new Set(['search_vacancies', 'search_chats', 'search_whatsapp', 'trace_amount', 'ask_data']);

/**
 * Return tool definitions + executor map filtered by the org's capabilities.
 * INTERNAL_ONLY tools are always excluded here — this is the PROSPECT toolset.
 * @param {object} capabilities  e.g. { can_search: true, can_book_viewings: false, ... }
 */
function toolsForCapabilities(capabilities) {
  const caps = capabilities || {};
  const allowed = ALL_TOOLS.filter(t =>
    !INTERNAL_ONLY.has(t.definition.function.name) && (!t.cap || caps[t.cap] !== false));
  return {
    definitions: allowed.map(t => t.definition),
    byName: Object.fromEntries(allowed.map(t => [t.definition.function.name, t])),
  };
}

// Fixed internal toolset for Chat: Internal (staff-only). Assembled in code, NOT
// from bot_settings — so the PII tools + vacancy + ask_data can never leak to the
// prospect bot. `extra` lets the internal endpoint add ask_data (Phase 3).
const INTERNAL_TOOL_NAMES = [
  'search_leases', 'search_invoices', 'search_services',
  'search_documents', 'search_inquiries', 'search_vacancies', 'search_chats', 'search_whatsapp', 'trace_amount',
];
function toolsForInternal(extra = []) {
  const base = INTERNAL_TOOL_NAMES.map(n => ALL_BY_NAME[n]).filter(Boolean);
  const all = [...base, ...extra];
  return {
    definitions: all.map(t => t.definition),
    byName: Object.fromEntries(all.map(t => [t.definition.function.name, t])),
  };
}

// Curated schema summary for ask_data. Deliberately an ALLOWLIST — only tables/
// columns staff legitimately query. Credentials, tokens and auth tables are
// omitted on purpose (and the read-only user + SQL guard back this up).
const ASK_DATA_SCHEMA = [
  'When using ask_data, the connection is already scoped to THIS organization\'s database, so do not filter by org except where noted. Available tables/columns:',
  '  property(id, display_name, street_address, district, city, state, country, zip_code, type, status, currency, org_id)  -- type 1=Residential 2=Commercial; filter status=1 AND deleted_at IS NULL',
  '  unit(id, name, type, property_id, beds, baths, size, status, active_status, rent_price_min, rent_price_max, deposit_price)  -- status 0=vacant 1=occupied; active_status 1=active; filter deleted_at IS NULL',
  '  leasing(id, lease_no, unit_id, tenant_id, start_date, end_date, amount, price, deposit, status, type, contract_type, due_date, invoicing, note)  -- type 0=fixed 1=month-to-month; contract_type 1=MR 2=MTM 3=NR 4=UC; filter deleted_at IS NULL',
  '  tenant(id, first_name, middle_name, last_name, company_name, type, email, phone, status, category)  -- type 0=personal 1=company; category 1=tenant 2=payee; status 0=Pending 1=Active 2=Inactive',
  '  invoice(id, invoice_code, property_id, unit_id, leasing_id, tenant_id, due_on, category, amount, note, type, status)  -- status 0=Open 1=Paid 2=Overdue; type 0=Inflow 1=Outflow; ALWAYS filter deleted_at IS NULL',
  '  accounting(id, type, amount, payment_date, tenant_id, transaction_code, note)  -- type 0=Inflow(CR) 1=Outflow(DR); filter deleted_at IS NULL',
  '  accounting_line(id, accounting_id, invoice_code, amount)  -- links a payment to invoice(s); filter deleted_at IS NULL',
  '  category_setting(id, name)  -- invoice.category is a FK to this',
  '  chat_session(id, channel, channel_user_id, contact_id, viewer_name, viewer_email, viewer_phone, message_count, last_message_at, created_at)  -- channel: whatsapp/email/web = TaneChat prospect chats, staff-test/staff-internal = the in-Tenafy assistants',
  '  chat_message(id, session_id, role, content, created_at)  -- role: user/assistant (also system/tool — exclude those, they are prompts and raw JSON)',
  'Join hints: unit.property_id->property.id; leasing.unit_id->unit.id; leasing.tenant_id->tenant.id; invoice.leasing_id->leasing.id; accounting_line.invoice_code->invoice.invoice_code.',
  'Money is HK$. Dates are DATE/DATETIME — use CURDATE() for "today".',
].join('\n');

const INTERNAL_SYSTEM_PROMPT = [
  'You are the INTERNAL operations assistant for a property-management team using Tenafy.',
  'You are talking to STAFF, not prospects. Answer their data questions directly and completely.',
  'Do NOT use a sales tone. Do NOT ask for a move-in date, area, or budget. There is no qualification gate — just answer.',
  'Prefer the structured tools: search_leases, search_invoices, search_services, search_documents, search_inquiries, search_vacancies (vacant-now + upcoming vacancies), search_chats (local mirrored chat sessions), search_whatsapp (LIVE TaneChat WhatsApp/email search), and trace_amount (reconcile bank-line amounts).',
  'For Xero screenshots or reconciliation requests, first parse each bank line into {amount, date, direction}, echo the parsed rows back for confirmation, and call out Spent vs Received explicitly because OCR can flip columns.',
  'Then call trace_amount ONCE with all parsed rows. For each row, rank leads by returned score and date closeness; always show alternatives, never a lone confident answer, because common HK surnames and identical rents collide.',
  'Cite WhatsApp deep_link values so staff can verify. Treat chat mentions as corroboration, not proof of identity. Nothing is auto-reconciled; this is advice and the human reconciles in Xero.',
  'Use ask_data ONLY when the structured tools cannot answer it — aggregations, sums, counts, ad-hoc joins. It is strictly read-only.',
  'Be precise with numbers, dates (DD-MMM-YYYY), and money (HK$). If a tool returns nothing, say so plainly — never invent rows.',
  'When you list units/leases/invoices, include the identifying details (unit, property, tenant, dates, amounts). Group long lists sensibly.',
  '',
  ASK_DATA_SCHEMA,
].join('\n');

module.exports = {
  toolsForCapabilities, toolsForInternal, INTERNAL_SYSTEM_PROMPT, ALL_BY_NAME,
  ASK_DATA: ask_data,
  INTERNAL_ONLY,
  INTERNAL_TOOL_NAMES,
};
