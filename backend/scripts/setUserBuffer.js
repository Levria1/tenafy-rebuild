#!/usr/bin/env node
/**
 * Set a user's viewing_buffer_minutes (for back-to-back viewing spacing).
 * Usage: node scripts/setUserBuffer.js <username> <minutes>
 * Example:
 *   node scripts/setUserBuffer.js acjairbnb@gmail.com 30
 *   node scripts/setUserBuffer.js taneresidence3@gmail.com 60
 */

require('dotenv').config();
const mysql = require('mysql2/promise');

const [, , username, minutesArg] = process.argv;
const minutes = parseInt(minutesArg, 10);

if (!username || isNaN(minutes) || minutes < 0 || minutes > 240) {
  console.error('Usage: node scripts/setUserBuffer.js <username> <minutes>');
  console.error('Minutes must be 0-240.');
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
      `UPDATE user SET viewing_buffer_minutes = ? WHERE username = ?`,
      [minutes, username]
    );
    if (res.affectedRows === 0) {
      console.error(`No user found with username: ${username}`);
      process.exit(1);
    }
    console.log(`✓ Updated ${username} — viewing buffer set to ${minutes} min`);
  } finally {
    await conn.end();
  }
})().catch(e => { console.error(e); process.exit(1); });
