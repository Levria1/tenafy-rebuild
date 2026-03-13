require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');

const ORG_ID = '8300127259922432';
const EMAIL = 'alextn@gmail.com';
const USERNAME = 'alextn@gmail.com';
const FIRST_NAME = 'Alex';
const LAST_NAME = 'TN';
const PASSWORD = 'Tenafy8888';
const ADMIN_ROLE_ID = '230000000001';

async function seedAdmin() {
  const pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
  });

  try {
    // Check if user already exists
    const [existing] = await pool.execute('SELECT id FROM user WHERE email = ? AND org_id = ?', [EMAIL, ORG_ID]);
    if (existing.length > 0) {
      console.log('User already exists with id:', existing[0].id.toString());
      await pool.end();
      return;
    }

    // Generate Snowflake ID
    const userId = (BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000))).toString();

    // Hash password
    const hashedPassword = '{bcrypt}' + await bcrypt.hash(PASSWORD, 10);

    // Insert user
    await pool.execute(
      `INSERT INTO user (id, org_id, username, password, email, first_name, last_name, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, NOW(), NOW())`,
      [userId, ORG_ID, USERNAME, hashedPassword, EMAIL, FIRST_NAME, LAST_NAME]
    );
    console.log('Created user:', EMAIL, '| id:', userId);

    // Assign admin role
    await pool.execute(
      'INSERT INTO user_role (user_id, role_id) VALUES (?, ?)',
      [userId, ADMIN_ROLE_ID]
    );
    console.log('Assigned role: Landlord System Manager');

    console.log('\nDone! Login with username:', USERNAME, '/ password:', PASSWORD);
    await pool.end();
  } catch (err) {
    console.error('Error:', err.message);
    await pool.end();
    process.exit(1);
  }
}

seedAdmin();
