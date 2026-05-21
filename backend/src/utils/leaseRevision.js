/**
 * Lease revision resolution.
 *
 * A `lease_revision` row carries the values that take effect on its
 * `effective_from` date. NULL fields mean "inherit from prior state."
 * This module resolves the effective values for a given lease as of any
 * date — used by the invoice scheduler so future invoices pick up
 * scheduled rate changes automatically.
 *
 * Backward compatible: if a lease has no revisions, returns the fallback
 * values from the `leasing` row itself, so existing leases keep working.
 */

/**
 * Resolve effective lease values as of a specific date.
 *
 * @param {Pool} pool                — MySQL pool for the org DB
 * @param {string|bigint} leaseId
 * @param {Date|string} asOfDate     — when invoice is due (or any date)
 * @param {object} fallback          — current leasing.{amount,credits,utility_credit,deposit}
 * @returns {Promise<{ price, credits, utility_credit, deposit, revision_id }>}
 */
async function resolveLeaseValues(pool, leaseId, asOfDate, fallback) {
  const dateStr = asOfDate instanceof Date
    ? asOfDate.toISOString().split('T')[0]
    : String(asOfDate).split('T')[0];

  // Walk all revisions for this lease in effect on or before `dateStr`,
  // newest first. Apply non-null values from each in order so an earlier
  // revision can fill a field a later revision left blank.
  const [revs] = await pool.execute(
    `SELECT id, effective_from, price, credits, utility_credit, deposit
     FROM lease_revision
     WHERE lease_id = ? AND deleted_at IS NULL AND effective_from <= ?
     ORDER BY effective_from DESC, id DESC`,
    [String(leaseId), dateStr]
  );

  let price = null, credits = null, utility_credit = null, deposit = null;
  let revisionId = null;
  for (const r of revs) {
    if (price === null && r.price !== null) price = r.price;
    if (credits === null && r.credits !== null) credits = r.credits;
    if (utility_credit === null && r.utility_credit !== null) utility_credit = r.utility_credit;
    if (deposit === null && r.deposit !== null) deposit = r.deposit;
    if (revisionId === null) revisionId = String(r.id);
    if (price !== null && credits !== null && utility_credit !== null && deposit !== null) break;
  }

  return {
    price: price !== null ? price : (fallback?.price ?? fallback?.amount ?? null),
    credits: credits !== null ? credits : (fallback?.credits ?? null),
    utility_credit: utility_credit !== null ? utility_credit : (fallback?.utility_credit ?? null),
    deposit: deposit !== null ? deposit : (fallback?.deposit ?? null),
    revision_id: revisionId,
  };
}

module.exports = { resolveLeaseValues };
