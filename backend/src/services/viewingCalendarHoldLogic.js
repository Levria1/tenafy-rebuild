function normalizeWallClock(value) {
  if (!value) return null;
  if (value instanceof Date) {
    if (isNaN(value.getTime())) return null;
    const p = (n) => String(n).padStart(2, '0');
    return `${value.getFullYear()}-${p(value.getMonth() + 1)}-${p(value.getDate())}T${p(value.getHours())}:${p(value.getMinutes())}:${p(value.getSeconds())}`;
  }
  const s = String(value).trim();
  if (!s) return null;
  return s.replace(' ', 'T').slice(0, 19);
}

function viewingSlotOverlaps({ proposedStart, proposedEnd, existingDatetime, durationMinutes = 30, bufferMin = 30 }) {
  const startMs = new Date(proposedStart).getTime();
  const endMs = new Date(proposedEnd).getTime();
  const existingMs = new Date(existingDatetime).getTime();
  if ([startMs, endMs, existingMs].some(Number.isNaN)) return false;

  const existingStart = existingMs - Number(bufferMin || 0) * 60000;
  const existingEnd = existingMs + ((Number(durationMinutes) || 30) + Number(bufferMin || 0)) * 60000;
  return startMs < existingEnd && endMs > existingStart;
}

function negotiationConflictOverlaps(row, excludeNegotiationId, { proposedStart, proposedEnd, bufferMin = 30 }) {
  if (!row) return false;
  if (String(row.id) === String(excludeNegotiationId)) return false;
  return viewingSlotOverlaps({
    proposedStart,
    proposedEnd,
    existingDatetime: row.current_proposed_datetime,
    durationMinutes: 30,
    bufferMin,
  });
}

function decideCalendarHoldSync(existing, next) {
  const calendarId = next && next.calendarId ? String(next.calendarId) : '';
  const whenIso = next && next.whenIso ? normalizeWallClock(next.whenIso) : null;
  if (!calendarId || !whenIso) return 'skip';

  const existingEventId = existing && existing.existingEventId;
  if (!existingEventId) return 'create';

  const existingCalendarId = existing && existing.existingCalendarId ? String(existing.existingCalendarId) : '';
  if (existingCalendarId !== calendarId) return 'move';

  const existingDatetime = normalizeWallClock(existing && existing.existingDatetime);
  if (existingDatetime !== whenIso) return 'patch';
  return 'noop';
}

module.exports = {
  normalizeWallClock,
  viewingSlotOverlaps,
  negotiationConflictOverlaps,
  decideCalendarHoldSync,
};
