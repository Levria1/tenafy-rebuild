/**
 * Lease-template resolution + PDF sign-status derivation.
 *
 * Shared by:
 *   - routes/pdf.js         → which template to render for "View Lease"
 *   - routes/leasing.js     → the `pdf_status` tag on lease detail + the list
 *
 * Kept free of any Puppeteer / rendering dependency so the list and detail
 * routes can require it cheaply (it only reads two small tables).
 *
 * Resolution order (mirrors the e-sign template picker on review-and-send, so
 * "View Lease" and "Generate for E-Signature" resolve to the SAME document):
 *   1. The template already assigned to this lease (e.g. a prior e-sign run),
 *      as long as it's still active.
 *   2. Otherwise the property's allowlist → org default within it → first
 *      allowed. A property with no allowlist rows is unrestricted (every
 *      active template is eligible).
 * Returns null when the org has no usable template at all (caller then falls
 * back to the hand-drawn "Basic" PDF).
 */

// Load org-wide resolution inputs ONCE, so a list of N leases costs 2 queries
// total instead of 2 per lease. Returns data consumed by resolveWithData().
async function loadResolutionData(pool, orgId) {
  const [templates] = await pool.execute(
    `SELECT id, is_default FROM lease_template
      WHERE org_id = ? AND status = 1 AND deleted_at IS NULL
      ORDER BY is_default DESC, name ASC`,
    [orgId]
  );

  const allowByProperty = new Map();
  try {
    const [rows] = await pool.execute(
      `SELECT property_id, template_id FROM property_lease_template WHERE org_id = ?`,
      [orgId]
    );
    for (const r of rows) {
      const k = String(r.property_id);
      if (!allowByProperty.has(k)) allowByProperty.set(k, []);
      allowByProperty.get(k).push(String(r.template_id));
    }
  } catch (e) {
    // property_lease_template absent on un-migrated org DBs — treat as
    // unrestricted (every template eligible for every property).
  }

  return { templates, allowByProperty };
}

// Pure, in-memory resolution against pre-loaded data. Returns a template id
// string, or null when nothing resolves.
// `requestedTemplateId` (optional) lets a caller preview the real lease against a
// template the user is choosing in the UI — but it is only honoured when that
// template is genuinely eligible for the lease's property, so a hand-edited query
// param can't render a lease with another property's contract.
function resolveWithData(lease, data, requestedTemplateId = null) {
  const allowed = data.allowByProperty.get(String(lease.property_id)) || [];
  const candidates = allowed.length
    ? data.templates.filter(t => allowed.includes(String(t.id)))
    : data.templates;

  if (requestedTemplateId) {
    const req = candidates.find(t => String(t.id) === String(requestedTemplateId));
    if (req) return String(req.id);
    return null;   // asked for something not permitted here — don't silently substitute
  }

  if (lease.template_id) {
    const own = data.templates.find(t => String(t.id) === String(lease.template_id));
    if (own) return String(own.id);
  }
  const chosen = candidates.find(t => t.is_default) || candidates[0];
  return chosen ? String(chosen.id) : null;
}

// Convenience for single-lease callers (pdf.js, lease detail GET): loads data
// then resolves. Two queries.
async function resolveLeaseTemplateId(pool, orgId, lease, requestedTemplateId = null) {
  const data = await loadResolutionData(pool, orgId);
  return resolveWithData(lease, data, requestedTemplateId);
}

// Derive the display status shown next to the "View Lease" button and in the
// Leases list "Sign Status" column:
//   'signed'   — fully signed (final PDF stored)
//   'pending'  — sent, awaiting signatures
//   'declined' — a party declined; needs re-sending
//   'unsigned' — a real template resolves but it was never sent (ACTION: send)
//   'basic'    — no template configured; View Lease falls back to the Basic PDF
function derivePdfStatus(lease, resolvedTemplateId) {
  if (lease.signed_file_id || lease.signature_status === 'signed') return 'signed';
  if (lease.signature_status === 'pending')  return 'pending';
  if (lease.signature_status === 'declined') return 'declined';
  return resolvedTemplateId ? 'unsigned' : 'basic';
}

// SQL predicate (for the Leases-list filter) that is TRUE when a lease resolves
// to a real template — i.e. would show 'unsigned' rather than 'basic'. This is
// the SQL mirror of resolveWithData() above; keep the two in sync. Expressing
// it in SQL (rather than filtering in app) is what lets the 'unsigned' / 'basic'
// filters coexist with LIMIT/OFFSET pagination.
//
// Assumes the outer query exposes aliases: l = leasing, p = property.
// Returns { sql, params } — splice params into the query in fragment order.
function hasTemplateSql(orgId) {
  const sql = `(
    EXISTS (SELECT 1 FROM lease_template lt
             WHERE lt.id = l.template_id AND lt.org_id = ? AND lt.status = 1 AND lt.deleted_at IS NULL)
    OR EXISTS (SELECT 1 FROM property_lease_template plt
                JOIN lease_template lt2 ON lt2.id = plt.template_id
                     AND lt2.org_id = ? AND lt2.status = 1 AND lt2.deleted_at IS NULL
               WHERE plt.org_id = ? AND plt.property_id = p.id)
    OR (
      NOT EXISTS (SELECT 1 FROM property_lease_template plt2
                   WHERE plt2.org_id = ? AND plt2.property_id = p.id)
      AND EXISTS (SELECT 1 FROM lease_template lt3
                   WHERE lt3.org_id = ? AND lt3.status = 1 AND lt3.deleted_at IS NULL)
    )
  )`;
  return { sql, params: [orgId, orgId, orgId, orgId, orgId] };
}

module.exports = {
  loadResolutionData,
  resolveWithData,
  resolveLeaseTemplateId,
  derivePdfStatus,
  hasTemplateSql,
};
