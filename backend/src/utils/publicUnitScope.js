/**
 * What counts as a PUBLIC unit — one shared definition.
 *
 * Three surfaces answer prospects about units: the vacancy feed
 * (computeVacancies), unit search (/units/search) and the resolver
 * (/units/resolve). They each built their own WHERE clause, and they disagreed:
 * only the vacancy feed excluded placeholder/test records. The consequences were
 * not symmetric —
 *
 *   /units/search   listed "Test Property 2 Unit 1" among alternatives
 *   /units/resolve  answered "mong kok 6a" with a CONFIDENT match on "6A Test",
 *                   i.e. named a test unit back to a customer
 *
 * so the predicate lives here now and every surface composes it. A fourth caller
 * gets the same rule for free; more importantly, changing the rule cannot leave
 * one endpoint behind.
 *
 * Deliberately a SQL fragment with no bound parameters: the pattern is a
 * constant, not user input, and keeping it parameter-free means callers can drop
 * it into a WHERE clause without disturbing their own placeholder ordering —
 * which is exactly the sort of edit that silently misaligns params.
 *
 * NAME-BASED, and that is a real limitation. It catches "Test Unit 1", "6A Test"
 * and "Test Property 2" because someone typed "test"; it catches nothing about a
 * placeholder called "Demo" or "Spare". Operationally the answer is not to widen
 * the pattern (which starts eating real names — a property on Testbourne Road is
 * a name, not a placeholder) but to keep test records out of the production
 * portfolio. See docs/public-api.md.
 */

// Substring match on both the unit and its property. LOWER() on the column so a
// "TEST"/"Test"/"test" all match regardless of the column's collation.
const PUBLIC_UNIT_NAME_SQL = `LOWER(u.name) NOT LIKE '%test%' AND LOWER(p.display_name) NOT LIKE '%test%'`;

/**
 * The same rule in JS, for filtering rows already in memory.
 * Takes the unit name and property name; returns true when the pair is publishable.
 */
function isPublicUnitName(unitName, propertyName) {
  const has = (value) => String(value ?? '').toLowerCase().includes('test');
  return !has(unitName) && !has(propertyName);
}

module.exports = { PUBLIC_UNIT_NAME_SQL, isPublicUnitName };
