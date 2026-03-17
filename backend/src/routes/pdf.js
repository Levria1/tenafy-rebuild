const express = require('express');
const router = express.Router();
const PDFDocument = require('pdfkit');
const { authenticate } = require('../middleware/auth');


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
// GET /api/pdf/invoice/:id  —  Generate invoice PDF
// ─────────────────────────────────────────────────────────────────────────────
router.get('/invoice/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;

    // Fetch invoice + related data
    const [invoices] = await req.pool.execute(
      `SELECT i.*,
              t.first_name as tenant_first_name, t.last_name as tenant_last_name,
              t.email as tenant_email, t.phone as tenant_phone,
              u.name as unit_name,
              p.display_name as property_name, p.street_address as property_address
       FROM invoice i
       LEFT JOIN tenant t ON i.tenant_id = t.id
       LEFT JOIN unit u ON i.unit_id = u.id
       LEFT JOIN property p ON u.property_id = p.id
       WHERE i.id = ? AND i.org_id = ?`,
      [id, orgId]
    );

    if (invoices.length === 0) {
      return res.status(404).json({ code: 404, message: 'Invoice not found' });
    }

    // Fetch landlord/org settings
    const [orgRows] = await req.pool.execute(
      'SELECT * FROM org_setting WHERE org_id = ? LIMIT 1',
      [orgId]
    ).catch(() => [[]]);

    const inv = invoices[0];
    const org = orgRows?.[0] || {};

    // Build PDF
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="invoice-${inv.invoice_code || id}.pdf"`);
    doc.pipe(res);

    // ── Header ──────────────────────────────────────────────────────────────
    doc.rect(0, 0, doc.page.width, 80).fill('#1a3c8f');
    doc.fillColor('#ffffff').fontSize(22).font('Helvetica-Bold').text('INVOICE', 50, 25);
    doc.fontSize(10).font('Helvetica').text(org.company_name || 'Property Management', 50, 52);

    // Invoice number top-right
    doc.fillColor('#ffffff').fontSize(11).font('Helvetica-Bold')
       .text(`# ${inv.invoice_code || id}`, doc.page.width - 200, 25, { width: 150, align: 'right' });
    doc.fontSize(9).font('Helvetica')
       .text(`Date: ${inv.created_at ? new Date(inv.created_at).toLocaleDateString() : '-'}`, doc.page.width - 200, 45, { width: 150, align: 'right' })
       .text(`Due: ${inv.due_on ? new Date(inv.due_on).toLocaleDateString() : '-'}`, doc.page.width - 200, 58, { width: 150, align: 'right' });

    let y = 100;

    // ── Status badge ────────────────────────────────────────────────────────
    const statusColor = inv.status === 1 ? '#52c41a' : '#faad14';
    const statusText = inv.status === 1 ? 'PAID' : 'UNPAID';
    doc.rect(50, y, 60, 18).fill(statusColor);
    doc.fillColor('#ffffff').fontSize(9).font('Helvetica-Bold').text(statusText, 52, y + 4, { width: 56, align: 'center' });
    y += 30;

    // ── Billed To / Property ─────────────────────────────────────────────────
    const colW = (doc.page.width - 100) / 2;
    doc.rect(50, y, colW - 5, 90).fill('#f8f8f8').stroke('#eeeeee');
    doc.rect(50 + colW + 5, y, colW - 5, 90).fill('#f8f8f8').stroke('#eeeeee');

    doc.fillColor('#1a3c8f').fontSize(9).font('Helvetica-Bold').text('BILLED TO', 58, y + 8);
    doc.fillColor('#333333').fontSize(9).font('Helvetica')
       .text(`${inv.tenant_first_name || ''} ${inv.tenant_last_name || ''}`.trim() || 'N/A', 58, y + 20)
       .text(inv.tenant_email || '-', 58, y + 32)
       .text(inv.tenant_phone || '-', 58, y + 44);

    doc.fillColor('#1a3c8f').fontSize(9).font('Helvetica-Bold').text('PROPERTY / UNIT', 58 + colW + 5, y + 8);
    doc.fillColor('#333333').fontSize(9).font('Helvetica')
       .text(inv.property_name || '-', 58 + colW + 5, y + 20)
       .text(inv.property_address || '-', 58 + colW + 5, y + 32, { width: colW - 20 })
       .text(`Unit: ${inv.unit_name || '-'}`, 58 + colW + 5, y + 56);

    y += 105;

    // ── Description table ────────────────────────────────────────────────────
    doc.rect(50, y, doc.page.width - 100, 20).fill('#1a3c8f');
    doc.fillColor('#ffffff').fontSize(9).font('Helvetica-Bold')
       .text('DESCRIPTION', 58, y + 6)
       .text('AMOUNT', doc.page.width - 130, y + 6, { width: 70, align: 'right' });
    y += 25;

    doc.rect(50, y, doc.page.width - 100, 30).fill('#f8f8f8').stroke('#eeeeee');
    doc.fillColor('#333333').fontSize(10).font('Helvetica')
       .text(inv.note || 'Rent', 58, y + 9)
       .text(`$${Number(inv.amount || 0).toFixed(2)}`, doc.page.width - 130, y + 9, { width: 70, align: 'right' });
    y += 40;

    hLine(doc, y);
    y += 10;

    // ── Total ─────────────────────────────────────────────────────────────────
    doc.rect(doc.page.width - 200, y, 150, 30).fill('#1a3c8f');
    doc.fillColor('#ffffff').fontSize(11).font('Helvetica-Bold')
       .text('TOTAL DUE', doc.page.width - 195, y + 8)
       .text(`$${Number(inv.amount || 0).toFixed(2)}`, doc.page.width - 195, y + 8, { width: 135, align: 'right' });
    y += 50;

    // ── Notes ─────────────────────────────────────────────────────────────────
    if (org.invoice_notes || inv.notes) {
      y = sectionHeader(doc, 'NOTES', y);
      doc.fontSize(9).font('Helvetica').fillColor('#555555').text(org.invoice_notes || inv.notes || '', 58, y, { width: doc.page.width - 120 });
      y += 30;
    }

    // ── Footer ────────────────────────────────────────────────────────────────
    doc.rect(0, doc.page.height - 40, doc.page.width, 40).fill('#f0f4ff');
    doc.fillColor('#888888').fontSize(8).font('Helvetica')
       .text(`Generated by Tenafy | ${new Date().toLocaleDateString()}`, 50, doc.page.height - 25, { align: 'center', width: doc.page.width - 100 });

    doc.end();
  } catch (error) {
    console.error('Generate invoice PDF error:', error);
    if (!res.headersSent) res.status(500).json({ code: 500, message: 'Failed to generate PDF' });
  }
});

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

    const [orgRows] = await req.pool.execute('SELECT * FROM org_setting WHERE org_id = ? LIMIT 1', [orgId]).catch(() => [[]]);
    const lease = leases[0];
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
    doc.fontSize(9).text(`Generated: ${new Date().toLocaleDateString()}`, doc.page.width - 200, 50, { width: 150, align: 'right' });

    let y = 100;

    // ── Status ──────────────────────────────────────────────────────────────
    const isActive = lease.status === 1 && !lease.deleted_at;
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
       .text(`Tenafy Property Management | Lease ID: ${id} | ${new Date().toLocaleDateString()}`, 50, doc.page.height - 20, { align: 'center', width: doc.page.width - 100 });

    doc.end();
  } catch (error) {
    console.error('Generate lease PDF error:', error);
    if (!res.headersSent) res.status(500).json({ code: 500, message: 'Failed to generate PDF' });
  }
});

module.exports = router;
