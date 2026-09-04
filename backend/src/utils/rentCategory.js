/**
 * The org's rent category, resolved the one way everything else resolves it.
 *
 * Rent is filed under a category named "Rental Income". Matching on '%Rental%'
 * alone is ambiguous and unordered: org 8300127259922432 also carries a "Rental
 * Expense" category, and another org has four rows matching %Rental%. Picking
 * the wrong one is not a cosmetic error — the recurring-invoice job scopes its
 * duplicate check to this id, so a mismatch there would create duplicate rent.
 *
 * Several call sites already inline this exact query. This is the shared copy
 * for new callers; the pattern and the ORDER BY must stay identical to the
 * inline ones, which test/rentCategoryPattern.test.js checks across the tree.
 *
 * @returns {Promise<string|null>} the category id, or null if the org has none
 */
async function resolveRentCategoryId(pool, orgId) {
  try {
    const [[row]] = await pool.execute(
      "SELECT id FROM category_setting WHERE org_id = ? AND enabled = 1 AND name LIKE '%Rental Income%' ORDER BY id LIMIT 1",
      [orgId]
    );
    return row ? String(row.id) : null;
  } catch (err) {
    console.error('[rentCategory] lookup failed for org', String(orgId), '-', err.message);
    return null;
  }
}

/**
 * Is this invoice's category the org's rent category?
 *
 * Both sides are compared as strings. Category ids are Snowflake bigints well
 * past Number.MAX_SAFE_INTEGER, so comparing them as numbers rounds and can
 * make two different categories look equal.
 */
function isRentCategory(invoiceCategory, rentCategoryId) {
  if (invoiceCategory == null || rentCategoryId == null) return false;
  return String(invoiceCategory) === String(rentCategoryId);
}

module.exports = { resolveRentCategoryId, isRentCategory };
