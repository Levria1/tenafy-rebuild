const test = require('node:test');
const assert = require('node:assert');
const {
  marketabilityDecision,
  isResumableHold,
} = require('../src/services/viewingNegotiationLogic');

test('marketabilityDecision: vacant unit with rostered staff proceeds', () => {
  assert.deepEqual(marketabilityDecision({
    hasActiveLease: false,
    viewingEnabled: 0,
    hasRosteredStaff: true,
    hasHostLink: false,
  }), { proceed: true, reason: null });
});

test('marketabilityDecision: vacant unit with no roster but host link proceeds for compatibility', () => {
  assert.deepEqual(marketabilityDecision({
    hasActiveLease: false,
    viewingEnabled: 0,
    hasRosteredStaff: false,
    hasHostLink: true,
  }), { proceed: true, reason: null });
});

test('marketabilityDecision: vacant unit with no roster and no link is no_host', () => {
  // This is the 495-unit case: vacant units are viewable in principle, but the
  // relay needs someone assigned to let the viewer in.
  assert.deepEqual(marketabilityDecision({
    hasActiveLease: false,
    viewingEnabled: 0,
    hasRosteredStaff: false,
    hasHostLink: false,
  }), { proceed: false, reason: 'no_host' });
});

test('marketabilityDecision: occupied unit with viewing_enabled proceeds unchanged', () => {
  assert.deepEqual(marketabilityDecision({
    hasActiveLease: true,
    viewingEnabled: 1,
    hasRosteredStaff: false,
    hasHostLink: false,
  }), { proceed: true, reason: null });
});

test('marketabilityDecision: occupied unit with viewing disabled stays not_marketing despite roster', () => {
  // A rostered host does not override an explicit "do not show this unit".
  assert.deepEqual(marketabilityDecision({
    hasActiveLease: true,
    viewingEnabled: 0,
    hasRosteredStaff: true,
    hasHostLink: false,
  }), { proceed: false, reason: 'not_marketing' });
});

test('marketabilityDecision: occupied unit with viewing disabled stays not_marketing despite host link', () => {
  // Same rule: occupied units require the active lease to permit viewings.
  assert.deepEqual(marketabilityDecision({
    hasActiveLease: true,
    viewingEnabled: 0,
    hasRosteredStaff: false,
    hasHostLink: true,
  }), { proceed: false, reason: 'not_marketing' });
});

test('isResumableHold: only staff-releaseable reasons are resumable', () => {
  for (const reason of ['off_window', 'not_marketing', 'no_host']) {
    assert.equal(isResumableHold(reason), true, reason);
  }
  for (const reason of ['multi_unit', 'stale', null, 'something_else']) {
    assert.equal(isResumableHold(reason), false, String(reason));
  }
});
