/**
 * Who may do what in the tenant portal.
 *
 * Two DIFFERENT rules, and conflating them is the mistake this file exists to prevent:
 *
 *   read  (log in, see leases, see invoices)  -> has held a lease at any point  (~1,721 people)
 *   write (raise a repair)                    -> holds a CURRENT ACTIVE lease   (~114 people)
 *
 * A departed tenant keeps access to their own history, which is the common reason someone
 * logs in after moving out (final invoice, deposit refund). They must not be able to raise
 * work on a flat somebody else now lives in.
 *
 * A lease counts for either rule whether the person is the named tenant OR an additional
 * tenant on it (`leasing_additional_tenant`). A spouse or flatmate lives there just as much.
 */

const { orgToday } = require('./orgTime');

// A lease belongs to this person if they are the named tenant or an additional one.
// Written once, used by every rule below, so the two can never drift apart.
const LEASE_BELONGS_TO = (placeholders) => `(
  l.tenant_id IN (${placeholders})
  OR EXISTS (SELECT 1 FROM leasing_additional_tenant lat
              WHERE lat.leasing_id = l.id AND lat.tenant_id IN (${placeholders}))
)`;

/**
 * Every live tenant row for this email in this org.
 *
 * Resolved per request rather than stored, because a person who re-leases gets a NEW
 * `tenant` row: 13 emails in production map to more than one (Eiji Tsuchizawa has 4).
 * Picking one at registration would hide the rest of that person's own history.
 *
 * `deleted_at IS NULL` matters: a soft-deleted tenant row is usually a merge or a
 * mistaken entry, and its leases and invoices must stop being reachable the moment it is
 * removed. Without this the authorising set is decided by rows staff believe they deleted.
 */
async function resolveTenantIds(pool, orgId, email) {
  if (!pool || !orgId || !email) return [];
  const [rows] = await pool.execute(
    // category 1 = tenant, 2 = payee. A payee is someone the business PAYS (an owner or a
    // vendor) and their invoices are not a tenant's to read. Sharing an email with a payee
    // row must not fold that row into a tenant portal identity.
    //
    // The lease requirement is re-applied here on EVERY request, not just at registration.
    // Otherwise a tenant whose only lease is later deleted as an error keeps read access
    // to whatever else still hangs off their tenant row, which is not the stated rule.
    `SELECT t.id FROM tenant t
      WHERE t.org_id = ? AND LOWER(t.email) = LOWER(?) AND t.deleted_at IS NULL
        AND (t.category IS NULL OR t.category = 1)
        AND EXISTS (
          SELECT 1 FROM leasing l
           WHERE l.deleted_at IS NULL
             AND (l.tenant_id = t.id
                  OR EXISTS (SELECT 1 FROM leasing_additional_tenant lat
                              WHERE lat.leasing_id = l.id AND lat.tenant_id = t.id))
        )`,
    [String(orgId), String(email)]
  );
  return rows.map(r => String(r.id));
}

/**
 * The portal account for this email, only if it is usable.
 *
 * Status 2 is the staff kill switch. Checked on EVERY request rather than at login,
 * because a token already in someone's browser outlives a login-time check: disabling a
 * compromised account has to end the session that is being abused, not the next one.
 */
async function loadActiveAccount(pool, orgId, email) {
  if (!pool || !orgId || !email) return null;
  const [[row]] = await pool.execute(
    `SELECT id, status, token_version FROM tenant_portal_account
      WHERE org_id = ? AND LOWER(email) = LOWER(?) LIMIT 1`,
    [String(orgId), String(email)]
  );
  if (!row) return null;
  if (Number(row.status) !== 1) return null;   // 0 unverified, 2 disabled
  return { id: String(row.id), status: Number(row.status), tokenVersion: Number(row.token_version) || 0 };
}

/**
 * May this email register at all? Requires at least one lease, ever.
 *
 * Excludes the ~125 chatbot prospects who have an email on file but never leased: they
 * would see an empty portal, and every extra account is another credential to look after.
 *
 * Deliberately does NOT filter on lease dates or `leasing.status`: read access is
 * "has leased ever", so an archived lease from 2019 still qualifies its holder.
 */
async function isEligibleToRegister(pool, orgId, email) {
  if (!pool || !orgId || !email) return false;
  const [[row]] = await pool.execute(
    `SELECT EXISTS (
       SELECT 1 FROM tenant t
        WHERE t.org_id = ? AND LOWER(t.email) = LOWER(?) AND t.deleted_at IS NULL
          AND (t.category IS NULL OR t.category = 1)
          AND EXISTS (
            SELECT 1 FROM leasing l
             WHERE l.deleted_at IS NULL
               AND (l.tenant_id = t.id
                    OR EXISTS (SELECT 1 FROM leasing_additional_tenant lat
                                WHERE lat.leasing_id = l.id AND lat.tenant_id = t.id))
          )
     ) AS ok`,
    [String(orgId), String(email)]
  );
  return Number(row?.ok) === 1;
}

/**
 * The units this person may currently raise a repair against.
 *
 * The caller uses this as the ONLY source of unit_id. A unit_id in a request body is
 * ignored entirely: accepting one would let any logged-in tenant, including one whose
 * lease ended years ago, file work against any flat in the portfolio.
 *
 * `l.status = 1` is load-bearing and is NOT redundant with the date window. Production
 * has leases that are archived (status 0) yet whose dates still span today: 1,803 rows
 * sit at status 0 and 3 of them are live by date. Filtering on dates alone would hand
 * those three a write path into the repair queue.
 */
async function currentLeaseUnits(pool, orgId, tenantIds, today = orgToday()) {
  // `today` defaults to the org clock and exists as a parameter ONLY so tests can pin a
  // date. A route must never pass a request value: a departed tenant who supplies a date
  // inside their old tenancy would get back a unit somebody else now lives in.
  if (!pool || !orgId || !Array.isArray(tenantIds) || tenantIds.length === 0 || !today) return [];
  const placeholders = tenantIds.map(() => '?').join(',');
  const ids = tenantIds.map(String);
  const [rows] = await pool.execute(
    `SELECT DISTINCT l.id AS lease_id, l.tenant_id AS lease_tenant_id,
            u.id AS unit_id, u.name AS unit_name,
            p.id AS property_id, p.display_name AS property_name
       FROM leasing l
       JOIN unit u ON l.unit_id = u.id
       JOIN property p ON u.property_id = p.id
      WHERE p.org_id = ?
        AND ${LEASE_BELONGS_TO(placeholders)}
        AND l.deleted_at IS NULL
        AND p.deleted_at IS NULL
        AND l.status = 1
        AND l.start_date <= ?
        AND (l.end_date IS NULL OR l.end_date >= ?)
      ORDER BY p.display_name, u.name`,
    [String(orgId), ...ids, ...ids, today, today]
  );
  return rows.map(r => ({
    lease_id: String(r.lease_id),
    // The tenant row that actually holds this lease. A person can have an old primary
    // row and a newer one; attributing a repair to whichever id happened to sort first
    // files it against a tenancy that has nothing to do with the flat.
    lease_tenant_id: r.lease_tenant_id == null ? null : String(r.lease_tenant_id),
    unit_id: String(r.unit_id),
    unit_name: r.unit_name,
    property_id: String(r.property_id),
    property_name: r.property_name,
  }));
}

module.exports = { resolveTenantIds, loadActiveAccount, isEligibleToRegister, currentLeaseUnits };
