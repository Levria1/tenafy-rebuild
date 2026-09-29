const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { formatRentPeriod, rentPeriodNote } = require('../src/utils/rentPeriodNote');
const { loadInvoicePdfData, loadReceiptPdfData, renderInvoicePdf, renderReceiptPdf } = require('../src/routes/pdf');

test('formatRentPeriod follows the staff wording examples', () => {
  assert.equal(formatRentPeriod('2026-09-01', '2026-09-30'), 'Sept. 1 - 30, 2026');
  assert.equal(formatRentPeriod('2026-09-15', '2026-10-14'), 'Sept. 15 - Oct. 14, 2026');
  assert.equal(formatRentPeriod('2026-12-15', '2027-01-14'), 'Dec. 15, 2026 - Jan. 14, 2027');
  assert.equal(formatRentPeriod('2026-06-17', '2026-06-17'), 'June 17, 2026');
});

test('formatRentPeriod keeps May June July unabbreviated and spells Sept.', () => {
  assert.equal(formatRentPeriod('2026-05-01', '2026-05-31'), 'May 1 - 31, 2026');
  assert.equal(formatRentPeriod('2026-06-01', '2026-06-30'), 'June 1 - 30, 2026');
  assert.equal(formatRentPeriod('2026-07-01', '2026-07-31'), 'July 1 - 31, 2026');
  assert.equal(formatRentPeriod('2026-09-01', '2026-09-30'), 'Sept. 1 - 30, 2026');
});

test('rentPeriodNote uses the schedule period and due-day month-end clamp', () => {
  assert.equal(
    rentPeriodNote({
      dueOn: '2026-08-31',
      invoicing: '30',
      dueDay: 31,
      leaseStart: '2026-08-31',
      leaseEnd: null,
    }),
    'Rental payment for Aug. 31 - Sept. 29, 2026'
  );
});

test('rentPeriodNote clips a recurring period to a mid-period lease end', () => {
  assert.equal(
    rentPeriodNote({
      dueOn: '2026-09-01',
      invoicing: '30',
      dueDay: 1,
      leaseStart: '2026-09-01',
      leaseEnd: '2026-09-18',
    }),
    'Rental payment for Sept. 1 - 18, 2026'
  );
});

test('rentPeriodNote handles non-recurring whole-stay invoices', () => {
  assert.equal(
    rentPeriodNote({
      dueOn: '2026-09-01',
      invoicing: null,
      dueDay: null,
      leaseStart: '2026-09-15',
      leaseEnd: '2026-10-14',
    }),
    'Rental payment for Sept. 15 - Oct. 14, 2026'
  );
});

test('a scheduled lease billed once (recurring off) describes ONE period, not the stay', () => {
  // POST /leasing and /:id/confirm take the one-invoice branch whenever recurring
  // is off, even on a monthly lease. That invoice is one month's rent.
  assert.equal(
    rentPeriodNote({
      dueOn: '2026-09-01',
      invoicing: 'monthly',
      dueDay: 1,
      leaseStart: '2026-09-01',
      leaseEnd: '2027-08-31',
    }),
    'Rental payment for Sept. 1 - 30, 2026'
  );
});

test('string and Date inputs agree', () => {
  const fromStrings = rentPeriodNote({
    dueOn: '2026-09-01',
    invoicing: '30',
    dueDay: 1,
    leaseStart: '2026-09-01',
    leaseEnd: '2026-09-30',
  });
  const fromDates = rentPeriodNote({
    dueOn: new Date(2026, 8, 1),
    invoicing: '30',
    dueDay: 1,
    leaseStart: new Date(2026, 8, 1),
    leaseEnd: new Date(2026, 8, 30),
  });
  assert.equal(fromDates, fromStrings);
});

test('rentPeriodNote returns null when the period cannot be determined', () => {
  assert.equal(rentPeriodNote({ invoicing: '30', dueDay: 1, leaseStart: '2026-09-01', leaseEnd: null }), null);
  assert.equal(rentPeriodNote({ dueOn: '2026-09-01', invoicing: null, leaseStart: '2026-09-01', leaseEnd: null }), null);
  assert.equal(rentPeriodNote({ dueOn: '2026-09-01', invoicing: '30', dueDay: 1, leaseStart: '2026-09-01', leaseEnd: '2026-08-31' }), null);
  assert.equal(formatRentPeriod('2026-09-02', '2026-09-01'), null);
});

function stubDoc() {
  const drawn = [];
  const doc = {
    page: { width: 595, height: 842 },
    text: (t) => { drawn.push(String(t)); return doc; },
    rect: () => doc, fill: () => doc, fillColor: () => doc, font: () => doc,
    fontSize: () => doc, moveTo: () => doc, lineTo: () => doc, stroke: () => doc,
    strokeColor: () => doc, lineWidth: () => doc, image: () => doc,
    heightOfString: () => 10,
  };
  doc.drawn = drawn;
  return doc;
}

const ORG = '8300127259922432';
const PAYMENT = {
  id: 'P-1',
  tenant_id: 'T-1',
  transaction_code: 'TANE50001',
  payment_date: '2026-09-20',
  header_amount: '30100.00',
  payment_note: null,
};

function receiptPool(lines) {
  return {
    execute: async (sql) => {
      if (/FROM accounting a/i.test(sql)) return [[PAYMENT]];
      if (/FROM accounting_line al/i.test(sql)) return [lines];
      if (/FROM organization/i.test(sql)) return [[{ company_name: 'Tane', default_currency: 'HKD' }]];
      return [[]];
    },
  };
}

test('staff receipt derives period notes only for note-less Rental Income lines', async () => {
  const data = await loadReceiptPdfData(receiptPool([
    {
      amount: '10000.00',
      invoice_code: 'INV-1',
      invoice_tenant_id: 'T-1',
      invoice_note: null,
      invoice_category: 'Rental Income',
      invoice_due_on: '2026-09-01',
      lease_invoicing: '30',
      lease_due_day: 1,
      lease_start: '2026-09-01',
      lease_end: '2026-09-30',
      property_currency: 'HKD',
    },
    {
      amount: '10000.00',
      invoice_code: 'INV-2',
      invoice_tenant_id: 'T-1',
      invoice_note: 'Staff note wins',
      invoice_category: 'Rental Income',
      invoice_due_on: '2026-10-01',
      lease_invoicing: '30',
      lease_due_day: 1,
      lease_start: '2026-09-01',
      lease_end: '2026-10-31',
      property_currency: 'HKD',
    },
    {
      amount: '100.00',
      invoice_code: 'INV-3',
      invoice_tenant_id: 'T-1',
      invoice_note: null,
      invoice_category: 'Utility Income',
      property_currency: 'HKD',
    },
  ]), PAYMENT.id, ORG);

  const doc = stubDoc();
  renderReceiptPdf(doc, data);
  const page = doc.drawn.join('\n');
  assert.match(page, /Rental payment for Sept\. 1 - 30, 2026/);
  assert.match(page, /Staff note wins/);
  assert.match(page, /Utility Income/);
});

function invoicePool(invoice) {
  return {
    execute: async (sql) => {
      if (/FROM invoice i/i.test(sql)) return [[invoice]];
      if (/FROM accounting_line al/i.test(sql)) return [[{ paid: 0 }]];
      if (/FROM organization/i.test(sql)) return [[{ company_name: 'Tane', default_currency: 'HKD' }]];
      return [[]];
    },
  };
}

test('invoice PDF derives a Rental Income description when note is missing', async () => {
  const data = await loadInvoicePdfData(invoicePool({
    id: 'I-1',
    invoice_code: 'INV-1',
    amount: '10000.00',
    status: 0,
    note: null,
    due_on: '2026-09-01',
    category_name: 'Rental Income',
    lease_invoicing: '30',
    lease_due_day: 1,
    lease_start: '2026-09-01',
    lease_end: '2026-09-30',
    property_currency: 'HKD',
  }), 'I-1', ORG);

  const doc = stubDoc();
  renderInvoicePdf(doc, data);
  assert.match(doc.drawn.join('\n'), /Rental payment for Sept\. 1 - 30, 2026/);
});

test('scheduler insert passes a rent period note', async () => {
  const scheduler = require('../src/services/scheduler');
  const emailService = require('../src/services/emailService');
  emailService.sendInvoiceToLandlord = async () => null;

  const inserted = [];
  const pool = {
    execute: async (sql, params = []) => {
      const s = sql.replace(/\s+/g, ' ');
      if (/FROM leasing l JOIN unit u/.test(s)) {
        return [[{
          id: 'L-1', tenant_id: 'T-1', unit_id: 'U-1', price: 10000, invoicing: '30',
          due_date: 1, start_date: '2026-08-01', end_date: null, currency_id: 'C-1',
          booking_platform_id: null, sales_agent_id: null, property_id: 'P-1',
          property_name: 'Property', unit_name: '1A',
        }]];
      }
      if (/FROM category_setting/.test(s)) return [[{ id: 'RENT' }]];
      if (/SELECT due_on FROM invoice/.test(s)) return [[{ due_on: '2026-09-01' }]];
      if (/SELECT id FROM invoice/.test(s)) return [[]];
      if (/FROM lease_revision/.test(s)) return [[]];
      if (/FROM sequence/.test(s)) return [[]];
      if (/INSERT INTO invoice/.test(s)) {
        inserted.push({ sql, params });
        return [{ affectedRows: 1 }];
      }
      return [[]];
    },
  };

  await scheduler.generateRecurringInvoicesForOrg(pool, ORG);
  assert.equal(inserted.length, 1);
  assert.match(inserted[0].sql, /\bnote\b/);
  assert.equal(inserted[0].params.at(-1), 'Rental payment for Oct. 1 - 31, 2026');
});

test('the four rent invoice insert sites wire a note column and rentPeriodNote', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');
  const scheduler = read('../src/services/scheduler.js');
  const leasing = read('../src/routes/leasing.js');
  const invoice = read('../src/routes/invoice.js');

  assert.match(scheduler, /INSERT INTO invoice[\s\S]*sales_agent_id, note, created_at/);
  assert.match(scheduler, /rentPeriodNote\(\{\s*dueOn: nextDueDateStr/);

  assert.equal((leasing.match(/sales_agent_id, note, created_at/g) || []).length, 2);
  assert.match(leasing, /dueOn: dateStr, invoicing, dueDay: due_date/);
  assert.match(leasing, /dueOn: invoiceDate, invoicing, dueDay: due_date, leaseStart: start_date, leaseEnd: end_date/);
  assert.match(leasing, /dueOn: dateStr, invoicing: lease\.invoicing, dueDay: lease\.due_date/);
  assert.match(leasing, /dueOn: invoiceDate, invoicing: lease\.invoicing, dueDay: lease\.due_date/);
  // The one-off branch must never hard-code null: that described a monthly lease
  // with recurring switched off as its whole multi-month stay.
  assert.doesNotMatch(leasing, /invoicing: null/);

  assert.match(invoice, /sales_agent_id, note, created_at/);
  assert.match(invoice, /SELECT booking_platform_id, sales_agent_id, invoicing, due_date, start_date, end_date FROM leasing/);
  assert.match(invoice, /if \(!category\) \{/);
});
