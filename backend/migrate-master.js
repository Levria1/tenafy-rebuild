#!/usr/bin/env node
/**
 * MASTER database migration runner.
 *
 * Usage:  npm run migrate:master        (or: node migrate-master.js)
 *
 * Applies backend/migrations-master/*.sql to `tena_master` — the registry database holding
 * `organizations`, `api_keys`, `master_admin`, `org_user_map` and `viewing_link_registry`.
 *
 * Why this exists: it did not, and that cost a failed deploy. Despite its header, `migrate.js`
 * runs against DB_DATABASE, which in production is the main ORG database (tena_prod_v2) — so
 * `backend/migrations/` is the legacy single-org set, and master had no migration path at all.
 * A migration placed there to add a column to `organizations` failed with "Table
 * tena_prod_v2.organizations doesn't exist", and would have failed on every deploy thereafter,
 * blocking everything queued behind it.
 *
 * Same mechanism as its two siblings: a `schema_migrations` table in the database being
 * migrated, alphabetical order, files must be idempotent so re-running is safe.
 */

require('dotenv').config();
const mysql = require('mysql2/promise');
const fs    = require('fs');
const path  = require('path');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations-master');
const MASTER_DB      = process.env.MASTER_DB_NAME || 'tena_master';

async function run() {
  const conn = await mysql.createConnection({
    host:     process.env.DB_HOST     || 'localhost',
    port:     process.env.DB_PORT     || 3306,
    user:     process.env.DB_USER     || 'root',
    password: process.env.DB_PASSWORD || '',
    database: MASTER_DB,
    multipleStatements: true,
  });
  console.log('Connected to MASTER database:', MASTER_DB);

  await conn.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         INT          NOT NULL AUTO_INCREMENT,
      filename   VARCHAR(255) NOT NULL,
      applied_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_schema_migrations_filename (filename)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  const [applied] = await conn.execute('SELECT filename FROM schema_migrations');
  const done = new Set(applied.map(r => r.filename));

  const files = fs.existsSync(MIGRATIONS_DIR)
    ? fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort()
    : [];
  const pending = files.filter(f => !done.has(f));

  if (!pending.length) {
    console.log('No pending master migrations. Database is up to date.');
    await conn.end();
    return;
  }

  console.log(`Found ${pending.length} pending migration(s):`);
  let failed = 0;
  for (const file of pending) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    try {
      console.log('  → Running:', file);
      await conn.query(sql);
      await conn.execute('INSERT INTO schema_migrations (filename) VALUES (?)', [file]);
      console.log('  ✓ Applied: ', file);
    } catch (err) {
      failed += 1;
      console.error('  ✗ Failed:  ', file);
      console.error('    ', err.message);
      break;   // stop rather than run later files against a half-migrated schema
    }
  }
  await conn.end();
  if (failed) process.exit(1);
  console.log('Master database up to date.');
}

run().catch((err) => { console.error('Master migration error:', err.message); process.exit(1); });
