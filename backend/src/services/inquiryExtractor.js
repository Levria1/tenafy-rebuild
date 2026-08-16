/**
 * Inquiry extractor — shared by:
 *   - routes/inquiry.js POST /parse        (form-create from pasted text/screenshot)
 *   - routes/public.js  POST /chat/log     (first-time WhatsApp auto-create)
 *   - services/scheduler.js daily 23:00 HK (re-extract diff into notes)
 *
 * Two entry points:
 *   - extractInitial(transcript) → { is_inquiry, fields }
 *       Classifies a (possibly long) WhatsApp transcript and pulls fields.
 *       Used for the very first extraction on a session.
 *
 *   - extractDiff(transcriptDelta, existingInquiry) → { diff: [...] }
 *       Looks ONLY at messages since last_extracted_at and tells us what new
 *       facts the prospect has added or changed. Returns an array of
 *       human-readable diff strings ready to be appended to inquiry.notes.
 *
 * Both call llmClient.chat (MiniMax primary, OpenRouter fallback).
 */

const llmClient = require('./llmClient');
const { orgWallClock, orgToday } = require('../utils/orgTime');

// ---------------------------------------------------------------------------
// Field set we extract. Matches the inquiry table columns the form exposes.
// ---------------------------------------------------------------------------
const FIELD_LIST = [
  'first_name', 'last_name', 'email', 'phone',
  'budget', 'desired_start_date', 'notes',
];

// ---------------------------------------------------------------------------
// Build a single source-text block from chat_message rows. Each line is
// prefixed with role + timestamp so the LLM can see who said what when.
// ---------------------------------------------------------------------------
function transcriptToText(messages) {
  return messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => {
      const role = m.role === 'user' ? 'PROSPECT' : 'BOT';
      // Hong Kong, and labelled. created_at is an absolute instant, so
      // toISOString() renders it in UTC — telling the model a message arrived at
      // "15 Aug 16:05" when the prospect sent it at 00:05 on the 16th. The model
      // reasons about "tomorrow" and "this weekend" from these, so a silent
      // eight-hour shift moves the dates it extracts.
      const ts = m.created_at
        ? `${orgWallClock(new Date(m.created_at)).slice(0, 16).replace('T', ' ')} HKT`
        : '';
      return `[${ts} ${role}] ${m.content || ''}`;
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// Strip ```json fences a model may have added despite being told not to.
// ---------------------------------------------------------------------------
function safeParseJson(raw) {
  if (!raw) return null;
  const cleaned = String(raw).replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try { return JSON.parse(cleaned); } catch { return null; }
}

// ---------------------------------------------------------------------------
// extractInitial — full transcript → is_inquiry + fields
// ---------------------------------------------------------------------------
async function extractInitial(transcript) {
  const text = typeof transcript === 'string' ? transcript : transcriptToText(transcript);
  if (!text.trim()) return { is_inquiry: false, fields: {} };

  const systemPrompt = [
    'You triage WhatsApp/chat conversations for a property-rental company in Hong Kong.',
    'The transcript may be English, Cantonese, Mandarin, or mixed.',
    '',
    'First decide: is this person a PROSPECT inquiring about renting a unit?',
    '  YES → set "is_inquiry": true, AND extract their details.',
    '  NO  → set "is_inquiry": false, omit "fields". (Current tenants asking',
    '         maintenance/payment questions are NOT inquiries.)',
    '',
    'When is_inquiry is true, populate as many of these fields as the transcript supports.',
    'Omit any field you cannot find — do not guess.',
    '  first_name        (string)',
    '  last_name         (string)',
    '  email             (string, lowercase)',
    '  phone             (string, digits only; strip +852, spaces, dashes)',
    '  budget            (number, HKD per month; infer from "20k", "$25,000/mo")',
    '  desired_start_date (string, YYYY-MM-DD)',
    '  notes             (string, ≤2 sentences, English summary of what they want)',
    '',
    'OTA / booking enquiries: if the transcript contains an Airbnb or Booking.com',
    'reservation card or enquiry, treat its details as authoritative:',
    '  - check-in  → desired_start_date.   Recognize English (Check-in / Checkout /',
    '    Guests) AND Chinese (入住 / 退房 / 客人 / N名成人 / N位).',
    '  - Put check-out and the guest count in `notes` (e.g. "Airbnb enquiry: 20 Jul–20 Aug,',
    '    1 guest; asked which floor").',
    'Resolve any date written without a year to the SOONEST FUTURE date.',
    '',
    'OCCUPANCY ≠ BEDROOMS: "N people / persons / guests / adults / N名成人" is how many',
    'will live there — record it in `notes` as occupancy. NEVER treat it as a bedroom count.',
    '',
    'Return STRICT JSON only. No prose. No markdown fences.',
    'Shape: { "is_inquiry": boolean, "fields"?: { ... } }',
  ].join('\n');

  const resp = await llmClient.chat(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: text.slice(0, 8000) },
    ],
    null,
    { temperature: 0.1 }
  );

  const parsed = safeParseJson(resp.message && resp.message.content) || {};
  const out = {
    is_inquiry: !!parsed.is_inquiry,
    fields: {},
  };
  if (out.is_inquiry && parsed.fields && typeof parsed.fields === 'object') {
    for (const k of FIELD_LIST) {
      if (parsed.fields[k] != null && parsed.fields[k] !== '') out.fields[k] = parsed.fields[k];
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// extractDiff — only NEW messages → array of diff lines for notes
//
// existingInquiry is the current row (snake_case keys). The LLM is told what
// we already know so it only flags genuinely new facts or changes.
// ---------------------------------------------------------------------------
async function extractDiff(newMessages, existingInquiry) {
  const text = transcriptToText(newMessages);
  if (!text.trim()) return { diff: [] };

  const knownSnapshot = {};
  for (const k of FIELD_LIST) {
    if (existingInquiry[k] != null && existingInquiry[k] !== '') knownSnapshot[k] = existingInquiry[k];
  }

  const systemPrompt = [
    'You read NEW chat messages from a rental prospect we already have a record on.',
    'We already know these facts:',
    JSON.stringify(knownSnapshot, null, 2),
    '',
    'Looking at the new messages BELOW, identify any new or changed facts about the prospect:',
    '  - new budget, change in budget',
    '  - new desired start date, change in start date',
    '  - new preferences (number of bedrooms, neighbourhood, parking, pets, etc.)',
    '  - new contact info we did not have',
    '  - significant intent shift (e.g. "no longer looking", "found a place")',
    '',
    'Return STRICT JSON: { "diff": [ "...short sentence...", "...", ... ] }',
    'Each diff entry is one self-contained English sentence describing a fact the prospect newly',
    'revealed or changed. Examples:',
    '  "Budget updated to $10,000 HKD"',
    '  "Prefers Causeway Bay over Wan Chai"',
    '  "No longer needs a parking space"',
    '  "Postponed move-in to August 15"',
    '',
    'Output EMPTY array if the new messages add nothing meaningful. No prose. No fences.',
  ].join('\n');

  const resp = await llmClient.chat(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: text.slice(0, 6000) },
    ],
    null,
    { temperature: 0.1 }
  );

  const parsed = safeParseJson(resp.message && resp.message.content) || {};
  const diff = Array.isArray(parsed.diff) ? parsed.diff.filter(s => typeof s === 'string' && s.trim()) : [];
  return { diff };
}

// ---------------------------------------------------------------------------
// Notes-append formatter — one line per fact, date-prefixed (Option A).
//
//   2026-06-05: Budget updated to $10,000 HKD
//   2026-06-05: Wants 2BR with parking
// ---------------------------------------------------------------------------
const UPDATES_HEADING = '── Updates from chat ──';

function appendDiffToNotes(currentNotes, diff, when) {
  if (!diff || !diff.length) return currentNotes;
  // orgToday, not toISOString: these notes are read by staff in Hong Kong, and a
  // diff appended at 00:30 HK would otherwise be filed under the previous day.
  const dateStr = orgToday(when || new Date());
  const lines = diff.map(d => `${dateStr}: ${d.trim()}`);

  const existing = currentNotes ? String(currentNotes).trimEnd() : '';
  const hasHeading = existing.includes(UPDATES_HEADING);

  const blockParts = hasHeading ? [existing, ...lines] : [
    existing,
    existing ? '' : null,        // blank line only if there's prior content
    UPDATES_HEADING,
    ...lines,
  ].filter(p => p !== null);

  return blockParts.join('\n');
}

module.exports = {
  extractInitial,
  extractDiff,
  appendDiffToNotes,
  transcriptToText,
  FIELD_LIST,
};
