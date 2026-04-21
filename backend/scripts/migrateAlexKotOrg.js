/**
 * Migrate Alex Kot organization (old Tenafy org_id 9769886235037696) into
 * the new multi-org rebuild as a new org.
 *
 * Imports ONLY properties + units (+ their amenities and furnishings).
 * SKIPS tenants, leasing, accounting, invoices, property_owner, etc.
 *
 * Source:   tena_prod (loaded from D:\Tane\tena_prod_dump.sql)
 * Source org_id: 9769886235037696 ("Alex Kot", HKD, 7 properties, 20 units)
 *
 * Usage:
 *   node scripts/migrateAlexKotOrg.js                 # dry-run (default)
 *   node scripts/migrateAlexKotOrg.js --execute       # actually run it
 *   node scripts/migrateAlexKotOrg.js --execute --password=YourPass
 *
 * After success, login at http://localhost:3000/login with:
 *   username: alexkot.tenafy@gmail.com
 *   password: (value of --password, or default below)
 */

require('dotenv').config();
const mysql = require('mysql2/promise');
const { provisionOrg } = require('../src/services/orgProvisioner');
const config = require('../src/config');

const SOURCE_DB = process.env.SOURCE_DB_NAME || 'tena_prod';
const SOURCE_ORG_ID = '9769886235037696';

const args = process.argv.slice(2);
const EXECUTE = args.includes('--execute');
const passwordArg = args.find(a => a.startsWith('--password='));
const ADMIN_PASSWORD = passwordArg ? passwordArg.split('=')[1] : 'AlexKot1234';

const NEW_ORG_DISPLAY_NAME = 'Alex Kot';
const NEW_ADMIN_USERNAME = 'alexkot.tenafy@gmail.com';
const NEW_ADMIN_EMAIL = 'alexkot.tenafy@gmail.com';
const NEW_ADMIN_FIRST_NAME = 'Alex';
const NEW_ADMIN_LAST_NAME = 'Kot';

async function getSourceConn() {
  return mysql.createConnection({
    host: config.database.host,
    port: config.database.port,
    user: config.database.user,
    password: config.database.password,
    database: SOURCE_DB,
    supportBigNumbers: true,
    bigNumberStrings: true,
  });
}

async function preview() {
  const conn = await getSourceConn();
  try {
    const [[orgRow]] = await conn.query(
      'SELECT id, display_name, default_currency FROM organization WHERE id = ?',
      [SOURCE_ORG_ID]
    );
    const [props] = await conn.query(
      'SELECT id, display_name, street_address, city, currency FROM property WHERE org_id = ? ORDER BY created_at',
      [SOURCE_ORG_ID]
    );
    const [[{ unitCount }]] = await conn.query(
      `SELECT COUNT(*) AS unitCount FROM unit u
       JOIN property p ON u.property_id = p.id
       WHERE p.org_id = ?`,
      [SOURCE_ORG_ID]
    );
    const [[{ uaCount }]] = await conn.query(
      `SELECT COUNT(*) AS uaCount FROM unit_amenity ua
       JOIN unit u ON ua.unit_id = u.id
       JOIN property p ON u.property_id = p.id
       WHERE p.org_id = ?`,
      [SOURCE_ORG_ID]
    );
    const [[{ ufCount }]] = await conn.query(
      `SELECT COUNT(*) AS ufCount FROM unit_furnishing uf
       JOIN unit u ON uf.unit_id = u.id
       JOIN property p ON u.property_id = p.id
       WHERE p.org_id = ? AND (uf.deleted_at IS NULL OR uf.deleted_at IS NOT NULL)`,
      [SOURCE_ORG_ID]
    );

    console.log('\n=== MIGRATION PREVIEW ===');
    console.log(`Source DB:         ${SOURCE_DB}`);
    console.log(`Source org:        ${orgRow?.display_name} (id=${SOURCE_ORG_ID}, currency=${orgRow?.default_currency})`);
    console.log(`Properties:        ${props.length}`);
    for (const p of props) {
      console.log(`   - ${p.id}  ${p.display_name}  (${p.street_address}, ${p.city}) ${p.currency}`);
    }
    console.log(`Units:             ${unitCount}`);
    console.log(`Unit amenities:    ${uaCount}`);
    console.log(`Unit furnishings:  ${ufCount}`);
    console.log(`\nNEW org target:`);
    console.log(`   display_name:   ${NEW_ORG_DISPLAY_NAME}`);
    console.log(`   admin user:     ${NEW_ADMIN_USERNAME}`);
    console.log(`   admin password: ${ADMIN_PASSWORD}`);
    console.log(`\nSKIPPED tables: tenant, leasing, accounting, invoice, property_owner, tags, everything else.`);
  } finally {
    await conn.end();
  }
}

async function copyProperties(srcConn, destConn, newOrgId) {
  const [rows] = await srcConn.query(
    `SELECT id, display_name, year_of_built, mls, street_address, city, state, zip_code, country,
            district, type, currency, status, photo, notes, created_at, updated_at, deleted_at
     FROM property WHERE org_id = ?`,
    [SOURCE_ORG_ID]
  );

  for (const r of rows) {
    await destConn.query(
      `INSERT INTO property
         (id, display_name, year_of_built, mls, street_address, city, state, zip_code, country,
          district, type, currency, org_id, status, photo, notes,
          created_at, updated_at, deleted_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        r.id, r.display_name, r.year_of_built, r.mls, r.street_address, r.city, r.state, r.zip_code, r.country,
        r.district, r.type, r.currency, newOrgId, r.status, null /* photo */, r.notes,
        r.created_at, r.updated_at, r.deleted_at,
      ]
    );
  }
  return rows.length;
}

async function copyUnits(srcConn, destConn) {
  const [rows] = await srcConn.query(
    `SELECT u.*
     FROM unit u
     JOIN property p ON u.property_id = p.id
     WHERE p.org_id = ?`,
    [SOURCE_ORG_ID]
  );

  for (const r of rows) {
    await destConn.query(
      `INSERT INTO unit
         (id, property_id, owner_id, name, type, amenity_type, size, size_unit, beds, baths,
          deposit_price, rent_price_min, rent_price_max, parking, smoking, laundry,
          amenity_detail, access_information, key_code, wifi_information, payment_information, internal_note,
          status, active_status, photo, charge_method, fee)
       VALUES (?,?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?, ?,?,?,?,?,?, ?,?,?,?,?)`,
      [
        r.id, r.property_id, null /* drop owner_id */, r.name, r.type, r.amenity_type, r.size, r.size_unit, r.beds, r.baths,
        r.deposit_price, r.rent_price_min, r.rent_price_max, r.parking, r.smoking, r.laundry,
        r.amenity_detail, r.access_information, r.key_code, r.wifi_information, r.payment_information, r.internal_note,
        r.status, r.active_status, null /* photo */, r.charge_method, r.fee,
      ]
    );
  }
  return rows.length;
}

async function copyUnitAmenities(srcConn, destConn) {
  const [rows] = await srcConn.query(
    `SELECT ua.unit_id, ua.amenity_id
     FROM unit_amenity ua
     JOIN unit u ON ua.unit_id = u.id
     JOIN property p ON u.property_id = p.id
     WHERE p.org_id = ?`,
    [SOURCE_ORG_ID]
  );
  for (const r of rows) {
    try {
      await destConn.query(
        'INSERT INTO unit_amenity (unit_id, amenity_id) VALUES (?, ?)',
        [r.unit_id, r.amenity_id]
      );
    } catch (e) {
      // Amenity might not exist in new org's seeded amenity set — skip
      if (!e.message.includes('foreign key') && !e.message.includes('Duplicate')) {
        console.warn(`  amenity skip: ${e.message}`);
      }
    }
  }
  return rows.length;
}

async function copyUnitFurnishings(srcConn, destConn) {
  const [rows] = await srcConn.query(
    `SELECT uf.*
     FROM unit_furnishing uf
     JOIN unit u ON uf.unit_id = u.id
     JOIN property p ON u.property_id = p.id
     WHERE p.org_id = ?`,
    [SOURCE_ORG_ID]
  );
  for (const r of rows) {
    await destConn.query(
      `INSERT INTO unit_furnishing
         (id, unit_id, item_name, quantity, item_price, note, currency_id, created_at, updated_at, deleted_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [r.id, r.unit_id, r.item_name, r.quantity, r.item_price, r.note, r.currency_id, r.created_at, r.updated_at, r.deleted_at]
    );
  }
  return rows.length;
}

async function run() {
  console.log(`Mode: ${EXECUTE ? 'EXECUTE' : 'DRY-RUN (use --execute to actually migrate)'}`);

  await preview();

  if (!EXECUTE) {
    console.log('\nDry-run complete. Re-run with --execute to provision the new org and copy data.');
    return;
  }

  console.log('\n=== PROVISIONING NEW ORG ===');
  const orgId = (BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000))).toString();
  const { dbName } = await provisionOrg({
    orgId,
    displayName: NEW_ORG_DISPLAY_NAME,
    adminUsername: NEW_ADMIN_USERNAME,
    adminPassword: ADMIN_PASSWORD,
    adminEmail: NEW_ADMIN_EMAIL,
    adminFirstName: NEW_ADMIN_FIRST_NAME,
    adminLastName: NEW_ADMIN_LAST_NAME,
  });
  console.log(`New org: id=${orgId}  db=${dbName}`);

  const srcConn = await getSourceConn();
  const destConn = await mysql.createConnection({
    host: config.database.host,
    port: config.database.port,
    user: config.database.user,
    password: config.database.password,
    database: dbName,
    supportBigNumbers: true,
    bigNumberStrings: true,
  });

  try {
    console.log('\n=== COPYING DATA ===');
    const nProp = await copyProperties(srcConn, destConn, orgId);
    console.log(`  properties:       ${nProp}`);

    const nUnit = await copyUnits(srcConn, destConn);
    console.log(`  units:            ${nUnit}`);

    const nAmen = await copyUnitAmenities(srcConn, destConn);
    console.log(`  unit_amenities:   ${nAmen}`);

    const nFurn = await copyUnitFurnishings(srcConn, destConn);
    console.log(`  unit_furnishings: ${nFurn}`);

    console.log('\n=== DONE ===');
    console.log(`Login:     http://localhost:3000/login`);
    console.log(`Username:  ${NEW_ADMIN_USERNAME}`);
    console.log(`Password:  ${ADMIN_PASSWORD}`);
    console.log(`Org ID:    ${orgId}`);
    console.log(`Database:  ${dbName}`);
  } finally {
    await srcConn.end();
    await destConn.end();
  }
}

run().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
