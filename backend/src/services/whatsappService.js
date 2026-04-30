// WhatsApp send service — mirrors emailService.js but for the TaneChat integration endpoint.
// Sends are fire-and-forget from the caller's perspective; this module never throws.

const axios = require('axios');
const {
  resolveVariables,
  substituteVariables,
  getSampleVariables,
} = require('./emailService');

const HTTP_TIMEOUT_MS = 10000;

// ---------------------------------------------------------------------------
// Per-org credentials (Model B — each org runs their own TaneChat instance)
// ---------------------------------------------------------------------------
async function getOrgWhatsAppConfig(pool, orgId) {
  try {
    const [[row]] = await pool.execute(
      'SELECT whatsapp_api_url, whatsapp_api_key FROM organization WHERE id = ?',
      [orgId]
    );
    if (!row) return { url: '', key: '' };
    return {
      url: (row.whatsapp_api_url || '').trim(),
      key: (row.whatsapp_api_key || '').trim(),
    };
  } catch (err) {
    console.error('[WhatsApp] getOrgWhatsAppConfig failed:', err.message);
    return { url: '', key: '' };
  }
}

// ---------------------------------------------------------------------------
// HTML → plain-text for WhatsApp
// ---------------------------------------------------------------------------
function stripHtmlToText(html) {
  if (!html) return '';
  let s = String(html);
  // Convert common block/break tags to newlines
  s = s.replace(/<\s*br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n');
  s = s.replace(/<li[^>]*>/gi, '• ');
  // Strip all remaining tags
  s = s.replace(/<[^>]+>/g, '');
  // Decode a small set of common HTML entities
  s = s.replace(/&nbsp;/g, ' ')
       .replace(/&amp;/g, '&')
       .replace(/&lt;/g, '<')
       .replace(/&gt;/g, '>')
       .replace(/&quot;/g, '"')
       .replace(/&#39;/g, "'");
  // Collapse runs of blank lines, trim
  s = s.replace(/\n{3,}/g, '\n\n').trim();
  return s;
}

// ---------------------------------------------------------------------------
// Phone normalization — caller is expected to provide a country-coded number.
// We strip all non-digits and validate length. No country-code injection here.
// ---------------------------------------------------------------------------
function normalizePhone(input) {
  if (!input) return null;
  const digits = String(input).replace(/\D+/g, '');
  if (digits.length < 8) return null;
  return digits;
}

// ---------------------------------------------------------------------------
// Load WhatsApp template (default for type, or specific id)
// ---------------------------------------------------------------------------
async function loadWhatsAppTemplate(pool, orgId, templateType, templateId = null) {
  if (templateId) {
    const [rows] = await pool.execute(
      `SELECT * FROM whatsapp_template WHERE id = ? AND org_id = ? AND status = 1`,
      [templateId, orgId]
    );
    return rows[0] || null;
  }
  const [rows] = await pool.execute(
    `SELECT * FROM whatsapp_template
     WHERE org_id = ? AND template_type = ? AND is_default_template = 1 AND status = 1
     LIMIT 1`,
    [orgId, templateType]
  );
  if (rows[0]) return rows[0];
  const [fallback] = await pool.execute(
    `SELECT * FROM whatsapp_template
     WHERE org_id = ? AND template_type = ? AND status = 1
     ORDER BY created_time DESC LIMIT 1`,
    [orgId, templateType]
  );
  return fallback[0] || null;
}

// ---------------------------------------------------------------------------
// Whitelist check (org-level safety net for testing)
// ---------------------------------------------------------------------------
async function passesWhitelist(pool, orgId, phoneDigits) {
  try {
    const [[org]] = await pool.execute(
      'SELECT whatsapp_whitelist_enabled, whatsapp_whitelist FROM organization WHERE id = ?',
      [orgId]
    );
    if (!org) return true;
    let enabled = false;
    if (Buffer.isBuffer(org.whatsapp_whitelist_enabled)) {
      enabled = org.whatsapp_whitelist_enabled[0] === 1;
    } else {
      enabled = Boolean(org.whatsapp_whitelist_enabled);
    }
    if (!enabled) return true;
    const list = (org.whatsapp_whitelist || '')
      .split(/[,\n;]/)
      .map(p => p.replace(/\D+/g, ''))
      .filter(Boolean);
    return list.includes(phoneDigits);
  } catch (err) {
    console.error('[WhatsApp] whitelist check failed, allowing send:', err.message);
    return true;
  }
}

// ---------------------------------------------------------------------------
// Resolve recipient phone — by leaseId (tenant) or by toOverride
// Returns { phone, optedOut, tenantId }
// ---------------------------------------------------------------------------
async function getRecipient(pool, orgId, { leaseId, templateType, toOverride }) {
  if (toOverride) {
    return { phone: toOverride, optedOut: false, tenantId: null };
  }

  // Landlord-targeted templates use the org's primary owner phone (best-effort).
  if (templateType && templateType.toLowerCase().includes('landlord')) {
    try {
      const [[org]] = await pool.execute(
        'SELECT phone FROM organization WHERE id = ?',
        [orgId]
      );
      return { phone: (org && org.phone) || null, optedOut: false, tenantId: null };
    } catch {
      return { phone: null, optedOut: false, tenantId: null };
    }
  }

  if (!leaseId) return { phone: null, optedOut: false, tenantId: null };

  try {
    const [[row]] = await pool.execute(
      `SELECT t.id AS tenant_id, t.phone, t.whatsapp_opt_out
         FROM leasing l JOIN tenant t ON l.tenant_id = t.id
        WHERE l.id = ?`,
      [leaseId]
    );
    if (!row) return { phone: null, optedOut: false, tenantId: null };
    let optedOut = false;
    if (Buffer.isBuffer(row.whatsapp_opt_out)) {
      optedOut = row.whatsapp_opt_out[0] === 1;
    } else {
      optedOut = Boolean(row.whatsapp_opt_out);
    }
    return { phone: row.phone || null, optedOut, tenantId: row.tenant_id };
  } catch (err) {
    console.error('[WhatsApp] getRecipient failed:', err.message);
    return { phone: null, optedOut: false, tenantId: null };
  }
}

// ---------------------------------------------------------------------------
// Log helper
// ---------------------------------------------------------------------------
async function writeLog(pool, { orgId, phone, message, type, templateId, leaseId, status, error, waMessageId }) {
  try {
    await pool.execute(
      `INSERT INTO whatsapp_log (org_id, to_phone, message, type, template_id, lease_id, status, error, wa_message_id, sent_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        orgId,
        phone || '',
        message || null,
        type || null,
        templateId || null,
        leaseId || null,
        status,
        error || null,
        waMessageId || null,
        status === 'sent' ? new Date() : null,
      ]
    );
  } catch (logErr) {
    console.error('[WhatsApp] Failed to write whatsapp_log:', logErr.message);
  }
}

// ---------------------------------------------------------------------------
// Low-level send: phone + plain-text message → org-specific TaneChat instance
// ---------------------------------------------------------------------------
async function sendWhatsApp(pool, orgId, phone, message) {
  const cfg = await getOrgWhatsAppConfig(pool, orgId);
  if (!cfg.url || !cfg.key) {
    return { ok: false, error: 'WhatsApp not configured for this organization' };
  }
  const phoneDigits = normalizePhone(phone);
  if (!phoneDigits) return { ok: false, error: 'Invalid phone' };
  if (!message || !String(message).trim()) return { ok: false, error: 'Empty message' };

  try {
    const res = await axios.post(
      `${cfg.url.replace(/\/$/, '')}/send`,
      { phone: phoneDigits, message: String(message).trim() },
      {
        headers: { 'X-API-Key': cfg.key, 'Content-Type': 'application/json' },
        timeout: HTTP_TIMEOUT_MS,
      }
    );
    return {
      ok: !!(res.data && res.data.ok),
      waMessageId: res.data && res.data.waMessageId,
      chatId: res.data && res.data.chatId,
      raw: res.data,
    };
  } catch (err) {
    const detail = err.response && err.response.data && err.response.data.error;
    return { ok: false, error: detail || err.message || 'send failed' };
  }
}

// Connection ping — used by Settings UI to verify per-org URL+key
async function pingWhatsApp(pool, orgId) {
  const cfg = await getOrgWhatsAppConfig(pool, orgId);
  if (!cfg.url || !cfg.key) return { configured: false, ok: false };
  try {
    const r = await axios.get(`${cfg.url.replace(/\/$/, '')}/ping`, {
      headers: { 'X-API-Key': cfg.key },
      timeout: 5000,
    });
    return { configured: true, ok: !!(r.data && r.data.ok), raw: r.data };
  } catch (err) {
    return { configured: true, ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Template send — same shape as sendTemplateEmail
// ---------------------------------------------------------------------------
async function sendTemplateWhatsApp(pool, orgId, {
  templateType,
  templateId = null,
  leaseId,
  category,
  dueDate,
  overdueAmount,
  invoiceCode,
  invoiceId,
  toOverride,
  extraVariables,
} = {}) {
  // Per-org config check — if org hasn't configured WhatsApp, silently skip
  const cfg = await getOrgWhatsAppConfig(pool, orgId);
  if (!cfg.url || !cfg.key) return null;

  const template = await loadWhatsAppTemplate(pool, orgId, templateType, templateId);
  if (!template) {
    // No WA template configured for this type → silently skip (this is the kill switch).
    return null;
  }

  // Variables — reuse email pipeline so behavior matches exactly.
  let variables;
  if (leaseId) {
    variables = await resolveVariables(pool, orgId, leaseId, { category, dueDate, overdueAmount, invoiceCode, invoiceId });
  } else {
    variables = getSampleVariables();
  }
  if (extraVariables) Object.assign(variables, extraVariables);

  const renderedRaw = substituteVariables(template.template_content || '', variables);
  const renderedText = stripHtmlToText(renderedRaw);

  // Recipient
  const { phone, optedOut } = await getRecipient(pool, orgId, { leaseId, templateType, toOverride });

  if (optedOut) {
    await writeLog(pool, { orgId, phone, message: renderedText, type: templateType, templateId: template.id, leaseId, status: 'skipped_opt_out' });
    return null;
  }
  if (!phone) {
    await writeLog(pool, { orgId, phone: '', message: renderedText, type: templateType, templateId: template.id, leaseId, status: 'skipped_no_phone' });
    return null;
  }

  const phoneDigits = normalizePhone(phone);
  if (!phoneDigits) {
    await writeLog(pool, { orgId, phone, message: renderedText, type: templateType, templateId: template.id, leaseId, status: 'failed', error: 'invalid phone format' });
    return null;
  }

  if (!(await passesWhitelist(pool, orgId, phoneDigits))) {
    await writeLog(pool, { orgId, phone: phoneDigits, message: renderedText, type: templateType, templateId: template.id, leaseId, status: 'whitelist_blocked' });
    return null;
  }

  const result = await sendWhatsApp(pool, orgId, phoneDigits, renderedText);
  await writeLog(pool, {
    orgId,
    phone: phoneDigits,
    message: renderedText,
    type: templateType,
    templateId: template.id,
    leaseId,
    status: result.ok ? 'sent' : 'failed',
    error: result.ok ? null : result.error,
    waMessageId: result.waMessageId,
  });
  return result;
}

// ---------------------------------------------------------------------------
// Preview (render without sending) — matches previewTemplate shape
// ---------------------------------------------------------------------------
async function previewWhatsAppTemplate(pool, orgId, { templateId, templateType, leaseId, category, dueDate } = {}) {
  const template = await loadWhatsAppTemplate(pool, orgId, templateType, templateId);
  if (!template) return { body: '', variables: getSampleVariables() };
  let variables;
  if (leaseId) {
    variables = await resolveVariables(pool, orgId, leaseId, { category, dueDate });
  } else {
    variables = getSampleVariables();
  }
  const renderedRaw = substituteVariables(template.template_content || '', variables);
  return {
    body: stripHtmlToText(renderedRaw),
    variables,
  };
}

module.exports = {
  sendWhatsApp,
  sendTemplateWhatsApp,
  previewWhatsAppTemplate,
  loadWhatsAppTemplate,
  stripHtmlToText,
  normalizePhone,
  pingWhatsApp,
  getOrgWhatsAppConfig,
};
