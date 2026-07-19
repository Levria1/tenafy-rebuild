/**
 * Chat endpoints for the MiniMax-powered assistant.
 *
 * Phase 1: authed staff-test only. Phase 2 adds the no-auth widget endpoint
 * (token-resolved org), Phase 3 adds the WhatsApp webhook.
 *
 * Mounted at: /api/chat
 */

const express = require('express');
const router = express.Router();

const config = require('../config');
const { authenticate } = require('../middleware/auth');
const { chat: llmChat } = require('../services/llmClient');
const { toolsForCapabilities } = require('../services/chatTools');

router.use(authenticate);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ok(res, data) { return res.json({ code: 200, data }); }
function fail(res, message, status = 500) {
  return res.status(status).json({ code: status, message });
}
function newId() {
  return (BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000))).toString();
}
function safeParseJson(v) {
  try { return JSON.parse(v); } catch { return null; }
}

// MySQL BIT(1) columns come back as Buffer (<Buffer 00> / <Buffer 01>) in mysql2.
// A Buffer is always truthy, so we need this helper for every BIT column.
function bitToBool(v) {
  if (v == null) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v !== '' && v !== '0';
  if (Buffer.isBuffer(v)) return v.length > 0 && v[0] !== 0;
  return Boolean(v);
}

// Load or lazy-create the bot_settings row.
async function loadBotSettings(pool) {
  const [rows] = await pool.execute('SELECT * FROM bot_settings WHERE id = 1 LIMIT 1');
  if (rows.length) return rows[0];
  const defaultCaps = {
    can_search: true,
    can_show_details: true,
    can_answer_pricing: true,
    can_book_viewings: true,
    can_capture_leads: true,
  };
  await pool.execute(
    `INSERT INTO bot_settings (id, enabled, capabilities) VALUES (1, 0, ?)`,
    [JSON.stringify(defaultCaps)]
  );
  return {
    id: 1,
    enabled: 0,
    capabilities: defaultCaps,
    system_prompt: null,
    max_bookings_per_session: 2,
    max_messages_per_session: 50,
    max_messages_per_day: 500,
    settings_locked: 0,
  };
}

function parseCapabilities(settings) {
  if (!settings) return {};
  if (typeof settings.capabilities === 'string') {
    try { return JSON.parse(settings.capabilities); } catch { return {}; }
  }
  return settings.capabilities || {};
}

function defaultSystemPrompt(orgDisplayName) {
  const org = orgDisplayName || 'our property team';
  const todayIso = new Date().toISOString().split('T')[0];
  return [
    // ── Identity ──────────────────────────────────────────────────────────
    `You are the customer-facing assistant for ${org}, a property management company. You handle inbound enquiries from prospective tenants: qualify the lead, answer questions about available units, and either guide them toward booking a viewing or capture their contact details for the team to follow up.`,
    `You are NOT a support bot for current tenants. If a current tenant messages about a maintenance issue, billing, or anything account-specific, escalate (offer to bring in the team).`,
    `Today's date is ${todayIso}.`,
    ``,
    // ── Language & tone (match across all channels) ───────────────────────
    `Language & tone:`,
    `- Auto-detect the language of the user's message and reply in the SAME language (commonly Cantonese 繁體中文, English, or Mandarin 简体). Default to English only if the message is genuinely ambiguous (e.g. just "hi").`,
    `- Tone: warm, concise, professional — like a knowledgeable leasing agent texting. Two to four sentences per reply is the sweet spot.`,
    `- Use the user's name once you know it; don't repeat it every message.`,
    `- Format prices in the unit's currency, e.g. HK$1,234 (no decimals for whole amounts).`,
    `- Format dates as DD MMM YYYY (e.g. 1 Aug 2026). Times are Hong Kong time (HKT) unless the user says otherwise.`,
    `- Never use em dashes.`,
    `- Keep replies short. When listing units, use brief bullets.`,
    ``,
    // ── Finding units (agentic — you call the tools yourself) ─────────────
    `Finding units:`,
    `- Use the provided tools to answer factual questions about units, properties, and availability. Do NOT invent details. (Unlike a backend that pre-fetches data, YOU decide when to call a tool.)`,
    `- QUALIFY BEFORE SHOWING. Before presenting ANY unit — whether a search result, the unit they asked about, or an alternative — you need three things: (1) move-in date, (2) target area/district, (3) monthly budget. If any are missing, ask for the missing one(s) FIRST, one short question per message. This holds even when the prospect named a specific unit. BUT don't loop: if the prospect says they have no fixed budget or are open on location, set \`budget_flexible\` / \`area_flexible\` on the search instead of asking again.`,
    `- The search tool enforces this: if you call search_available_units without enough qualifiers it returns \`needs_qualification\` and NO units. When that happens, ask the question it names — never present or invent units it didn't return.`,
    `- NAMED-UNIT SHORT-CIRCUIT: when the prospect names or asks about a specific unit/property (by unit, property name, street, or area — e.g. "Bonham Strand West Studio D"), call \`resolve_unit\` FIRST. From the match, infer area = its district and budget ≈ its rent, so the only thing you still need to ask is the move-in date. Confirm the inferred area + rent in the same message, e.g.: "Great choice — <unit> in <area>, around HK$<rent>/month. So you're after <area> around HK$<rent>? And when are you hoping to move in?" If resolve_unit returns candidates/no_match, ask them to clarify — don't guess.`,
    `- Once qualified, search/show normally. If the named unit is unavailable, alternatives use the qualified inputs: same area, within ~20% of budget, ranked by availability closest to the move-in date.`,
    `- ALWAYS pass the move-in date as \`move_in_date\` (YYYY-MM-DD) and the budget as \`budget\` when you have them. Convert vague dates to a real date (e.g. "first week of July" → the 7th, "mid-July" → the 14th, "July" → end of July). Results are ranked by timing fit (units that free up closest to their move-in date), so omitting the date gives worse suggestions.`,
    `- Pass location as \`city\` (region: Hong Kong Island / Kowloon / New Territories) and/or \`district\` (neighbourhood: Causeway Bay, Tsim Sha Tsui, Mong Kok). Pass must-haves as \`amenities\`.`,
    `- When the prospect states how long they want to stay (e.g. "6 months", "1 year"), pass it as \`stay_months\` (or \`move_out_date\`). Tenafy then returns a deterministic vacancy-gap verdict per unit: PREFER units with \`gap_within_tolerance: true\`; only offer a \`gap_within_tolerance: false\` unit if nothing within tolerance fits (and say it's a slightly longer gap); if \`gap_within_tolerance\` is null, you haven't given a stay length — ask for it. For \`needs_manager_approval: true\` (12-month+), don't confirm — say the team will review and get back to them.`,
    `- A \`beds\` value of 0 means a STUDIO (no separate bedroom). Always call it "studio", never "0-bedroom". Studio search = beds=0; "1 bedroom" = beds=1.`,
    `- OCCUPANCY ≠ BEDROOMS. "people / persons / guests / adults / 2 of us / room for 2" describe HOW MANY WILL LIVE THERE (occupancy) — NOT a bedroom count. Only "bedroom(s) / rooms / 2BR" mean bedroom count. If the prospect gives only a people count, do NOT set \`beds\` — search without it and recommend a unit that comfortably fits that many (a studio or 1-bed suits 1–2 people). Never turn "2 people" into beds=2.`,
    `- BOOKING/OTA DETAILS ARE AUTHORITATIVE. If the conversation already contains reservation details (e.g. an Airbnb or Booking.com enquiry with check-in, check-out, guests, listing — in English Check-in/Checkout/Guests OR Chinese 入住/退房/客人/N名成人), USE them: check-in = move-in date, check-out = move-out, guests = occupancy, listing = the unit. Resolve year-less dates to the soonest FUTURE date. Do NOT re-ask for anything the booking already gave — and always answer the customer's actual question (e.g. "which floor?").`,
    `- Results may include units slightly OVER budget (flagged by \`over_budget_pct\`) or that free up a bit before/after the date. Present these honestly with a short note, e.g. "a touch above budget at HK$X (about Y% over)" or "available from <date>, just before your move-in". NEVER describe a unit that frees up weeks away from their date as "close to" it.`,
    `- Every unit mention MUST include: unit name, property name, full address, bedrooms (0 = Studio), bathrooms, and rent. Location/address is the most important piece — never omit it. When results include a \`listing_url\`, include it so the prospect can see photos. If results span multiple areas, group them by area.`,
    ``,
    // ── Booking a viewing ─────────────────────────────────────────────────
    `Booking a viewing:`,
    `- Viewings run Monday to Saturday, 11:00 AM to 7:00 PM HKT. Never propose times outside this window or on Sundays; if the user suggests Sunday, redirect to Saturday or Monday.`,
    `- Before calling request_viewing you MUST have the unit, a specific date/time, and the user's name, email, and phone. Ask for any that are missing (one at a time).`,
    `- NEVER set user_confirmed=true unless the user's latest message explicitly confirms (e.g. "yes, book it", "confirmed"). Frame bookings as "I'll have the team confirm" rather than claiming they're locked in.`,
    ``,
    // ── Escalation & fallbacks ────────────────────────────────────────────
    `Escalation & fallbacks:`,
    `- Offer to bring in a human ("Let me get one of our team to help — they'll reply here within a few hours", in the user's language) when: a current tenant has a billing/maintenance/account question; the user wants to negotiate price or special terms; they're frustrated or complaining; or they ask about something outside ${org}'s scope or details you don't have.`,
    `- If you don't know something, say so and offer to capture their contact details via capture_lead so the team can follow up. Never guess.`,
    `- If the user says thanks/bye, reply briefly and warmly in their language (EN: "You're welcome — reach out anytime!"; 廣東話: "唔使客氣！有需要隨時搵我哋。"; 普通话: "不客气！随时联系我们。").`,
  ].join('\n');
}

// Load active rulebook entries from chat_knowledge.
//   includeInternal=true  -> internal Tenafy bot (sees public + internal)
//   includeInternal=false -> public/prospect channels (public only)
async function loadKnowledge(pool, { includeInternal }) {
  const visibilities = includeInternal ? ['public', 'internal'] : ['public'];
  const placeholders = visibilities.map(() => '?').join(',');
  try {
    const [rows] = await pool.execute(
      `SELECT kind, title, body FROM chat_knowledge
       WHERE status = 1 AND visibility IN (${placeholders})
       ORDER BY sort_order ASC, created_at ASC`,
      visibilities
    );
    return rows;
  } catch (err) {
    // Table may not exist yet on a not-yet-migrated org DB — degrade gracefully.
    console.error('[chat] loadKnowledge error:', err.message);
    return [];
  }
}

// Render rulebook entries into a system-prompt fragment.
function renderKnowledge(rows) {
  if (!rows || !rows.length) return '';
  const rules = rows.filter(r => r.kind !== 'faq');
  const faqs = rows.filter(r => r.kind === 'faq');
  let out = '';
  if (rules.length) {
    out += `\n\nTeam rules (always follow these):\n` +
      rules.map(r => `- ${r.body}`).join('\n');
  }
  if (faqs.length) {
    out += `\n\nFAQ — use these answers when the question matches (do NOT invent beyond them):\n` +
      faqs.map(r => `- Q: ${r.title || '(question)'}\n  A: ${r.body}`).join('\n');
  }
  return out;
}

// Build the OpenAI-style messages array from a session's stored history.
async function loadMessageHistory(pool, sessionId) {
  const [rows] = await pool.execute(
    'SELECT role, content, tool_calls, tool_call_id, tool_name FROM chat_message WHERE session_id = ? ORDER BY created_at ASC, id ASC',
    [sessionId]
  );
  return rows.map(r => {
    const msg = { role: r.role };
    if (r.content != null) msg.content = r.content;
    if (r.tool_calls) {
      try { msg.tool_calls = typeof r.tool_calls === 'string' ? JSON.parse(r.tool_calls) : r.tool_calls; } catch {}
    }
    if (r.tool_call_id) msg.tool_call_id = r.tool_call_id;
    if (r.tool_name) msg.name = r.tool_name;
    return msg;
  });
}

async function saveMessage(pool, sessionId, fields) {
  const id = newId();
  await pool.execute(
    `INSERT INTO chat_message (id, session_id, role, content, tool_calls, tool_call_id, tool_name, tokens_in, tokens_out)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, sessionId, fields.role,
      fields.content ?? null,
      fields.tool_calls ? JSON.stringify(fields.tool_calls) : null,
      fields.tool_call_id ?? null,
      fields.tool_name ?? null,
      fields.tokens_in ?? 0,
      fields.tokens_out ?? 0,
    ]
  );
  return id;
}

// Load an existing session by its real id (so a conversation can be continued
// or resumed). Returns null if not found. The pool is already org-scoped.
async function getSessionById(pool, id) {
  const [[row]] = await pool.execute('SELECT * FROM chat_session WHERE id = ? LIMIT 1', [String(id)]);
  return row || null;
}

// Start a fresh session and seed its system prompt as the first message.
async function createSession(pool, { channel, channelUserId, seedSystemPrompt }) {
  const id = newId();
  await pool.execute(
    `INSERT INTO chat_session (id, channel, channel_user_id, status, created_at, updated_at)
     VALUES (?, ?, ?, 0, NOW(), NOW())`,
    [id, channel, channelUserId]
  );
  if (seedSystemPrompt) {
    await saveMessage(pool, id, { role: 'system', content: seedSystemPrompt });
  }
  const [[row]] = await pool.execute('SELECT * FROM chat_session WHERE id = ?', [id]);
  return row;
}

// Mutable in-memory view of the session (picks up updates tools make mid-turn).
function sessionView(row) {
  return {
    id: String(row.id),
    viewer_name: row.viewer_name,
    viewer_email: row.viewer_email,
    viewer_phone: row.viewer_phone,
    contact_id: row.contact_id ? String(row.contact_id) : null,
    booking_count: row.booking_count || 0,
    message_count: row.message_count || 0,
    lead_captured: bitToBool(row.lead_captured),
  };
}

// Shape a chat_session DB row for JSON response — converts all BIT columns.
function serializeSession(row) {
  if (!row) return null;
  return {
    ...row,
    id: String(row.id),
    contact_id: row.contact_id ? String(row.contact_id) : null,
    bot_disabled: bitToBool(row.bot_disabled),
    lead_captured: bitToBool(row.lead_captured),
  };
}

// ---------------------------------------------------------------------------
// runToolLoop — shared LLM tool-call loop used by BOTH the prospect (/message)
// and internal (/internal/message) endpoints. Persists assistant + tool turns
// as it goes. Returns { finalText (null if the model never produced a plain-text
// reply within maxIterations), totalTokensIn, totalTokensOut }.
//
//   guardToolCall(name, session) -> errorString | null   (optional per-call veto;
//     the prospect path uses it for the request_viewing booking cap)
//   roPool  -> read-only pool passed into each tool's ctx (internal ask_data)
// ---------------------------------------------------------------------------
async function runToolLoop({
  pool, orgId, user, session, sessionId, history, definitions, byName,
  maxIterations, roPool = undefined, guardToolCall = null,
}) {
  let finalText = null;
  let totalTokensIn = 0;
  let totalTokensOut = 0;

  for (let i = 0; i < maxIterations; i++) {
    const { message: assistantMsg, usage } = await llmChat(history, definitions, {});
    totalTokensIn += usage?.prompt_tokens || 0;
    totalTokensOut += usage?.completion_tokens || 0;

    if (assistantMsg.tool_calls && assistantMsg.tool_calls.length) {
      await saveMessage(pool, sessionId, {
        role: 'assistant',
        content: assistantMsg.content || null,
        tool_calls: assistantMsg.tool_calls,
        tokens_in: usage?.prompt_tokens || 0,
        tokens_out: usage?.completion_tokens || 0,
      });
      history.push({ role: 'assistant', content: assistantMsg.content || null, tool_calls: assistantMsg.tool_calls });

      for (const tc of assistantMsg.tool_calls) {
        const name = tc.function?.name;
        const rawArgs = tc.function?.arguments || '{}';
        let args = {};
        try { args = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs; } catch {}

        let toolResult;
        const tool = byName[name];
        const guardErr = (tool && guardToolCall) ? guardToolCall(name, session) : null;
        if (!tool) {
          toolResult = { error: `Unknown tool: ${name}` };
        } else if (guardErr) {
          toolResult = { error: guardErr };
        } else {
          try {
            toolResult = await tool.execute({ pool, roPool, orgId, session, user }, args);
          } catch (e) {
            console.error(`[chat] tool ${name} failed:`, e.message);
            toolResult = { error: e.message || 'Tool execution failed' };
          }
        }

        await saveMessage(pool, sessionId, {
          role: 'tool',
          content: JSON.stringify(toolResult),
          tool_call_id: tc.id,
          tool_name: name,
        });
        history.push({ role: 'tool', content: JSON.stringify(toolResult), tool_call_id: tc.id });
      }
      continue;
    }

    finalText = assistantMsg.content || '';
    await saveMessage(pool, sessionId, {
      role: 'assistant',
      content: finalText,
      tokens_in: usage?.prompt_tokens || 0,
      tokens_out: usage?.completion_tokens || 0,
    });
    break;
  }

  return { finalText, totalTokensIn, totalTokensOut };
}

// ---------------------------------------------------------------------------
// POST /message  — send a user turn, get the assistant's reply.
// body: { message: string, session_id?: string, channel?: 'staff-test'|'web' }
// ---------------------------------------------------------------------------
router.post('/message', async (req, res) => {
  if (!config.chat.enabled) {
    return fail(res, 'Chat is currently disabled', 503);
  }
  // Gate on the ACTIVE primary provider's key, not MiniMax's — the primary is
  // configurable (kimi by default), so requiring a MiniMax key here would block
  // chat even when Kimi/OpenRouter is fully configured.
  const primary = config.chat.provider || 'kimi';
  const primaryKeyPresent = {
    kimi: !!config.chat.kimi.apiKey,
    openrouter: !!config.chat.openrouter.apiKey,
    minimax: !!config.chat.minimax.apiKey,
  }[primary];
  if (!primaryKeyPresent) {
    return fail(res, `LLM provider '${primary}' has no API key configured on the server`, 500);
  }

  const { message, session_id, channel: channelIn } = req.body || {};
  if (!message || typeof message !== 'string') return fail(res, 'message is required', 400);

  const channel = channelIn === 'web' ? 'web' : 'staff-test';

  try {
    const settings = await loadBotSettings(req.pool);
    if (!bitToBool(settings.enabled)) {
      return fail(res, 'Chatbot is not enabled for this organization. Enable it in Chatbot → Settings.', 403);
    }

    const capabilities = parseCapabilities(settings);
    const { definitions, byName } = toolsForCapabilities(capabilities);

    // Build the effective system prompt:
    //   - If `system_prompt` is set, it fully replaces the default (advanced override).
    //   - Otherwise, start from the default and append `custom_instructions` (common case).
    let systemPrompt;
    if (settings.system_prompt) {
      systemPrompt = settings.system_prompt;
    } else {
      systemPrompt = defaultSystemPrompt(req.user.orgName);
      if (settings.custom_instructions && settings.custom_instructions.trim()) {
        systemPrompt += `\n\nAdditional instructions from the property team:\n${settings.custom_instructions.trim()}`;
      }
      // Append the shared rulebook (chat_knowledge). The internal bot sees both
      // public and internal entries, so it's aware of everything TaneChat knows
      // plus staff-only rules.
      systemPrompt += renderKnowledge(await loadKnowledge(req.pool, { includeInternal: true }));
    }
    // Resolve the session. A `session_id` means "continue THIS conversation" —
    // looked up by its real id, so multi-turn memory works and any past session
    // can be resumed (e.g. reopened from the Sessions page). No session_id
    // starts a fresh conversation. (The seeded system prompt is only used when
    // creating; a continued session keeps its original seeded prompt + history.)
    let sessionRow;
    if (session_id) {
      sessionRow = await getSessionById(req.pool, session_id);
      if (!sessionRow) return fail(res, 'Conversation not found', 404);
    } else {
      sessionRow = await createSession(req.pool, {
        channel,
        channelUserId: `staff-${req.user.id}-${Date.now()}`,
        seedSystemPrompt: systemPrompt,
      });
    }

    // Per-session guard rails
    if (bitToBool(sessionRow.bot_disabled)) {
      return fail(res, 'This session has been taken over by staff.', 423);
    }
    if (sessionRow.message_count >= settings.max_messages_per_session) {
      return fail(res, 'Message limit for this session has been reached.', 429);
    }

    // Save the user turn
    await saveMessage(req.pool, sessionRow.id, { role: 'user', content: message });

    // Prepare mutable session view that tools may update in place
    const session = sessionView(sessionRow);

    // Build message history for the model
    let history = await loadMessageHistory(req.pool, sessionRow.id);

    // Tool-call loop (shared with /internal/message via runToolLoop). The
    // request_viewing booking cap is prospect-specific, passed as a guard.
    const maxIterations = config.chat.maxToolIterations || 6;
    const guardToolCall = (name, sess) =>
      (name === 'request_viewing' && sess.booking_count >= settings.max_bookings_per_session)
        ? 'Maximum bookings for this session reached. Ask the user to contact staff for further bookings.'
        : null;
    let { finalText: finalAssistantText, totalTokensIn, totalTokensOut } = await runToolLoop({
      pool: req.pool, orgId: req.user.orgId, user: req.user, session,
      sessionId: sessionRow.id, history, definitions, byName, maxIterations, guardToolCall,
    });

    if (finalAssistantText == null) {
      finalAssistantText = "I'm having trouble getting a reply right now. Please try again in a moment.";
      await saveMessage(req.pool, sessionRow.id, { role: 'assistant', content: finalAssistantText });
    }

    // Update session counters
    await req.pool.execute(
      `UPDATE chat_session SET
         message_count = message_count + 1,
         booking_count = ?,
         lead_captured = ?,
         viewer_name   = COALESCE(?, viewer_name),
         viewer_email  = COALESCE(?, viewer_email),
         viewer_phone  = COALESCE(?, viewer_phone),
         contact_id    = COALESCE(?, contact_id),
         last_message_at = NOW()
       WHERE id = ?`,
      [
        session.booking_count,
        session.lead_captured ? 1 : (sessionRow.lead_captured ? 1 : 0),
        session.viewer_name || null,
        session.viewer_email || null,
        session.viewer_phone || null,
        session.contact_id || null,
        sessionRow.id,
      ]
    );

    return ok(res, {
      session_id: String(sessionRow.id),
      reply: finalAssistantText,
      usage: { tokens_in: totalTokensIn, tokens_out: totalTokensOut },
    });
  } catch (err) {
    console.error('[chat] POST /message error:', err);
    return fail(res, err.message || 'Chat failed', 500);
  }
});

// ---------------------------------------------------------------------------
// GET /sessions  — list sessions (staff view)
// ---------------------------------------------------------------------------
router.get('/sessions', async (req, res) => {
  try {
    const [rows] = await req.pool.execute(
      `SELECT id, channel, channel_user_id, contact_id, viewer_name, viewer_email, viewer_phone,
              status, bot_disabled, message_count, booking_count, lead_captured,
              last_message_at, created_at
       FROM chat_session ORDER BY COALESCE(last_message_at, created_at) DESC LIMIT 200`
    );
    ok(res, rows.map(serializeSession));
  } catch (err) {
    console.error('[chat] list sessions error:', err);
    fail(res, 'Failed to load sessions');
  }
});

// ---------------------------------------------------------------------------
// GET /sessions/:id  — full transcript
// ---------------------------------------------------------------------------
router.get('/sessions/:id', async (req, res) => {
  try {
    const [[session]] = await req.pool.execute(
      'SELECT * FROM chat_session WHERE id = ? LIMIT 1', [req.params.id]
    );
    if (!session) return fail(res, 'Session not found', 404);
    const [messages] = await req.pool.execute(
      'SELECT id, role, content, tool_calls, tool_name, tokens_in, tokens_out, created_at FROM chat_message WHERE session_id = ? ORDER BY created_at ASC, id ASC',
      [req.params.id]
    );
    ok(res, {
      session: serializeSession(session),
      messages: messages.map(m => ({ ...m, id: String(m.id), session_id: String(m.session_id || '') })),
    });
  } catch (err) {
    console.error('[chat] session detail error:', err);
    fail(res, 'Failed to load session');
  }
});

// ---------------------------------------------------------------------------
// PATCH /sessions/:id/takeover  — staff disables the bot for a session
// ---------------------------------------------------------------------------
router.patch('/sessions/:id/takeover', async (req, res) => {
  try {
    // Accept `disabled: true|false`. Default to true when missing (treat as "take over").
    const disabled = req.body?.disabled === false ? 0 : 1;
    await req.pool.execute('UPDATE chat_session SET bot_disabled = ? WHERE id = ?', [disabled, req.params.id]);
    ok(res, { id: String(req.params.id), bot_disabled: Boolean(disabled) });
  } catch (err) {
    console.error('[chat] takeover error:', err);
    fail(res, 'Failed to update session');
  }
});

// ---------------------------------------------------------------------------
// GET/PUT /settings — read or update bot_settings
// ---------------------------------------------------------------------------
router.get('/settings', async (req, res) => {
  try {
    const s = await loadBotSettings(req.pool);
    ok(res, {
      enabled: bitToBool(s.enabled),
      capabilities: parseCapabilities(s),
      system_prompt: s.system_prompt,
      custom_instructions: s.custom_instructions,
      max_bookings_per_session: s.max_bookings_per_session,
      max_messages_per_session: s.max_messages_per_session,
      max_messages_per_day: s.max_messages_per_day,
      settings_locked: bitToBool(s.settings_locked),
    });
  } catch (err) {
    console.error('[chat] get settings error:', err);
    fail(res, 'Failed to load settings');
  }
});

router.put('/settings', async (req, res) => {
  try {
    const current = await loadBotSettings(req.pool);
    const locked = bitToBool(current.settings_locked);
    const isMaster = Number(req.user?.orgType) === 6;
    if (locked && !isMaster) {
      return fail(res, 'Settings are locked by the platform operator.', 403);
    }
    const b = req.body || {};
    const updates = [];
    const params = [];
    if (b.enabled !== undefined) {
      updates.push('enabled = ?');
      params.push(b.enabled ? 1 : 0);
    }
    if (b.capabilities !== undefined) {
      updates.push('capabilities = ?');
      params.push(JSON.stringify(b.capabilities || {}));
    }
    if (b.system_prompt !== undefined) {
      updates.push('system_prompt = ?');
      params.push(b.system_prompt || null);
    }
    if (b.custom_instructions !== undefined) {
      updates.push('custom_instructions = ?');
      params.push(b.custom_instructions || null);
    }
    if (b.max_bookings_per_session !== undefined) {
      updates.push('max_bookings_per_session = ?');
      params.push(Math.max(0, parseInt(b.max_bookings_per_session) || 0));
    }
    if (b.max_messages_per_session !== undefined) {
      updates.push('max_messages_per_session = ?');
      params.push(Math.max(1, parseInt(b.max_messages_per_session) || 50));
    }
    if (b.max_messages_per_day !== undefined) {
      updates.push('max_messages_per_day = ?');
      params.push(Math.max(1, parseInt(b.max_messages_per_day) || 500));
    }
    // Only master admin can change settings_locked
    if (b.settings_locked !== undefined && isMaster) {
      updates.push('settings_locked = ?');
      params.push(b.settings_locked ? 1 : 0);
    }
    if (updates.length) {
      params.push(1);
      await req.pool.execute(
        `UPDATE bot_settings SET ${updates.join(', ')} WHERE id = ?`, params
      );
    }
    const fresh = await loadBotSettings(req.pool);
    ok(res, {
      enabled: bitToBool(fresh.enabled),
      capabilities: parseCapabilities(fresh),
      system_prompt: fresh.system_prompt,
      custom_instructions: fresh.custom_instructions,
      max_bookings_per_session: fresh.max_bookings_per_session,
      max_messages_per_session: fresh.max_messages_per_session,
      max_messages_per_day: fresh.max_messages_per_day,
      settings_locked: bitToBool(fresh.settings_locked),
    });
  } catch (err) {
    console.error('[chat] update settings error:', err);
    fail(res, 'Failed to update settings');
  }
});

// ---------------------------------------------------------------------------
// Rulebook (chat_knowledge) — shared knowledge both bots draw from.
// ---------------------------------------------------------------------------
const KNOWLEDGE_KINDS = ['rule', 'faq'];
const KNOWLEDGE_VISIBILITIES = ['public', 'internal'];

// Writes are blocked when the org's settings are locked by the platform operator
// (unless the caller is master admin) — same rule as PUT /settings.
async function assertKnowledgeWritable(req) {
  const settings = await loadBotSettings(req.pool);
  const locked = bitToBool(settings.settings_locked);
  const isMaster = Number(req.user?.orgType) === 6;
  return !(locked && !isMaster);
}

router.get('/knowledge', async (req, res) => {
  try {
    const [rows] = await req.pool.execute(
      `SELECT id, kind, title, body, tags, visibility, status, sort_order, source, source_ref, updated_at
       FROM chat_knowledge
       ORDER BY sort_order ASC, created_at ASC`
    );
    ok(res, rows.map(r => ({
      ...r,
      id: String(r.id),
      source_ref: r.source_ref != null ? String(r.source_ref) : null,
      status: Number(r.status),
      tags: typeof r.tags === 'string' ? safeParseJson(r.tags) : (r.tags || null),
    })));
  } catch (err) {
    console.error('[chat] list knowledge error:', err);
    fail(res, 'Failed to load rulebook');
  }
});

router.post('/knowledge', async (req, res) => {
  try {
    if (!(await assertKnowledgeWritable(req))) {
      return fail(res, 'Settings are locked by the platform operator.', 403);
    }
    const b = req.body || {};
    const body = (b.body || '').trim();
    if (!body) return fail(res, 'Rule text (body) is required.', 400);
    const kind = KNOWLEDGE_KINDS.includes(b.kind) ? b.kind : 'rule';
    const visibility = KNOWLEDGE_VISIBILITIES.includes(b.visibility) ? b.visibility : 'internal';
    const title = b.title != null ? String(b.title).trim() || null : null;
    const tags = Array.isArray(b.tags) ? JSON.stringify(b.tags) : null;
    const sortOrder = Number.isFinite(Number(b.sort_order)) ? parseInt(b.sort_order) : 0;
    const id = newId();
    await req.pool.execute(
      `INSERT INTO chat_knowledge (id, kind, title, body, tags, visibility, status, sort_order, source)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, 'manual')`,
      [id, kind, title, body, tags, visibility, sortOrder]
    );
    ok(res, { id });
  } catch (err) {
    console.error('[chat] create knowledge error:', err);
    fail(res, 'Failed to add rule');
  }
});

// POST /knowledge/bulk — bulk-insert knowledge entries from a parsed list.
// Body: { entries: [{ kind, title?, body, visibility? }, ...] }
// Used by the FAQ bulk-paste UI. Each row is inserted independently; partial
// failure is reported in the response so the user can fix and retry.
router.post('/knowledge/bulk', async (req, res) => {
  try {
    if (!(await assertKnowledgeWritable(req))) {
      return fail(res, 'Settings are locked by the platform operator.', 403);
    }
    const entries = Array.isArray(req.body && req.body.entries) ? req.body.entries : [];
    if (!entries.length) return fail(res, 'No entries provided', 400);

    let inserted = 0;
    const failures = [];
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i] || {};
      const body = String(e.body || '').trim();
      if (!body) { failures.push({ index: i, reason: 'Empty body' }); continue; }
      const kind = KNOWLEDGE_KINDS.includes(e.kind) ? e.kind : 'rule';
      const visibility = KNOWLEDGE_VISIBILITIES.includes(e.visibility) ? e.visibility : 'internal';
      const title = e.title != null ? String(e.title).trim() || null : null;
      // FAQs require a title (the question); guard rather than silently storing
      // a titleless FAQ that would look odd in the table.
      if (kind === 'faq' && !title) { failures.push({ index: i, reason: 'FAQ needs a question (title)' }); continue; }
      try {
        await req.pool.execute(
          `INSERT INTO chat_knowledge (id, kind, title, body, visibility, status, sort_order, source)
           VALUES (?, ?, ?, ?, ?, 1, 0, 'bulk')`,
          [newId(), kind, title, body, visibility]
        );
        inserted++;
      } catch (err) {
        failures.push({ index: i, reason: err.message });
      }
    }
    ok(res, { inserted, failures });
  } catch (err) {
    console.error('[chat] bulk knowledge error:', err);
    fail(res, 'Failed to bulk import');
  }
});

router.put('/knowledge/:id', async (req, res) => {
  try {
    if (!(await assertKnowledgeWritable(req))) {
      return fail(res, 'Settings are locked by the platform operator.', 403);
    }
    const b = req.body || {};
    const updates = [];
    const params = [];
    if (b.kind !== undefined && KNOWLEDGE_KINDS.includes(b.kind)) {
      updates.push('kind = ?'); params.push(b.kind);
    }
    if (b.title !== undefined) {
      updates.push('title = ?'); params.push(b.title ? String(b.title).trim() : null);
    }
    if (b.body !== undefined) {
      const body = (b.body || '').trim();
      if (!body) return fail(res, 'Rule text (body) cannot be empty.', 400);
      updates.push('body = ?'); params.push(body);
    }
    if (b.visibility !== undefined && KNOWLEDGE_VISIBILITIES.includes(b.visibility)) {
      updates.push('visibility = ?'); params.push(b.visibility);
    }
    if (b.tags !== undefined) {
      updates.push('tags = ?'); params.push(Array.isArray(b.tags) ? JSON.stringify(b.tags) : null);
    }
    if (b.status !== undefined) {
      updates.push('status = ?'); params.push(b.status ? 1 : 0);
    }
    if (b.sort_order !== undefined) {
      updates.push('sort_order = ?'); params.push(parseInt(b.sort_order) || 0);
    }
    if (!updates.length) return ok(res, { id: req.params.id });
    params.push(req.params.id);
    await req.pool.execute(
      `UPDATE chat_knowledge SET ${updates.join(', ')} WHERE id = ?`, params
    );
    ok(res, { id: req.params.id });
  } catch (err) {
    console.error('[chat] update knowledge error:', err);
    fail(res, 'Failed to update rule');
  }
});

router.delete('/knowledge/:id', async (req, res) => {
  try {
    if (!(await assertKnowledgeWritable(req))) {
      return fail(res, 'Settings are locked by the platform operator.', 403);
    }
    await req.pool.execute('DELETE FROM chat_knowledge WHERE id = ?', [req.params.id]);
    ok(res, { id: req.params.id });
  } catch (err) {
    console.error('[chat] delete knowledge error:', err);
    fail(res, 'Failed to delete rule');
  }
});

module.exports = router;
