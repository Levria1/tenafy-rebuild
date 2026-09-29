const express = require('express');
const router = express.Router();
const PDFDocument = require('pdfkit');
const { authenticate } = require('../middleware/auth');
const { renderFromTemplate } = require('../services/leasePdfRenderer');
const { resolveLeaseTemplateId } = require('../services/leaseTemplateResolver');
const { orgToday, ORG_TIME_ZONE } = require('../utils/orgTime');
const { collapseDuplicateNote } = require('../utils/paymentNote');
const { rentPeriodNote } = require('../utils/rentPeriodNote');


// Org-level info for document headers.
//
// These four call sites used to read `SELECT * FROM org_setting`, a table that has
// NEVER existed in any org DB — no migration creates it. Every call therefore threw
// straight into its `.catch(() => [[]])` and produced `{}`, which is why org fields
// rendered blank: on invoices the company line was simply omitted, and on receipts
// `titleText = companyName || 'RECEIPT'` meant the document was titled with the
// literal word "RECEIPT".
//
// The real table is `organization`, keyed by `id` (not `org_id`). It carries
// display_name + default_currency but no contact_person / address / logo, so those
// reads stay undefined exactly as before. The company name on invoices and receipts
// now comes from `unit.account_name || property.landlord_name` (migration 032)
// rather than from here.
const ORG_INFO_SQL =
  'SELECT display_name AS company_name, default_currency FROM organization WHERE id = ? LIMIT 1';

// Renders an INSTANT in the operator's zone. Bare calendar dates (due_on,
// payment_date) must NOT go through this — they carry no timezone and a
// conversion would slide them a day.
const fmtInstantHk = (d) => d ? new Date(d).toLocaleDateString('en-US', {
  year: 'numeric', month: 'long', day: 'numeric', timeZone: ORG_TIME_ZONE,
}) : '-';

// Helper: draw a horizontal line
function hLine(doc, y, margin = 50) {
  doc.moveTo(margin, y).lineTo(doc.page.width - margin, y).strokeColor('#cccccc').lineWidth(0.5).stroke();
}

// Helper: section header
function sectionHeader(doc, text, y) {
  doc.rect(50, y, doc.page.width - 100, 20).fill('#f0f4ff');
  doc.fillColor('#1a3c8f').fontSize(10).font('Helvetica-Bold').text(text, 58, y + 5);
  doc.fillColor('#333333').font('Helvetica');
  return y + 25;
}

// Helper: two-column row
function row(doc, label, value, y, labelX = 58, valueX = 220) {
  doc.fontSize(9).font('Helvetica-Bold').fillColor('#666666').text(label, labelX, y);
  doc.fontSize(9).font('Helvetica').fillColor('#333333').text(String(value || '-'), valueX, y);
}

// ─────────────────────────────────────────────────────────────────────────────
// Invoice PDF — shared loader + renderer
// ─────────────────────────────────────────────────────────────────────────────
async function loadInvoicePdfData(pool, id, orgId) {
  const [invoices] = await pool.execute(
    `SELECT i.*,
            t.first_name as tenant_first_name, t.last_name as tenant_last_name,
            t.email as tenant_email, t.phone as tenant_phone,
            t.company_name as tenant_company_name, t.type as tenant_type,
            u.name as unit_name, u.account_name as unit_account_name,
            p.display_name as property_name, p.street_address as property_address,
            p.city as property_city, p.state as property_state,
            p.currency as property_currency, p.landlord_name as property_landlord_name,
            cs.name AS category_name,
            l.invoicing AS lease_invoicing, l.due_date AS lease_due_day,
            l.start_date AS lease_start, l.end_date AS lease_end
     FROM invoice i
     LEFT JOIN tenant t ON i.tenant_id = t.id
     LEFT JOIN unit u ON i.unit_id = u.id
     LEFT JOIN property p ON COALESCE(i.property_id, u.property_id) = p.id
     LEFT JOIN category_setting cs ON cs.id = i.category
     LEFT JOIN leasing l ON l.id = i.leasing_id AND l.deleted_at IS NULL
     WHERE i.id = ? AND i.org_id = ? AND i.deleted_at IS NULL`,
    [id, orgId]
  );
  if (invoices.length === 0) return null;
  const inv = invoices[0];
  if (/Rental Income/i.test(inv.category_name || '') && inv.lease_start) {
    inv.derived_note = rentPeriodNote({
      dueOn: inv.due_on,
      invoicing: inv.lease_invoicing,
      dueDay: inv.lease_due_day,
      leaseStart: inv.lease_start,
      leaseEnd: inv.lease_end,
    });
  }

  let amountPaid = 0;
  if (inv.invoice_code) {
    const [paidRows] = await pool.execute(
      `SELECT COALESCE(SUM(al.amount), 0) AS paid
       FROM accounting_line al
       JOIN accounting a ON al.accounting_id = a.id
       WHERE al.invoice_code = ? AND a.org_id = ?
         AND a.deleted_at IS NULL AND al.deleted_at IS NULL`,
      [inv.invoice_code, orgId]
    );
    amountPaid = parseFloat(paidRows?.[0]?.paid) || 0;
  }
  const amountTotal = parseFloat(inv.amount) || 0;
  const outstanding = Math.max(0, amountTotal - amountPaid);

  const [orgRows] = await pool.execute(ORG_INFO_SQL, [orgId]).catch(() => [[]]);
  const org = orgRows?.[0] || {};

  return { inv, org, amountTotal, amountPaid, outstanding };
}

function renderInvoicePdf(doc, { inv, org, amountTotal, amountPaid, outstanding }) {
  // Unit-level account name wins, then the property's landlord entity. `org` came
  // from the non-existent `org_setting` table, so it was ALWAYS '' — see migration 032.
  const companyName = inv.unit_account_name || inv.property_landlord_name || '';
  const currencyCode = inv.property_currency || org.default_currency || 'USD';
  const currSymbol = { USD: '$', HKD: 'HK$', GBP: '£', EUR: '€', SGD: 'S$', AUD: 'A$', CAD: 'C$', NZD: 'NZ$', MYR: 'RM', PHP: '₱', THB: '฿', JPY: '¥', CNY: '¥', KRW: '₩', INR: '₹', AED: 'AED ' }[currencyCode] || (currencyCode + ' ');
  const fmtCurr = (v) => `${currSymbol}${Number(v || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const fmtDate = (d) => d ? new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : '-';
  // For true instants (created_at) only. These are absolute moments, so without an
  // explicit zone they render in the server's — printing the previous day on a
  // tenant's invoice for anything raised before 08:00 Hong Kong. due_on is NOT an
  // instant: it is a bare calendar date and must keep using fmtDate.
  const fmtInstant = (d) => d ? new Date(d).toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric', timeZone: ORG_TIME_ZONE,
  }) : '-';

  const invoiceNo = inv.invoice_code || inv.id;
  const today = new Date();
  const dueDate = inv.due_on ? new Date(inv.due_on) : null;
  let statusText = 'OPEN';
  let statusColor = '#faad14';
  if (inv.status === 1 || (amountPaid >= amountTotal && amountTotal > 0)) {
    statusText = 'PAID';
    statusColor = '#52c41a';
  } else if (inv.status === 2 || (dueDate && dueDate < today && outstanding > 0)) {
    statusText = 'OVERDUE';
    statusColor = '#ff4d4f';
  }

  const W = doc.page.width;
  const M = 40;
  const CW = W - M * 2;

  let y = 25;
  if (org.logo) {
    try {
      const fs = require('fs');
      const path = require('path');
      const logoPath = path.join(__dirname, '../../uploads', org.logo);
      if (fs.existsSync(logoPath)) {
        doc.image(logoPath, M, y, { height: 45 });
      }
    } catch (e) { /* skip logo on error */ }
    y += 55;
  } else {
    y += 10;
  }

  doc.rect(0, y, W, 65).fill('#f0f0f0');
  doc.fillColor('#333333').fontSize(24).font('Helvetica-Bold').text('Invoice', M, y + 12);
  if (companyName) {
    doc.fillColor('#666666').fontSize(10).font('Helvetica').text(companyName, M, y + 40);
  }
  doc.fillColor('#333333').fontSize(11).font('Helvetica-Bold')
     .text(`Date: ${inv.created_at ? fmtInstant(inv.created_at) : (inv.due_on ? fmtDate(inv.due_on) : fmtInstant(new Date()))}`, W - M - 220, y + 15, { width: 220, align: 'right' });
  doc.fillColor('#666666').fontSize(9).font('Helvetica')
     .text(`Invoice: #${invoiceNo}`, W - M - 220, y + 36, { width: 220, align: 'right' });

  y += 80;

  const badgeW = statusText.length * 6 + 16;
  doc.rect(M, y, badgeW, 18).fill(statusColor);
  doc.fillColor('#ffffff').fontSize(9).font('Helvetica-Bold')
     .text(statusText, M, y + 4, { width: badgeW, align: 'center' });
  y += 30;

  const halfW = CW / 2;
  doc.rect(M, y, halfW - 2, 80).fill('#f8f9fb');
  doc.rect(M + halfW + 2, y, halfW - 2, 80).fill('#f8f9fb');

  doc.fillColor('#1a3c8f').fontSize(8).font('Helvetica-Bold').text('BILLED TO', M + 12, y + 8);
  const tenantName = inv.tenant_type === 1
    ? (inv.tenant_company_name || `${inv.tenant_first_name || ''} ${inv.tenant_last_name || ''}`.trim())
    : `${inv.tenant_first_name || ''} ${inv.tenant_last_name || ''}`.trim();
  doc.fillColor('#333333').fontSize(9).font('Helvetica')
     .text(tenantName || '-', M + 12, y + 22)
     .text(inv.tenant_email || '', M + 12, y + 35)
     .text(inv.tenant_phone || '', M + 12, y + 48);

  doc.fillColor('#1a3c8f').fontSize(8).font('Helvetica-Bold').text('PROPERTY / UNIT', M + halfW + 14, y + 8);
  const addressParts = [inv.property_address, inv.property_city, inv.property_state].filter(Boolean).join(', ');
  doc.fillColor('#333333').fontSize(9).font('Helvetica')
     .text(inv.property_name || '-', M + halfW + 14, y + 22)
     .text(inv.unit_name ? `Unit ${inv.unit_name}` : '', M + halfW + 14, y + 35)
     .text(addressParts || '', M + halfW + 14, y + 48, { width: halfW - 30 });

  y += 95;

  doc.rect(M, y, CW, 22).fill('#f0f0f0');
  doc.fillColor('#333333').fontSize(9).font('Helvetica-Bold')
     .text('DESCRIPTION', M + 10, y + 6)
     .text('INVOICE #', M + CW * 0.55, y + 6)
     .text('AMOUNT', M + CW - 80, y + 6, { width: 70, align: 'right' });
  y += 22;

  doc.rect(M, y, CW, 28).fill('#ffffff');
  doc.fillColor('#333333').fontSize(9).font('Helvetica')
     .text(inv.note || inv.derived_note || 'Invoice', M + 10, y + 8, { width: CW * 0.5 - 10 })
     .text(invoiceNo, M + CW * 0.55, y + 8)
     .font('Helvetica-Bold')
     .text(fmtCurr(amountTotal), M + CW - 80, y + 8, { width: 70, align: 'right' });
  y += 28;

  doc.moveTo(M, y).lineTo(M + CW, y).strokeColor('#e8e8e8').lineWidth(0.5).stroke();
  y += 15;

  const totalsX = M + CW - 220;
  const totalsW = 220;
  const totalsRow = (label, value, bold) => {
    const f = bold ? 'Helvetica-Bold' : 'Helvetica';
    const sz = bold ? 12 : 10;
    doc.fillColor(bold ? '#333333' : '#555555').fontSize(sz).font(f)
       .text(label, totalsX, y, { width: totalsW / 2 })
       .text(value, totalsX + totalsW / 2, y, { width: totalsW / 2, align: 'right' });
    y += bold ? 22 : 16;
  };

  totalsRow('Amount:', fmtCurr(amountTotal), false);
  totalsRow('Amount Paid:', fmtCurr(amountPaid), false);
  doc.moveTo(totalsX, y).lineTo(totalsX + totalsW, y).strokeColor('#333333').lineWidth(1.5).stroke();
  y += 8;
  totalsRow('Outstanding:', fmtCurr(outstanding), true);

  y += 10;
  doc.moveTo(M, y).lineTo(M + CW, y).strokeColor('#e8e8e8').lineWidth(0.5).stroke();
  y += 15;

  const detailCols = [];
  if (inv.due_on) detailCols.push({ label: 'DUE DATE', value: fmtDate(inv.due_on) });
  detailCols.push({ label: 'INVOICE #', value: invoiceNo });
  detailCols.push({ label: 'STATUS', value: statusText });
  const colWidth = CW / detailCols.length;
  detailCols.forEach((col, i) => {
    const x = M + (i * colWidth);
    doc.fillColor('#999999').fontSize(8).font('Helvetica-Bold').text(col.label, x, y);
    doc.fillColor('#333333').fontSize(10).font('Helvetica').text(col.value, x, y + 12);
  });
}

router.get('/invoice/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;
    const data = await loadInvoicePdfData(req.pool, id, orgId);
    if (!data) return res.status(404).json({ code: 404, message: 'Invoice not found' });

    const invoiceNo = data.inv.invoice_code || id;
    const doc = new PDFDocument({ margin: 0, size: 'A4' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="invoice-${invoiceNo}.pdf"`);
    doc.pipe(res);
    renderInvoicePdf(doc, data);
    doc.end();
  } catch (error) {
    console.error('Generate invoice PDF error:', error);
    if (!res.headersSent) res.status(500).json({ code: 500, message: 'Failed to generate PDF' });
  }
});

async function generateInvoicePdfBuffer(pool, id, orgId) {
  const data = await loadInvoicePdfData(pool, id, orgId);
  if (!data) throw new Error('Invoice not found');
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 0, size: 'A4' });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    renderInvoicePdf(doc, data);
    doc.end();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/pdf/lease/:id  —  Generate lease PDF
// ─────────────────────────────────────────────────────────────────────────────
router.get('/lease/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;

    const [leases] = await req.pool.execute(
      `SELECT l.*,
              t.first_name as tenant_first_name, t.last_name as tenant_last_name,
              t.email as tenant_email, t.phone as tenant_phone, t.id_card,
              u.name as unit_name, u.beds, u.baths, u.size,
              p.id as property_id,
              p.display_name as property_name, p.street_address as property_address
       FROM leasing l
       LEFT JOIN tenant t ON l.tenant_id = t.id
       LEFT JOIN unit u ON l.unit_id = u.id
       LEFT JOIN property p ON u.property_id = p.id
       WHERE l.id = ? AND p.org_id = ?`,
      [id, orgId]
    );

    if (leases.length === 0) {
      return res.status(404).json({ code: 404, message: 'Lease not found' });
    }

    const lease = leases[0];

    // ── "View Lease": render the real lease template filled with this lease's ──
    // data (same document the e-sign flow produces). No e-signature required —
    // this is a read-only, on-the-fly render (nothing stored, lease not stamped).
    // Falls through to the hand-drawn Basic PDF below when no template resolves
    // or the HTML→PDF render fails, so this endpoint never errors out.
    // `?template_id=` lets the e-sign review screen preview THIS lease against the
    // template being chosen in its dropdown (it previously rendered the template's
    // sample data, so the real dates — including the stamped Term of Tenancy —
    // were never visible before sending). Validated against the property allowlist.
    const requestedTemplateId = req.query.template_id || null;
    // The preview must show the same period the signature request will send, or
    // staff approve a document that differs from the one the signer receives.
    const previewTerm = (req.query.term_start && req.query.term_end)
      ? {
          start_date: String(req.query.term_start).slice(0, 10),
          end_date: String(req.query.term_end).slice(0, 10),
          stamp_end_date: req.query.term_stamp_end
            ? String(req.query.term_stamp_end).slice(0, 10) : null,
        }
      : null;
    try {
      const templateId = await resolveLeaseTemplateId(req.pool, orgId, lease, requestedTemplateId);
      if (templateId) {
        const { pdfBuffer, emptyPlaceholders } = await renderFromTemplate({
          pool: req.pool, orgId, leaseId: id, templateId, stamp: false, term: previewTerm,
        });
        // The body is a PDF, so the warning rides on a header the preview caller can read
        // without a second request. Names only — never the values.
        if (emptyPlaceholders && emptyPlaceholders.length) {
          res.setHeader('X-Empty-Placeholders', emptyPlaceholders.map(e => e.key).join(','));
          res.setHeader('Access-Control-Expose-Headers', 'X-Empty-Placeholders');
        }
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="lease-${id}.pdf"`);
        return res.end(pdfBuffer);
      }
      // An explicitly requested template that isn't permitted for this property must
      // NOT quietly become the generic Basic PDF — that reads as a successful render
      // of the wrong document. Only the no-request path falls through.
      if (requestedTemplateId) {
        return res.status(400).json({
          code: 400,
          message: 'That template is not available for this property',
        });
      }
    } catch (err) {
      console.error('View Lease template render failed — falling back to Basic PDF:', err.message);
    }

    // ── Fallback: generic hand-drawn Basic PDF (org has no lease template) ─────
    // Org info: `organization`, not the phantom `org_setting` — see ORG_INFO_SQL note above.
    const [orgRows] = await req.pool.execute(ORG_INFO_SQL, [orgId]).catch(() => [[]]);
    const org = orgRows?.[0] || {};
    const fmtDate = (d) => d ? new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : '-';
    const fmtCurr = (v) => `$${Number(v || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}`;

    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="lease-${id}.pdf"`);
    doc.pipe(res);

    // ── Header ──────────────────────────────────────────────────────────────
    doc.rect(0, 0, doc.page.width, 80).fill('#1a3c8f');
    doc.fillColor('#ffffff').fontSize(22).font('Helvetica-Bold').text('LEASE AGREEMENT', 50, 22);
    doc.fontSize(10).font('Helvetica').text(org.company_name || 'Property Management', 50, 50);
    doc.fontSize(9).text(`Generated: ${new Date().toLocaleDateString('en-US', { timeZone: ORG_TIME_ZONE })}`, doc.page.width - 200, 50, { width: 150, align: 'right' });

    let y = 100;

    // ── Status ──────────────────────────────────────────────────────────────
    // Compute active status from dates, not stored status column
    const today = orgToday();
    const start = lease.start_date ? new Date(lease.start_date).toISOString().split('T')[0] : null;
    const end = lease.end_date ? new Date(lease.end_date).toISOString().split('T')[0] : null;
    const isActive = !lease.deleted_at && (!start || start <= today) && (!end || end >= today);
    doc.rect(50, y, 70, 18).fill(isActive ? '#52c41a' : '#ff4d4f');
    doc.fillColor('#ffffff').fontSize(9).font('Helvetica-Bold')
       .text(isActive ? 'ACTIVE LEASE' : 'INACTIVE', 52, y + 4, { width: 66, align: 'center' });
    y += 30;

    // ── Parties ──────────────────────────────────────────────────────────────
    y = sectionHeader(doc, 'PARTIES', y);
    row(doc, 'Landlord / Company:', org.company_name || '-', y); y += 14;
    row(doc, 'Landlord Contact:', org.contact_person || '-', y); y += 14;
    row(doc, 'Tenant Name:', `${lease.tenant_first_name || ''} ${lease.tenant_last_name || ''}`.trim(), y); y += 14;
    row(doc, 'Tenant Email:', lease.tenant_email || '-', y); y += 14;
    row(doc, 'Tenant Phone:', lease.tenant_phone || '-', y); y += 14;
    if (lease.id_card) { row(doc, 'ID / Passport:', lease.id_card, y); y += 14; }
    y += 6;

    // ── Property ────────────────────────────────────────────────────────────
    y = sectionHeader(doc, 'PROPERTY & UNIT', y);
    row(doc, 'Property:', lease.property_name || '-', y); y += 14;
    row(doc, 'Address:', lease.property_address || '-', y); y += 14;
    row(doc, 'Unit:', `${lease.unit_name || '-'}`, y); y += 14;
    if (lease.beds) { row(doc, 'Bedrooms / Bathrooms:', `${lease.beds} / ${lease.baths || '-'}`, y); y += 14; }
    if (lease.size) { row(doc, 'Size:', `${lease.size} sq ft`, y); y += 14; }
    y += 6;

    // ── Lease Terms ──────────────────────────────────────────────────────────
    y = sectionHeader(doc, 'LEASE TERMS', y);
    row(doc, 'Start Date:', fmtDate(lease.start_date), y); y += 14;
    row(doc, 'End Date:', fmtDate(lease.end_date), y); y += 14;
    row(doc, 'Monthly Rent:', fmtCurr(lease.price), y); y += 14;
    if (lease.deposit) { row(doc, 'Security Deposit:', fmtCurr(lease.deposit), y); y += 14; }
    if (lease.invoicing) { row(doc, 'Payment Schedule:', lease.invoicing, y); y += 14; }
    if (lease.payment_method) { row(doc, 'Payment Method:', lease.payment_method, y); y += 14; }
    if (lease.notes) { row(doc, 'Notes:', lease.notes, y); y += 14; }
    y += 6;

    // ── Terms & Conditions ────────────────────────────────────────────────────
    if (doc.y < doc.page.height - 180) {
      y = sectionHeader(doc, 'TERMS & CONDITIONS', y);
      const terms = [
        '1. The Tenant agrees to pay rent on the due date each payment period.',
        '2. The Tenant shall maintain the property in good condition.',
        '3. Subletting is not permitted without written consent from the Landlord.',
        '4. Notice of termination must be given at least 30 days before vacating.',
        '5. The security deposit will be returned within 14 days of the lease end, less any deductions for damages.',
      ];
      terms.forEach(t => {
        doc.fontSize(8.5).font('Helvetica').fillColor('#555555').text(t, 58, y, { width: doc.page.width - 120 });
        y += 13;
      });
      y += 10;
    }

    // ── Signatures ────────────────────────────────────────────────────────────
    if (y < doc.page.height - 100) {
      hLine(doc, y); y += 15;
      doc.fontSize(9).font('Helvetica-Bold').fillColor('#333333').text('SIGNATURES', 50, y); y += 20;
      const sigW = (doc.page.width - 120) / 2;
      doc.fontSize(9).font('Helvetica').fillColor('#555555')
         .text('Landlord Signature:', 50, y).text('Tenant Signature:', 60 + sigW, y); y += 30;
      hLine(doc, y, 50); doc.moveTo(60 + sigW, y).lineTo(60 + sigW + sigW - 10, y).stroke(); y += 15;
      doc.fontSize(8).fillColor('#888888')
         .text(org.contact_person || 'Landlord', 50, y, { width: sigW, align: 'center' })
         .text(`${lease.tenant_first_name || ''} ${lease.tenant_last_name || ''}`.trim(), 60 + sigW, y, { width: sigW, align: 'center' });
      doc.text('Date: _______________', 50, y + 12).text('Date: _______________', 60 + sigW, y + 12);
    }

    // ── Footer ────────────────────────────────────────────────────────────────
    doc.rect(0, doc.page.height - 35, doc.page.width, 35).fill('#f0f4ff');
    doc.fillColor('#888888').fontSize(8).font('Helvetica')
       .text(`Tenafy Property Management | Lease ID: ${id} | ${new Date().toLocaleDateString('en-US', { timeZone: ORG_TIME_ZONE })}`, 50, doc.page.height - 20, { align: 'center', width: doc.page.width - 100 });

    doc.end();
  } catch (error) {
    console.error('Generate lease PDF error:', error);
    if (!res.headersSent) res.status(500).json({ code: 500, message: 'Failed to generate PDF' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Receipt PDF — shared loader + renderer
//
// There used to be two copies of this: one inline in the /receipt route, one in
// generateReceiptPdfBuffer for email. They had already drifted — the route knew
// 16 currency symbols and the email copy only 8, so an INR receipt read "INR 500"
// by email and "₹500" on screen, and the rule under the totals block sat 10pt
// apart between them. The route's version is the canonical one kept here.
//
// `opts.tenantIds` makes the receipt TENANT-SCOPED, for the portal. See
// buildVisibleLines below for why that is not the same as an ownership check.
// ─────────────────────────────────────────────────────────────────────────────

const CURRENCY_SYMBOLS = {
  USD: '$', HKD: 'HK$', GBP: '£', EUR: '€', SGD: 'S$', AUD: 'A$',
  CAD: 'C$', NZD: 'NZ$', MYR: 'RM', PHP: '₱', THB: '฿', JPY: '¥',
  CNY: '¥', KRW: '₩', INR: '₹', AED: 'AED ',
};
const currencySymbol = (code) => CURRENCY_SYMBOLS[code] || (code + ' ');

const RECEIPT_PAYMENT_SQL =
  `SELECT a.*, a.transaction_code, a.payment_date, a.note AS payment_note, a.amount AS header_amount,
          t.first_name AS tenant_first_name, t.last_name AS tenant_last_name,
          t.email AS tenant_email, t.phone AS tenant_phone,
          t.company_name AS tenant_company_name, t.type AS tenant_type,
          pms.payment_method AS payment_method_name
     FROM accounting a
     LEFT JOIN tenant t ON a.tenant_id = t.id
     LEFT JOIN payment_method_setting pms ON a.payment_setting_id = pms.id
    WHERE a.id = ? AND a.org_id = ? AND a.deleted_at IS NULL`;

// `i.tenant_id` is selected purely so the portal can tell whose line this is.
const RECEIPT_LINES_SQL =
  `SELECT al.amount, al.invoice_code,
          i.id AS invoice_id, i.tenant_id AS invoice_tenant_id,
          i.due_on AS invoice_due_on,
          i.amount AS invoice_amount, i.status AS invoice_status, i.note AS invoice_note,
          cs.name AS invoice_category,
          l.invoicing AS lease_invoicing, l.due_date AS lease_due_day,
          l.start_date AS lease_start, l.end_date AS lease_end,
          u.name AS unit_name, u.account_name AS unit_account_name,
          p.display_name AS property_name, p.street_address AS property_address,
          p.city AS property_city, p.state AS property_state,
          p.currency AS property_currency, p.landlord_name AS property_landlord_name
     FROM accounting_line al
     LEFT JOIN invoice i ON i.invoice_code = al.invoice_code AND i.org_id = ? AND i.deleted_at IS NULL
     LEFT JOIN category_setting cs ON cs.id = i.category
     LEFT JOIN leasing l ON l.id = i.leasing_id AND l.deleted_at IS NULL
     LEFT JOIN unit u ON i.unit_id = u.id
     LEFT JOIN property p ON COALESCE(i.property_id, u.property_id) = p.id
    WHERE al.accounting_id = ? AND al.deleted_at IS NULL
    ORDER BY al.id ASC`;

/**
 * Decide which lines of a payment a given tenant may see.
 *
 * A plain ownership check on `accounting.tenant_id` is NOT enough. Tane receives
 * Airbnb payouts through Xero: one bank deposit covering several guests' stays,
 * split into one accounting_line per guest invoice, with the payment's own
 * tenant_id left NULL. Four such rows landed between 20 Jul and 4 Sep 2026
 * (TANE41799, TANE41918, TANE42218, TANE42354), covering nine tenants. A receipt
 * built from the whole payment would show each of them the others' invoice codes
 * and amounts, and the payment note on those rows carries the other guests'
 * names, confirmation codes, nightly rates and Airbnb's service fee.
 *
 * So: keep the lines that are theirs, drop the rest.
 *
 * Orphan lines — an invoice_code matching no surviving invoice, which is most of
 * the pre-migration Xero data — carry no tenant identity, so they cannot be
 * attributed. They ride along only on a payment that is unambiguously this
 * tenant's (their header id, no other tenant's line on it) and are dropped from
 * a scoped receipt otherwise.
 */
function buildVisibleLines(pmt, lines, tenantIds) {
  if (!tenantIds) return lines;               // staff: whole payment, unchanged
  const ids = new Set(tenantIds.map(String));
  const foreign = lines.filter(l => l.invoice_tenant_id && !ids.has(String(l.invoice_tenant_id)));
  const own = lines.filter(l => l.invoice_tenant_id && ids.has(String(l.invoice_tenant_id)));
  const headerTheirs = pmt.tenant_id && ids.has(String(pmt.tenant_id));
  if (foreign.length === 0 && headerTheirs) return lines;
  return own;
}

/**
 * @param {object} [opts]
 * @param {string[]} [opts.tenantIds] Scope to these tenants (tenant portal). The
 *        raw payment note is never printed when set — on a combined payout it is
 *        the note, not the line list, that names other people.
 * @returns {object|null} null when the payment does not exist, or when nothing on
 *        it belongs to the given tenants.
 */
async function loadReceiptPdfData(pool, paymentId, orgId, opts = {}) {
  const tenantIds = opts.tenantIds && opts.tenantIds.length ? opts.tenantIds : null;

  const [paymentRows] = await pool.execute(RECEIPT_PAYMENT_SQL, [paymentId, orgId]);
  if (paymentRows.length === 0) return null;
  const pmt = paymentRows[0];

  const [allLines] = await pool.execute(RECEIPT_LINES_SQL, [orgId, paymentId]);

  // A payment with no lines at all (20 of them in Tane's data) still gets a
  // receipt, synthesised from the header amount — but only for whoever it is
  // actually booked against.
  if (allLines.length === 0 && tenantIds) {
    const ids = new Set(tenantIds.map(String));
    if (!pmt.tenant_id || !ids.has(String(pmt.tenant_id))) return null;
  }

  const lines = buildVisibleLines(pmt, allLines, tenantIds).map((line) => {
    if (/Rental Income/i.test(line.invoice_category || '') && line.lease_start) {
      return {
        ...line,
        derived_note: rentPeriodNote({
          dueOn: line.invoice_due_on,
          invoicing: line.lease_invoicing,
          dueDay: line.lease_due_day,
          leaseStart: line.lease_start,
          leaseEnd: line.lease_end,
        }),
      };
    }
    return line;
  });
  if (tenantIds && allLines.length > 0 && lines.length === 0) return null;

  const [orgRows] = await pool.execute(ORG_INFO_SQL, [orgId]).catch(() => [[]]);
  const org = orgRows?.[0] || {};

  // Company name and the property block come from the VISIBLE lines, so a scoped
  // receipt is headed with the tenant's own property rather than whichever one
  // happened to sort first on the payout.
  const companyName = (lines.length > 0 && (lines[0].unit_account_name || lines[0].property_landlord_name)) || '';
  const firstLine = lines[0] || {};
  const currencyCode = firstLine.property_currency || org.default_currency || 'USD';

  // Receipt number: REC + transaction_code digits
  const receiptNo = `REC${(pmt.transaction_code || '').replace(/^[A-Za-z-]+/, '')}`;

  let paymentAmount = 0;
  lines.forEach(l => { paymentAmount += parseFloat(l.amount) || 0; });
  // The header amount is the whole deposit, so it can only stand in when there
  // were no lines to add up. Falling back to it on a scoped receipt would print
  // the full payout total under the tenant's single line.
  if (paymentAmount === 0 && lines.length === 0) paymentAmount = parseFloat(pmt.header_amount) || 0;

  return {
    pmt, lines, org, companyName, firstLine, receiptNo, paymentAmount,
    currSymbol: currencySymbol(currencyCode),
    allowPaymentNote: !tenantIds,
  };
}

function renderReceiptPdf(doc, data) {
  const { pmt, lines, org, companyName, firstLine, receiptNo, paymentAmount, currSymbol, allowPaymentNote } = data;
  const fmtCurr = (v) => `${currSymbol}${Number(v || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const fmtDate = (d) => d ? new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : '-';

  const W = doc.page.width;   // 595
  const M = 40;               // margin
  const CW = W - M * 2;       // content width

  // ── Company Logo ─────────────────────────────────────────────────────────
  let y = 25;
  if (org.logo) {
    try {
      const fs = require('fs');
      const path = require('path');
      const logoPath = path.join(__dirname, '../../uploads', org.logo);
      if (fs.existsSync(logoPath)) {
        doc.image(logoPath, M, y, { height: 45 });
      }
    } catch (e) { /* skip logo on error */ }
    y += 55;
  } else {
    y += 10;
  }

  // ── Header bar (light grey) ──────────────────────────────────────────────
  doc.rect(0, y, W, 65).fill('#f0f0f0');

  // Left side: Bank account name (from unit.account_name) as title, fallback to RECEIPT
  const titleText = companyName || 'RECEIPT';
  doc.fillColor('#333333').fontSize(24).font('Helvetica-Bold').text(titleText, M, y + 12);
  if (companyName) {
    doc.fillColor('#666666').fontSize(10).font('Helvetica').text(companyName, M, y + 40);
  }

  // Right side: date on top (larger), receipt number below (smaller)
  doc.fillColor('#333333').fontSize(11).font('Helvetica-Bold')
     .text(`Date: ${(pmt.payment_date ? fmtDate(pmt.payment_date) : fmtInstantHk(new Date()))}`, W - M - 200, y + 15, { width: 200, align: 'right' });
  doc.fillColor('#666666').fontSize(9).font('Helvetica')
     .text(`Receipt: #${receiptNo}`, W - M - 200, y + 36, { width: 200, align: 'right' });

  y += 80;

  // ── Status badge ─────────────────────────────────────────────────────────
  doc.rect(M, y, 50, 18).fill('#52c41a');
  doc.fillColor('#ffffff').fontSize(9).font('Helvetica-Bold')
     .text('PAID', M + 2, y + 4, { width: 46, align: 'center' });
  y += 30;

  // ── Info grid: Received From / Property ──────────────────────────────────
  const halfW = CW / 2;
  doc.rect(M, y, halfW - 2, 80).fill('#f8f9fb');
  doc.rect(M + halfW + 2, y, halfW - 2, 80).fill('#f8f9fb');

  // Left: Received From
  doc.fillColor('#1a3c8f').fontSize(8).font('Helvetica-Bold').text('RECEIVED FROM', M + 12, y + 8);
  const tenantName = pmt.tenant_type === 1
    ? (pmt.tenant_company_name || `${pmt.tenant_first_name || ''} ${pmt.tenant_last_name || ''}`.trim())
    : `${pmt.tenant_first_name || ''} ${pmt.tenant_last_name || ''}`.trim();
  doc.fillColor('#333333').fontSize(9).font('Helvetica')
     .text(tenantName || '-', M + 12, y + 22)
     .text(pmt.tenant_email || '', M + 12, y + 35)
     .text(pmt.tenant_phone || '', M + 12, y + 48);

  // Right: Property / Unit
  doc.fillColor('#1a3c8f').fontSize(8).font('Helvetica-Bold').text('PROPERTY / UNIT', M + halfW + 14, y + 8);
  const addressParts = [firstLine.property_address, firstLine.property_city, firstLine.property_state].filter(Boolean).join(', ');
  doc.fillColor('#333333').fontSize(9).font('Helvetica')
     .text(firstLine.property_name || '-', M + halfW + 14, y + 22)
     .text(firstLine.unit_name ? `Unit ${firstLine.unit_name}` : '', M + halfW + 14, y + 35)
     .text(addressParts || '', M + halfW + 14, y + 48, { width: halfW - 30 });

  y += 95;

  // ── Items table ──────────────────────────────────────────────────────────
  doc.rect(M, y, CW, 22).fill('#f0f0f0');
  doc.fillColor('#333333').fontSize(9).font('Helvetica-Bold')
     .text('DESCRIPTION', M + 10, y + 6)
     .text('INVOICE #', M + CW * 0.55, y + 6)
     .text('AMOUNT', M + CW - 80, y + 6, { width: 70, align: 'right' });
  y += 22;

  // One row per line item (usually 1, but could be multiple if payment covers multiple invoices)
  const displayLines = lines.length > 0 ? lines : [{ amount: paymentAmount, invoice_code: pmt.invoice_code, invoice_note: null }];
  const descW = CW * 0.5 - 10;
  displayLines.forEach((line, idx) => {
    // Per-line description: prefer THIS line's invoice note. Only a single-line
    // receipt falls back to the payment's (combined) note — using pmt.payment_note
    // for every line duplicated the whole combined note on each row.
    // collapseDuplicateNote covers notes already stored as "X — X" by an earlier
    // Xero import; the backfill script clears those, this keeps a stale one from
    // reaching a tenant's receipt in the meantime.
    //
    // allowPaymentNote is false for the tenant portal. On a combined Airbnb payout
    // the note is a transcript of every guest's stay on that deposit, so a scoped
    // receipt describes each line from its own invoice or nothing at all.
    const ownNote = line.invoice_note || line.derived_note || line.invoice_category || 'Payment';
    const desc = (allowPaymentNote && displayLines.length === 1)
      ? (collapseDuplicateNote(pmt.payment_note) || ownNote)
      : ownNote;
    // Row height must fit the WRAPPED description — a long note overflowed the
    // fixed 28px row and overlapped the next row / the totals block.
    const descH = doc.fontSize(9).font('Helvetica').heightOfString(desc, { width: descW });
    const rowH = Math.max(28, descH + 14);
    const bg = idx % 2 === 0 ? '#ffffff' : '#fafafa';
    doc.rect(M, y, CW, rowH).fill(bg);
    doc.fillColor('#333333').fontSize(9).font('Helvetica')
       .text(desc, M + 10, y + 8, { width: descW })
       .text(line.invoice_code || '-', M + CW * 0.55, y + 8)
       .font('Helvetica-Bold')
       .text(fmtCurr(line.amount), M + CW - 80, y + 8, { width: 70, align: 'right' });
    y += rowH;
  });

  doc.moveTo(M, y).lineTo(M + CW, y).strokeColor('#e8e8e8').lineWidth(0.5).stroke();
  y += 15;

  // ── Totals (right-aligned) ───────────────────────────────────────────────
  const totalsX = M + CW - 220;
  const totalsW = 220;

  const totalsRow = (label, value, bold) => {
    const f = bold ? 'Helvetica-Bold' : 'Helvetica';
    const sz = bold ? 12 : 10;
    doc.fillColor(bold ? '#333333' : '#555555').fontSize(sz).font(f)
       .text(label, totalsX, y, { width: totalsW / 2 })
       .text(value, totalsX + totalsW / 2, y, { width: totalsW / 2, align: 'right' });
    y += bold ? 22 : 16;
  };

  // Divider before total
  doc.moveTo(totalsX, y).lineTo(totalsX + totalsW, y).strokeColor('#333333').lineWidth(1.5).stroke();
  y += 8;
  totalsRow('Total Received:', fmtCurr(paymentAmount), true);

  y += 10;

  // ── Payment details ──────────────────────────────────────────────────────
  doc.moveTo(M, y).lineTo(M + CW, y).strokeColor('#e8e8e8').lineWidth(0.5).stroke();
  y += 15;

  const detailCols = [];
  if (pmt.payment_method_name) {
    detailCols.push({ label: 'PAYMENT METHOD', value: pmt.payment_method_name });
  }
  if (pmt.payment_date) {
    detailCols.push({ label: 'PAYMENT DATE', value: fmtDate(pmt.payment_date) });
  }
  if (pmt.transaction_code) {
    detailCols.push({ label: 'TRANSACTION CODE', value: pmt.transaction_code });
  }

  if (detailCols.length > 0) {
    const colWidth = CW / detailCols.length;
    detailCols.forEach((col, i) => {
      const x = M + (i * colWidth);
      doc.fillColor('#999999').fontSize(8).font('Helvetica-Bold').text(col.label, x, y);
      doc.fillColor('#333333').fontSize(10).font('Helvetica').text(col.value, x, y + 12);
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/pdf/receipt/:paymentId  —  Generate receipt PDF for a single payment
// Each payment (accounting record) gets its own receipt
// ─────────────────────────────────────────────────────────────────────────────
router.get('/receipt/:paymentId', authenticate, async (req, res) => {
  try {
    const { paymentId } = req.params;
    const data = await loadReceiptPdfData(req.pool, paymentId, req.user.orgId);
    if (!data) return res.status(404).json({ code: 404, message: 'Payment not found' });

    const doc = new PDFDocument({ margin: 0, size: 'A4' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="receipt-${data.receiptNo}.pdf"`);
    doc.pipe(res);
    renderReceiptPdf(doc, data);
    doc.end();
  } catch (error) {
    console.error('Generate receipt PDF error:', error);
    if (!res.headersSent) res.status(500).json({ code: 500, message: 'Failed to generate receipt' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// generateReceiptPdfBuffer — same receipt PDF but returns a Buffer (for email,
// and for the tenant portal, which passes opts.tenantIds)
// ─────────────────────────────────────────────────────────────────────────────
function receiptBufferFromData(data) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 0, size: 'A4' });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    renderReceiptPdf(doc, data);
    doc.end();
  });
}

async function generateReceiptPdfBuffer(pool, paymentId, orgId, opts = {}) {
  const data = await loadReceiptPdfData(pool, paymentId, orgId, opts);
  if (!data) return null;
  return receiptBufferFromData(data);
}

module.exports = router;
module.exports.generateReceiptPdfBuffer = generateReceiptPdfBuffer;
module.exports.generateInvoicePdfBuffer = generateInvoicePdfBuffer;
// Exported for tests: lets the renderer be driven against a stub `doc` so the
// text it actually emits can be asserted, rather than a copy of its logic.
module.exports.renderInvoicePdf = renderInvoicePdf;
module.exports.renderReceiptPdf = renderReceiptPdf;
module.exports.loadInvoicePdfData = loadInvoicePdfData;
module.exports.loadReceiptPdfData = loadReceiptPdfData;
// Split from generateReceiptPdfBuffer so a caller that already has the data — the
// portal needs the receipt number for the filename — renders it without loading twice.
module.exports.receiptBufferFromData = receiptBufferFromData;
// Exported for tests: the tenant-scoping rule is the whole reason a portal receipt
// is safe to serve, so it is asserted directly rather than through a PDF.
module.exports.buildVisibleLines = buildVisibleLines;
