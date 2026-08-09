const test = require('node:test');
const assert = require('node:assert');
const { assessFactDeliveryHealth, STALE_HOURS } = require('../src/utils/inquiryFactHealth');

const NOW = new Date('2026-08-09T10:00:00Z').getTime();
const hoursAgo = (h) => new Date(NOW - h * 3600 * 1000);

const session = (id, hours, count = 3) => ({
  session_id: id, channel: 'whatsapp', channel_user_id: `8529000000${id}`,
  inquiry_id: `100${id}`, last_delivery_at: hoursAgo(hours), deliveries_in_lookback: count,
});

test('everything delivering recently is healthy', () => {
  const h = assessFactDeliveryHealth({ sessions: [session(1, 2), session(2, 20)], nowMs: NOW });
  assert.equal(h.tracked, 2);
  assert.equal(h.stale.length, 0);
  assert.equal(h.orgSilent, false);
});

test('a single conversation gone quiet is flagged, not the whole org', () => {
  const h = assessFactDeliveryHealth({ sessions: [session(1, 2), session(2, 60)], nowMs: NOW });
  assert.equal(h.stale.length, 1);
  assert.equal(h.stale[0].session_id, 2);
  assert.equal(h.orgSilent, false);
});

test('ALL conversations quiet at once reads as an org-wide failure', () => {
  // A dead emitter, a bad deploy or a revoked API key looks like this. One loud
  // alert, not N warnings.
  const h = assessFactDeliveryHealth({ sessions: [session(1, 50), session(2, 60), session(3, 72)], nowMs: NOW });
  assert.equal(h.stale.length, 3);
  assert.equal(h.orgSilent, true);
});

test('the boundary allows exactly one missed daily heartbeat', () => {
  // TaneChat heartbeats daily; 48h means one miss is tolerated and two is not.
  assert.equal(assessFactDeliveryHealth({ sessions: [session(1, 47)], nowMs: NOW }).stale.length, 0);
  assert.equal(assessFactDeliveryHealth({ sessions: [session(1, 49)], nowMs: NOW }).stale.length, 1);
  assert.equal(STALE_HOURS, 48);
});

test('conversations never delivered to are out of scope', () => {
  // Not broken — may not be an enquiry, or may predate cutover. Flagging these
  // would make the alert permanently noisy and therefore ignored.
  const h = assessFactDeliveryHealth({
    sessions: [{ session_id: 9, inquiry_id: '9', last_delivery_at: null, deliveries_in_lookback: 0 }],
    nowMs: NOW,
  });
  assert.equal(h.tracked, 0);
  assert.equal(h.stale.length, 0);
  assert.equal(h.orgSilent, false);
});

test('nothing tracked is never an org-wide alarm', () => {
  // Pre-cutover the delivery table is empty. The job must stay silent rather than
  // announce that TaneChat has stopped before it ever started.
  const h = assessFactDeliveryHealth({ sessions: [], nowMs: NOW });
  assert.equal(h.orgSilent, false);
  assert.equal(h.stale.length, 0);
});

test('a tracked conversation with a null timestamp counts as stale', () => {
  const h = assessFactDeliveryHealth({
    sessions: [{ session_id: 4, inquiry_id: '4', last_delivery_at: null, deliveries_in_lookback: 2 }],
    nowMs: NOW,
  });
  assert.equal(h.stale.length, 1);
});

test('a string timestamp from mysql2 is handled', () => {
  const h = assessFactDeliveryHealth({
    sessions: [{ session_id: 5, inquiry_id: '5', last_delivery_at: '2026-08-09T09:00:00Z', deliveries_in_lookback: 1 }],
    nowMs: NOW,
  });
  assert.equal(h.stale.length, 0);
});

test('bigNumberStrings: a delivery count arriving as a string still counts', () => {
  const h = assessFactDeliveryHealth({
    sessions: [{ session_id: 6, inquiry_id: '6', last_delivery_at: hoursAgo(1), deliveries_in_lookback: '4' }],
    nowMs: NOW,
  });
  assert.equal(h.tracked, 1);
});

// ── regression tests from the Kimi review ────────────────────────────────────

test('an outage lasting longer than the lookback window still alarms', () => {
  // The blind spot: after 7 silent days EVERY conversation drops out of `tracked`,
  // so an "all tracked are stale" rule goes quiet exactly while the outage runs.
  const h = assessFactDeliveryHealth({ sessions: [], historicalTotal: 412, nowMs: NOW });
  assert.equal(h.tracked, 0);
  assert.equal(h.orgSilent, true);
});

test('a revoked key on day one alarms too', () => {
  // Deliveries exist historically, none in the window, no sessions in scope.
  const h = assessFactDeliveryHealth({ sessions: [], historicalTotal: 1, nowMs: NOW });
  assert.equal(h.orgSilent, true);
});

test('but a genuinely never-used integration stays silent', () => {
  // Pre-cutover: no history at all. Must not announce a failure of something that
  // has not started.
  const h = assessFactDeliveryHealth({ sessions: [], historicalTotal: 0, nowMs: NOW });
  assert.equal(h.orgSilent, false);
});

test('historicalTotal arriving as a string still counts (bigNumberStrings)', () => {
  const h = assessFactDeliveryHealth({ sessions: [], historicalTotal: '7', nowMs: NOW });
  assert.equal(h.orgSilent, true);
});

test('healthy traffic is not dragged into an alarm by history', () => {
  const h = assessFactDeliveryHealth({ sessions: [session(1, 2)], historicalTotal: 999, nowMs: NOW });
  assert.equal(h.orgSilent, false);
});
