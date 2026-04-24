/**
 * Backfill operational defaults (currency, sequences, categories) into an
 * existing org that was provisioned before orgProvisioner started seeding them.
 *
 * Idempotent — re-running on an already-seeded org is a no-op.
 *
 * Usage:
 *   node scripts/seedOrgDefaults.js <org_id>
 *   node scripts/seedOrgDefaults.js 1776755536769098686
 */

require('dotenv').config();
const mysql = require('mysql2/promise');
const config = require('../src/config');
const { getMasterPool } = require('../src/config/poolRegistry');
const { seedOrgDefaults } = require('../src/services/orgSeedDefaults');

async function run() {
  const orgId = process.argv[2];
  if (!orgId) {
    console.error('Usage: node scripts/seedOrgDefaults.js <org_id>');
    process.exit(1);
  }

  const masterPool = getMasterPool();
  const [rows] = await masterPool.execute(
    'SELECT id, display_name, db_name FROM organizations WHERE id = ?',
    [orgId]
  );
  if (!rows.length) {
    console.error(`Org ${orgId} not found in tena_master.organizations`);
    process.exit(1);
  }
  const org = rows[0];
  console.log(`Seeding defaults into: ${org.display_name} (db=${org.db_name})`);

  const conn = await mysql.createConnection({
    host: config.database.host,
    port: config.database.port,
    user: config.database.user,
    password: config.database.password,
    database: org.db_name,
    supportBigNumbers: true,
    bigNumberStrings: true,
  });

  try {
    const result = await seedOrgDefaults(conn, orgId);
    console.log('Done:', result);
    console.log(`  currency added:   ${result.currency}`);
    console.log(`  sequences added:  ${result.sequences}`);
    console.log(`  categories added: ${result.categories}`);
  } finally {
    await conn.end();
  }
}

run().catch(err => {
  console.error('Seeding failed:', err);
  process.exit(1);
});
