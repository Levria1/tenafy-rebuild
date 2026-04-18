#!/usr/bin/env node
/**
 * Lists all active users so you can find the username for Dennis and CL.
 * Usage: node scripts/listUsers.js
 */

require('dotenv').config();
const mysql = require('mysql2/promise');

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
    const [rows] = await conn.execute(
      `SELECT id, username, first_name, last_name, email, google_calendar_id
       FROM user
       WHERE status = 1 AND org_id = ?
       ORDER BY first_name, last_name`,
      [orgId]
    );
    console.log(`Showing active users for org ${orgId}:\n`);
    console.table(rows.map(r => ({
      id: String(r.id),
      username: r.username,
      name: `${r.first_name || ''} ${r.last_name || ''}`.trim(),
      email: r.email,
      calendar: r.google_calendar_id || '(none)',
    })));
  } finally {
    await conn.end();
  }
})().catch(e => { console.error(e); process.exit(1); });
