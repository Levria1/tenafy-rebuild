#!/usr/bin/env node
/**
 * Per-org migration runner.
 *
 * Usage:  npm run migrate:orgs        (or: node migrate-orgs.js)
 *
 * Companion to migrate.js. Where migrate.js migrates the MAIN/master database,
 * this applies backend/migrations-org/*.sql to EVERY active org database listed
 * in tena_master.organizations.
 *
 * - Tracks applied files PER-DB in each org's own `schema_migrations` table
 *   (same mechanism as migrate.js), so each org only runs what it's missing.
 * - Files in migrations-org/ MUST be idempotent (CREATE TABLE IF NOT EXISTS,
 *   information_schema-guarded ALTERs), so they're safe on already-current orgs.
 * - One org failing does NOT stop the others; the script reports all failures at
 *   the end and exits non-zero so the deploy surfaces the problem.
 *
 * Why this exists: migrate.js only touches the main DB, so per-org DBs silently
 * drift behind the code (missing columns/tables → 500s). This keeps them in sync.
 */

require('dotenv').config();
const mysql = require('mysql2/promise');
const fs    = require('fs');
const path  = require('path');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations-org');
const MASTER_DB      = process.env.MASTER_DB_NAME || 'tena_master';

const base = {
  host:     process.env.DB_HOST     || 'localhost',
  port:     process.env.DB_PORT     || 3306,
  user:     process.env.DB_USER     || 'root',
  password: process.env.DB_PASSWORD || '',
};

async function ensureMigrationsTable(conn) {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         INT          NOT NULL AUTO_INCREMENT,
      filename   VARCHAR(255) NOT NULL UNIQUE,
      applied_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

async function migrateOneOrg(org, files) {
  const conn = await mysql.createConnection({
    host:               org.db_host     || base.host,
    port:               org.db_port     || base.port,
    user:               org.db_user     || base.user,
    password:           org.db_password || base.password,
    database:           org.db_name,
    multipleStatements: true, // migration files contain multiple statements
  });

  let applied = 0;
  try {
    await ensureMigrationsTable(conn);
    const [doneRows] = await conn.query('SELECT filename FROM schema_migrations');
    const done = new Set(doneRows.map(r => r.filename));
    const pending = files.filter(f => !done.has(f));

    for (const filename of pending) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf8');
      await conn.query(sql);
      await conn.query('INSERT INTO schema_migrations (filename) VALUES (?)', [filename]);
      applied++;
      console.log(`      ✓ ${filename}`);
    }
  } finally {
    await conn.end();
  }
  return applied;
}

async function run() {
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    console.log('No migrations-org/ directory — nothing to do.');
    return;
  }
  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
  if (files.length === 0) {
    console.log('No per-org migration files found.');
    return;
  }

  // Load the active org registry from the master DB.
  const master = await mysql.createConnection({ ...base, database: MASTER_DB });
  let orgs;
  try {
    const [rows] = await master.query(
      `SELECT id, db_name, db_host, db_port, db_user, db_password
       FROM organizations WHERE status = 1 ORDER BY id`
    );
    orgs = rows;
  } finally {
    await master.end();
  }

  console.log(`Per-org migrations: ${files.length} file(s) × ${orgs.length} active org(s)\n`);

  const failures = [];
  let totalApplied = 0;

  for (const org of orgs) {
    console.log(`  → ${org.db_name}`);
    try {
      const n = await migrateOneOrg(org, files);
      totalApplied += n;
      if (n === 0) console.log('      (already up to date)');
    } catch (err) {
      console.error(`      ✗ FAILED: ${err.message}`);
      failures.push({ db: org.db_name, error: err.message });
    }
  }

  console.log(`\nApplied ${totalApplied} migration(s) across ${orgs.length} org(s).`);

  if (failures.length) {
    console.error(`\n${failures.length} org(s) FAILED:`);
    failures.forEach(f => console.error(`  - ${f.db}: ${f.error}`));
    process.exit(1);
  }
  console.log('All org databases up to date.');
}

run().catch(err => {
  console.error('Per-org migration runner error:', err.message);
  process.exit(1);
});
