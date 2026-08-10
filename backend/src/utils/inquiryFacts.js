const crypto = require('crypto');

const MAX_FACTS = 50;
const MAX_FACT_CHARS = 500;
const MAX_NOTES_CHARS = 60000;
// Column widths in `inquiry` — validate here so an oversized value is a 400, not a 500.
const MAX_FIELD_CHARS = { first_name: 255, last_name: 255, email: 255, phone: 50 };
const UPDATES_HEADING = '── Updates from chat ──';
const FIELD_WHITELIST = new Set([
  'first_name',
  'last_name',
  'email',
  'phone',
  'budget',
  'desired_start_date',
  'desired_end_date',
  'nightly_rate',
  'stay_total',
]);

function hkDate(isoString) {
  if (!isoString) return '';
  const d = new Date(isoString);
  const t = d.getTime();
  if (!Number.isFinite(t)) return '';
  const hk = new Date(t + 8 * 60 * 60 * 1000);
  const y = hk.getUTCFullYear();
  const m = String(hk.getUTCMonth() + 1).padStart(2, '0');
  const day = String(hk.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Compare facts by their text, ignoring the date prefix, case, surrounding
// whitespace and trailing punctuation — an extractor re-emitting a fact tends to
// produce the identical sentence, not a reworded one.
function factKey(text) {
  return String(text == null ? '' : text)
    .replace(/^\d{4}-\d{2}-\d{2}:\s*/, '')
    .replace(/\s+/g, ' ')
    .replace(/[.\s]+$/, '')
    .trim()
    .toLowerCase();
}

function existingFactKeys(notes) {
  const keys = new Set();
  for (const line of String(notes || '').split('\n')) {
    const key = factKey(line);
    if (key) keys.add(key);
  }
  return keys;
}

/**
 * Append dated fact lines, skipping any fact already recorded.
 *
 * Notes are append-only and kept forever, and idempotency does NOT cover this: it
 * stops the SAME delivery replaying, but a different delivery carrying a fact
 * already in notes would append it again. An extractor whose "already sent"
 * snapshot slips — or two extractors that both notice the same thing — would
 * otherwise write permanent duplicates into an audit trail nobody cleans.
 *
 * Returns { notes, applied, skipped } so the caller can report how many landed
 * rather than silently dropping them.
 */
function appendFactsToNotes(currentNotes, facts, dateStr) {
  const notes = currentNotes == null ? '' : String(currentNotes);
  if (!Array.isArray(facts) || facts.length === 0) return { notes, applied: 0, skipped: 0 };

  const seen = existingFactKeys(notes);
  const lines = [];
  let skipped = 0;
  for (const fact of facts) {
    const text = String(fact);
    const key = factKey(text);
    // Also catches the same fact twice inside ONE payload.
    if (!key || seen.has(key)) {
      skipped++;
      continue;
    }
    seen.add(key);
    lines.push(`${dateStr}: ${text}`);
  }
  if (!lines.length) return { notes, applied: 0, skipped };

  const trimmed = notes.trimEnd();
  let next;
  if (trimmed.includes(UPDATES_HEADING)) {
    next = `${trimmed}\n${lines.join('\n')}`;
  } else if (!trimmed) {
    next = `${UPDATES_HEADING}\n${lines.join('\n')}`;
  } else {
    next = `${trimmed}\n\n${UPDATES_HEADING}\n${lines.join('\n')}`;
  }
  return { notes: next, applied: lines.length, skipped };
}

function parseApiSetFields(apiSetFields) {
  if (Array.isArray(apiSetFields)) return apiSetFields.filter(f => typeof f === 'string');
  if (typeof apiSetFields !== 'string' || !apiSetFields.trim()) return [];
  try {
    const parsed = JSON.parse(apiSetFields);
    return Array.isArray(parsed) ? parsed.filter(f => typeof f === 'string') : [];
  } catch {
    return [];
  }
}

function isEmptyCurrentValue(value) {
  return value === null || value === undefined || value === '';
}

function resolveWritableFields(incoming, currentRow, apiSetFields) {
  const provenance = new Set(parseApiSetFields(apiSetFields));
  const writable = {};
  const skipped = [];
  for (const [field, value] of Object.entries(incoming || {})) {
    if (isEmptyCurrentValue(currentRow ? currentRow[field] : undefined) || provenance.has(field)) {
      writable[field] = value;
    } else {
      skipped.push(field);
    }
  }
  return { writable, skipped };
}

function mergeApiSetFields(apiSetFields, writtenFieldNames) {
  const out = [];
  const seen = new Set();
  for (const field of [...parseApiSetFields(apiSetFields), ...(writtenFieldNames || [])]) {
    if (typeof field !== 'string' || seen.has(field)) continue;
    seen.add(field);
    out.push(field);
  }
  return out;
}

function hasMaxTwoDecimals(value) {
  return Math.abs(value * 100 - Math.round(value * 100)) < Number.EPSILON * 100;
}

function isValidMoneyFieldValue(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && hasMaxTwoDecimals(value);
}

function validateFields(fields) {
  if (fields == null) return { ok: true, fields: {} };
  if (typeof fields !== 'object' || Array.isArray(fields)) {
    return { ok: false, error: 'fields_must_be_object' };
  }

  const out = {};
  for (const [field, value] of Object.entries(fields)) {
    if (!FIELD_WHITELIST.has(field)) return { ok: false, error: `unknown_field: ${field}` };
    if (field === 'budget' || field === 'nightly_rate' || field === 'stay_total') {
      if (!isValidMoneyFieldValue(value)) return { ok: false, error: `invalid_${field}` };
      out[field] = value;
    } else if (field === 'desired_start_date' || field === 'desired_end_date') {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return { ok: false, error: `invalid_${field}` };
      }
      out[field] = value;
    } else {
      // Strings must be strings. Without this an object or an over-long value
      // reaches MySQL and comes back as a 500 ("Data too long"/coercion) where a
      // 400 is the honest answer. Lengths match the column widths.
      if (value == null) { out[field] = null; continue; }
      if (typeof value !== 'string') return { ok: false, error: `invalid_${field}` };
      const trimmed = field === 'email' ? value.trim().toLowerCase() : value.trim();
      if (trimmed.length > MAX_FIELD_CHARS[field]) return { ok: false, error: `invalid_${field}` };
      out[field] = trimmed === '' ? null : trimmed;
    }
  }
  return { ok: true, fields: out };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((acc, key) => {
      if (value[key] !== undefined) acc[key] = canonical(value[key]);
      return acc;
    }, {});
  }
  return value;
}

function payloadHash(body) {
  const relevant = {
    facts: body ? body.facts : undefined,
    fields: body ? body.fields : undefined,
    summary: body ? body.summary : undefined,
    is_inquiry: body ? body.is_inquiry : undefined,
    occurred_at: body ? body.occurred_at : undefined,
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical(relevant))).digest('hex');
}

// 'staging' only when explicitly enabled; anything else (unset, typo, empty) must
// mean 'notes', because defaulting to staging would silently stop inquiry notes
// being updated in production.
function resolveExtractMode(raw) {
  return raw === 'staging' ? 'staging' : 'notes';
}

module.exports = {
  hkDate,
  // The single source of truth for which inquiry fields the public fact API may
  // write. `routes/inquiry.js` uses it to decide which fields a HUMAN edit must
  // drop from api_set_fields — it previously kept its own hard-coded copy, which
  // silently missed nightly_rate/stay_total/desired_end_date when they were added
  // and would have let the API overwrite a human's correction to them.
  API_WRITABLE_FIELDS: FIELD_WHITELIST,
  MAX_FIELD_CHARS,
  appendFactsToNotes,
  resolveWritableFields,
  mergeApiSetFields,
  validateFields,
  payloadHash,
  resolveExtractMode,
};
