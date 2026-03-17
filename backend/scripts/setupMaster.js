/**
 * Setup Master Database
 *
 * Run once to:
 * 1. Create tena_master database and tables
 * 2. Create a master admin user
 * 3. Register existing org (tena_prod / 8300127259922432)
 * 4. Populate org_user_map from existing users
 *
 * Usage: node scripts/setupMaster.js
 */

require('dotenv').config();
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');

const DB_HOST = process.env.DB_HOST || 'localhost';
const DB_PORT = process.env.DB_PORT || 3306;
const DB_USER = process.env.DB_USER || 'root';
const DB_PASSWORD = process.env.DB_PASSWORD || '';
const MASTER_DB = process.env.MASTER_DB_NAME || 'tena_master';
const ORG_DB = process.env.DB_DATABASE || 'tena_prod';
const ORG_ID = '8300127259922432';

// Master admin credentials (change these)
const MASTER_USERNAME = process.env.MASTER_ADMIN_USERNAME || 'masteradmin';
const MASTER_PASSWORD = process.env.MASTER_ADMIN_PASSWORD || 'Master1234';
const MASTER_EMAIL = process.env.MASTER_ADMIN_EMAIL || 'master@tenafy.com';

async function run() {
  // Connect without a specific database
  const conn = await mysql.createConnection({
    host: DB_HOST,
    port: DB_PORT,
    user: DB_USER,
    password: DB_PASSWORD,
    multipleStatements: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
  });

  console.log('Connected to MySQL');

  // Step 1: Run master database migration
  console.log('\n--- Step 1: Create master database and tables ---');
  const migrationSql = fs.readFileSync(
    path.join(__dirname, '../src/migrations/001_master_database.sql'),
    'utf8'
  );
  await conn.query(migrationSql);
  console.log(`Database '${MASTER_DB}' and tables created`);

  // Step 2: Create master admin user
  console.log('\n--- Step 2: Create master admin user ---');
  await conn.query(`USE ${MASTER_DB}`);

  const [existing] = await conn.execute(
    'SELECT id FROM master_admin WHERE username = ?',
    [MASTER_USERNAME]
  );

  if (existing.length) {
    console.log(`Master admin '${MASTER_USERNAME}' already exists, skipping`);
  } else {
    const hashedPassword = await bcrypt.hash(MASTER_PASSWORD, 10);
    const adminId = (BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000))).toString();
    await conn.execute(
      'INSERT INTO master_admin (id, username, password, email, first_name, last_name) VALUES (?, ?, ?, ?, ?, ?)',
      [adminId, MASTER_USERNAME, hashedPassword, MASTER_EMAIL, 'Master', 'Admin']
    );
    console.log(`Master admin created: ${MASTER_USERNAME} / ${MASTER_PASSWORD}`);
  }

  // Step 3: Register existing org
  console.log('\n--- Step 3: Register existing organization ---');
  const [existingOrg] = await conn.execute(
    'SELECT id FROM organizations WHERE id = ?',
    [ORG_ID]
  );

  if (existingOrg.length) {
    console.log(`Organization ${ORG_ID} already registered, skipping`);
  } else {
    await conn.execute(
      'INSERT INTO organizations (id, display_name, db_name, db_host, db_port, db_user, db_password, status) VALUES (?, ?, ?, ?, ?, ?, ?, 1)',
      [ORG_ID, 'Tane Residence', ORG_DB, DB_HOST, DB_PORT, DB_USER, DB_PASSWORD]
    );
    console.log(`Registered org ${ORG_ID} → database: ${ORG_DB}`);
  }

  // Step 4: Populate org_user_map from existing users
  console.log('\n--- Step 4: Populate org_user_map ---');
  const [users] = await conn.execute(
    `SELECT username, email FROM ${ORG_DB}.user WHERE org_id = ? AND status = 1`,
    [ORG_ID]
  );

  let inserted = 0;
  for (const u of users) {
    try {
      await conn.execute(
        'INSERT IGNORE INTO org_user_map (username, email, org_id, db_name) VALUES (?, ?, ?, ?)',
        [u.username, u.email, ORG_ID, ORG_DB]
      );
      inserted++;
    } catch (err) {
      // Duplicate key, skip
    }
  }
  console.log(`Inserted ${inserted} user(s) into org_user_map (${users.length} total in org)`);

  await conn.end();
  console.log('\nSetup complete!');
  console.log(`\nMaster admin login: ${MASTER_USERNAME} / ${MASTER_PASSWORD}`);
  console.log('Login at: http://localhost:3000/master/login');
}

run().catch(err => {
  console.error('Setup failed:', err);
  process.exit(1);
});
