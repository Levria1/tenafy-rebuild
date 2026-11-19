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
const {parseLayout,upgradeTemplate}=require('../services/tenantTemplateBlocks');
const layoutValue=value=>value==null?null:JSON.stringify(parseLayout(value));

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

// Pure transform of the editor's unsaved HTML. Staff preview both tenant counts
// before saving a new version; this endpoint never writes a template.
router.post('/tenant-upgrade', (req,res)=>{
  try{ok(res,upgradeTemplate(req.body?.body_html));}
  catch(e){fail(res,e.message,e.status||400);}
});

// ─────────────────────────────────────────────────────────────────────────
// POST /preview — inline render from editor HTML (no save required)
// Body: { body_html, header_html?, footer_html?, page_size? }
// Returns: PDF binary
// ─────────────────────────────────────────────────────────────────────────
router.post('/preview', async (req, res) => {
  try {
    const { body_html, header_html, footer_html, page_size, tenant_layout, tenant_count } = req.body || {};
    if (!body_html) return fail(res, 'body_html is required', 400);
    const pdf = await renderer.renderInlinePreview({ body_html, header_html, footer_html, page_size, tenant_layout, tenant_count });
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
      property_ids, tenant_layout,
    } = req.body || {};
    if (!name || !String(name).trim()) return fail(res, 'name is required', 400);
    const layout=layoutValue(tenant_layout);

    const id = newId();
    await req.pool.execute(
      `INSERT INTO lease_template
         (id, org_id, name, description, body_html, header_html, footer_html,
          page_size, is_default, status, version, created_by,tenant_layout)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?,?)`,
      [
        id, orgId, String(name).trim(), description || null,
        body_html || null, header_html || null, footer_html || null,
        page_size || 'A4', is_default ? 1 : 0, userId || null,layout,
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
         (id, template_id, version, body_html, header_html, footer_html, edited_by,tenant_layout)
       VALUES (?, ?, 1, ?, ?, ?, ?,?)`,
      [newId(), id, body_html || null, header_html || null, footer_html || null, userId || null,layout]
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
  let conn;
  try {
    const orgId=req.user.orgId,userId=req.user.id,id=req.params.id;
    const b=req.body||{};
    const layout=b.tenant_layout===undefined?undefined:layoutValue(b.tenant_layout);
    conn=await req.pool.getConnection();await conn.beginTransaction();
    const [[cur]]=await conn.execute('SELECT * FROM lease_template WHERE id=? AND org_id=? AND deleted_at IS NULL FOR UPDATE',[id,orgId]);
    if(!cur)throw Object.assign(new Error('Template not found'),{status:404});
    if(b.expected_version!==undefined&&Number(b.expected_version)!==Number(cur.version))throw Object.assign(new Error('Template changed. Reload it before saving this upgrade.'),{status:409});
    if(b.tenant_layout!==undefined&&b.expected_version===undefined)throw Object.assign(new Error('Reload the template before changing its tenant layout.'),{status:409});
    await conn.execute(`INSERT INTO lease_template_revision
      (id,template_id,version,body_html,header_html,footer_html,edited_by,tenant_layout)
      VALUES (?,?,?,?,?,?,?,?)`,[newId(),id,cur.version,cur.body_html,cur.header_html,cur.footer_html,userId||null,layoutValue(cur.tenant_layout)]);
    const sets=['version=version+1','updated_at=NOW()'],params=[];
    for(const key of ['name','description','body_html','header_html','footer_html','page_size','is_default']){
      if(b[key]===undefined)continue;
      sets.push(`${key}=?`);
      params.push(key==='is_default'?(b[key]?1:0):key==='name'?String(b[key]).trim():b[key]||(key==='page_size'?'A4':null));
    }
    if(layout!==undefined){sets.push('tenant_layout=?');params.push(layout);}
    await conn.execute(`UPDATE lease_template SET ${sets.join(', ')} WHERE id=? AND org_id=?`,[...params,id,orgId]);
    if(b.is_default)await conn.execute('UPDATE lease_template SET is_default=0 WHERE org_id=? AND id!=? AND deleted_at IS NULL',[orgId,id]);
    await applyPropertyAllowlist(conn,orgId,id,b.property_ids);
    await conn.commit();
    logActivity(req,{action:'UPDATE',entityType:'LEASE_TEMPLATE',entityId:id}).catch(()=>{});
    ok(res,{updated:true,version:Number(cur.version)+1});
  } catch(err) {
    if(conn)await conn.rollback();
    if(!err.status)console.error('[lease-template] update error:',err.code||'unknown');
    fail(res,err.status?err.message:'Failed to update template',err.status||500);
  } finally {if(conn)conn.release();}
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
          page_size, is_default, status, version, created_by,tenant_layout)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1, 1, ?,?)`,
      [
        id, orgId, `${cur.name} (copy)`, cur.description,
        cur.body_html, cur.header_html, cur.footer_html,
        cur.page_size, userId || null,layoutValue(cur.tenant_layout),
      ]
    );
    await req.pool.execute(
      `INSERT INTO lease_template_revision
         (id, template_id, version, body_html, header_html, footer_html, edited_by,tenant_layout)
       VALUES (?, ?, 1, ?, ?, ?, ?,?)`,
      [newId(), id, cur.body_html, cur.header_html, cur.footer_html, userId || null,layoutValue(cur.tenant_layout)]
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
