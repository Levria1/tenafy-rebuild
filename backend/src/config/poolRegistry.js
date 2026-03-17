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

async function closePools() {
  if (masterPool) {
    await masterPool.end();
    masterPool = null;
  }
  for (const [orgId, entry] of orgPools.entries()) {
    await entry.pool.end();
  }
  orgPools.clear();
  orgCache.clear();
  console.log('All database pools closed');
}

module.exports = { getMasterPool, getOrgPool, getOrgPoolByDbName, closePools };
