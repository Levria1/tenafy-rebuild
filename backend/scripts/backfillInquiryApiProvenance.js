#!/usr/bin/env node
/**
 * One-off repair for the TaneChat cutover: hand machine-extracted inquiry fields
 * back to the API, and undo the full-name-in-first_name bug while we are here.
 *
 * Usage:
 *   node scripts/backfillInquiryApiProvenance.js <orgDbName>            # dry run
 *   node scripts/backfillInquiryApiProvenance.js <orgDbName> --apply    # write
 *
 * WHY
 * ---
 * `inquiry.api_set_fields` decides what the public fact API may overwrite: a field
 * is writable only if it is empty or already listed there. Tenafy's own nightly
 * extractor never recorded itself, so every value it wrote looks like a human edit
 * and outranks TaneChat permanently.
 *
 * That is not a theoretical ordering problem. Our extractor put a prospect's whole
 * name into `first_name`; TaneChat sent the correct split ("Zaneta" / "Imam"),
 * `last_name` applied because it was empty, `first_name` was refused because it was
 * not — and the record now reads "Zaneta Imam Imam". Their value was the right one
 * and it lost.
 *
 * SCOPE, and why it is safe
 * -------------------------
 * Only inquiries that are open, not deleted, sourced from chat (whatsapp/email) and
 * have `created_by_user_id IS NULL` — i.e. rows no human created. On the live org
 * that is 878 rows, all 878 with a null creator.
 *
 * We cannot be more surgical than that: `logActivity` is called with an object where
 * it expects positional arguments, so `entity_type` binds as undefined and the
 * insert throws. There has never been a single INQUIRY row in `activity_log`, so
 * there is no record of which fields a human edited. That bug is worth fixing
 * separately; it is why this script uses origin rather than edit history.
 *
 * The exposure is one case: a human who corrected one of these fields in the past
 * could see TaneChat overwrite it. Bounded, because a human edit made *after* this
 * runs drops the field from api_set_fields again (the provenance hook on
 * PUT /api/inquiry/:id), which re-protects it permanently.
 *
 * REVERSAL
 * --------
 * Every changed row is snapshotted into `inquiry_provenance_backfill_backup` before
 * anything is written. The script prints the exact revert statement.
 */

require('dotenv').config();
const mysql = require('mysql2/promise');
const config = require('../src/config');

const FIELDS = ['first_name', 'last_name', 'email', 'phone', 'budget', 'desired_start_date'];

// Open, machine-created, chat-sourced. Anything a human made or touched enough to
// close is out of scope.
const SCOPE = `deleted_at IS NULL
                 AND status = 0
                 AND tenant_id IS NULL
                 AND source IN ('whatsapp', 'email')
                 AND created_by_user_id IS NULL`;

function isSet(value) {
  return value !== null && value !== undefined && value !== '';
}

function parseList(value) {
  if (Array.isArray(value)) return value.filter(v => typeof v === 'string');
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter(v => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

// "Dr. Ashita Narula" + "Narula" -> "Dr. Ashita". Requires a real separator and a
// remainder, so first_name === last_name ("Ko" / "Ko") is left alone: there is no
// way to tell a duplicated surname from a genuine repeated name.
function repairedFirstName(firstName, lastName) {
  if (!isSet(firstName) || !isSet(lastName)) return null;
  const first = String(firstName).trim();
  const last = String(lastName).trim();
  if (first.length <= last.length) return null;
  if (!first.toLowerCase().endsWith(last.toLowerCase())) return null;
  const head = first.slice(0, first.length - last.length).trim();
  if (!head) return null;
  return head;
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const orgDbName = args.filter(a => !a.startsWith('--'))[0];
  if (!orgDbName) {
    console.error('Usage: node scripts/backfillInquiryApiProvenance.js <orgDbName> [--apply]');
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
    const [rows] = await conn.query(
      `SELECT id, org_id, first_name, last_name, email, phone, budget,
              DATE_FORMAT(desired_start_date, '%Y-%m-%d') AS desired_start_date,
              api_set_fields
         FROM inquiry
        WHERE ${SCOPE}
        ORDER BY id`
    );

    const provenanceChanges = [];
    const nameRepairs = [];

    for (const row of rows) {
      const existing = parseList(row.api_set_fields);
      const populated = FIELDS.filter(f => isSet(row[f]));
      const merged = [...new Set([...existing, ...populated])];
      if (merged.length !== existing.length) {
        provenanceChanges.push({ id: String(row.id), before: existing, after: merged });
      }
      const fixed = repairedFirstName(row.first_name, row.last_name);
      if (fixed) {
        nameRepairs.push({ id: String(row.id), before: row.first_name, after: fixed, last_name: row.last_name });
      }
    }

    console.log(`${orgDbName}: ${rows.length} in-scope inquiries (open, chat-sourced, no human creator)`);
    console.log(`  provenance rows to change: ${provenanceChanges.length}`);
    console.log(`  first_name repairs:        ${nameRepairs.length}`);
    console.log('');
    for (const r of nameRepairs) {
      console.log(`  name  ${r.id}: "${r.before}" + "${r.last_name}"  ->  "${r.after}"`);
    }
    if (provenanceChanges.length) {
      console.log('');
      console.log('  sample provenance changes:');
      for (const r of provenanceChanges.slice(0, 5)) {
        console.log(`    ${r.id}: [${r.before.join(', ')}] -> [${r.after.join(', ')}]`);
      }
    }

    if (!apply) {
      console.log('');
      console.log('DRY RUN — nothing written. Re-run with --apply to make these changes.');
      return;
    }

    await conn.query(
      `CREATE TABLE IF NOT EXISTS inquiry_provenance_backfill_backup (
         inquiry_id            BIGINT      NOT NULL,
         api_set_fields_before JSON        NULL,
         first_name_before     VARCHAR(255) NULL,
         backed_up_at          TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
         PRIMARY KEY (inquiry_id)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
    );

    const touched = new Set([...provenanceChanges.map(r => r.id), ...nameRepairs.map(r => r.id)]);
    await conn.beginTransaction();
    try {
      for (const id of touched) {
        const row = rows.find(r => String(r.id) === id);
        // INSERT IGNORE so a re-run cannot overwrite the ORIGINAL snapshot with a
        // half-applied one — the first backup is the one that can restore.
        await conn.execute(
          `INSERT IGNORE INTO inquiry_provenance_backfill_backup
             (inquiry_id, api_set_fields_before, first_name_before)
           VALUES (?, ?, ?)`,
          [id, JSON.stringify(parseList(row.api_set_fields)), row.first_name == null ? null : String(row.first_name)]
        );
      }
      for (const r of nameRepairs) {
        await conn.execute(`UPDATE inquiry SET first_name = ? WHERE id = ?`, [r.after, r.id]);
      }
      for (const r of provenanceChanges) {
        await conn.execute(`UPDATE inquiry SET api_set_fields = ? WHERE id = ?`, [JSON.stringify(r.after), r.id]);
      }
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    }

    console.log('');
    console.log(`APPLIED. ${provenanceChanges.length} provenance row(s), ${nameRepairs.length} name repair(s).`);
    console.log(`Snapshot: ${touched.size} row(s) in inquiry_provenance_backfill_backup.`);
    console.log('');
    console.log('To revert everything this script did:');
    console.log('  UPDATE inquiry i');
    console.log('    JOIN inquiry_provenance_backfill_backup b ON b.inquiry_id = i.id');
    console.log('     SET i.api_set_fields = b.api_set_fields_before,');
    console.log('         i.first_name     = b.first_name_before;');
  } finally {
    await conn.end();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
