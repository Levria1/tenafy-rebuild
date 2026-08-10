const CHAT_SOURCE_CHANNELS = {
  tenafy: ['staff-test', 'staff-internal'],
  // 'airbnb' is an OTA channel TaneChat owns like any other prospect conversation —
  // without it here, routeChatSearch treats it as unknown and probes the local
  // mirror as well as the live API.
  tanechat: ['whatsapp', 'email', 'web', 'airbnb'],
};

function norm(value) {
  return value == null ? '' : String(value).trim().toLowerCase();
}

// Decide where a search_chats call should go.
// Returns 'local' | 'tanechat' | 'both'.
function routeChatSearch(args = {}) {
  const channel = norm(args.channel);
  if (CHAT_SOURCE_CHANNELS.tenafy.includes(channel)) return 'local';
  if (CHAT_SOURCE_CHANNELS.tanechat.includes(channel)) return 'tanechat';

  const source = norm(args.source);
  if (source === 'tenafy') return 'local';
  if (source === 'tanechat') return 'tanechat';

  return 'both';
}

function mapTaneChatResult(result = {}) {
  const contact = result.contact || null;
  return {
    conversation_id: result.conversation_id,
    source: 'tanechat',
    channel: (contact && contact.channel) || 'whatsapp',
    prospect: (contact && (contact.name || contact.phone)) || '',
    who: result.direction === 'inbound' ? 'prospect' : 'assistant',
    said: result.content,
    at: result.timestamp,
    link: result.deep_link,
  };
}

// A prospect filter is only usable against TaneChat if it resolves to a phone
// number — their API keys contacts on phone, not name. Anything with 7+ digits
// once punctuation is stripped is treated as a number; a shorter string is a
// name and has to be resolved locally first.
function looksLikePhone(value) {
  const raw = value == null ? '' : String(value).trim();
  if (!raw) return false;
  if (/[a-z@]/i.test(raw)) return false;
  return normalizePhone(raw).length >= 7;
}

function normalizePhone(value) {
  return (value == null ? '' : String(value)).replace(/\D+/g, '');
}

// Build the query for TaneChat's /search/messages.
//
// Their API needs at least one selector — `q` OR `phone` (or an amount). It also
// uses `from`/`to` for date bounds and IGNORES `since`/`until` outright, so a
// date filter passed under the wrong name is silently dropped and old messages
// come back looking current. Returns null when there is no usable selector.
function buildTaneChatSearchParams({ keyword, phone, since, until, limit } = {}) {
  const q = keyword == null ? '' : String(keyword).trim();
  const digits = normalizePhone(phone);
  if (!q && !digits) return null;

  const params = { limit };
  if (q) params.q = q;
  if (digits) params.phone = digits;
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(since || ''))) params.from = String(since);
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(until || ''))) params.to = String(until);
  return params;
}

module.exports = {
  CHAT_SOURCE_CHANNELS,
  routeChatSearch,
  mapTaneChatResult,
  looksLikePhone,
  normalizePhone,
  buildTaneChatSearchParams,
};
