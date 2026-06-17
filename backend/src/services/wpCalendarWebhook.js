/**
 * WordPress Calendar Webhook (Tenafy -> tenafy-wp-bridge)
 *
 * Fires a fire-and-forget webhook to the standalone Python bridge whenever a
 * lease becomes active (block dates) or is cancelled/deleted (unblock dates).
 * The bridge maps the unit name to a WP Booking System calendar and updates it.
 *
 * Config (env):
 *   TENAFY_WP_WEBHOOK_URL     - full URL of the bridge, e.g. http://127.0.0.1:8090/webhook/lease
 *   TENAFY_WP_WEBHOOK_SECRET  - shared secret, must match the bridge's WEBHOOK_SECRET
 *   TENAFY_WP_WEBHOOK_ORG_ID  - (optional) only fire for this org id. The WP
 *                               calendars belong to one org (Tane Residence), so
 *                               set this so other orgs never hit the bridge.
 *
 * If URL or SECRET is unset, this module is a no-op (safe in dev / other envs).
 *
 * IMPORTANT — unit name mapping: the bridge matches `unit_name` against aliases
 * in units.csv. Tenafy stores the unit name and property separately, so we send
 * "<property> <unit>" (e.g. "Mong Kok 1A"). Those combined strings must exist as
 * aliases in units.csv or the bridge returns 422 (logged, no calendar change).
 */

const axios = require('axios');

const WEBHOOK_URL = process.env.TENAFY_WP_WEBHOOK_URL || '';
const WEBHOOK_SECRET = process.env.TENAFY_WP_WEBHOOK_SECRET || '';
const ORG_GATE = process.env.TENAFY_WP_WEBHOOK_ORG_ID || '';

function isEnabled(orgId) {
  if (!WEBHOOK_URL || !WEBHOOK_SECRET) return false;
  if (ORG_GATE && String(orgId) !== String(ORG_GATE)) return false;
  return true;
}

/** Format a DATE value (JS Date from mysql2, or string) to YYYY-MM-DD using
 *  local components — NOT toISOString(), which shifts a day in +UTC zones. */
function fmtDate(d) {
  if (!d) return null;
  if (typeof d === 'string') return d.slice(0, 10);
  if (d instanceof Date && !isNaN(d)) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  return null;
}

/** Add one calendar day (UTC math, TZ-safe) to a YYYY-MM-DD string. The WP
 *  plugin blocks check_in..check_out EXCLUSIVE of check_out, so to block the
 *  lease's final night we send end_date + 1. */
function addOneDay(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + 1);
  return dt.toISOString().slice(0, 10);
}

function fmtRate(amount) {
  const n = Number(amount);
  if (!n || isNaN(n)) return null;
  return '$' + n.toLocaleString('en-US');
}

function tenantName(row) {
  if (Number(row.tenant_type) === 1 && row.company_name) return row.company_name.trim();
  const name = [row.first_name, row.last_name].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  return name || null;
}

function buildUnitName(row) {
  const prop = (row.property_name || '').trim();
  const unit = (row.unit_name || '').trim();
  if (prop && unit) return `${prop} ${unit}`;
  return unit || prop || '';
}

async function loadLease(pool, leasingId) {
  const [[row]] = await pool.execute(
    `SELECT l.start_date, l.end_date, l.amount, l.price, l.unit_id, l.tenant_id,
            u.name AS unit_name, p.display_name AS property_name,
            t.first_name, t.last_name, t.company_name, t.type AS tenant_type
       FROM leasing l
       JOIN unit u ON l.unit_id = u.id
       LEFT JOIN property p ON u.property_id = p.id
       LEFT JOIN tenant t ON l.tenant_id = t.id
      WHERE l.id = ? LIMIT 1`,
    [leasingId]
  );
  return row || null;
}

/** Heuristic: a lease is a renewal if the same tenant already has another
 *  (non-deleted) lease on the same unit. Only affects the calendar note label
 *  (Booking vs Renewal); both block the same dates, so a miss is cosmetic. */
async function detectRenewal(pool, row, leasingId) {
  try {
    const [[prev]] = await pool.execute(
      `SELECT id FROM leasing
        WHERE unit_id = ? AND tenant_id = ? AND id != ? AND deleted_at IS NULL
        LIMIT 1`,
      [row.unit_id, row.tenant_id, leasingId]
    );
    return !!prev;
  } catch (_) {
    return false;
  }
}

async function postWebhook(payload) {
  return axios.post(WEBHOOK_URL, payload, {
    headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': WEBHOOK_SECRET },
    timeout: 10000,
  });
}

function logErr(label, leasingId, err) {
  const msg = err.response
    ? `${err.response.status} ${JSON.stringify(err.response.data)}`
    : err.message;
  console.error(`[wpCal] ${label} failed for lease ${leasingId}: ${msg}`);
}

/**
 * Lease became active (created active, or confirmed) -> block the date range.
 * Fire-and-forget; never throws into the request path.
 * @param {object} [opts] - { renewal: boolean } to force the label.
 */
function notifyLeaseBlocked(pool, orgId, leasingId, opts = {}) {
  if (!isEnabled(orgId)) return;
  setImmediate(async () => {
    try {
      const row = await loadLease(pool, leasingId);
      if (!row) return;
      const checkIn = fmtDate(row.start_date);
      const endDate = fmtDate(row.end_date);
      if (!checkIn || !endDate) {
        console.warn(
          `[wpCal] lease ${leasingId}: open-ended (no start/end date) — skipping calendar block.`
        );
        return;
      }
      const isRenewal =
        opts.renewal != null ? !!opts.renewal : await detectRenewal(pool, row, leasingId);
      const payload = {
        event: isRenewal ? 'renewed' : 'created',
        unit_id: String(row.unit_id),
        unit_name: buildUnitName(row), // readability only; bridge maps by unit_id
        check_in: checkIn,
        check_out: addOneDay(endDate),
        tenant_name: tenantName(row),
        monthly_rate: fmtRate(row.amount || row.price),
      };
      const res = await postWebhook(payload);
      console.log(
        `[wpCal] ${payload.event} '${payload.unit_name}' ${payload.check_in}->${payload.check_out}: ` +
          `${(res.data && res.data.action) || res.status}`
      );
    } catch (err) {
      logErr('block', leasingId, err);
    }
  });
}

/**
 * Lease cancelled/deleted -> unblock the date range. Call AFTER the soft-delete;
 * loadLease() does not filter deleted_at so the row is still readable.
 * Fire-and-forget; never throws into the request path.
 */
function notifyLeaseCancelled(pool, orgId, leasingId) {
  if (!isEnabled(orgId)) return;
  setImmediate(async () => {
    try {
      const row = await loadLease(pool, leasingId);
      if (!row) return;
      const checkIn = fmtDate(row.start_date);
      const endDate = fmtDate(row.end_date);
      if (!checkIn || !endDate) {
        console.warn(
          `[wpCal] lease ${leasingId}: open-ended (no start/end date) — skipping calendar unblock.`
        );
        return;
      }
      const payload = {
        event: 'cancelled',
        unit_id: String(row.unit_id),
        unit_name: buildUnitName(row), // readability only; bridge maps by unit_id
        check_in: checkIn,
        check_out: addOneDay(endDate),
      };
      const res = await postWebhook(payload);
      console.log(
        `[wpCal] cancelled '${payload.unit_name}' ${payload.check_in}->${payload.check_out}: ` +
          `${(res.data && res.data.action) || res.status}`
      );
    } catch (err) {
      logErr('cancel', leasingId, err);
    }
  });
}

module.exports = { notifyLeaseBlocked, notifyLeaseCancelled, isEnabled };
