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

// Loaded lazily via dynamic import(), not require().
//
// puppeteer ships as ESM. A top-level require() of it throws ERR_REQUIRE_ESM below
// Node 22.12, so merely importing this module — or anything reaching it, such as
// routes/pdf.js — failed outright. Moving that require() inside the function is NOT
// enough: it only defers the same throw to the first render. import() works on
// every supported version.
//
// `mod.default || mod` because an ESM namespace puts the default export on
// `.default`, and reading `.launch` straight off the namespace yields undefined.
//
// The promise is cached so concurrent first calls share one load, and cleared on
// failure so a transient error does not poison every later attempt.
let _puppeteerPromise = null;
function loadPuppeteer() {
  if (!_puppeteerPromise) {
    _puppeteerPromise = import('puppeteer')
      .then(mod => {
        const p = mod.default || mod;
        if (!p || typeof p.launch !== 'function') {
          throw new Error('puppeteer loaded but has no launch(); unexpected module shape');
        }
        return p;
      })
      .catch(err => { _puppeteerPromise = null; throw err; });
  }
  return _puppeteerPromise;
}
const {
  substitute, sampleContext, applyTermOverride, applyPageBreakMarkers, findEmptyPlaceholders,
} = require('./leaseTemplateVariables');

let _browserPromise = null;

async function getBrowser() {
  const puppeteer = await loadPuppeteer();
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
// Quill often stores text with a `&nbsp;` between every word (from pasted copy).
// `&nbsp;` is NON-breaking, so long lines can't wrap and overflow the page (text
// gets clipped on the right). Convert only a GENUINE word-separator `&nbsp;`
// (a lone one with an alphanumeric character on BOTH sides) back to a normal
// space so prose wraps. Everything else stays non-breaking:
//   - runs of 2+ `&nbsp;` (intentional column/indent spacing), and
//   - a `&nbsp;` next to underscores or a tag boundary (the signature LINE —
//     `____&nbsp;</u>` — which must stay on one line or the two-column
//     landlord/tenant signature layout wraps and breaks).
function softenNbsp(html) {
  const s = String(html || '');
  // A neighbour is "content" (letter, digit, punctuation, accented char, …) as
  // long as it isn't a marker of intentional/structural nbsp: `_` (signature
  // underscore line), `<`/`>` (tag boundary) or `&` (adjacent entity). Convert a
  // lone nbsp with content on BOTH sides (a real word separator) to a space.
  const content = (ch) => !!ch && !'<>&_'.includes(ch);
  return s.replace(/&nbsp;/g, (m, off) => {
    if (s.slice(off - 6, off) === '&nbsp;' || s.slice(off + 6, off + 12) === '&nbsp;') return '&nbsp;';
    return (content(s[off - 1]) && content(s[off + 6])) ? ' ' : '&nbsp;';
  });
}

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
    /* ── WYSIWYG with the Quill editor ─────────────────────────────────────
       These values MIRROR quill.snow.css, which is what the author sees while
       editing:
           .ql-editor                    { line-height: 1.42 }
           .ql-editor p, ol, h1…h6       { margin: 0; padding: 0 }
       Previously this stylesheet added a 0.7em bottom margin to EVERY paragraph
       and used line-height 1.5. The editor has neither, so a block of one-line
       paragraphs (Schedule I is ~15 of them) gained an extra ~7.7pt per row —
       about an inch and a half of phantom space in that schedule alone, and a
       whole document ~19% taller than what the author laid out. Blank-line
       spacers were hit twice (1.2em min-height PLUS the 0.7em margin = 1.9em
       against the editor's 1.42em).
       Do NOT reintroduce paragraph margins here: spacing belongs to the author's
       blank lines, not to the renderer. */
    html, body { margin: 0; padding: 0; }
    body {
      font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
      font-size: 11pt;
      line-height: 1.42;
      color: #222;
    }
    /* Quill's default output classes — keep typography sensible */
    h1, h2, h3 { color: #1a3c8f; margin: 0; padding: 0; }
    h1 { font-size: 18pt; }
    h2 { font-size: 14pt; }
    h3 { font-size: 12pt; }
    p { margin: 0; padding: 0; }
    /* Empty paragraphs are the templates' blank-line spacers. Without this they
       have no content, so their margins "collapse through" and a run of them
       renders as almost no space — which let stamped signatures (drawn upward
       from their anchor line) overlap the text above. One empty paragraph must
       equal exactly ONE editor line, hence 1.42em to match line-height above. */
    p:empty { min-height: 1.42em; }
    ul, ol { margin: 0 0 0 1.5em; padding: 0; }
    table { border-collapse: collapse; margin: 0.5em 0; }
    table td, table th { border: 1px solid #ccc; padding: 4px 8px; }
    /* Emitted by applyPageBreakMarkers from a {{PAGE_BREAK}} marker in the
       template. break-after is the modern alias; keep both for Chrome. */
    .page-break { page-break-after: always; break-after: page; }
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
async function renderFromTemplate({ pool, orgId, leaseId, templateId, stamp = true, term = null }) {
  // Fetch the template
  const [[tpl]] = await pool.execute(
    `SELECT id, name, body_html, header_html, footer_html, page_size, version
       FROM lease_template
      WHERE id = ? AND org_id = ? AND deleted_at IS NULL
      LIMIT 1`,
    [templateId, orgId]
  );
  if (!tpl) throw new Error('Template not found');

  // Fetch the full lease context
  const ctx = await loadLeaseContext(pool, orgId, leaseId);
  // Documents that cover ONE period of the tenancy print that period, not the
  // lease's own dates. No-op when no term is supplied.
  applyTermOverride(ctx, term);
  // Real render: signature anchors emit invisible markers (not the visible
  // dashed preview placeholders) so the stamper can locate them after signing.
  ctx.realRender = true;

  // Substitute placeholders, then convert {{PAGE_BREAK}} markers. Body only —
  // headers and footers repeat on every page, so a break there is meaningless.
  const body   = applyPageBreakMarkers(substitute(tpl.body_html || '', ctx));
  const header = substitute(tpl.header_html || '', ctx);
  const footer = substitute(tpl.footer_html || '', ctx);

  // Which fields printed as blanks. Reported alongside the PDF so the caller can warn
  // BEFORE a contract goes out with an empty identification line, rather than someone
  // spotting it in the signed copy.
  const emptyPlaceholders = findEmptyPlaceholders(
    [tpl.body_html, tpl.header_html, tpl.footer_html], ctx);

  const pdfBuffer = await renderHtmlToPdf({ body, header, footer, pageSize: tpl.page_size });

  // Stamp which template + version was used onto the lease for audit. Skipped
  // for read-only renders (e.g. the "View Lease" button) — merely viewing a
  // lease shouldn't rewrite its audit trail; only the e-sign send flow does.
  if (stamp) {
    await pool.execute(
      `UPDATE leasing SET template_id = ?, template_version_used = ? WHERE id = ?`,
      [tpl.id, tpl.version, leaseId]
    );
  }

  return { pdfBuffer, templateId: tpl.id, version: tpl.version, emptyPlaceholders };
}

// ───────────────────────────────────────────────────────────────────────────
// Preview renderer (sample data, no lease required)
// ───────────────────────────────────────────────────────────────────────────
async function renderTemplatePreview({ pool, orgId, templateId }) {
  const [[tpl]] = await pool.execute(
    `SELECT name, body_html, header_html, footer_html, page_size
       FROM lease_template
      WHERE id = ? AND org_id = ? AND deleted_at IS NULL
      LIMIT 1`,
    [templateId, orgId]
  );
  if (!tpl) throw new Error('Template not found');

  const ctx = sampleContext();
  // Same page-break handling as the real render, so the editor's Preview button
  // shows the pagination staff will actually get.
  const body   = applyPageBreakMarkers(substitute(tpl.body_html || '', ctx));
  const header = substitute(tpl.header_html || '', ctx);
  const footer = substitute(tpl.footer_html || '', ctx);

  return renderHtmlToPdf({ body, header, footer, pageSize: tpl.page_size });
}

// Preview without saving — caller passes the editor's current HTML directly.
// Used so staff can see changes BEFORE clicking Save.
async function renderInlinePreview({ body_html, header_html, footer_html, page_size }) {
  const ctx = sampleContext();
  // Markers must convert here too, or "Preview" before saving would show
  // different pagination from the saved template.
  const body   = applyPageBreakMarkers(substitute(body_html || '', ctx));
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
            t.id   AS tenant_id_row, t.first_name, t.middle_name, t.last_name, t.company_name,
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
    `SELECT t.first_name, t.middle_name, t.last_name, t.company_name, t.type
       FROM leasing_additional_tenant lat
       JOIN tenant t ON t.id = lat.tenant_id
      WHERE lat.leasing_id = ?`,
    [leaseId]
  );

  // `org_setting` does not exist in any org DB (no migration ever created it), so
  // this query always threw and the `.catch` always produced {} — every LANDLORD_*
  // variable has therefore rendered blank since day one. The Landlord group is now
  // hidden from the Insert-Variable menu (leaseTemplateVariables.HIDDEN_GROUPS) and
  // no template references it, so keep the empty context object and skip the query.
  const org = {};

  const [currencyRows] = await pool.execute(
    'SELECT symbol FROM currency WHERE org_id = ? AND is_current = 1 LIMIT 1',
    [orgId]
  ).catch(() => [[]]);
  const currency = (currencyRows && currencyRows[0] && currencyRows[0].symbol) || 'HK$';

  return {
    lease,
    tenant: {
      first_name:  lease.first_name,
      middle_name: lease.middle_name,
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
    await page.setContent(wrapBody(softenNbsp(body)), { waitUntil: 'networkidle0' });
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

// Exported for tests: proves the ESM loader resolves to something with launch(),
// without paying for an actual browser launch.
module.exports = {
  renderFromTemplate,
  renderTemplatePreview,
  renderInlinePreview,
  applyTermOverride,
};

// Exported for tests: proves the ESM loader resolves to something with launch(),
// without paying for an actual browser launch.
module.exports.loadPuppeteer = loadPuppeteer;
