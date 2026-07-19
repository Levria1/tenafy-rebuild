const mysql = require('mysql2/promise');
const config = require('./index');

// Master pool — connects to tena_master
let masterPool = null;

// Org pools — Map<orgId, { pool, dbName }>
const orgPools = new Map();

// Org registry cache — Map<orgId, { db_name, db_host, db_port, db_user, db_password, status }>
const orgCache = new Map();

function createPool(dbName, dbHost, dbPort, dbUser, dbPassword) {
  return mysql.createPool({
    host: dbHost || config.database.host,
    port: dbPort || config.database.port,
    user: dbUser || config.database.user,
    password: dbPassword || config.database.password,
    database: dbName,
    waitForConnections: true,
    connectionLimit: 5,
    queueLimit: 0,
    supportBigNumbers: true,
    bigNumberStrings: true
  });
}

function getMasterPool() {
  if (!masterPool) {
    const masterDbName = process.env.MASTER_DB_NAME || 'tena_master';
    masterPool = createPool(masterDbName);
    console.log(`Master pool created for database: ${masterDbName}`);
  }
  return masterPool;
}

async function getOrgPool(orgId) {
  const orgIdStr = String(orgId);

  // Check cache
  if (orgPools.has(orgIdStr)) {
    return orgPools.get(orgIdStr).pool;
  }

  // Look up org in master database
  const master = getMasterPool();
  const [rows] = await master.execute(
    'SELECT db_name, db_host, db_port, db_user, db_password, status FROM organizations WHERE id = ?',
    [orgIdStr]
  );

  if (!rows.length) {
    throw new Error(`Organization ${orgIdStr} not found`);
  }

  const org = rows[0];
  if (org.status !== 1) {
    throw new Error(`Organization ${orgIdStr} is disabled`);
  }

  // Create pool for this org
  const pool = createPool(org.db_name, org.db_host, org.db_port, org.db_user, org.db_password);
  orgPools.set(orgIdStr, { pool, dbName: org.db_name });
  orgCache.set(orgIdStr, org);
  console.log(`Org pool created for org ${orgIdStr} → database: ${org.db_name}`);

  return pool;
}

async function getOrgPoolByDbName(dbName) {
  // Find org by db_name in cache first
  for (const [orgId, entry] of orgPools.entries()) {
    if (entry.dbName === dbName) return entry.pool;
  }

  // Look up in master database
  const master = getMasterPool();
  const [rows] = await master.execute(
    'SELECT id, db_name, db_host, db_port, db_user, db_password, status FROM organizations WHERE db_name = ?',
    [dbName]
  );

  if (!rows.length) {
    throw new Error(`Organization with database ${dbName} not found`);
  }

  const org = rows[0];
  const pool = createPool(org.db_name, org.db_host, org.db_port, org.db_user, org.db_password);
  const orgIdStr = String(org.id);
  orgPools.set(orgIdStr, { pool, dbName: org.db_name });
  orgCache.set(orgIdStr, org);

  return pool;
}

// Read-only org pools — Map<orgId, pool>. Same org database as getOrgPool, but
// connected with SELECT-only credentials (config.dbReadOnly). Used exclusively by
// the internal assistant's ask_data (NL->SQL) tool, so a generated query can not
// write even if the app-side SQL guard were bypassed.
const roPools = new Map();

async function getReadOnlyOrgPool(orgId) {
  const ro = config.dbReadOnly || {};
  if (!ro.user) return null; // ask_data disabled — no read-only user configured

  const orgIdStr = String(orgId);
  if (roPools.has(orgIdStr)) return roPools.get(orgIdStr);

  // Resolve the org's database (reuse the cache the read-write path populated).
  let org = orgCache.get(orgIdStr);
  if (!org) {
    const master = getMasterPool();
    const [rows] = await master.execute(
      'SELECT db_name, db_host, db_port, status FROM organizations WHERE id = ?',
      [orgIdStr]
    );
    if (!rows.length) throw new Error(`Organization ${orgIdStr} not found`);
    org = rows[0];
    if (org.status !== 1) throw new Error(`Organization ${orgIdStr} is disabled`);
  }

  // Same host/port/database as the org's normal pool, but READ-ONLY credentials.
  const pool = createPool(org.db_name, org.db_host, org.db_port, ro.user, ro.password);
  roPools.set(orgIdStr, pool);
  console.log(`Read-only pool created for org ${orgIdStr} → database: ${org.db_name}`);
  return pool;
}

async function closePools() {
  if (masterPool) {
    await masterPool.end();
    masterPool = null;
  }
  for (const [orgId, entry] of orgPools.entries()) {
    await entry.pool.end();
  }
  for (const [orgId, pool] of roPools.entries()) {
    await pool.end();
  }
  orgPools.clear();
  roPools.clear();
  orgCache.clear();
  console.log('All database pools closed');
}

module.exports = { getMasterPool, getOrgPool, getOrgPoolByDbName, getReadOnlyOrgPool, closePools };
