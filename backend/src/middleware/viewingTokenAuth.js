/**
 * Public link auth middleware.
 *
 * Resolves the per-org MySQL pool from a URL-path token registered in
 * tena_master.viewing_link_registry. Despite the table name, this is a general
 * public-link registry: kinds 1-4 are viewing-related, kind 5 is an iCal feed.
 * A separate registry would duplicate this tested org-resolution path for no
 * benefit. This is the ONLY way an unauthenticated public request can obtain
 * `req.pool`.
 *
 * A JWT cookie or API-key header is NEVER consulted here — the token is the
 * single source of authority. That keeps the public surface fully isolated
 * from the logged-in staff surface.
 */

const { getMasterPool, getOrgPool } = require('../config/poolRegistry');

// Kind values in viewing_link_registry (keep in sync with the SQL comment).
const KIND_LINK = 1;    // shareable per-unit URL (vbk_ prefix)
const KIND_ACTION = 2;  // tenant / employee approve or decline token
const KIND_MANAGE = 3;  // viewer self-cancel token
const KIND_INVITE = 4;  // per-prospect prefilled, short-lived link (vbi_ prefix)
const KIND_ICAL = 5;    // per-unit Airbnb availability iCal feed (ical_ prefix)

async function lookupToken(token, kinds) {
  if (!token || typeof token !== 'string') return null;
  const master = getMasterPool();
  const placeholders = kinds.map(() => '?').join(',');
  const [rows] = await master.execute(
    `SELECT token, org_id, kind, status FROM viewing_link_registry
     WHERE token = ? AND kind IN (${placeholders}) LIMIT 1`,
    [token, ...kinds]
  );
  if (!rows.length) return null;
  const row = rows[0];
  if (row.status !== 1) return null; // revoked
  return row;
}

function attachOrgPoolMiddleware(kinds, options = {}) {
  return async (req, res, next) => {
    try {
      const token = req.params.token;
      const row = await lookupToken(token, kinds);
      if (!row) {
        // Do NOT leak whether a token exists-but-revoked vs. never-existed.
        if (options.plainTextErrors) {
          return res.status(404).type('text/plain; charset=utf-8').send('Link not found or no longer active');
        }
        return res.status(404).json({ code: 404, message: 'Link not found or no longer active' });
      }
      req.viewingToken = row.token;
      req.viewingTokenKind = row.kind;
      req.orgId = String(row.org_id);
      try {
        req.pool = await getOrgPool(row.org_id);
      } catch (poolErr) {
        console.error('[viewingTokenAuth] org pool error:', poolErr.message);
        if (options.plainTextErrors) {
          return res.status(503).type('text/plain; charset=utf-8').send('Calendar temporarily unavailable');
        }
        return res.status(404).json({ code: 404, message: 'Link not found or no longer active' });
      }
      next();
    } catch (err) {
      console.error('[viewingTokenAuth] unexpected error:', err);
      if (options.plainTextErrors) {
        return res.status(503).type('text/plain; charset=utf-8').send('Calendar temporarily unavailable');
      }
      return res.status(500).json({ code: 500, message: 'Server error' });
    }
  };
}

// Public middleware exports
const resolveOrgByViewingToken = attachOrgPoolMiddleware([KIND_LINK]);
const resolveOrgByActionToken = attachOrgPoolMiddleware([KIND_ACTION]);
const resolveOrgByManageToken = attachOrgPoolMiddleware([KIND_MANAGE]);
const resolveOrgByInviteToken = attachOrgPoolMiddleware([KIND_INVITE]);
const resolveOrgByIcalToken = attachOrgPoolMiddleware([KIND_ICAL], { plainTextErrors: true });

module.exports = {
  KIND_LINK,
  KIND_ACTION,
  KIND_MANAGE,
  KIND_INVITE,
  KIND_ICAL,
  resolveOrgByViewingToken,
  resolveOrgByActionToken,
  resolveOrgByManageToken,
  resolveOrgByInviteToken,
  resolveOrgByIcalToken,
};
