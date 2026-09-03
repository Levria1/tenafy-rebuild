/**
 * One-off backfill: remove commas from stored tenant name parts.
 *
 * Deliberately NARROW. A full "letters only" pass would rewrite 2,991 of 4,765 rows,
 * and almost all of that is not bad data entry: routes/accounting.js auto-creates
 * category-2 payee rows from raw bank statement text ("CLP POWER HK LTD 82850500212"),
 * and the payment matcher compares on first_name + last_name, so those reference numbers
 * are load-bearing. Parenthetical English names ("Qin (Hazel)") were also typed on
 * purpose. Operator decision 2026-09-04: commas only.
 *
 * Scoped to category = 1 (real tenants). See the query comment for why.
 *
 * Usage:
 *   node scripts/stripNameCommas.js            # dry run, prints every change
 *   node scripts/stripNameCommas.js --apply    # writes
 *
 * Idempotent: re-running after a successful apply finds nothing.
 */

require('dotenv').config();
const pool = require('../src/config/database');

const ORG_ID = process.env.BACKFILL_ORG_ID || '8300127259922432';
const APPLY = process.argv.includes('--apply');
const FIELDS = ['first_name', 'middle_name', 'last_name'];

// Commas out, then tidy the whitespace they leave behind ("Marie, Balthazar" would
// otherwise become "Marie  Balthazar"). Nothing else is touched.
const stripCommas = (value) => {
  if (typeof value !== 'string' || !value.includes(',')) return null;
  const next = value.replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
  return next === value ? null : next;
};

(async () => {
  // category = 1 only. Category 2 is payees, and routes/accounting.js fills those from
  // bank statement text: money amounts ("1,218.00"), company names ("BARWIN METAL CO.,
  // LTD"), payment references, in one case an entire pasted message. Removing a comma
  // from "1,218.00" yields "1 218.00", which reads as two numbers and is worse than
  // leaving it. Those rows are the importer's business, not a person's name.
  const [rows] = await pool.execute(
    `SELECT id, first_name, middle_name, last_name FROM tenant
      WHERE org_id = ? AND deleted_at IS NULL AND category = 1
        AND (first_name LIKE '%,%' OR middle_name LIKE '%,%' OR last_name LIKE '%,%')`,
    [ORG_ID]
  );

  const plan = [];
  for (const row of rows) {
    const sets = {};
    for (const field of FIELDS) {
      const next = stripCommas(row[field]);
      if (next !== null) sets[field] = next;
    }
    if (Object.keys(sets).length) plan.push({ id: String(row.id), before: row, sets });
  }

  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} — org ${ORG_ID}`);
  console.log(`rows containing a comma: ${rows.length}`);
  console.log(`rows to change:          ${plan.length}\n`);
  for (const p of plan) {
    for (const [field, next] of Object.entries(p.sets)) {
      console.log(`  ${p.id}  ${field.padEnd(12)} "${p.before[field]}"  ->  "${next}"`);
    }
  }

  if (!APPLY) {
    console.log('\nNothing written. Re-run with --apply to write.');
    process.exit(0);
  }

  let changed = 0;
  for (const p of plan) {
    const fields = Object.keys(p.sets);
    // Each field is guarded on its CURRENT value, so a row edited by a human between
    // the dry run and the apply is skipped rather than silently overwritten.
    const setSql = fields.map(f => `${f} = ?`).join(', ');
    const whereSql = fields.map(f => `${f} = ?`).join(' AND ');
    const [res] = await pool.execute(
      `UPDATE tenant SET ${setSql}, updated_at = NOW()
        WHERE id = ? AND org_id = ? AND ${whereSql}`,
      [...fields.map(f => p.sets[f]), p.id, ORG_ID, ...fields.map(f => p.before[f])]
    );
    if (res.affectedRows === 1) changed++;
    else console.warn(`  SKIPPED ${p.id} — row changed since the dry run`);
  }
  console.log(`\nrows updated: ${changed} of ${plan.length}`);
  process.exit(0);
})().catch(e => { console.error(e.stack); process.exit(1); });
