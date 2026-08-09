/**
 * Detects TaneChat fact deliveries going silent.
 *
 * The whole point of moving extraction to TaneChat is undermined if their emitter
 * dies quietly: inquiries simply stop being updated, nothing errors, and after
 * cutover Tenafy has no transcripts to fall back on. This is the detector.
 *
 * ⚠️ It is DELIVERY-based, not inbound-message-based, and it has to be. The spec
 * originally defined an active conversation as "inbound activity within the last
 * 3 days" — but after cutover TaneChat stops calling /chat/log, so `chat_message`
 * stops being written and Tenafy can no longer see inbound activity at all. An
 * inbound-based rule would go permanently quiet exactly when it became load-bearing.
 *
 * So instead we watch for a DROP-OFF: a conversation that was receiving deliveries
 * and then stopped, and the org-wide case where everything stopped at once (which
 * is what a dead emitter, a bad deploy or a revoked API key looks like).
 *
 * Pure — no DB, no Express.
 */

const STALE_HOURS = 48;      // TaneChat heartbeats daily, so 48h allows one miss
const LOOKBACK_DAYS = 7;     // "was recently being delivered to"

function toMs(value) {
  if (value == null) return null;
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? t : null;
  }
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * @param {object}   input
 * @param {Array}    input.sessions  [{ session_id, channel, inquiry_id, channel_user_id,
 *                                     last_delivery_at, deliveries_in_lookback }]
 * @param {number}   input.nowMs
 * @param {number}  [input.staleHours]
 * @returns {{ tracked: number, stale: Array, orgSilent: boolean }}
 */
function assessFactDeliveryHealth({ sessions, historicalTotal = 0, nowMs, staleHours = STALE_HOURS }) {
  const list = Array.isArray(sessions) ? sessions : [];
  const cutoff = nowMs - staleHours * 3600 * 1000;

  // Only conversations TaneChat has actually been delivering to are in scope. A
  // conversation that never received anything is not "broken" — it may simply not
  // be an enquiry, or predate the cutover.
  const tracked = list.filter(s => Number(s.deliveries_in_lookback) > 0);

  const stale = tracked.filter(s => {
    const last = toMs(s.last_delivery_at);
    return last == null || last < cutoff;
  });

  // Everything tracked has gone quiet at once — that is an emitter/credential/deploy
  // failure, not a per-conversation quirk, and deserves one loud alert rather than N.
  const allTrackedStale = tracked.length > 0 && stale.length === tracked.length;

  // ...and once an outage passes the lookback window, EVERY conversation falls out of
  // `tracked` and the check above goes quiet exactly while the outage continues. So a
  // history of deliveries plus nothing inside the window is the same alarm.
  const silentPastLookback = tracked.length === 0 && Number(historicalTotal) > 0;

  return { tracked: tracked.length, stale, orgSilent: allTrackedStale || silentPastLookback };
}

module.exports = { assessFactDeliveryHealth, STALE_HOURS, LOOKBACK_DAYS };
