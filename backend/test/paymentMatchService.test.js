const test = require('node:test');
const assert = require('node:assert');

const {
  normalizeRows,
  scoreCandidate,
  traceOne,
} = require('../src/services/paymentMatchService');
const chatTools = require('../src/services/chatTools');
const taneChatClient = require('../src/services/taneChatClient');

function makePool(handler) {
  const calls = [];
  return {
    calls,
    async execute(sql, params) {
      calls.push({ sql, params });
      return [await handler(sql, params)];
    },
  };
}

test('normalizeRows coerces single row, synonyms, ISO dates, and drops non-positive amounts', () => {
  assert.deepEqual(normalizeRows({ amount: '13800.50', date: '2026-07-17T05:54:50.330Z', direction: 'inflow' }), [{
    amount: 13800.50,
    date: '2026-07-17',
    direction: 'received',
  }]);

  assert.deepEqual(normalizeRows([
    { amount: '1', direction: 'paid' },
    { amount: 2, direction: 'out' },
    { amount: 3, direction: 'Received' },
    { amount: 0, direction: 'in' },
    { amount: -5, direction: 'spent' },
    { amount: 'x', direction: 'in' },
  ]), [
    { amount: 1, date: null, direction: 'spent' },
    { amount: 2, date: null, direction: 'spent' },
    { amount: 3, date: null, direction: 'received' },
  ]);
});

test('scoreCandidate applies invoice date bonus and tolerance penalty', () => {
  const close = scoreCandidate('invoice', {
    amount: 100,
    days_from_date: 2,
    invoice_date_tolerance_days: 30,
  }, { amount: 100, date: '2026-07-15', direction: 'received' });
  const far = scoreCandidate('invoice', {
    amount: 100,
    days_from_date: 60,
    invoice_date_tolerance_days: 30,
  }, { amount: 100, date: '2026-07-15', direction: 'received' });

  assert.ok(close.score > far.score);
  assert.ok(close.reasons.includes('exact amount'));
  assert.ok(close.reasons.some(r => /2 days after payment/.test(r)));
  assert.ok(far.reasons.some(r => /60 days from payment/.test(r)));
});

test('scoreCandidate explains lease rent, deposit, accounting, and keeps WhatsApp unscored', () => {
  const rent = scoreCandidate('lease', { matched_field: 'rent' }, { direction: 'received' });
  const deposit = scoreCandidate('lease', { matched_field: 'deposit' }, { direction: 'received' });
  const refund = scoreCandidate('lease', { matched_field: 'deposit' }, { direction: 'spent' });
  const accounting = scoreCandidate('accounting', { tenant_name: 'Chan Tai Man' }, { direction: 'received' });
  const whatsapp = scoreCandidate('whatsapp', { contact: { name: 'Chan' } }, { direction: 'received' });

  assert.ok(rent.reasons.includes('monthly rent matches'));
  assert.ok(deposit.reasons.includes('deposit matches'));
  assert.ok(refund.reasons.includes('deposit refund matches'));
  assert.ok(accounting.reasons.some(r => /same amount received before, from Chan Tai Man/.test(r)));
  assert.equal(whatsapp.score, 0);
  assert.deepEqual(whatsapp.reasons, []);
});

test('traceOne merges parallel sources and maps received direction to type 0', async () => {
  const pool = makePool(async (sql, params) => {
    if (sql.includes('FROM invoice i')) {
      return [{
        invoice_code: 'INV-1',
        amount: '13800.00',
        due_on: '2026-07-16',
        days_from_date: -1,
        tenant_name: 'Chan Tai Man',
        unit_name: '3A',
        property_name: 'Central House',
        category: 'Rental Income',
      }];
    }
    if (sql.includes('FROM leasing l')) {
      return [{
        lease_no: 'L-1',
        amount: '13800.00',
        price: '13800.00',
        deposit: '27600.00',
        tenant_name: 'Chan Tai Man',
        unit_name: '3A',
      }];
    }
    if (sql.includes('FROM accounting a')) {
      return [{
        payment_date: '2026-06-17',
        tenant_name: 'Chan Tai Man',
        transaction_code: 'TX-1',
        note: 'June rent',
        category: 'Rental Income',
      }];
    }
    return [];
  });
  const taneChat = {
    isConfigured: () => true,
    async searchMessages(params) {
      assert.deepEqual(params, { amount: 13800, limit: 5, from: '2026-07-03', to: '2026-07-31' });
      return {
        results: [{
          timestamp: '2026-07-17T00:00:00Z',
          direction: 'inbound',
          content: 'x'.repeat(350),
          contact: { name: 'Chan', phone: '+85290000000', channel: 'whatsapp', extra: 'drop' },
          deep_link: 'https://chat.test/c/1',
        }],
      };
    },
  };

  const r = await traceOne({ pool, orgId: 9, taneChat }, {
    amount: 13800,
    date: '2026-07-17',
    direction: 'received',
  });

  assert.equal(r.invoices.length, 1);
  assert.equal(r.leases.length, 1);
  assert.equal(r.accounting.length, 1);
  assert.equal(r.whatsapp.available, true);
  assert.equal(r.whatsapp.hits[0].content.length, 301);
  assert.equal(r.whatsapp.hits[0].contact.extra, undefined);
  assert.match(r.top_hint, /invoice/);
  assert.equal(r.errors.invoices, null);

  const invoiceCall = pool.calls.find(c => c.sql.includes('FROM invoice i'));
  const accountingCall = pool.calls.find(c => c.sql.includes('FROM accounting a'));
  assert.ok(invoiceCall.params.includes(0), 'received invoice search uses type 0');
  assert.ok(accountingCall.params.includes(0), 'received accounting search uses type 0');
});

test('traceOne maps spent direction to type 1 and TaneChat unavailable does not throw', async () => {
  const pool = makePool(async () => []);
  const r = await traceOne(
    { pool, orgId: 9, taneChat: { isConfigured: () => false } },
    { amount: 500, date: '2026-07-17', direction: 'spent' }
  );

  const invoiceCall = pool.calls.find(c => c.sql.includes('FROM invoice i'));
  const accountingCall = pool.calls.find(c => c.sql.includes('FROM accounting a'));
  assert.ok(invoiceCall.params.includes(1), 'spent invoice search uses type 1');
  assert.ok(accountingCall.params.includes(1), 'spent accounting search uses type 1');
  assert.deepEqual(r.whatsapp, { available: false, error: null, hits: [] });
});

test('traceOne captures a source DB error and returns the other sources', async () => {
  const pool = makePool(async (sql) => {
    if (sql.includes('FROM invoice i')) throw new Error('invoice failed');
    if (sql.includes('FROM leasing l')) return [{ lease_no: 'L-2', amount: '100.00', price: '100.00', deposit: '200.00', tenant_name: 'Lee', unit_name: '5B' }];
    return [];
  });

  const r = await traceOne(
    { pool, orgId: 9, taneChat: { isConfigured: () => false } },
    { amount: 100, date: '2026-07-17', direction: 'received' }
  );

  assert.deepEqual(r.invoices, []);
  assert.match(r.errors.invoices, /invoice failed/);
  assert.equal(r.leases.length, 1);
  assert.deepEqual(r.accounting, []);
});

test('trace_amount tool accepts multiple rows in one internal-only call', async () => {
  const origConfigured = taneChatClient.isConfigured;
  taneChatClient.isConfigured = () => false;
  const pool = makePool(async () => []);

  try {
    const tool = chatTools.ALL_BY_NAME.trace_amount;
    const r = await tool.execute({ pool, orgId: 9 }, {
      rows: [
        { amount: 100, date: '2026-02-20', direction: 'received' },
        { amount: 200, date: '2026-07-17', direction: 'spent' },
      ],
    });

    assert.equal(r.rows.length, 2);
    assert.match(r.note, /2026-03-01/);
    assert.match(r.note, /not configured/);
    assert.equal(pool.calls.filter(c => c.sql.includes('FROM invoice i')).length, 2);

    const prospect = chatTools.toolsForCapabilities({
      can_search: true,
      can_show_details: true,
      can_book_viewings: true,
      can_capture_leads: true,
      can_search_inquiries: true,
      can_search_leases: true,
      can_search_invoices: true,
      can_search_services: true,
      can_search_documents: true,
    });
    const internal = chatTools.toolsForInternal();
    assert.ok(chatTools.INTERNAL_ONLY.has('trace_amount'));
    assert.ok(!prospect.byName.trace_amount);
    assert.ok(internal.byName.trace_amount);
  } finally {
    taneChatClient.isConfigured = origConfigured;
  }
});
