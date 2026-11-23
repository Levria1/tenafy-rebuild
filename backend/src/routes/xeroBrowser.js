const express = require('express');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const { authenticate, requirePermission, requireSuperAdmin } = require('../middleware/auth');
const { logActivity } = require('../utils/activityLog');
const service = require('../services/xeroBrowserLookup');
const slips = require('../services/xeroPaymentSlips');
const { getCatalog } = require('../services/xeroBankCatalog');
const { resolveHistoryScope } = require('../services/switchboardHistorySearch');
const { getMasterPool } = require('../config/poolRegistry');
const router = express.Router();

// Bound unauthenticated traffic before auth/session and permission DB reads.
// Express trusts only the local reverse proxy; use the library's IP key here.
router.use(rateLimit({ windowMs: 60000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false,
  message: { code: 429, message: 'Too many requests. Please wait before retrying.' } }));
router.use(authenticate);
router.use((req, res, next) => {
  if (!req.pool || !req.user?.id || !req.user.orgId || req.user.isMasterAdmin) return res.status(403).json({ code: 403, message: 'An authorised staff organisation is required.' });
  res.setHeader('Cache-Control', 'no-store');
  next();
});
// Lookup/history/binding reads do not create or approve payments. Accounting
// viewers can use them; configuration writes below still require Super Admin.
router.use(requirePermission('LANDLORD/ACCOUNTING_LIST', 'LANDLORD/ACCOUNTING_CREATE'));
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

router.get('/accounts', async (req, res) => {
  try { res.json({ code:200, data:await getCatalog(req.pool, String(req.user.orgId)) }); }
  catch (err) { error(res, err); }
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
    const result = await service.lookup(req.pool, String(req.user.orgId), req.body, {
      getHistoryScope: () => resolveHistoryScope(req.pool, String(req.user.orgId), getMasterPool()),
      findSlips: (mapping, statement) => slips.candidates(req.pool, String(req.user.orgId), mapping, statement),
    });
    res.json({ code: 200, data: result });
  } catch (err) { error(res, err); }
});

const slipWrite = requirePermission('LANDLORD/ACCOUNTING_CREATE');
const uploadSlip = multer({
  storage: multer.memoryStorage(), limits: { fileSize: slips.MAX_BYTES, files: 1, fields: 3, fieldSize: 1024 },
}).single('slip');
router.post('/slips', slipWrite, (req,res,next) => {
  uploadSlip(req,res,err => {
    if (!err) return next();
    const code = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    res.status(code).json({ code, message: 'Upload one PNG, JPEG or PDF slip up to 5 MB.' });
  });
}, async (req,res) => {
  try {
    if (req.body?.expected_org_id !== String(req.user.orgId)) {
      return res.status(409).json({ code:409,message:'Your Tenafy organisation changed. Reconnect before importing.' });
    }
    const data = await slips.importSlip(req.pool,String(req.user.orgId),req.user.id,req.file,req.body);
    res.json({ code:200,data });
  } catch (err) { error(res,err); }
});

router.post('/slips/:id/verify', slipWrite, async (req,res) => {
  try {
    const data = await slips.verify(req.pool,String(req.user.orgId),req.params.id,req.user.id,req.body);
    res.json({ code:200,data });
  } catch (err) { error(res,err); }
});

function sendSlip(res, file) {
  res.json({ code:200,data:{ name:file.name,type:file.type,size:file.bytes.length,
    sha256:file.hash.toLowerCase(),base64:file.bytes.toString('base64') } });
}

router.get('/slips/:id/original', async (req,res) => {
  try { sendSlip(res,await slips.original(req.pool,String(req.user.orgId),req.params.id)); }
  catch (err) { error(res,err); }
});

router.post('/slips/:id/approve', slipWrite, async (req,res) => {
  try {
    const org = String(req.user.orgId);
    if (req.body?.expected_org_id !== org || req.body.confirmed !== true) {
      return res.status(409).json({ code:409,message:'Confirm the slip against the bank line in the active organisation.' });
    }
    const statement = service.validateStatement(req.body.statement);
    const mapping = await service.resolveMapping(req.pool,org,service.slug(req.body.ui_org_slug),
      service.normalizeAccountId(req.body.xero_account_id),statement);
    const invoiceId = req.body.invoice_id ?? null;
    if (invoiceId !== null) {
      if (typeof invoiceId !== 'string' || !/^\d{1,20}$/.test(invoiceId)) {
        return res.status(400).json({ code:400,message:'Invalid invoice.' });
      }
      const invoices = await service.sourcesFor(mapping,statement).fetchInvoices(req.pool,org,statement);
      if (!invoices.some(invoice=>invoice.id===invoiceId)) {
        return res.status(409).json({ code:409,message:'That invoice is no longer a verified lead for this bank line.' });
      }
    }
    sendSlip(res,await slips.approve(req.pool,org,req.user.id,req.params.id,mapping,statement,invoiceId));
  } catch (err) { error(res,err); }
});

router.post('/history', async (req, res) => {
  try {
    const result = await service.searchHistory(req.pool, String(req.user.orgId), req.body, {
      getHistoryScope: () => resolveHistoryScope(req.pool, String(req.user.orgId), getMasterPool()),
    });
    res.json({ code: 200, data: result });
  } catch (err) { error(res, err); }
});

module.exports = router;
