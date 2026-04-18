#!/usr/bin/env node
/**
 * One-shot: mark migrations 014-022 as applied in schema_migrations.
 *
 * These already exist on the local DB (added manually/earlier) but the
 * migration tracking table never recorded them, so `npm run migrate`
 * keeps trying to re-run them and fails on duplicate columns.
 */

require('dotenv').config();
const mysql = require('mysql2/promise');

const FILES = [
  '014_viewing_booking_viewer_contact.sql',
  '015_create_chat_tables.sql',
  '016_create_bot_settings.sql',
  '017_viewing_booking_source.sql',
  '018_chat_permissions.sql',
  '019_property_listing_url.sql',
  '020_unit_listing_url.sql',
  '021_bot_settings_custom_instructions.sql',
  '022_unit_deleted_at.sql',
];

(async () => {
  const conn = await mysql.createConnection({
    host:     process.env.DB_HOST     || 'localhost',
    port:     process.env.DB_PORT     || 3306,
    user:     process.env.DB_USER     || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_DATABASE || 'tenafy',
  });

  try {
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id         INT          NOT NULL AUTO_INCREMENT,
        filename   VARCHAR(255) NOT NULL UNIQUE,
        applied_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    for (const f of FILES) {
      await conn.query(
        'INSERT IGNORE INTO schema_migrations (filename) VALUES (?)',
        [f]
      );
      console.log(`  ✓ marked: ${f}`);
    }

    console.log('\nDone. Now run: npm run migrate');
  } finally {
    await conn.end();
  }
})().catch(e => {
  console.error(e);
  process.exit(1);
});
