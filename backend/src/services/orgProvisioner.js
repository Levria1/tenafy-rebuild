const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const mysql = require('mysql2/promise');
const config = require('../config');
const { getMasterPool } = require('../config/poolRegistry');

async function provisionOrg({ orgId, displayName, adminUsername, adminPassword, adminEmail, adminFirstName, adminLastName }) {
  const dbName = `tena_org_${orgId}`;
  const masterPool = getMasterPool();

  // Create a temporary connection without a specific database to run CREATE DATABASE
  const tempConn = await mysql.createConnection({
    host: config.database.host,
    port: config.database.port,
    user: config.database.user,
    password: config.database.password,
    supportBigNumbers: true,
    bigNumberStrings: true,
    multipleStatements: true
  });

  try {
    // 1. Create the org database
    await tempConn.query(`CREATE DATABASE \`${dbName}\``);
    console.log(`Created database: ${dbName}`);

    // 2. Execute schema template
    const schemaPath = path.join(__dirname, '../migrations/org_schema_template.sql');
    let schemaSql = fs.readFileSync(schemaPath, 'utf8');
    // Remove any USE or CREATE DATABASE statements from the template
    schemaSql = schemaSql.replace(/^(USE|CREATE DATABASE)[^;]*;\s*/gim, '');

    await tempConn.query(`USE \`${dbName}\``);
    // Split by statement and execute individually to handle edge cases
    const statements = schemaSql.split(/;\s*\n/).filter(s => s.trim());
    for (const stmt of statements) {
      if (stmt.trim()) {
        try {
          await tempConn.query(stmt);
        } catch (e) {
          // Skip errors for things like duplicate table, etc
          if (!e.message.includes('already exists')) {
            console.warn(`Schema statement warning: ${e.message}`);
          }
        }
      }
    }
    console.log(`Schema applied to ${dbName}`);

    // 3. Seed default data
    // Create the organization record in the org database
    await tempConn.query(
      `INSERT INTO organization (id, display_name, type, status, created_at) VALUES (?, ?, 6, 1, NOW())`,
      [orgId, displayName]
    );

    // System admin role
    const roleId = '230000000001';
    await tempConn.query(
      `INSERT INTO role (id, display_name, description, type, org_id, status) VALUES (?, 'Landlord System Manager', 'Full system access', 1, ?, 1)`,
      [roleId, orgId]
    );

    // All LANDLORD permissions
    const permissions = [
      'LANDLORD/DASHBOARD',
      'LANDLORD/PROPERTY_LIST', 'LANDLORD/PROPERTY_CREATE', 'LANDLORD/PROPERTY_EDIT', 'LANDLORD/PROPERTY_DETAIL', 'LANDLORD/PROPERTY_DELETE', 'LANDLORD/PROPERTY_CLONE',
      'LANDLORD/UNIT_LIST', 'LANDLORD/UNIT_CREATE', 'LANDLORD/UNIT_DETAIL', 'LANDLORD/UNIT_EDIT', 'LANDLORD/UNIT_DELETE', 'LANDLORD/UNIT_CLONE',
      'LANDLORD/TENANT_LIST', 'LANDLORD/TENANT_CREATE', 'LANDLORD/TENANT_EDIT', 'LANDLORD/TENANT_DELETE', 'LANDLORD/TENANT_DETAIL',
      'LANDLORD/PAYEE_LIST', 'LANDLORD/PAYEE_CREATE', 'LANDLORD/PAYEE_EDIT', 'LANDLORD/PAYEE_DELETE', 'LANDLORD/PAYEE_DETAIL',
      'LANDLORD/LEASING_LIST', 'LANDLORD/LEASING_CREATE', 'LANDLORD/LEASING_DETAIL', 'LANDLORD/LEASING_EDIT', 'LANDLORD/LEASING_DELETE',
      'LANDLORD/ACCOUNTING_LIST', 'LANDLORD/ACCOUNTING_CREATE', 'LANDLORD/ACCOUNTING_EDIT', 'LANDLORD/ACCOUNTING_DETAIL', 'LANDLORD/ACCOUNTING_DELETE',
      'LANDLORD/INVOICE_LIST', 'LANDLORD/INVOICE_CREATE', 'LANDLORD/INVOICE_EDIT', 'LANDLORD/INVOICE_DETAIL', 'LANDLORD/INVOICE_DELETE',
      'LANDLORD/INVOICE_CREATE_MULTIPLE_PAY', 'LANDLORD/INVOICE_CREATE_MULTIPLE_RECEIVE',
      'LANDLORD/USER_LIST', 'LANDLORD/USER_CREATE', 'LANDLORD/USER_EDIT', 'LANDLORD/USER_DETAIL', 'LANDLORD/USER_DELETE', 'LANDLORD/USER_ROLE_ASSIGN',
      'LANDLORD/SETTING_PERSONAL', 'LANDLORD/SETTING_CURRENCY', 'LANDLORD/SETTING_AMENITY',
      'LANDLORD/AMENITY_CREATE', 'LANDLORD/AMENITY_EDIT', 'LANDLORD/AMENITY_DELETE',
      'LANDLORD/SETTING_LANDLORD', 'LANDLORD/SETTING_ACCOUNT', 'LANDLORD/SETTING_PAYMENT_METHODS', 'LANDLORD/SETTING_CATEGORY', 'LANDLORD/SETTING_SEQUENCE',
      'LANDLORD/ROLE_LIST', 'LANDLORD/ROLE_CREATE', 'LANDLORD/ROLE_EDIT', 'LANDLORD/ROLE_DELETE', 'LANDLORD/ROLE_DETAIL',
      'LANDLORD/SETTING_EMAIL_TEMPLATE', 'LANDLORD/EMAIL_TEMPLATE_CREATE', 'LANDLORD/EMAIL_TEMPLATE_EDIT', 'LANDLORD/EMAIL_TEMPLATE_DETAIL', 'LANDLORD/EMAIL_TEMPLATE_DELETE',
      'LANDLORD/EMAIL_GROUP_LIST', 'LANDLORD/EMAIL_GROUP_CREATE', 'LANDLORD/EMAIL_GROUP_EDIT',
      'LANDLORD/SERVICE_LIST', 'LANDLORD/SERVICE_DETAIL', 'LANDLORD/SERVICE_CREATE', 'LANDLORD/SERVICE_EDIT', 'LANDLORD/SERVICE_DELETE',
      'LANDLORD/SERVICE_VENDOR_LIST', 'LANDLORD/SERVICE_VENDOR_CREATE', 'LANDLORD/SERVICE_VENDOR_DETAIL', 'LANDLORD/SERVICE_VENDOR_EDIT', 'LANDLORD/SERVICE_VENDOR_DELETE',
      'LANDLORD/LISTING_LIST', 'LANDLORD/LISTING_CREATE', 'LANDLORD/LISTING_DETAIL', 'LANDLORD/LISTING_EDIT', 'LANDLORD/LISTING_DELETE',
    ];

    for (const perm of permissions) {
      await tempConn.query(
        'INSERT INTO role_permission (role_id, permission_code) VALUES (?, ?)',
        [roleId, perm]
      );
    }

    // 4. Create super admin user
    const userId = (BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000))).toString();
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = '{bcrypt}' + await bcrypt.hash(adminPassword, salt);

    await tempConn.query(
      `INSERT INTO user (id, username, email, password, first_name, last_name, org_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, NOW(), NOW())`,
      [userId, adminUsername, adminEmail, hashedPassword, adminFirstName, adminLastName, orgId]
    );

    // Assign system admin role
    await tempConn.query(
      'INSERT INTO user_role (user_id, role_id) VALUES (?, ?)',
      [userId, roleId]
    );

    // 5. Register in master database
    await masterPool.execute(
      `INSERT INTO organizations (id, display_name, db_name, status, created_at) VALUES (?, ?, ?, 1, NOW())`,
      [orgId, displayName, dbName]
    );

    // 6. Insert into org_user_map
    await masterPool.execute(
      'INSERT INTO org_user_map (username, email, org_id, db_name) VALUES (?, ?, ?, ?)',
      [adminUsername, adminEmail, orgId, dbName]
    );

    console.log(`Organization ${displayName} (${orgId}) provisioned successfully`);
    return { orgId, dbName, userId };
  } catch (error) {
    // Attempt cleanup on failure
    try { await tempConn.query(`DROP DATABASE IF EXISTS \`${dbName}\``); } catch (e) {}
    try { await masterPool.execute('DELETE FROM organizations WHERE id = ?', [orgId]); } catch (e) {}
    try { await masterPool.execute('DELETE FROM org_user_map WHERE org_id = ?', [orgId]); } catch (e) {}
    throw error;
  } finally {
    await tempConn.end();
  }
}

module.exports = { provisionOrg };
