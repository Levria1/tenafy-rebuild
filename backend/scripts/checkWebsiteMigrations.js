#!/usr/bin/env node
// Scratch-only integration check: an explicit local UNIX socket is required.
// It never loads Tenafy's .env, pool registry, or a production database name.
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');

async function check(socketPath) {
  if (!socketPath || !path.isAbsolute(socketPath)) throw new Error('Pass an absolute scratch MySQL UNIX socket with --socket');
  const conn = await mysql.createConnection({ socketPath, user: 'root', multipleStatements: true });
  const databases = [], results = [];
  const migrations = {
    '045': await fs.readFile(path.join(__dirname, '../migrations/045_unit_website_products.sql'), 'utf8'),
    '086': await fs.readFile(path.join(__dirname, '../migrations-org/086_unit_website_products.sql'), 'utf8'),
  };
  try {
    const [[version]] = await conn.query('SELECT VERSION() AS version');
    for (const [label, sequence] of [['045', ['045', '045']], ['086', ['086', '086']], ['combined', ['045', '086', '045', '086']]]) {
      const database = `tenafy_website_scratch_${Date.now()}_${label}`;
      databases.push(database);
      await conn.query(`CREATE DATABASE \`${database}\``);
      await conn.query(`USE \`${database}\``);
      await conn.query('CREATE TABLE organization (id BIGINT PRIMARY KEY); CREATE TABLE unit (id BIGINT PRIMARY KEY); INSERT INTO organization VALUES (1),(2); INSERT INTO unit VALUES (11),(12)');
      let expectedSchema;
      for (const [i, key] of sequence.entries()) {
        await conn.query(migrations[key]);
        const [[schema]] = await conn.query('SHOW CREATE TABLE unit_website_product');
        if (i === 0) {
          expectedSchema = schema['Create Table'];
          const [orgs] = await conn.query('SELECT website_base_url FROM organization');
          assert.ok(orgs.every(o => o.website_base_url === null));
          await conn.query("UPDATE unit SET website_name='Checked name' WHERE id=11; INSERT INTO unit_website_product (org_id,unit_id,product_id,permalink,name,is_primary) VALUES (1,11,101,'https://listings.example/product/a/','Checked name',1)");
        } else assert.equal(schema['Create Table'], expectedSchema, `${label}: schema changed on repeat`);
        const [[unit]] = await conn.query('SELECT website_name FROM unit WHERE id=11');
        assert.equal(unit.website_name, 'Checked name');
        const [[mapping]] = await conn.query('SELECT unit_id,name,is_primary FROM unit_website_product WHERE org_id=1 AND product_id=101');
        assert.equal(Number(mapping.unit_id), 11); assert.equal(mapping.name, 'Checked name'); assert.equal(mapping.is_primary, 1);
      }
      // Two copies can belong to one unit; another org can use the same number.
      await conn.query("INSERT INTO unit_website_product (org_id,unit_id,product_id,permalink,name) VALUES (1,11,102,'https://listings.example/product/a-copy/','Checked name'),(2,12,101,'https://other.example/product/a/','Other org')");
      await assert.rejects(conn.query("INSERT INTO unit_website_product (org_id,unit_id,product_id,permalink,name) VALUES (1,12,101,'https://listings.example/product/wrong/','Wrong unit')"), error => error.code === 'ER_DUP_ENTRY');
      const [[count]] = await conn.query('SELECT COUNT(*) AS count FROM unit_website_product WHERE org_id=1 AND unit_id=11');
      assert.equal(Number(count.count), 2);
      results.push({ scenario: label, successful_migration_runs: sequence, schema_and_data_preserved: true, copies_allowed: true, cross_org_product_allowed: true, duplicate_org_product_rejected: true });
    }
    const result = { mysql_version: version.version, results };
    console.log(JSON.stringify(result, null, 2));
    return result;
  } finally {
    for (const database of databases) await conn.query(`DROP DATABASE IF EXISTS \`${database}\``);
    await conn.end();
  }
}
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--socket') { console.error('Usage: node scripts/checkWebsiteMigrations.js --socket /absolute/scratch/mysql.sock'); process.exitCode = 1; }
  else check(args[1]).catch(e => { console.error(e.message); process.exitCode = 1; });
}
module.exports = { check };
