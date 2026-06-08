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
    `You are a friendly, concise assistant for ${org}, helping prospective tenants find and book apartment viewings.`,
    `Today's date is ${todayIso}. Detect the language of the user's message and reply in the same language.`,
    ``,
    `Rules:`,
    `- Use the provided tools to answer factual questions about units, properties, and availability. Do NOT invent details.`,
    `- When the user gives criteria (bedrooms, budget, location), immediately call search_available_units.`,
    `- IMPORTANT: \`beds\` value of 0 means a STUDIO apartment (no separate bedroom). Always call it "studio" in your reply, never "0-bedroom". If the user asks for a studio, search with beds=0. If they ask for "1 bedroom" treat that as beds=1 (not a studio).`,
    `- If the user mentions a future move-in date (e.g. "in May", "next month", "from June 1st"), convert to YYYY-MM-DD and pass as the \`available_on\` argument to search_available_units.`,
    `- When results include a \`listing_url\`, INCLUDE the link in your reply so the prospect can see photos. Format it like: "See photos: <listing_url>". If no listing_url is set, don't mention photos.`,
    `- If a unit isn't available on the requested date but its \`next_available_on\` is soon, mention it: "It's booked through <date> — would <next_available_on> work instead?"`,
    `- Viewings run Monday to Saturday, 11:00 AM to 7:00 PM local time. Never propose times outside this window or on Sundays.`,
    `- Before calling request_viewing, you MUST have the unit, a specific date/time, and the user's name, email, and phone. If any are missing, ask for them.`,
    `- NEVER set user_confirmed=true unless the user's latest message explicitly confirms the booking (e.g., "yes, book it", "confirmed").`,
    `- Keep replies short. Use bullet points when listing units.`,
    `- Every unit mention MUST include: unit name, property name, **full street address** (from \`property.address\`), bedrooms (remember beds=0 = Studio), bathrooms, and rent price. Location/address is the most important piece — never omit it.`,
    `- When the prospect asks about a specific location ("Mong Kok", "Causeway Bay", "a particular street"), call search_available_units with that value as the \`city\` argument. The tool does a fuzzy match across city/district/state/street_address/display_name — whatever matches wins.`,
    `- If a result set spans multiple neighborhoods, group the bullet points by area so the prospect can scan quickly.`,
    `- If you don't know something, say so and offer to capture their contact details via capture_lead so the team can follow up.`,
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

async function findOrCreateSession(pool, { channel, channelUserId, seedSystemPrompt }) {
  const [existing] = await pool.execute(
    'SELECT * FROM chat_session WHERE channel = ? AND channel_user_id = ? LIMIT 1',
    [channel, channelUserId]
  );
  if (existing.length) return existing[0];

  const id = newId();
  await pool.execute(
    `INSERT INTO chat_session (id, channel, channel_user_id, status, created_at, updated_at)
     VALUES (?, ?, ?, 0, NOW(), NOW())`,
    [id, channel, channelUserId]
  );
  // Seed the system prompt as the first message
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
// POST /message  — send a user turn, get the assistant's reply.
// body: { message: string, session_id?: string, channel?: 'staff-test'|'web' }
// ---------------------------------------------------------------------------
router.post('/message', async (req, res) => {
  if (!config.chat.enabled) {
    return fail(res, 'Chat is currently disabled', 503);
  }
  if (!config.chat.minimax.apiKey) {
    return fail(res, 'MiniMax API key is not configured on the server', 500);
  }

  const { message, session_id, channel: channelIn } = req.body || {};
  if (!message || typeof message !== 'string') return fail(res, 'message is required', 400);

  const channel = channelIn === 'web' ? 'web' : 'staff-test';
  const channelUserId = session_id || `staff-${req.user.id}-${Date.now()}`;

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
    const sessionRow = await findOrCreateSession(req.pool, {
      channel,
      channelUserId,
      seedSystemPrompt: systemPrompt,
    });

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

    // Tool-call loop
    const maxIterations = config.chat.maxToolIterations || 6;
    let finalAssistantText = null;
    let totalTokensIn = 0;
    let totalTokensOut = 0;

    for (let i = 0; i < maxIterations; i++) {
      const { message: assistantMsg, usage } = await llmChat(history, definitions, {});
      totalTokensIn += usage?.prompt_tokens || 0;
      totalTokensOut += usage?.completion_tokens || 0;

      if (assistantMsg.tool_calls && assistantMsg.tool_calls.length) {
        // Save assistant tool-call turn
        await saveMessage(req.pool, sessionRow.id, {
          role: 'assistant',
          content: assistantMsg.content || null,
          tool_calls: assistantMsg.tool_calls,
          tokens_in: usage?.prompt_tokens || 0,
          tokens_out: usage?.completion_tokens || 0,
        });
        history.push({
          role: 'assistant',
          content: assistantMsg.content || null,
          tool_calls: assistantMsg.tool_calls,
        });

        // Execute each tool call
        for (const tc of assistantMsg.tool_calls) {
          const name = tc.function?.name;
          const rawArgs = tc.function?.arguments || '{}';
          let args = {};
          try { args = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs; } catch {}

          let toolResult;
          const tool = byName[name];
          if (!tool) {
            toolResult = { error: `Unknown tool: ${name}` };
          } else if (name === 'request_viewing' && session.booking_count >= settings.max_bookings_per_session) {
            toolResult = { error: 'Maximum bookings for this session reached. Ask the user to contact staff for further bookings.' };
          } else {
            try {
              toolResult = await tool.execute(
                { pool: req.pool, orgId: req.user.orgId, session, user: req.user },
                args
              );
            } catch (e) {
              console.error(`[chat] tool ${name} failed:`, e.message);
              toolResult = { error: e.message || 'Tool execution failed' };
            }
          }

          await saveMessage(req.pool, sessionRow.id, {
            role: 'tool',
            content: JSON.stringify(toolResult),
            tool_call_id: tc.id,
            tool_name: name,
          });
          history.push({
            role: 'tool',
            content: JSON.stringify(toolResult),
            tool_call_id: tc.id,
          });
        }
        // Loop again to let the model respond to tool results
        continue;
      }

      // Plain text reply → done
      finalAssistantText = assistantMsg.content || '';
      await saveMessage(req.pool, sessionRow.id, {
        role: 'assistant',
        content: finalAssistantText,
        tokens_in: usage?.prompt_tokens || 0,
        tokens_out: usage?.completion_tokens || 0,
      });
      break;
    }

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
