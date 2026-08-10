const test = require('node:test');
const assert = require('node:assert');
const {
  normalizeChannel,
  validateChannel,
  channelLabel,
} = require('../src/utils/chatChannel');

test('normalizeChannel trims and lowercases values', () => {
  assert.equal(normalizeChannel(' Airbnb '), 'airbnb');
  assert.equal(normalizeChannel(null), '');
  assert.equal(normalizeChannel(undefined), '');
});

test('validateChannel accepts well-shaped prospect channels', () => {
  for (const value of ['whatsapp', 'email', 'airbnb', 'booking', 'agoda', 'booking-com']) {
    assert.deepEqual(validateChannel(value), { ok: true, channel: value });
  }
  assert.deepEqual(validateChannel(' AIRBNB '), { ok: true, channel: 'airbnb' });
});

test('validateChannel rejects malformed channels as unsupported_channel', () => {
  for (const value of ['', 'a', 'a'.repeat(21), 'booking.com', 'book ing', 'Ünicode', 'booking_com']) {
    assert.deepEqual(validateChannel(value), { ok: false, error: 'unsupported_channel' });
  }
});

test('validateChannel rejects reserved staff channels', () => {
  for (const value of ['staff-test', 'staff-internal', 'staff-anything', ' STAFF-TEST ']) {
    assert.deepEqual(validateChannel(value), { ok: false, error: 'reserved_channel' });
  }
});

test('channelLabel renders readable slug labels', () => {
  assert.equal(channelLabel('booking'), 'Booking');
  assert.equal(channelLabel('staff-test'), 'Staff test');
  assert.equal(channelLabel(''), '');
});
