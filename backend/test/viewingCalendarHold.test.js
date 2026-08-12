const test = require('node:test');
const assert = require('node:assert');
const {
  viewingSlotOverlaps,
  negotiationConflictOverlaps,
  decideCalendarHoldSync,
} = require('../src/services/viewingCalendarHoldLogic');

test('viewingSlotOverlaps catches an exact overlap', () => {
  assert.equal(viewingSlotOverlaps({
    proposedStart: '2099-01-06T15:00:00',
    proposedEnd: '2099-01-06T15:30:00',
    existingDatetime: '2099-01-06T15:00:00',
    durationMinutes: 30,
    bufferMin: 0,
  }), true);
});

test('viewingSlotOverlaps catches buffer-only overlap', () => {
  assert.equal(viewingSlotOverlaps({
    proposedStart: '2099-01-06T14:45:00',
    proposedEnd: '2099-01-06T15:15:00',
    existingDatetime: '2099-01-06T14:00:00',
    durationMinutes: 30,
    bufferMin: 30,
  }), true);
});

test('viewingSlotOverlaps allows adjacent but clear slots', () => {
  assert.equal(viewingSlotOverlaps({
    proposedStart: '2099-01-06T15:00:00',
    proposedEnd: '2099-01-06T15:30:00',
    existingDatetime: '2099-01-06T14:00:00',
    durationMinutes: 30,
    bufferMin: 30,
  }), false);
});

test('viewingSlotOverlaps catches an earlier long booking reaching forward', () => {
  assert.equal(viewingSlotOverlaps({
    proposedStart: '2099-01-06T15:00:00',
    proposedEnd: '2099-01-06T15:30:00',
    existingDatetime: '2099-01-06T13:30:00',
    durationMinutes: 120,
    bufferMin: 0,
  }), true);
});

test('decideCalendarHoldSync creates when there is no existing hold', () => {
  assert.equal(decideCalendarHoldSync({}, {
    calendarId: 'staff-cal',
    whenIso: '2099-01-06T15:00:00',
  }), 'create');
});

test('decideCalendarHoldSync patches the same calendar at a different time', () => {
  assert.equal(decideCalendarHoldSync({
    existingEventId: 'event-1',
    existingCalendarId: 'staff-cal',
    existingDatetime: '2099-01-06T15:00:00',
  }, {
    calendarId: 'staff-cal',
    whenIso: '2099-01-06T16:00:00',
  }), 'patch');
});

test('decideCalendarHoldSync moves when the staff calendar changes', () => {
  assert.equal(decideCalendarHoldSync({
    existingEventId: 'event-1',
    existingCalendarId: 'old-cal',
    existingDatetime: '2099-01-06T15:00:00',
  }, {
    calendarId: 'new-cal',
    whenIso: '2099-01-06T15:00:00',
  }), 'move');
});

test('decideCalendarHoldSync noops when calendar and time match', () => {
  assert.equal(decideCalendarHoldSync({
    existingEventId: 'event-1',
    existingCalendarId: 'staff-cal',
    existingDatetime: '2099-01-06 15:00:00',
  }, {
    calendarId: 'staff-cal',
    whenIso: '2099-01-06T15:00:00',
  }), 'noop');
});

test('decideCalendarHoldSync skips without a calendar id or proposed time', () => {
  assert.equal(decideCalendarHoldSync({}, { calendarId: '', whenIso: '2099-01-06T15:00:00' }), 'skip');
  assert.equal(decideCalendarHoldSync({}, { calendarId: 'staff-cal', whenIso: null }), 'skip');
});

test('negotiationConflictOverlaps self-excludes by negotiation id', () => {
  const row = { id: '123', current_proposed_datetime: '2099-01-06T15:00:00' };
  // Without this self-exclusion, a negotiation blocks its own confirmation.
  assert.equal(negotiationConflictOverlaps(row, '123', {
    proposedStart: '2099-01-06T15:00:00',
    proposedEnd: '2099-01-06T15:30:00',
    bufferMin: 30,
  }), false);
  assert.equal(negotiationConflictOverlaps(row, '124', {
    proposedStart: '2099-01-06T15:00:00',
    proposedEnd: '2099-01-06T15:30:00',
    bufferMin: 30,
  }), true);
});
