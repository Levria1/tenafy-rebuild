function normalizeDate(value) {
  if (value == null || value === '') return null;
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function normalizeDirection(value) {
  if (value == null || value === '') return null;
  const s = String(value).trim().toLowerCase();
  if (['in', 'inflow', 'received', 'receive', 'receipt', 'cr', 'credit'].includes(s)) return 'received';
  if (['out', 'outflow', 'spent', 'paid', 'payment', 'dr', 'debit'].includes(s)) return 'spent';
  return null;
}

function normalizeRows(input) {
  const rows = Array.isArray(input) ? input : [input];
  return rows.map(r => {
    const amount = Number(r && r.amount);
    return {
      amount,
      date: normalizeDate(r && r.date),
      direction: normalizeDirection(r && r.direction),
    };
  }).filter(r => Number.isFinite(r.amount) && r.amount > 0);
}

function typeFromDirection(direction) {
  if (direction === 'received') return 0;
  if (direction === 'spent') return 1;
  return null;
}

function addDays(date, days) {
  const d = new Date(date + 'T00:00:00.000Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function trimText(value, max = 300) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max) + '…' : text;
}

// mysql2's execute() (prepared statements) does not reliably accept `LIMIT ?`,
// so — matching the rest of the codebase — we interpolate a clamped integer.
// Safe against injection because the value is coerced to a bounded Number.
function safeLimit(n, def = 5, max = 50) {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v) || v < 1) return def;
  return Math.min(v, max);
}

function scoreCandidate(kind, cand, row) {
  const reasons = [];
  let score = 0;

  if (kind === 'invoice') {
    score += 70;
    reasons.push('exact amount');
    if (row.date && cand.days_from_date != null) {
      const days = Math.abs(Number(cand.days_from_date));
      const tolerance = Number(cand.invoice_date_tolerance_days) || 30;
      if (days <= tolerance) {
        score += Math.max(5, 30 - Math.min(days, 30));
        const rel = Number(cand.days_from_date) === 0
          ? 'on payment date'
          : Number(cand.days_from_date) > 0
            ? `${days} days after payment`
            : `${days} days before payment`;
        reasons.push(`due ${rel}`);
      } else {
        score -= 10;
        reasons.push(`due ${days} days from payment`);
      }
    }
  } else if (kind === 'lease') {
    if (cand.matched_field === 'deposit') {
      score += 55;
      reasons.push(row.direction === 'spent' ? 'deposit refund matches' : 'deposit matches');
    } else {
      score += 50;
      reasons.push('monthly rent matches');
    }
  } else if (kind === 'accounting') {
    score += 40;
    const dir = row.direction === 'spent' ? 'spent' : 'received';
    if (cand.tenant_name) {
      reasons.push(`same amount ${dir} before, from ${cand.tenant_name}`);
    } else {
      reasons.push(`same amount ${dir} before`);
    }
  }

  return { score, reasons };
}

async function fetchInvoices(pool, orgId, row, opts) {
  const type = typeFromDirection(row.direction);
  let where = 'i.org_id = ? AND i.deleted_at IS NULL AND i.status IN (0,2) AND i.amount = ?';
  const params = [orgId, row.amount];
  if (type != null) {
    where += ' AND i.type = ?';
    params.push(type);
  }

  const [rows] = await pool.execute(
    `SELECT i.invoice_code, i.amount,
            DATE_FORMAT(i.due_on, '%Y-%m-%d') AS due_on,
            ${row.date ? 'DATEDIFF(i.due_on, ?) AS days_from_date,' : 'NULL AS days_from_date,'}
            CASE WHEN t.type = 1 THEN t.company_name
                 ELSE CONCAT(COALESCE(t.first_name,''), ' ', COALESCE(t.last_name,'')) END AS tenant_name,
            u.name AS unit_name,
            p.display_name AS property_name,
            c.name AS category
       FROM invoice i
       LEFT JOIN tenant t ON i.tenant_id = t.id AND t.org_id = ? AND t.deleted_at IS NULL
       LEFT JOIN unit u ON i.unit_id = u.id
       LEFT JOIN property p ON i.property_id = p.id AND p.org_id = ? AND p.deleted_at IS NULL
       LEFT JOIN category_setting c ON i.category = c.id AND c.org_id = ?
      WHERE ${where}
      ORDER BY ${row.date ? 'ABS(DATEDIFF(i.due_on, ?)) ASC,' : ''} i.due_on DESC
      LIMIT ${safeLimit(opts.perSourceLimit)}`,
    [
      ...(row.date ? [row.date] : []),
      orgId, orgId, orgId,
      ...params,
      ...(row.date ? [row.date] : []),
    ]
  );

  return rows.map(r => ({
    code: r.invoice_code || null,
    amount: Number(r.amount),
    due_on: r.due_on ? String(r.due_on).slice(0, 10) : null,
    tenant_name: r.tenant_name ? String(r.tenant_name).trim() : null,
    unit_name: r.unit_name || null,
    property_name: r.property_name || null,
    category: r.category || null,
    days_from_date: r.days_from_date == null ? null : Number(r.days_from_date),
    invoice_date_tolerance_days: opts.invoiceDateToleranceDays,
  }));
}

async function fetchLeases(pool, orgId, row, opts) {
  const [rows] = await pool.execute(
    `SELECT l.lease_no, l.amount, l.price, l.deposit,
            CASE WHEN t.type = 1 THEN t.company_name
                 ELSE CONCAT(COALESCE(t.first_name,''), ' ', COALESCE(t.last_name,'')) END AS tenant_name,
            u.name AS unit_name
       FROM leasing l
       LEFT JOIN tenant t ON l.tenant_id = t.id AND t.org_id = ? AND t.deleted_at IS NULL
       LEFT JOIN unit u ON l.unit_id = u.id
      WHERE l.deleted_at IS NULL
        AND (l.amount = ? OR l.price = ? OR l.deposit = ?)
      ORDER BY l.status DESC, l.end_date DESC
      LIMIT ${safeLimit(opts.perSourceLimit)}`,
    [orgId, row.amount, row.amount, row.amount]
  );

  return rows.map(r => {
    const matched_field = Number(r.deposit) === row.amount ? 'deposit' : 'rent';
    return {
      matched_field,
      lease_no: r.lease_no || null,
      tenant_name: r.tenant_name ? String(r.tenant_name).trim() : null,
      unit_name: r.unit_name || null,
      amount: matched_field === 'deposit' ? Number(r.deposit) : Number(r.amount || r.price),
    };
  });
}

async function fetchAccounting(pool, orgId, row, opts) {
  const type = typeFromDirection(row.direction);
  let where = 'a.org_id = ? AND a.deleted_at IS NULL AND a.amount = ?';
  const params = [orgId, row.amount];
  if (type != null) {
    where += ' AND a.type = ?';
    params.push(type);
  }

  const [rows] = await pool.execute(
    `SELECT DATE_FORMAT(a.payment_date, '%Y-%m-%d') AS payment_date,
            CASE WHEN t.type = 1 THEN t.company_name
                 ELSE CONCAT(COALESCE(t.first_name,''), ' ', COALESCE(t.last_name,'')) END AS tenant_name,
            a.transaction_code,
            a.note,
            c.name AS category
       FROM accounting a
       LEFT JOIN tenant t ON a.tenant_id = t.id AND t.org_id = ? AND t.deleted_at IS NULL
       LEFT JOIN category_setting c ON a.category = c.id AND c.org_id = ?
      WHERE ${where}
      ORDER BY a.payment_date DESC
      LIMIT ${safeLimit(opts.perSourceLimit)}`,
    [orgId, orgId, ...params]
  );

  return rows.map(r => ({
    payment_date: r.payment_date ? String(r.payment_date).slice(0, 10) : null,
    tenant_name: r.tenant_name ? String(r.tenant_name).trim() : null,
    transaction_code: r.transaction_code || null,
    note: r.note || null,
    category: r.category || null,
  }));
}

async function fetchWhatsApp(taneChat, row, opts) {
  if (!taneChat || !taneChat.isConfigured || !taneChat.isConfigured()) {
    return { available: false, error: null, hits: [] };
  }

  const params = { amount: row.amount, limit: opts.perSourceLimit };
  if (row.date) {
    params.from = addDays(row.date, -opts.chatWindowDays);
    params.to = addDays(row.date, opts.chatWindowDays);
  }

  try {
    const resp = await taneChat.searchMessages(params);
    const rows = Array.isArray(resp.results) ? resp.results : [];
    return {
      available: true,
      error: null,
      hits: rows.map(r => ({
        timestamp: r.timestamp || null,
        direction: r.direction || null,
        content: trimText(r.content, 300),
        contact: r.contact ? {
          name: r.contact.name || null,
          phone: r.contact.phone || null,
          channel: r.contact.channel || null,
        } : null,
        deep_link: r.deep_link || null,
      })),
    };
  } catch (e) {
    return { available: true, error: e.message || String(e), hits: [] };
  }
}

async function traceOne({ pool, orgId, taneChat }, row, opts = {}) {
  const options = {
    invoiceDateToleranceDays: Number(opts.invoiceDateToleranceDays) || 30,
    chatWindowDays: Number(opts.chatWindowDays) || 14,
    perSourceLimit: Number(opts.perSourceLimit) || 5,
  };
  const empty = { rows: [], error: null };
  const wrap = (fn) => fn().then(rows => ({ rows, error: null })).catch(e => ({ ...empty, error: e.message || String(e) }));

  const [invoiceResult, leaseResult, accountingResult, whatsapp] = await Promise.all([
    wrap(() => fetchInvoices(pool, orgId, row, options)),
    wrap(() => fetchLeases(pool, orgId, row, options)),
    wrap(() => fetchAccounting(pool, orgId, row, options)),
    fetchWhatsApp(taneChat, row, options),
  ]);

  const invoices = invoiceResult.rows.map(c => ({ ...c, ...scoreCandidate('invoice', c, row) }));
  const leases = leaseResult.rows.map(c => ({ ...c, ...scoreCandidate('lease', c, row) }));
  const accounting = accountingResult.rows.map(c => ({ ...c, ...scoreCandidate('accounting', c, row) }));
  const scored = [
    ...invoices.map(c => ({ kind: 'invoice', label: c.code || c.tenant_name || c.category, score: c.score })),
    ...leases.map(c => ({ kind: 'lease', label: c.lease_no || c.tenant_name || c.unit_name, score: c.score })),
    ...accounting.map(c => ({ kind: 'accounting', label: c.tenant_name || c.transaction_code || c.category, score: c.score })),
  ].sort((a, b) => b.score - a.score);

  // WhatsApp mentions are returned as corroborating context only. A message
  // can mention an amount without proving identity, so it is not folded into
  // the numeric score.
  const top = scored[0];
  return {
    input: { amount: row.amount, date: row.date, direction: row.direction },
    invoices,
    leases,
    accounting,
    whatsapp,
    errors: {
      invoices: invoiceResult.error,
      leases: leaseResult.error,
      accounting: accountingResult.error,
    },
    top_hint: top ? `${top.kind}: ${top.label || 'matching amount'}` : null,
  };
}

async function traceAmounts(ctx, rows, opts = {}) {
  const normalized = normalizeRows(rows);
  const limited = normalized.slice(0, 10);
  const results = await Promise.all(limited.map(row => traceOne(ctx, row, opts)));
  return {
    rows: results,
    truncated: normalized.length > limited.length,
    input_count: normalized.length,
    note: normalized.length > limited.length ? 'Only the first 10 valid rows were processed.' : null,
  };
}

module.exports = {
  normalizeRows,
  scoreCandidate,
  traceOne,
  traceAmounts,
};
