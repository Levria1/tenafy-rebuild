#!/usr/bin/env node
/**
 * Fill tenant.id_type (migration 084) for tenants recorded before the field existed.
 *
 * Usage:
 *   node scripts/backfillTenantIdType.js <orgDbName> <orgId>            # dry run
 *   node scripts/backfillTenantIdType.js <orgDbName> <orgId> --apply    # write
 *
 * WHY
 * ---
 * IRD eTAX asks whether a tenant's ID number is an HKID or a passport, and the
 * stamping payload reports it. The column is new, so every existing tenant is NULL.
 *
 * RULE — classifyIdNumber in services/stampingPayload.js, the same rule used on save,
 * in Smart Extract and in the payload:
 *   valid HKID check digit → 'hkid'; HKID-shaped with a failing check digit, or any
 *   other 6–12 character letter/digit code → 'passport'; anything else (phone numbers,
 *   emails, two IDs in one box) is left NULL for a person to look at.
 *
 * SCOPE
 * -----
 * Only tenants of <orgId> (tena_prod_v2 holds hundreds of legacy orgs), not deleted,
 * with an id_card and id_type still NULL. A type someone has already set is never
 * overwritten — the UPDATE re-checks `id_type IS NULL`.
 *
 * Prints counts and number SHAPES only (A9999999), never the numbers themselves.
 *
 * REVERSAL
 * --------
 * Every changed tenant id is printed with the revert statement.
 */

require('dotenv').config();
const mysql = require('mysql2/promise');
const config = require('../src/config');
const { classifyIdNumber } = require('../src/services/stampingPayload');

const shape = v => String(v).trim().toUpperCase().replace(/\d/g, '9').replace(/[A-Z]/g, 'A');

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const [orgDbName, orgId] = args.filter(a => !a.startsWith('--'));
  if (!orgDbName || !/^\d+$/.test(orgId || '')) {
    console.error('Usage: node scripts/backfillTenantIdType.js <orgDbName> <orgId> [--apply]');
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
      `SELECT id, id_card FROM tenant
        WHERE org_id = ? AND deleted_at IS NULL AND id_type IS NULL
          AND id_card IS NOT NULL AND TRIM(id_card) <> ''`,
      [orgId]
    );

    const byType = { hkid: [], passport: [], unclassified: [] };
    const shapes = { hkid: {}, passport: {}, unclassified: {} };
    for (const r of rows) {
      const type = classifyIdNumber(r.id_card) || 'unclassified';
      byType[type].push(String(r.id));
      const s = shape(r.id_card);
      shapes[type][s] = (shapes[type][s] || 0) + 1;
    }

    console.log(`${orgDbName} org ${orgId}: ${rows.length} tenant(s) with an ID number and no ID type\n`);
    for (const type of ['hkid', 'passport', 'unclassified']) {
      const top = Object.entries(shapes[type]).sort((a, b) => b[1] - a[1]).slice(0, 8)
        .map(([s, n]) => `${s}×${n}`).join('  ');
      console.log(`  ${type.padEnd(12)} ${String(byType[type].length).padStart(4)}   ${top}`);
    }
    console.log('\n  unclassified rows are left NULL.');

    if (!apply) {
      console.log('\nDRY RUN — nothing written. Re-run with --apply to set the types.');
      return;
    }

    let written = 0;
    for (const type of ['hkid', 'passport']) {
      const ids = byType[type];
      for (let offset = 0; offset < ids.length; offset += 500) {
        const chunk = ids.slice(offset, offset + 500);
        const [res] = await conn.query(
          `UPDATE tenant SET id_type = ?
            WHERE org_id = ? AND id_type IS NULL AND id IN (${chunk.map(() => '?').join(',')})`,
          [type, orgId, ...chunk]
        );
        written += res.affectedRows;
      }
    }
    const planned = byType.hkid.length + byType.passport.length;
    console.log(`\nAPPLIED. ${written} tenant(s) updated.`);
    if (written !== planned) {
      console.log(`NOTE: ${planned - written} row(s) changed after this script read them and were skipped.`);
    }
    const all = [...byType.hkid, ...byType.passport];
    if (all.length) {
      console.log('\nTo revert exactly what this run did:');
      console.log(`  UPDATE tenant SET id_type = NULL WHERE org_id = ${orgId} AND id IN (${all.join(', ')});`);
    }
  } finally {
    await conn.end();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
