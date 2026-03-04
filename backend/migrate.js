#!/usr/bin/env node
/**
 * Migration runner
 * Usage:  npm run migrate
 *
 * - Reads all *.sql files from ./migrations/ in alphabetical order
 * - Creates a schema_migrations table to track what has already run
 * - Skips files that have already been applied
 * - Runs each pending migration inside a transaction (rolls back on error)
 */

require('dotenv').config();
const mysql = require('mysql2/promise');
const fs    = require('fs');
const path  = require('path');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

const dbConfig = {
  host:             process.env.DB_HOST     || 'localhost',
  port:             process.env.DB_PORT     || 3306,
  user:             process.env.DB_USER     || 'root',
  password:         process.env.DB_PASSWORD || '',
  database:         process.env.DB_DATABASE || 'tenafy',
  multipleStatements: true,   // required to run multi-statement SQL files
};

async function run() {
  const conn = await mysql.createConnection(dbConfig);
  console.log('Connected to database:', dbConfig.database);

  try {
    // 1. Ensure tracking table exists
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id         INT          NOT NULL AUTO_INCREMENT,
        filename   VARCHAR(255) NOT NULL UNIQUE,
        applied_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // 2. Load already-applied filenames
    const [applied] = await conn.execute('SELECT filename FROM schema_migrations');
    const appliedSet = new Set(applied.map(r => r.filename));

    // 3. Find pending migration files (sorted — e.g. 001_..., 002_...)
    const files = fs.readdirSync(MIGRATIONS_DIR)
      .filter(f => f.endsWith('.sql'))
      .sort();

    const pending = files.filter(f => !appliedSet.has(f));

    if (pending.length === 0) {
      console.log('No pending migrations. Database is up to date.');
      return;
    }

    console.log(`Found ${pending.length} pending migration(s):`);

    // 4. Run each pending migration
    for (const filename of pending) {
      const filepath = path.join(MIGRATIONS_DIR, filename);
      const sql      = fs.readFileSync(filepath, 'utf8');

      console.log(`  → Running: ${filename}`);

      await conn.beginTransaction();
      try {
        await conn.query(sql);
        await conn.execute(
          'INSERT INTO schema_migrations (filename) VALUES (?)',
          [filename]
        );
        await conn.commit();
        console.log(`  ✓ Applied: ${filename}`);
      } catch (err) {
        await conn.rollback();
        console.error(`  ✗ Failed:  ${filename}`);
        console.error(`    ${err.message}`);
        process.exit(1);
      }
    }

    console.log('\nAll migrations applied successfully.');
  } finally {
    await conn.end();
  }
}

run().catch(err => {
  console.error('Migration runner error:', err.message);
  process.exit(1);
});
