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

function appendFactsToNotes(currentNotes, facts, dateStr) {
  const notes = currentNotes == null ? '' : String(currentNotes);
  if (!Array.isArray(facts) || facts.length === 0) return notes;

  const lines = facts.map(fact => `${dateStr}: ${String(fact)}`);
  const trimmed = notes.trimEnd();
  if (trimmed.includes(UPDATES_HEADING)) {
    return `${trimmed}\n${lines.join('\n')}`;
  }
  if (!trimmed) return `${UPDATES_HEADING}\n${lines.join('\n')}`;
  return `${trimmed}\n\n${UPDATES_HEADING}\n${lines.join('\n')}`;
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

function validateFields(fields) {
  if (fields == null) return { ok: true, fields: {} };
  if (typeof fields !== 'object' || Array.isArray(fields)) {
    return { ok: false, error: 'fields_must_be_object' };
  }

  const out = {};
  for (const [field, value] of Object.entries(fields)) {
    if (!FIELD_WHITELIST.has(field)) return { ok: false, error: `unknown_field: ${field}` };
    if (field === 'budget') {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || !hasMaxTwoDecimals(value)) {
        return { ok: false, error: 'invalid_budget' };
      }
      out[field] = value;
    } else if (field === 'desired_start_date') {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return { ok: false, error: 'invalid_desired_start_date' };
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
  MAX_FIELD_CHARS,
  appendFactsToNotes,
  resolveWritableFields,
  mergeApiSetFields,
  validateFields,
  payloadHash,
  resolveExtractMode,
};
