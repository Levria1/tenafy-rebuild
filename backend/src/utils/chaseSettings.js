/**
 * The org's overdue-chasing policy, with defaults.
 *
 * Follows the advertising_setting shape: one row per org, defaults living in
 * code so an org that has never opened the screen still behaves sensibly and no
 * backfill is needed.
 *
 * The defaults encode the decisions made when this was introduced:
 *   enabled 0          the sweep mails real tenants and had been dormant for a
 *                      long time, so a deploy must not start it for anyone
 *   categories null    rent only; the chaser threatens "5% of the monthly rent"
 *                      per week, which means nothing on a utility bill
 *   days_after_due 0   chase from the day after the due date, as before
 *   days_after_issue 7 never chase a bill the tenant only just received; see
 *                      utils/overdueChase.js for why this is separate
 *   repeat_days 7      one nudge per invoice per week, matching the cron
 */

const DEFAULTS = {
  enabled: 0,
  categories: null,
  days_after_due: 0,
  days_after_issue: 7,
  repeat_days: 7,
};

// A setting that is absent, blank or not a number falls back to the default
// rather than to NaN, which would silently poison every date comparison.
//
// Also floored. The HTTP route clamps what it accepts, but a value edited
// directly in the database never passes through it, and a negative day count
// inverts the SQL window it feeds (`INTERVAL -1 DAY` is valid MySQL). Reading
// is the right place to make that safe, since every consumer reads.
function intOr(value, fallback, min = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.trunc(n));
}

/**
 * Split the stored category list. Ids stay STRINGS: they are Snowflake bigints
 * past Number.MAX_SAFE_INTEGER, and parsing them as numbers rounds two distinct
 * categories into one.
 */
function parseCategories(raw) {
  if (raw == null) return null;
  const ids = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
  return ids.length ? ids : null;
}

function serialiseCategories(list) {
  if (!Array.isArray(list) || list.length === 0) return null;
  const ids = [...new Set(list.map((v) => String(v).trim()).filter(Boolean))];
  return ids.length ? ids.join(',') : null;
}

async function loadChaseSettings(pool, orgId) {
  try {
    const [[row]] = await pool.execute(
      `SELECT enabled, categories, days_after_due, days_after_issue, repeat_days
         FROM chase_setting WHERE org_id = ? LIMIT 1`,
      [orgId]
    );
    if (!row) return { ...DEFAULTS };
    return {
      enabled: Number(row.enabled) === 1 ? 1 : 0,
      categories: parseCategories(row.categories),
      days_after_due: intOr(row.days_after_due, DEFAULTS.days_after_due),
      days_after_issue: intOr(row.days_after_issue, DEFAULTS.days_after_issue),
      repeat_days: intOr(row.repeat_days, DEFAULTS.repeat_days, 1),
    };
  } catch (err) {
    // A missing table (org not yet migrated) must not turn into a burst of
    // emails, so the failure path is the OFF default rather than the old
    // hard-coded behaviour.
    console.error('[chaseSettings] load failed for org', String(orgId), '-', err.message);
    return { ...DEFAULTS };
  }
}

module.exports = { loadChaseSettings, parseCategories, serialiseCategories, CHASE_DEFAULTS: DEFAULTS };
