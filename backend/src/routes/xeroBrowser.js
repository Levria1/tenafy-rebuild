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
    res.json({ code: 200, data: binding ? { ...binding, org_id: String(req.user.orgId) } : null });
  } catch (err) { error(res, err); }
});

// Currency_id can point to a historical FX table. This explicit attestation
// concerns the denomination of invoice/lease amounts, not an FX conversion.
router.put('/currency', requireSuperAdmin, async (req, res) => {
  let conn;
  try {
    const { currency_id: id, currency_code: code, confirm_invoice_lease_currency: confirmed } = req.body || {};
    if (typeof id !== 'string' || !/^\d{1,20}$/.test(id) || typeof code !== 'string' || !/^[A-Z]{3}$/.test(code) || confirmed !== true) {
      throw Object.assign(new Error('Supply currency_id, an ISO currency_code, and confirm_invoice_lease_currency=true after verifying the stored amounts.'), { status: 400 });
    }
    service.currencyDigits(code);
    conn = await req.pool.getConnection(); await conn.beginTransaction();
    const [[row]] = await conn.execute('SELECT id,detail FROM currency WHERE id=? AND org_id=? FOR UPDATE', [id, req.user.orgId]);
    if (!row) throw Object.assign(new Error('Currency record is not in this organisation.'), { status: 404 });
    let detail;
    try { detail = typeof row.detail === 'string' ? JSON.parse(row.detail) : row.detail; }
    catch { throw Object.assign(new Error('Currency record needs review.'), { status: 409 }); }
    if (detail?.code && detail.code !== code) throw Object.assign(new Error('Currency code conflicts with this record.'), { status: 409 });
    const [existing] = await conn.execute(`SELECT currency_id,currency_code FROM xero_browser_currency_binding
      WHERE org_id=? AND (currency_id=? OR currency_code=?) FOR UPDATE`, [req.user.orgId, id, code]);
    if (existing.some(b => String(b.currency_id) !== id || b.currency_code !== code)) throw Object.assign(new Error('An existing currency binding conflicts. Review it before changing denominations.'), { status: 409 });
    await conn.execute(`INSERT INTO xero_browser_currency_binding (org_id,currency_id,currency_code,updated_by)
      VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE updated_by=VALUES(updated_by)`, [req.user.orgId, id, code, req.user.id]);
    await conn.commit();
    await logActivity(req, { action: 'UPDATE', entityType: 'XERO_BROWSER_CURRENCY', entityId: id,
      description: 'Verified invoice/lease amount currency for browser reconciliation.' });
    res.json({ code: 200, data: { currency_id: id, currency_code: code } });
  } catch (err) {
    if (conn) await conn.rollback(); error(res, err);
  } finally { if (conn) conn.release(); }
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
