#!/usr/bin/env node
/**
 * Turn the recurring-invoice flag on for leases that were configured for it but
 * never had it set.
 *
 * Usage:
 *   node scripts/repairRecurringFlag.js <orgDbName>            # dry run
 *   node scripts/repairRecurringFlag.js <orgDbName> --apply    # write
 *
 * WHY
 * ---
 * `share_lease` is the recurring-invoice flag: the scheduler filters on
 * `share_lease = 1 AND invoicing IS NOT NULL`, and leasing.js confirmation reads
 * `lease.share_lease && lease.invoicing`. Nothing else reads it.
 *
 * But both lease forms also carried a checkbox labelled "Share lease with tenant"
 * bound to the same column, and on the EDIT page that checkbox is what got saved.
 * So switching Recurring Invoice on and saving left the flag at 0: the switch
 * looked right, the lease generated nothing, and no warning was logged.
 *
 * The forms now let the switch own the flag. This clears the leases already
 * stranded by the old behaviour.
 *
 * SCOPE
 * -----
 * Only ACTIVE leases that are already fully configured for recurring invoices —
 * invoicing set, amount above zero — and have the flag off. A lease with no
 * invoicing schedule is not touched: there the flag genuinely means nothing.
 *
 * EFFECT
 * ------
 * On its next run the scheduler picks these up and raises any invoice now due,
 * which emails the LANDLORD per invoice (the tenant reminder is a separate job,
 * closer to the due date). Leases whose end_date has passed generate nothing —
 * the loop breaks at `nextDueDate > end_date` — so they are safe to include.
 *
 * REVERSAL
 * --------
 * Every changed lease id is printed, and the revert statement is printed with them.
 */

require('dotenv').config();
const mysql = require('mysql2/promise');
const config = require('../src/config');

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const orgDbName = args.filter(a => !a.startsWith('--'))[0];
  if (!orgDbName) {
    console.error('Usage: node scripts/repairRecurringFlag.js <orgDbName> [--apply]');
    process.exit(1);
  }

  const conn = await mysql.createConnection({
    host: config.database.host,
    port: config.database.port,
    user: config.database.user,
    password: config.database.password,
    database: orgDbName,
    supportBigNumbers: true,
    bigNumberStrings: true,
    dateStrings: ['DATE'],
  });

  try {
    const [rows] = await conn.query(
      `SELECT l.id, l.lease_no, l.invoicing, l.amount, l.due_date, l.start_date, l.end_date,
              CONCAT(COALESCE(t.first_name,''), ' ', COALESCE(t.last_name,'')) AS who,
              p.display_name AS property_name, u.name AS unit_name,
              (SELECT MAX(i.due_on) FROM invoice i
                WHERE i.leasing_id = l.id AND i.deleted_at IS NULL
                  AND i.category = (SELECT id FROM category_setting
                                     WHERE org_id = p.org_id AND enabled = 1
                                       AND name LIKE '%Rental Income%' ORDER BY id LIMIT 1)
              ) AS last_rent_due
         FROM leasing l
         JOIN unit u ON u.id = l.unit_id
         JOIN property p ON p.id = u.property_id
         LEFT JOIN tenant t ON t.id = l.tenant_id
        WHERE l.deleted_at IS NULL AND l.status = 1 AND l.lease_state = 'active'
          AND l.invoicing IS NOT NULL AND l.invoicing <> '' AND l.amount > 0
          AND (l.share_lease IS NULL OR l.share_lease = 0)
        ORDER BY l.start_date DESC`
    );

    console.log(`${orgDbName}: ${rows.length} lease(s) configured for recurring invoices with the flag off\n`);
    if (!rows.length) {
      console.log('Nothing to do.');
      return;
    }

    const today = new Date().toISOString().slice(0, 10);
    for (const r of rows) {
      const ended = r.end_date && String(r.end_date) < today;
      console.log(`  ${r.lease_no}  ${r.property_name} ${r.unit_name}  ${(r.who || '').trim()}`);
      console.log(`      ${r.invoicing} @ ${r.amount}, due day ${r.due_date}   lease ${r.start_date} .. ${r.end_date || 'open'}${ended ? '   [ENDED — will generate nothing]' : ''}`);
      console.log(`      last rent invoice: ${r.last_rent_due || 'NONE — scheduler has no anchor and will still skip it'}`);
    }

    if (!apply) {
      console.log('\nDRY RUN — nothing written. Re-run with --apply to set the flag.');
      return;
    }

    const ids = rows.map(r => String(r.id));
    // Re-checks the condition it matched on, so a lease someone fixed by hand in
    // the meantime is left alone rather than written over.
    const [res] = await conn.query(
      `UPDATE leasing SET share_lease = 1, updated_at = NOW()
        WHERE id IN (${ids.map(() => '?').join(',')})
          AND (share_lease IS NULL OR share_lease = 0)
          AND invoicing IS NOT NULL AND invoicing <> '' AND amount > 0`,
      ids
    );

    console.log(`\nAPPLIED. ${res.affectedRows} lease(s) updated.`);
    if (res.affectedRows !== rows.length) {
      console.log(`NOTE: ${rows.length - res.affectedRows} row(s) changed after this script read them and were skipped.`);
    }
    console.log('\nTo revert exactly what this run did:');
    console.log(`  UPDATE leasing SET share_lease = 0 WHERE id IN (${ids.join(', ')});`);
  } finally {
    await conn.end();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
