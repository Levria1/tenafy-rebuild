const CHAT_SOURCE_CHANNELS = {
  tenafy: ['staff-test', 'staff-internal'],
  tanechat: ['whatsapp', 'email', 'web'],
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

module.exports = {
  CHAT_SOURCE_CHANNELS,
  routeChatSearch,
  mapTaneChatResult,
};
