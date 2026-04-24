/**
 * Seed the operational defaults every org needs to actually use the product:
 *   - currency (at least one row with is_current=1)
 *   - sequence (leasing_code, mls_code, invoice_code, transaction_code, service_code)
 *   - category_setting (Rental Income, Deposit, + common expense categories)
 *
 * Idempotent: uses INSERT IGNORE / ON DUPLICATE KEY UPDATE so re-running against
 * an already-seeded org doesn't duplicate or error. Safe to call from
 * orgProvisioner during new-org creation AND from backfill scripts against
 * existing under-seeded orgs.
 *
 * `runner` must be a connection or pool with `.query()` / `.execute()` that is
 * already scoped to the org's database (caller's responsibility).
 */

const genId = () => (BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000))).toString();

// Required for rent + deposit invoice generation. Names must match the
// LIKE patterns in leasing.js (%Rental Income%, %Deposit%).
const DEFAULT_CATEGORIES = [
  'Rental Income',
  'Deposit',
  'Repair and Maintenance',
  'Utilities',
  'Cleaning',
  'Management Fee',
  'Stamp Fee',
  'Movers',
  'Damages Fee',
  'Laundry',
  'Penalties',
  'Insurance',
  'Miscellaneous',
];

// The 5 sequence keys that code paths in the rebuild reference.
const DEFAULT_SEQUENCES = [
  { key: 'leasing_code',     name: 'Leasing ID',     pattern: 'LEA1{#,010}' },
  { key: 'mls_code',         name: 'Property ID',    pattern: 'MLS1{#,010}' },
  { key: 'invoice_code',     name: 'Invoice ID',     pattern: 'INV1{#,010}' },
  { key: 'transaction_code', name: 'Transaction ID', pattern: 'TX1{#,010}'  },
  { key: 'service_code',     name: 'Service ID',     pattern: 'S1{#,010}'   },
];

async function seedOrgDefaults(runner, orgId, opts = {}) {
  const out = { currency: 0, sequences: 0, categories: 0 };

  // 1. currency
  const [curRows] = await runner.query(
    'SELECT id FROM currency WHERE org_id = ? AND is_current = 1 LIMIT 1',
    [orgId]
  );
  if (!curRows.length) {
    await runner.query(
      `INSERT INTO currency (id, org_id, detail, is_current, created_at) VALUES (?, ?, ?, 1, NOW())`,
      [genId(), orgId, JSON.stringify(opts.currencyDetail || {})]
    );
    out.currency = 1;
  }

  // 2. sequences
  for (const s of DEFAULT_SEQUENCES) {
    const [rows] = await runner.query(
      'SELECT id FROM sequence WHERE org_id = ? AND `key` = ? LIMIT 1',
      [orgId, s.key]
    );
    if (!rows.length) {
      await runner.query(
        `INSERT INTO sequence (id, org_id, \`key\`, name, pattern, seq_start, seq_next, seq_reset_cycle)
         VALUES (?, ?, ?, ?, ?, 1000, 1000, 0)`,
        [genId(), orgId, s.key, s.name, s.pattern]
      );
      out.sequences++;
    }
  }

  // 3. category_setting
  for (const name of DEFAULT_CATEGORIES) {
    const [rows] = await runner.query(
      'SELECT id FROM category_setting WHERE org_id = ? AND name = ? LIMIT 1',
      [orgId, name]
    );
    if (!rows.length) {
      await runner.query(
        `INSERT INTO category_setting (id, org_id, name, enabled) VALUES (?, ?, ?, 1)`,
        [genId(), orgId, name]
      );
      out.categories++;
    }
  }

  return out;
}

module.exports = { seedOrgDefaults };
