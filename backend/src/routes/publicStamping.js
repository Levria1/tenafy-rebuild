const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const { orgTimeSql } = require('../utils/orgTime');
const { buildSigningRows } = require('../utils/signingTracker');
const { clampTrackerFrom, loadSigningTrackerInputs } = require('../services/signingTrackerData');
const { buildStampingPayload, computeTerm, isUnderOneMonth } = require('../services/stampingPayload');

const UPLOADS_DIR = path.join(__dirname, '../../uploads');

function fail(res, message, status = 500) {
  return res.status(status).json({ code: status, message });
}

/**
 * The template text the landlord's name and BR number are read from (they exist
 * nowhere else in Tenafy — each entity's number is typed into its own templates).
 *
 * The EXACT version the document was generated from: the live row if the template
 * is still at that version, otherwise the snapshot in lease_template_revision (an
 * edit snapshots the outgoing version there). A deleted template still counts — the
 * contract was signed with it. Some versions were snapshotted twice; take the latest.
 *
 * Only when the document records no template (a paper signing) fall back to the
 * property's allowed templates, which the payload uses only if they all agree.
 */
async function loadLandlordTemplates(pool, orgId, templateId, templateVersion, propertyId) {
  const html = r => (r ? [r.header_html, r.body_html, r.footer_html].filter(Boolean).join(' ') : null);
  if (templateId != null && templateVersion != null) {
    const [[live]] = await pool.execute(
      `SELECT header_html, body_html, footer_html FROM lease_template
        WHERE id = ? AND org_id = ? AND version = ? LIMIT 1`,
      [String(templateId), orgId, Number(templateVersion)]
    );
    if (live) return { signedTemplateHtml: html(live), propertyTemplateHtmls: [] };
    const [[snap]] = await pool.execute(
      `SELECT r.header_html, r.body_html, r.footer_html
         FROM lease_template_revision r
         JOIN lease_template t ON t.id = r.template_id
        WHERE r.template_id = ? AND r.version = ? AND t.org_id = ?
        ORDER BY r.edited_at DESC, r.id DESC LIMIT 1`,
      [String(templateId), Number(templateVersion), orgId]
    );
    if (snap) return { signedTemplateHtml: html(snap), propertyTemplateHtmls: [] };
  }
  const [rows] = await pool.execute(
    `SELECT lt.header_html, lt.body_html, lt.footer_html
       FROM property_lease_template plt
       JOIN lease_template lt ON lt.id = plt.template_id
      WHERE plt.property_id = ? AND plt.org_id = ? AND lt.org_id = ? AND lt.deleted_at IS NULL`,
    [String(propertyId), orgId, orgId]
  );
  return { signedTemplateHtml: null, propertyTemplateHtmls: rows.map(html) };
}

async function loadSignedRequestContext(pool, orgId, requestId) {
  const [[row]] = await pool.execute(
    `SELECT sr.id, sr.lease_id, sr.status, sr.signature_method, sr.signed_file_id,
            sr.template_id, sr.template_version,
            DATE_FORMAT(sr.term_start, '%Y-%m-%d') AS term_start,
            DATE_FORMAT(sr.term_end, '%Y-%m-%d') AS term_end,
            DATE_FORMAT(sr.term_stamp_end, '%Y-%m-%d') AS term_stamp_end,
            DATE_FORMAT(${orgTimeSql('sr.completed_at')}, '%Y-%m-%d') AS completed_at,
            l.id AS lease_id, l.lease_no,
            DATE_FORMAT(l.start_date, '%Y-%m-%d') AS start_date,
            DATE_FORMAT(l.end_date, '%Y-%m-%d') AS end_date,
            DATE_FORMAT(l.stamp_end_date, '%Y-%m-%d') AS stamp_end_date,
            l.price, l.amount, l.invoicing, l.credits,
            u.id AS unit_id, u.name AS unit_name, u.account_name AS unit_account_name,
            p.id AS property_id, p.display_name AS property_name, p.street_address, p.district,
            p.landlord_name,
            t.id AS tenant_id, t.first_name, t.last_name, t.company_name, t.id_card, t.id_type
       FROM signature_request sr
       JOIN leasing l ON sr.lease_id = l.id
       JOIN unit u ON l.unit_id = u.id
       JOIN property p ON u.property_id = p.id
       LEFT JOIN tenant t ON l.tenant_id = t.id
      WHERE sr.id = ? AND sr.org_id = ? AND sr.status = 3
        AND p.org_id = ? AND l.deleted_at IS NULL
      LIMIT 1`,
    [requestId, orgId, orgId]
  );
  if (!row) return null;

  const [[lease], [unit], [property], [primaryTenant]] = [
    [{
      id: row.lease_id, lease_no: row.lease_no, start_date: row.start_date, end_date: row.end_date,
      stamp_end_date: row.stamp_end_date, price: row.price, amount: row.amount,
      invoicing: row.invoicing, credits: row.credits,
    }],
    [{ id: row.unit_id, name: row.unit_name, account_name: row.unit_account_name }],
    [{
      id: row.property_id, display_name: row.property_name, street_address: row.street_address,
      district: row.district, landlord_name: row.landlord_name,
    }],
    row.tenant_id ? [{
      id: row.tenant_id, first_name: row.first_name, last_name: row.last_name,
      company_name: row.company_name, id_card: row.id_card, id_type: row.id_type,
    }] : [null],
  ];

  const [additionalTenants] = await pool.execute(
    `SELECT t.id, t.first_name, t.last_name, t.company_name, t.id_card, t.id_type
       FROM leasing_additional_tenant lat
       JOIN tenant t ON t.id = lat.tenant_id
      WHERE lat.leasing_id = ? AND t.deleted_at IS NULL
      ORDER BY t.id ASC`,
    [String(lease.id)]
  );

  const [revisions] = await pool.execute(
    `SELECT id, DATE_FORMAT(effective_from, '%Y-%m-%d') AS effective_from, price, deleted_at
       FROM lease_revision
      WHERE lease_id = ? AND deleted_at IS NULL
      ORDER BY effective_from ASC`,
    [String(lease.id)]
  );

  const { signedTemplateHtml, propertyTemplateHtmls } =
    await loadLandlordTemplates(pool, orgId, row.template_id, row.template_version, row.property_id);

  return {
    signedTemplateHtml,
    propertyTemplateHtmls,
    request: {
      id: row.id, lease_id: row.lease_id, status: row.status, signature_method: row.signature_method,
      signed_file_id: row.signed_file_id, term_start: row.term_start, term_end: row.term_end,
      term_stamp_end: row.term_stamp_end, completed_at: row.completed_at,
    },
    lease,
    unit,
    property,
    tenants: [primaryTenant, ...additionalTenants].filter(Boolean),
    revisions,
  };
}

// GET /api/public/stamping/queue?signed_since=YYYY-MM-DD
// Uses the same loader and row builder as the staff tracker so the bot never sees
// a different signing universe from the dashboard humans use.
router.get('/queue', async (req, res) => {
  try {
    const from = clampTrackerFrom(req.query.signed_since);
    const { leases, documents } = await loadSigningTrackerInputs(req.pool, req.apiKey.orgId, from);
    const signed = buildSigningRows({ leases, documents, from, now: new Date() })
      .filter(row => row.signed_status === 'signed');

    // Tenancies under one calendar month are not stamped. Measure the STAMPED term —
    // the same computeTerm the payload uses — not the tracker's period, which ignores
    // term_stamp_end / leasing.stamp_end_date.
    const terms = new Map();
    const ids = signed.map(row => String(row.request_id));
    for (let offset = 0; offset < ids.length; offset += 500) {
      const chunk = ids.slice(offset, offset + 500);
      const [termRows] = await req.pool.execute(
        `SELECT sr.id,
                DATE_FORMAT(sr.term_start, '%Y-%m-%d') AS term_start,
                DATE_FORMAT(sr.term_end, '%Y-%m-%d') AS term_end,
                DATE_FORMAT(sr.term_stamp_end, '%Y-%m-%d') AS term_stamp_end,
                DATE_FORMAT(l.start_date, '%Y-%m-%d') AS start_date,
                DATE_FORMAT(l.end_date, '%Y-%m-%d') AS end_date,
                DATE_FORMAT(l.stamp_end_date, '%Y-%m-%d') AS stamp_end_date
           FROM signature_request sr
           JOIN leasing l ON l.id = sr.lease_id
          WHERE sr.org_id = ? AND sr.id IN (${chunk.map(() => '?').join(',')})`,
        [req.apiKey.orgId, ...chunk]
      );
      for (const t of termRows) terms.set(String(t.id), computeTerm(t, t));
    }
    const underOneMonth = row => {
      const term = terms.get(String(row.request_id));
      return Boolean(term && isUnderOneMonth(term.start, term.end));
    };
    const excluded = signed.filter(underOneMonth).length;

    const rows = signed
      .filter(row => !underOneMonth(row))
      .map(row => ({
        request_id: String(row.request_id),
        lease_id: String(row.lease_id),
        lease_no: row.lease_no || null,
        property_name: row.property_name || null,
        unit_name: row.unit_name || null,
        tenant_name: row.tenant_name || null,
        period_start: row.period_start || null,
        period_end: row.period_end || null,
        period_recorded: row.period_recorded,
        signed_method: row.signed_method || null,
        signed_at: row.signed_at || null,
      }));
    res.json({ code: 200, data: { from, rows, excluded_under_one_month: excluded } });
  } catch (err) {
    console.error('[public/stamping queue] error:', err);
    res.status(500).json({ code: 500, message: 'Failed to load stamping queue' });
  }
});

// GET /api/public/stamping/:request_id/document
router.get('/:request_id/document', async (req, res) => {
  try {
    const ctx = await loadSignedRequestContext(req.pool, req.apiKey.orgId, req.params.request_id);
    if (!ctx || !ctx.request.signed_file_id) return res.status(404).send('Not found');
    const [[file]] = await req.pool.execute(
      `SELECT filename, item_name FROM file WHERE id = ? LIMIT 1`,
      [ctx.request.signed_file_id]
    );
    if (!file) return res.status(404).send('PDF not found');
    const filePath = path.join(UPLOADS_DIR, file.item_name);
    if (!fs.existsSync(filePath)) return res.status(404).send('PDF file missing on disk');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${file.filename || 'lease.pdf'}"`);
    fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    console.error('[public/stamping document] error:', err);
    res.status(500).send('Failed to load PDF');
  }
});

// GET /api/public/stamping/:request_id
router.get('/:request_id', async (req, res) => {
  try {
    const ctx = await loadSignedRequestContext(req.pool, req.apiKey.orgId, req.params.request_id);
    if (!ctx) return fail(res, 'Signature request not found', 404);
    res.json({ code: 200, data: buildStampingPayload(ctx) });
  } catch (err) {
    console.error('[public/stamping payload] error:', err);
    res.status(500).json({ code: 500, message: 'Failed to load stamping payload' });
  }
});

module.exports = router;
