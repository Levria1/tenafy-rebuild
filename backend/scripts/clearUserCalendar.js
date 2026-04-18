#!/usr/bin/env node
/**
 * Clear a user's google_calendar_id (set back to NULL).
 * Usage:
 *   node scripts/clearUserCalendar.js <username>    — clear one user
 *   node scripts/clearUserCalendar.js --all         — clear everyone in this org
 */

require('dotenv').config();
const mysql = require('mysql2/promise');

const [, , arg] = process.argv;

if (!arg) {
  console.error('Usage: node scripts/clearUserCalendar.js <username|--all>');
  process.exit(1);
}

(async () => {
  const conn = await mysql.createConnection({
    host:     process.env.DB_HOST     || 'localhost',
    port:     process.env.DB_PORT     || 3306,
    user:     process.env.DB_USER     || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_DATABASE || 'tenafy',
  });

  try {
    const orgId = process.env.DEFAULT_ORG_ID || '8300127259922432';
    let res;
    if (arg === '--all') {
      [res] = await conn.execute(
        `UPDATE user SET google_calendar_id = NULL WHERE org_id = ?`,
        [orgId]
      );
      console.log(`✓ Cleared google_calendar_id on ${res.affectedRows} user(s)`);
    } else {
      [res] = await conn.execute(
        `UPDATE user SET google_calendar_id = NULL WHERE username = ?`,
        [arg]
      );
      if (res.affectedRows === 0) {
        console.error(`No user found with username: ${arg}`);
        process.exit(1);
      }
      console.log(`✓ Cleared ${arg}`);
    }
  } finally {
    await conn.end();
  }
})().catch(e => { console.error(e); process.exit(1); });
