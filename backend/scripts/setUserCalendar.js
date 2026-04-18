#!/usr/bin/env node
/**
 * Set a user's google_calendar_id.
 * Usage: node scripts/setUserCalendar.js <username> <calendar_id>
 * Example:
 *   node scripts/setUserCalendar.js dennis qvqgs5781vv7vkeap9drss1a3c@group.calendar.google.com
 */

require('dotenv').config();
const mysql = require('mysql2/promise');

const [, , username, calendarId] = process.argv;

if (!username || !calendarId) {
  console.error('Usage: node scripts/setUserCalendar.js <username> <calendar_id>');
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
    const [res] = await conn.execute(
      `UPDATE user SET google_calendar_id = ? WHERE username = ?`,
      [calendarId, username]
    );
    if (res.affectedRows === 0) {
      console.error(`No user found with username: ${username}`);
      process.exit(1);
    }
    console.log(`✓ Updated ${username} → ${calendarId}`);
  } finally {
    await conn.end();
  }
})().catch(e => { console.error(e); process.exit(1); });
