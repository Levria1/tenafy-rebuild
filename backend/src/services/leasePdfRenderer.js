/**
 * Lease PDF renderer — fills a lease template with real lease data, then runs
 * it through headless Chromium (Puppeteer) to produce a PDF buffer.
 *
 * Two entry points:
 *   - renderFromTemplate({ pool, orgId, leaseId, templateId })
 *       → real PDF for a specific lease. Used by the e-sign send flow and the
 *         lease-detail "Generate PDF" button.
 *
 *   - renderTemplatePreview({ pool, orgId, templateId })
 *       → preview PDF using SAMPLE data (alice@example.com, etc.). Used by the
 *         template editor's "Preview" button so staff can iterate without a
 *         real lease record.
 *
 * Puppeteer note: a single shared browser instance is reused across renders
 * (cold-start is ~1s, kept warm afterwards). Each render gets its own page.
 *
 * If Puppeteer fails to launch (missing system libs on the droplet, etc.) the
 * caller gets a clear error rather than a generic 500 — most common cause is
 * `apt install libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0
 *  libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0
 *  libcairo2 libasound2` not having been run.
 */

const puppeteer = require('puppeteer');
const { substitute, sampleContext } = require('./leaseTemplateVariables');

let _browserPromise = null;

async function getBrowser() {
  if (!_browserPromise) {
    _browserPromise = puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    }).catch(err => {
      // Reset so the next attempt can retry (browser launch may be transient).
      _browserPromise = null;
      throw err;
    });
  }
  return _browserPromise;
}

// Wrap the template's body in a full HTML document with sensible defaults.
// Header / footer are rendered separately by Puppeteer via headerTemplate /
// footerTemplate options (so they repeat on every page).
function wrapBody(bodyHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <style>
    /* NOTE: do NOT declare @page { margin } / @page { size } here.
       Chrome's print engine lets a CSS @page margin OVERRIDE Puppeteer's
       page.pdf({ margin }) option — an @page margin:0 here silently zeroed
       the 50px/60px page margins and rendered every lease edge-to-edge.
       Page size + margins are owned solely by the page.pdf() options below. */
    html, body { margin: 0; padding: 0; }
    body {
      font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
      font-size: 11pt;
      line-height: 1.5;
      color: #222;
    }
    /* Quill's default output classes — keep typography sensible */
    h1, h2, h3 { color: #1a3c8f; margin-top: 1.2em; margin-bottom: 0.5em; }
    h1 { font-size: 18pt; }
    h2 { font-size: 14pt; }
    h3 { font-size: 12pt; }
    p { margin: 0 0 0.7em 0; }
    ul, ol { margin: 0 0 0.7em 1.5em; padding: 0; }
    table { border-collapse: collapse; margin: 0.5em 0; }
    table td, table th { border: 1px solid #ccc; padding: 4px 8px; }
    .page-break { page-break-after: always; }
  </style>
</head>
<body>${bodyHtml}</body>
</html>`;
}

function wrapHeaderFooter(html, kind) {
  // Puppeteer's header/footer templates run in a separate context with tiny
  // default font and require explicit styling. Empty templates require ANY
  // wrapper element, otherwise Puppeteer renders nothing.
  if (!html || !html.trim()) return `<div></div>`;
  return `<div style="font-size: 9pt; color: #666; width: 100%; padding: 0 50px;
                     text-align: center; font-family: Helvetica, Arial, sans-serif;">
            ${html}
          </div>`;
}

// ───────────────────────────────────────────────────────────────────────────
// Real-data renderer
// ───────────────────────────────────────────────────────────────────────────
async function renderFromTemplate({ pool, orgId, leaseId, templateId }) {
  // Fetch the template
  const [[tpl]] = await pool.execute(
    `SELECT id, body_html, header_html, footer_html, page_size, version
       FROM lease_template
      WHERE id = ? AND org_id = ? AND deleted_at IS NULL
      LIMIT 1`,
    [templateId, orgId]
  );
  if (!tpl) throw new Error('Template not found');

  // Fetch the full lease context
  const ctx = await loadLeaseContext(pool, orgId, leaseId);
  // Real render: signature anchors emit invisible markers (not the visible
  // dashed preview placeholders) so the stamper can locate them after signing.
  ctx.realRender = true;

  // Substitute placeholders
  const body   = substitute(tpl.body_html   || '', ctx);
  const header = substitute(tpl.header_html || '', ctx);
  const footer = substitute(tpl.footer_html || '', ctx);

  const pdfBuffer = await renderHtmlToPdf({ body, header, footer, pageSize: tpl.page_size });

  // Stamp which template + version was used onto the lease for audit.
  await pool.execute(
    `UPDATE leasing SET template_id = ?, template_version_used = ? WHERE id = ?`,
    [tpl.id, tpl.version, leaseId]
  );

  return { pdfBuffer, templateId: tpl.id, version: tpl.version };
}

// ───────────────────────────────────────────────────────────────────────────
// Preview renderer (sample data, no lease required)
// ───────────────────────────────────────────────────────────────────────────
async function renderTemplatePreview({ pool, orgId, templateId }) {
  const [[tpl]] = await pool.execute(
    `SELECT body_html, header_html, footer_html, page_size
       FROM lease_template
      WHERE id = ? AND org_id = ? AND deleted_at IS NULL
      LIMIT 1`,
    [templateId, orgId]
  );
  if (!tpl) throw new Error('Template not found');

  const ctx = sampleContext();
  const body   = substitute(tpl.body_html   || '', ctx);
  const header = substitute(tpl.header_html || '', ctx);
  const footer = substitute(tpl.footer_html || '', ctx);

  return renderHtmlToPdf({ body, header, footer, pageSize: tpl.page_size });
}

// Preview without saving — caller passes the editor's current HTML directly.
// Used so staff can see changes BEFORE clicking Save.
async function renderInlinePreview({ body_html, header_html, footer_html, page_size }) {
  const ctx = sampleContext();
  const body   = substitute(body_html   || '', ctx);
  const header = substitute(header_html || '', ctx);
  const footer = substitute(footer_html || '', ctx);
  return renderHtmlToPdf({ body, header, footer, pageSize: page_size || 'A4' });
}

// ───────────────────────────────────────────────────────────────────────────
// Lease-context loader
// ───────────────────────────────────────────────────────────────────────────
async function loadLeaseContext(pool, orgId, leaseId) {
  const [[lease]] = await pool.execute(
    `SELECT l.*,
            t.id   AS tenant_id_row, t.first_name, t.last_name, t.company_name,
            t.email, t.phone, t.id_card, t.type AS tenant_type,
            u.id   AS unit_id_row,   u.name AS unit_name, u.beds, u.baths, u.size,
            p.id   AS property_id_row, p.display_name AS property_name,
            p.street_address, p.district, p.city
       FROM leasing l
       LEFT JOIN tenant   t ON l.tenant_id  = t.id
       LEFT JOIN unit     u ON l.unit_id    = u.id
       LEFT JOIN property p ON u.property_id = p.id
      WHERE l.id = ? AND p.org_id = ?
      LIMIT 1`,
    [leaseId, orgId]
  );
  if (!lease) throw new Error('Lease not found');

  const [additionalTenants] = await pool.execute(
    `SELECT t.first_name, t.last_name, t.company_name, t.type
       FROM leasing_additional_tenant lat
       JOIN tenant t ON t.id = lat.tenant_id
      WHERE lat.leasing_id = ?`,
    [leaseId]
  );

  const [orgRows] = await pool.execute(
    'SELECT * FROM org_setting WHERE org_id = ? LIMIT 1',
    [orgId]
  ).catch(() => [[]]);
  const org = (orgRows && orgRows[0]) || {};

  const [currencyRows] = await pool.execute(
    'SELECT symbol FROM currency WHERE org_id = ? AND is_current = 1 LIMIT 1',
    [orgId]
  ).catch(() => [[]]);
  const currency = (currencyRows && currencyRows[0] && currencyRows[0].symbol) || 'HK$';

  return {
    lease,
    tenant: {
      first_name:  lease.first_name,
      last_name:   lease.last_name,
      company_name: lease.company_name,
      email:       lease.email,
      phone:       lease.phone,
      id_card:     lease.id_card,
      type:        lease.tenant_type,
    },
    additionalTenants,
    unit: {
      name:  lease.unit_name,
      beds:  lease.beds,
      baths: lease.baths,
      size:  lease.size,
    },
    property: {
      display_name:   lease.property_name,
      street_address: lease.street_address,
      district:       lease.district,
      city:           lease.city,
    },
    org,
    today: new Date(),
    currency,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Low-level: HTML → PDF via Puppeteer
// ───────────────────────────────────────────────────────────────────────────
async function renderHtmlToPdf({ body, header, footer, pageSize }) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(wrapBody(body), { waitUntil: 'networkidle0' });
    const hasHeaderOrFooter = (header && header.trim()) || (footer && footer.trim());
    const pdf = await page.pdf({
      format: pageSize || 'A4',
      printBackground: true,
      displayHeaderFooter: !!hasHeaderOrFooter,
      headerTemplate: hasHeaderOrFooter ? wrapHeaderFooter(header, 'header') : '<div></div>',
      footerTemplate: hasHeaderOrFooter ? wrapHeaderFooter(footer, 'footer') : '<div></div>',
      margin: { top: '60px', bottom: '60px', left: '50px', right: '50px' },
    });
    return pdf;
  } finally {
    await page.close().catch(() => {});
  }
}

module.exports = {
  renderFromTemplate,
  renderTemplatePreview,
  renderInlinePreview,
};
