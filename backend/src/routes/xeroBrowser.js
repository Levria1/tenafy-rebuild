const express = require('express');
const rateLimit = require('express-rate-limit');
const { authenticate, requirePermission, requireSuperAdmin } = require('../middleware/auth');
const { logActivity } = require('../utils/activityLog');
const service = require('../services/xeroBrowserLookup');
const router = express.Router();

router.use(authenticate);
router.use((req, res, next) => {
  if (!req.pool || !req.user?.id || !req.user.orgId || req.user.isMasterAdmin) return res.status(403).json({ code: 403, message: 'An authorised staff organisation is required.' });
  res.setHeader('Cache-Control', 'no-store');
  next();
});
router.use(requirePermission('LANDLORD/ACCOUNTING_CREATE'));
router.use(rateLimit({ windowMs: 60000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false,
  keyGenerator: req => `${req.user.orgId}:${req.user.id}`,
  message: { code: 429, message: 'Too many reconciliation lookups. Please wait.' } }));

function error(res, err) {
  if (!err.status) console.error('[xero-browser] operation failed:', err.code || 'unknown');
  res.status(err.status || 500).json({ code: err.status || 500,
    message: err.status ? err.message : 'Lookup unavailable. Check the browser mapping and migration status.' });
}

router.get('/binding', async (req, res) => {
  try {
    const [[binding]] = await req.pool.execute('SELECT ui_org_slug,xero_tenant_id,updated_at FROM xero_browser_binding WHERE org_id=?', [req.user.orgId]);
    res.json({ code: 200, data: binding || null });
  } catch (err) { error(res, err); }
});

// Explicit configuration only. A UI slug is never inferred from a display name
// or treated as the API tenant ID. This does not create/refresh a Xero connection.
router.put('/binding', requireSuperAdmin, async (req, res) => {
  let conn;
  try {
    const uiSlug = service.slug(req.body?.ui_org_slug);
    const tenantId = req.body?.xero_tenant_id;
    if (typeof tenantId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenantId)) {
      throw Object.assign(new Error('Supply the verified Xero API tenant ID.'), { status: 400 });
    }
    conn = await req.pool.getConnection();
    await conn.beginTransaction();
    const [[connection]] = await conn.execute('SELECT xero_tenant_id FROM xero_connection WHERE org_id=? FOR UPDATE', [req.user.orgId]);
    if (!connection || service.normalizeAccountId(connection.xero_tenant_id) !== service.normalizeAccountId(tenantId)) throw Object.assign(new Error('API tenant ID does not match this organisation’s Xero connection.'), { status: 409 });
    await conn.execute(`INSERT INTO xero_browser_binding (org_id,ui_org_slug,xero_tenant_id,updated_by)
      VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE ui_org_slug=VALUES(ui_org_slug),xero_tenant_id=VALUES(xero_tenant_id),updated_by=VALUES(updated_by)`,
    [req.user.orgId, uiSlug, connection.xero_tenant_id, req.user.id]);
    await conn.commit();
    await logActivity(req, { action: 'UPDATE', entityType: 'XERO_BROWSER_BINDING', entityId: String(req.user.orgId),
      description: 'Configured explicit Xero UI organisation mapping.' });
    res.json({ code: 200, data: { ui_org_slug: uiSlug, xero_tenant_id: connection.xero_tenant_id } });
  } catch (err) {
    if (conn) await conn.rollback();
    error(res, err);
  } finally { if (conn) conn.release(); }
});

router.post('/lookup', async (req, res) => {
  try {
    // org_id and bank/currency IDs in a browser payload never select scope.
    const result = await service.lookup(req.pool, String(req.user.orgId), req.body);
    res.json({ code: 200, data: result });
  } catch (err) { error(res, err); }
});

module.exports = router;
