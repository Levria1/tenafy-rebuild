const RESERVED_PREFIXES = ['staff-'];

function normalizeChannel(value) {
  return value == null ? '' : String(value).trim().toLowerCase();
}

function validateChannel(value) {
  const channel = normalizeChannel(value);
  if (!/^[a-z0-9-]{2,20}$/.test(channel)) {
    return { ok: false, error: 'unsupported_channel' };
  }
  if (RESERVED_PREFIXES.some(prefix => channel.startsWith(prefix))) {
    return { ok: false, error: 'reserved_channel' };
  }
  return { ok: true, channel };
}

function channelLabel(value) {
  const channel = normalizeChannel(value);
  if (!channel) return '';
  const label = channel.replace(/-+/g, ' ');
  return label.charAt(0).toUpperCase() + label.slice(1);
}

module.exports = {
  RESERVED_PREFIXES,
  normalizeChannel,
  validateChannel,
  channelLabel,
};
