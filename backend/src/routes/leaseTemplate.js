/**
 * Lease-template CRUD + preview routes. Mounted at /api/lease-template.
 *
 * Endpoints (all authenticated, org-scoped via req.pool + req.user.orgId):
 *   GET  /list                          → active templates for the org
 *   GET  /variables                     → master variable list for the editor
 *   POST /preview                       → inline preview from raw editor HTML
 *                                         (used BEFORE save — body_html in JSON)
 *   GET  /:id                           → one template
 *   POST /                              → create
 *   PUT  /:id                           → update (snapshots prior version)
 *   POST /:id/duplicate                 → clone
 *   POST /:id/set-default               → flip is_default flag (unsets others)
 *   POST /:id/preview                   → render preview PDF for saved template
 *                                         (uses sample data, returns PDF)
 *   DELETE /:id                         → soft archive (sets deleted_at)
 *
 * Static routes are defined BEFORE the dynamic /:id route per the project's
 * convention.
 */

const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { logActivity } = require('../utils/activityLog');
const variables = require('../services/leaseTemplateVariables');
const renderer = require('../services/leasePdfRenderer');

router.use(authenticate);

function ok(res, data) { return res.json({ code: 200, data }); }
function fail(res, message, status = 500) {
  return res.status(status).json({ code: status, message });
}
function newId() {
  return (BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000))).toString();
}

// Set the exact list of properties this template is allowed on (the per-
// property allowlist, stored in property_lease_template). When a property has
// at least one allowed template, the e-sign dropdown is restricted to those;
// a property with none is unrestricted. Passing undefined leaves the
// assignments untouched; an empty array removes this template from all
// properties' allowlists.
async function applyPropertyAllowlist(pool, orgId, templateId, propertyIds) {
  if (!Array.isArray(propertyIds)) return; // undefined = "don't touch"
  const ids = [...new Set(propertyIds.map(String).filter(Boolean))];

  // Rebuild this template's allowlist from scratch (small dataset).
  await pool.execute(
    `DELETE FROM property_lease_template WHERE org_id = ? AND template_id = ?`,
    [orgId, templateId]
  );
  for (const pid of ids) {
    await pool.execute(
      `INSERT INTO property_lease_template (org_id, property_id, template_id)
       VALUES (?, ?, ?)`,
      [orgId, pid, templateId]
    );
  }
}

// Property ids this template is allowed on.
async function getAllowedProperties(pool, orgId, templateId) {
  const [rows] = await pool.execute(
    `SELECT property_id FROM property_lease_template
      WHERE org_id = ? AND template_id = ?`,
    [orgId, templateId]
  );
  return rows.map(r => String(r.property_id));
}

// ─────────────────────────────────────────────────────────────────────────
// GET /list — active templates for the org
// ─────────────────────────────────────────────────────────────────────────
router.get('/list', async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const [rows] = await req.pool.execute(
      `SELECT id, name, description, page_size, is_default, version, updated_at, created_at
         FROM lease_template
        WHERE org_id = ? AND status = 1 AND deleted_at IS NULL
        ORDER BY is_default DESC, name ASC`,
      [orgId]
    );
    ok(res, rows);
  } catch (err) {
    console.error('[lease-template] list error:', err);
    fail(res, 'Failed to list templates');
  }
});

// ─────────────────────────────────────────────────────────────────────────
// GET /variables — list of {{VARIABLES}} for the editor's "Insert" dropdown
// ─────────────────────────────────────────────────────────────────────────
router.get('/variables', (req, res) => {
  ok(res, variables.publicList());
});

// ─────────────────────────────────────────────────────────────────────────
// POST /preview — inline render from editor HTML (no save required)
// Body: { body_html, header_html?, footer_html?, page_size? }
// Returns: PDF binary
// ─────────────────────────────────────────────────────────────────────────
router.post('/preview', async (req, res) => {
  try {
    const { body_html, header_html, footer_html, page_size } = req.body || {};
    if (!body_html) return fail(res, 'body_html is required', 400);
    const pdf = await renderer.renderInlinePreview({ body_html, header_html, footer_html, page_size });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="template-preview.pdf"');
    res.end(pdf);
  } catch (err) {
    console.error('[lease-template] inline preview error:', err);
    fail(res, err.message || 'Preview failed');
  }
});

// ─────────────────────────────────────────────────────────────────────────
// GET /:id — full template detail
// ─────────────────────────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const [[row]] = await req.pool.execute(
      `SELECT * FROM lease_template
        WHERE id = ? AND org_id = ? AND deleted_at IS NULL
        LIMIT 1`,
      [req.params.id, orgId]
    );
    if (!row) return fail(res, 'Template not found', 404);
    row.property_ids = await getAllowedProperties(req.pool, orgId, req.params.id);
    ok(res, row);
  } catch (err) {
    console.error('[lease-template] get error:', err);
    fail(res, 'Failed to load template');
  }
});

// ─────────────────────────────────────────────────────────────────────────
// POST / — create a new template
// ─────────────────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const userId = req.user.id;
    const {
      name, description, body_html, header_html, footer_html, page_size, is_default,
      property_ids,
    } = req.body || {};
    if (!name || !String(name).trim()) return fail(res, 'name is required', 400);

    const id = newId();
    await req.pool.execute(
      `INSERT INTO lease_template
         (id, org_id, name, description, body_html, header_html, footer_html,
          page_size, is_default, status, version, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?)`,
      [
        id, orgId, String(name).trim(), description || null,
        body_html || null, header_html || null, footer_html || null,
        page_size || 'A4', is_default ? 1 : 0, userId || null,
      ]
    );

    // If created as default, unset the flag on the other templates.
    if (is_default) {
      await req.pool.execute(
        `UPDATE lease_template SET is_default = 0
          WHERE org_id = ? AND id != ? AND deleted_at IS NULL`,
        [orgId, id]
      );
    }

    // Snapshot the initial state as version 1 in the revision table.
    await req.pool.execute(
      `INSERT INTO lease_template_revision
         (id, template_id, version, body_html, header_html, footer_html, edited_by)
       VALUES (?, ?, 1, ?, ?, ?, ?)`,
      [newId(), id, body_html || null, header_html || null, footer_html || null, userId || null]
    );

    // Set which properties this template is allowed on.
    await applyPropertyAllowlist(req.pool, orgId, id, property_ids);

    logActivity(req, { action: 'CREATE', entityType: 'LEASE_TEMPLATE', entityId: id }).catch(() => {});
    ok(res, { id });
  } catch (err) {
    console.error('[lease-template] create error:', err);
    fail(res, 'Failed to create template');
  }
});

// ─────────────────────────────────────────────────────────────────────────
// PUT /:id — update; snapshots prior version into lease_template_revision
// ─────────────────────────────────────────────────────────────────────────
router.put('/:id', async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const userId = req.user.id;
    const id = req.params.id;
    const {
      name, description, body_html, header_html, footer_html, page_size, is_default,
      property_ids,
    } = req.body || {};

    // Load current state (need to snapshot it before overwriting).
    const [[cur]] = await req.pool.execute(
      `SELECT * FROM lease_template WHERE id = ? AND org_id = ? AND deleted_at IS NULL LIMIT 1`,
      [id, orgId]
    );
    if (!cur) return fail(res, 'Template not found', 404);

    // Snapshot the existing version into the revision table.
    await req.pool.execute(
      `INSERT INTO lease_template_revision
         (id, template_id, version, body_html, header_html, footer_html, edited_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [newId(), id, cur.version, cur.body_html, cur.header_html, cur.footer_html, userId || null]
    );

    // Build dynamic SET clause.
    const sets = ['version = version + 1', 'updated_at = NOW()'];
    const params = [];
    if (name !== undefined)        { sets.push('name = ?');        params.push(String(name).trim()); }
    if (description !== undefined) { sets.push('description = ?'); params.push(description || null); }
    if (body_html !== undefined)   { sets.push('body_html = ?');   params.push(body_html || null); }
    if (header_html !== undefined) { sets.push('header_html = ?'); params.push(header_html || null); }
    if (footer_html !== undefined) { sets.push('footer_html = ?'); params.push(footer_html || null); }
    if (page_size !== undefined)   { sets.push('page_size = ?');   params.push(page_size || 'A4'); }
    if (is_default !== undefined)  { sets.push('is_default = ?');  params.push(is_default ? 1 : 0); }
    params.push(id, orgId);

    await req.pool.execute(
      `UPDATE lease_template SET ${sets.join(', ')}
        WHERE id = ? AND org_id = ?`,
      params
    );

    // If now-default, unset others.
    if (is_default) {
      await req.pool.execute(
        `UPDATE lease_template SET is_default = 0
          WHERE org_id = ? AND id != ? AND deleted_at IS NULL`,
        [orgId, id]
      );
    }

    // Re-apply this template's property allowlist.
    await applyPropertyAllowlist(req.pool, orgId, id, property_ids);

    logActivity(req, { action: 'UPDATE', entityType: 'LEASE_TEMPLATE', entityId: id }).catch(() => {});
    ok(res, { updated: true });
  } catch (err) {
    console.error('[lease-template] update error:', err);
    fail(res, 'Failed to update template');
  }
});

// ─────────────────────────────────────────────────────────────────────────
// POST /:id/duplicate — clone a template (new id, version reset to 1)
// ─────────────────────────────────────────────────────────────────────────
router.post('/:id/duplicate', async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const userId = req.user.id;
    const [[cur]] = await req.pool.execute(
      `SELECT * FROM lease_template WHERE id = ? AND org_id = ? AND deleted_at IS NULL LIMIT 1`,
      [req.params.id, orgId]
    );
    if (!cur) return fail(res, 'Template not found', 404);

    const id = newId();
    await req.pool.execute(
      `INSERT INTO lease_template
         (id, org_id, name, description, body_html, header_html, footer_html,
          page_size, is_default, status, version, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1, 1, ?)`,
      [
        id, orgId, `${cur.name} (copy)`, cur.description,
        cur.body_html, cur.header_html, cur.footer_html,
        cur.page_size, userId || null,
      ]
    );
    await req.pool.execute(
      `INSERT INTO lease_template_revision
         (id, template_id, version, body_html, header_html, footer_html, edited_by)
       VALUES (?, ?, 1, ?, ?, ?, ?)`,
      [newId(), id, cur.body_html, cur.header_html, cur.footer_html, userId || null]
    );
    logActivity(req, { action: 'DUPLICATE', entityType: 'LEASE_TEMPLATE', entityId: id }).catch(() => {});
    ok(res, { id });
  } catch (err) {
    console.error('[lease-template] duplicate error:', err);
    fail(res, 'Failed to duplicate template');
  }
});

// ─────────────────────────────────────────────────────────────────────────
// POST /:id/set-default — flag this template as the org's default
// ─────────────────────────────────────────────────────────────────────────
router.post('/:id/set-default', async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const id = req.params.id;
    const [[row]] = await req.pool.execute(
      `SELECT id FROM lease_template WHERE id = ? AND org_id = ? AND deleted_at IS NULL LIMIT 1`,
      [id, orgId]
    );
    if (!row) return fail(res, 'Template not found', 404);
    await req.pool.execute(
      `UPDATE lease_template SET is_default = (id = ?) WHERE org_id = ? AND deleted_at IS NULL`,
      [id, orgId]
    );
    ok(res, { default_id: id });
  } catch (err) {
    console.error('[lease-template] set-default error:', err);
    fail(res, 'Failed to set default');
  }
});

// ─────────────────────────────────────────────────────────────────────────
// POST /:id/preview — render saved template with sample data, returns PDF
// ─────────────────────────────────────────────────────────────────────────
router.post('/:id/preview', async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const pdf = await renderer.renderTemplatePreview({
      pool: req.pool, orgId, templateId: req.params.id,
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="template-preview.pdf"');
    res.end(pdf);
  } catch (err) {
    console.error('[lease-template] preview error:', err);
    fail(res, err.message || 'Preview failed');
  }
});

// ─────────────────────────────────────────────────────────────────────────
// DELETE /:id — soft archive
// ─────────────────────────────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const id = req.params.id;
    const [r] = await req.pool.execute(
      `UPDATE lease_template SET deleted_at = NOW(), status = 0
        WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
      [id, orgId]
    );
    if (!r.affectedRows) return fail(res, 'Template not found', 404);
    // Drop this template from every property's allowlist.
    await req.pool.execute(
      `DELETE FROM property_lease_template WHERE org_id = ? AND template_id = ?`,
      [orgId, id]
    );
    logActivity(req, { action: 'DELETE', entityType: 'LEASE_TEMPLATE', entityId: id }).catch(() => {});
    ok(res, { deleted: true });
  } catch (err) {
    console.error('[lease-template] delete error:', err);
    fail(res, 'Failed to delete template');
  }
});

module.exports = router;
