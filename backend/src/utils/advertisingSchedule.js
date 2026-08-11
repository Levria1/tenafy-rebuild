const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function weekdayOf(ymd) {
  const m = String(ymd || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== mo - 1 ||
    dt.getUTCDate() !== d
  ) {
    return null;
  }
  return dt.getUTCDay();
}

function normalizeTokens(input) {
  if (Array.isArray(input)) return input;
  if (typeof input === 'string') {
    if (!input.trim()) return [];
    return input.split(',').map(s => s.trim());
  }
  if (input == null) return [];
  return null;
}

function parseDays(input) {
  const tokens = normalizeTokens(input);
  if (!tokens) return [];
  const set = new Set();
  for (const token of tokens) {
    if (typeof token === 'number') {
      if (Number.isInteger(token) && token >= 0 && token <= 6) set.add(token);
      continue;
    }
    const s = String(token).trim();
    if (/^-?\d+$/.test(s)) {
      const n = Number(s);
      if (n >= 0 && n <= 6) set.add(n);
    }
  }
  return [...set].sort((a, b) => a - b);
}

function formatDays(days) {
  return parseDays(days).join(',');
}

function postsOnDay(postDays, ymd) {
  const dow = weekdayOf(ymd);
  if (dow == null) return false;
  return parseDays(postDays).includes(dow);
}

function validateDays(input) {
  const tokens = normalizeTokens(input);
  if (!tokens) return { ok: false, error: 'invalid_post_days' };
  for (const token of tokens) {
    if (typeof token === 'number') {
      if (!Number.isInteger(token) || token < 0 || token > 6) {
        return { ok: false, error: 'invalid_post_days' };
      }
      continue;
    }
    const s = String(token).trim();
    if (!/^\d+$/.test(s)) return { ok: false, error: 'invalid_post_days' };
    const n = Number(s);
    if (n < 0 || n > 6) return { ok: false, error: 'invalid_post_days' };
  }
  return { ok: true, value: formatDays(tokens) };
}

function dayLabel(n) {
  return DAY_NAMES[n] || '';
}

module.exports = {
  DAY_NAMES,
  weekdayOf,
  parseDays,
  formatDays,
  postsOnDay,
  validateDays,
  dayLabel,
};
