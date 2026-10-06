#!/usr/bin/env node
/**
 * Rewrite the description on UNPAID utility invoices in the tenant-period wording.
 *
 * Usage:
 *   node scripts/backfillUtilityInvoiceNotes.js <orgDbName> <orgId>                 # dry run
 *   node scripts/backfillUtilityInvoiceNotes.js <orgDbName> <orgId> --apply         # write
 *   node scripts/backfillUtilityInvoiceNotes.js <orgDbName> <orgId> --revert <file> # undo
 *
 * WHY
 * ---
 * Utility invoices printed the BILL's period ("July 18 - September 18") even for a
 * tenant who moved in on 8 Aug, whose charge and allowance were already worked out
 * from their move-in. generate-invoices now writes the tenant's own period via
 * utils/utilityInvoiceNote.js; this brings the invoices still awaiting payment in line.
 *
 * SCOPE — deliberately narrow
 * ---------------------------
 * - Only invoices linked to a utility_bill_line, in this org, not deleted, not paid
 *   (status <> 1). Paid invoices are left exactly as the tenant received them.
 * - Only a note that is still byte-for-byte what an earlier generator wrote (the
 *   fmtPeriod format, or the older raw Date.toString() one with this bill's dates).
 *   A note staff edited by hand no longer matches and is skipped (and listed).
 * - Only the `note` column changes. Amounts, dates and status are never touched.
 *
 * REVERSAL
 * --------
 * --apply writes a JSON file of {invoice_id, invoice_code, old_note, new_note} before
 * changing anything. --revert <file> restores old_note wherever the note is still the
 * one this script wrote.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const config = require('../src/config');
const { formatUtilityNote, isGeneratedLegacyNote } = require('../src/utils/utilityInvoiceNote');

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const revertIdx = args.indexOf('--revert');
  const revertFile = revertIdx >= 0 ? args[revertIdx + 1] : null;
  const positional = args.filter((a, i) => !a.startsWith('--') && (revertIdx < 0 || i !== revertIdx + 1));
  const [orgDbName, orgId] = positional;
  const unknown = args.filter(a => a.startsWith('--') && a !== '--apply' && a !== '--revert');
  if (!orgDbName || !orgId || (revertIdx >= 0 && !revertFile) || (apply && revertFile) || unknown.length) {
    console.error('Usage: node scripts/backfillUtilityInvoiceNotes.js <orgDbName> <orgId> [--apply | --revert <file>]');
    process.exit(1);
  }

  const conn = await mysql.createConnection({
    host: config.database.host, port: config.database.port,
    user: config.database.user, password: config.database.password,
    database: orgDbName, supportBigNumbers: true, bigNumberStrings: true,
  });

  try {
    if (revertFile) {
      const rows = JSON.parse(fs.readFileSync(revertFile, 'utf8'));
      let restored = 0, skipped = 0;
      await conn.beginTransaction();          // all of the revert lands, or none of it
      for (const r of rows) {
        const [res] = await conn.execute(
          'UPDATE invoice SET note = ? WHERE id = ? AND org_id = ? AND note = ?',
          [r.old_note, r.invoice_id, orgId, r.new_note]);
        if (res.affectedRows === 1) restored++; else skipped++;
      }
      await conn.commit();
      console.log(`Reverted ${restored} invoice note(s); ${skipped} skipped (changed since).`);
      return;
    }

    const [rows] = await conn.execute(
      `SELECT i.id AS invoice_id, i.invoice_code, i.note,
              b.period_start, b.period_end, b.rate_per_kw,
              bl.kw_used, bl.gross_amount, bl.prorated_credit, bl.prorated_days,
              bl.lease_start, bl.lease_end, m.meter_number
         FROM invoice i
         JOIN utility_bill_line bl ON bl.invoice_id = i.id
         JOIN utility_bill b ON b.id = bl.bill_id AND b.org_id = i.org_id
         LEFT JOIN utility_meter m ON m.id = bl.meter_id
        WHERE i.org_id = ? AND i.deleted_at IS NULL AND i.status <> 1
        ORDER BY i.invoice_code`,
      [orgId]);

    const changes = [], handEdited = [];
    for (const r of rows) {
      const bill = { period_start: r.period_start, period_end: r.period_end, rate_per_kw: r.rate_per_kw };
      const next = formatUtilityNote(bill, r);
      if (r.note === next) continue;                       // already in the new wording
      if (!isGeneratedLegacyNote(r.note, bill, r)) { handEdited.push(r.invoice_code); continue; }
      changes.push({ invoice_id: String(r.invoice_id), invoice_code: r.invoice_code, old_note: r.note, new_note: next });
    }

    console.log(`Unpaid utility invoices: ${rows.length}; to rewrite: ${changes.length}; ` +
      `left alone (edited by hand, or bill data changed since): ${handEdited.length}`);
    if (handEdited.length) console.log(`  left alone: ${handEdited.join(', ')}`);
    for (const c of changes) console.log(`\n${c.invoice_code}\n  - ${c.old_note}\n  + ${c.new_note}`);

    if (!apply) { console.log('\nDry run. Re-run with --apply to write.'); return; }
    if (!changes.length) { console.log('\nNothing to write.'); return; }

    const backup = path.resolve(`utility-note-backfill-${orgId}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(backup, JSON.stringify(changes, null, 2));
    console.log(`\nBackup written: ${backup}`);

    await conn.beginTransaction();
    let written = 0;
    for (const c of changes) {
      // Guard on the old note so a row edited between the read and now is not clobbered.
      // Re-check the whole scope at write time, not just at read time: still this org,
      // still unpaid, not deleted, still a utility bill's invoice, note unchanged.
      const [res] = await conn.execute(
        `UPDATE invoice i
           JOIN utility_bill_line bl ON bl.invoice_id = i.id
           JOIN utility_bill b ON b.id = bl.bill_id AND b.org_id = i.org_id
            SET i.note = ?
          WHERE i.id = ? AND i.org_id = ? AND i.note = ? AND i.status <> 1 AND i.deleted_at IS NULL`,
        [c.new_note, c.invoice_id, orgId, c.old_note]);
      written += res.affectedRows;
    }
    await conn.commit();
    console.log(`Rewrote ${written} invoice note(s). Undo: node scripts/backfillUtilityInvoiceNotes.js ${orgDbName} ${orgId} --revert "${backup}"`);
  } catch (err) {
    try { await conn.rollback(); } catch { /* nothing open */ }
    throw err;
  } finally {
    await conn.end();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
