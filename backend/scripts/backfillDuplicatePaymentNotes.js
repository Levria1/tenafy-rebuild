#!/usr/bin/env node
/**
 * Collapse accounting notes that say the same thing twice.
 *
 * Usage:
 *   node scripts/backfillDuplicatePaymentNotes.js <orgDbName>            # dry run
 *   node scripts/backfillDuplicatePaymentNotes.js <orgDbName> --apply    # write
 *
 * WHY
 * ---
 * Xero staging joined the bank transaction's Reference and its line-item
 * Descriptions with ' — ' (services/xeroSync.js). Tane's Xero data holds the same
 * sentence in both, so 567 accounting rows store their note twice. Every one of
 * them is a single-line payment, which is exactly the case where the receipt PDF
 * falls back to the payment note — so the duplication is visible on the receipt a
 * tenant receives, and invisible on multi-invoice receipts.
 *
 * xeroSync no longer creates these. This clears the ones already stored, so the
 * accounting list and the exports read correctly too, not just receipts.
 *
 * SCOPE
 * -----
 * utils/paymentNote.js owns the rule, and the receipt renderer applies the same
 * function, so what this writes is exactly what a receipt would otherwise show.
 * Notes with a genuine Reference/description pair are untouched.
 *
 * REVERSAL
 * --------
 * Every changed row is snapshotted into `accounting_note_backfill_backup` before
 * anything is written. The script prints the exact revert statement.
 */

require('dotenv').config();
const mysql = require('mysql2/promise');
const config = require('../src/config');
const { collapseDuplicateNote, NOTE_JOIN } = require('../src/utils/paymentNote');

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const orgDbName = args.filter(a => !a.startsWith('--'))[0];
  if (!orgDbName) {
    console.error('Usage: node scripts/backfillDuplicatePaymentNotes.js <orgDbName> [--apply]');
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
  });

  try {
    // Deleted rows are included: a soft-deleted payment can be restored, and its
    // note would come back duplicated.
    const [rows] = await conn.query(
      `SELECT id, note FROM accounting WHERE note LIKE ? ORDER BY id`,
      ['%' + NOTE_JOIN + '%']
    );

    const changes = [];
    for (const row of rows) {
      const after = collapseDuplicateNote(row.note);
      if (after !== row.note) changes.push({ id: String(row.id), before: row.note, after });
    }

    console.log(`${orgDbName}: ${rows.length} accounting note(s) contain the join`);
    console.log(`  duplicated, to collapse: ${changes.length}`);
    console.log(`  genuine, left alone:     ${rows.length - changes.length}`);
    if (changes.length) {
      console.log('');
      console.log('  sample:');
      for (const c of changes.slice(0, 3)) {
        console.log(`    ${c.id}: ${JSON.stringify(c.before)}`);
        console.log(`         -> ${JSON.stringify(c.after)}`);
      }
    }

    if (!apply) {
      console.log('');
      console.log('DRY RUN — nothing written. Re-run with --apply to make these changes.');
      return;
    }
    if (!changes.length) {
      console.log('');
      console.log('Nothing to do.');
      return;
    }

    await conn.query(
      `CREATE TABLE IF NOT EXISTS accounting_note_backfill_backup (
         accounting_id BIGINT    NOT NULL,
         note_before   TEXT      NULL,
         backed_up_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
         PRIMARY KEY (accounting_id)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
    );

    await conn.beginTransaction();
    try {
      for (const c of changes) {
        // INSERT IGNORE so a re-run cannot overwrite the ORIGINAL snapshot with an
        // already-collapsed one — the first backup is the one that can restore.
        await conn.execute(
          `INSERT IGNORE INTO accounting_note_backfill_backup (accounting_id, note_before) VALUES (?, ?)`,
          [c.id, c.before]
        );
      }
      for (const c of changes) {
        await conn.execute(`UPDATE accounting SET note = ? WHERE id = ?`, [c.after, c.id]);
      }
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    }

    console.log('');
    console.log(`APPLIED. ${changes.length} note(s) collapsed.`);
    console.log(`Snapshot: ${changes.length} row(s) in accounting_note_backfill_backup.`);
    console.log('');
    console.log('To revert everything this script did:');
    console.log('  UPDATE accounting a');
    console.log('    JOIN accounting_note_backfill_backup b ON b.accounting_id = a.id');
    console.log('     SET a.note = b.note_before;');
  } finally {
    await conn.end();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
