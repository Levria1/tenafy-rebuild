#!/usr/bin/env node
const fs = require('node:fs/promises');
const path = require('node:path');
const { parseDirectoryCsv, planDirectory, counts, reportMarkdown, applyDirectory } = require('../src/services/websiteDirectoryLoader');
const { fetchProducts, websiteBase } = require('../src/services/websiteProducts');

async function readUnits(pool, orgId) {
  const [units] = await pool.execute(`SELECT u.id,u.name,u.property_id,u.active_status,u.deleted_at IS NOT NULL AS deleted,
    p.display_name AS property_name,p.status AS property_status,p.deleted_at IS NOT NULL AS property_deleted,
    p.street_address,p.district,p.city FROM unit u JOIN property p ON p.id=u.property_id WHERE p.org_id=?`, [orgId]);
  return units;
}
async function readMappings(pool, orgId) {
  try { const [rows] = await pool.execute('SELECT unit_id,product_id FROM unit_website_product WHERE org_id=?', [orgId]); return rows; }
  catch (e) { if (e.code === 'ER_NO_SUCH_TABLE') return []; throw e; }
}
function options(argv) {
  const out = { apply: false, report: path.resolve('website-directory-report.md') };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--apply') out.apply = true;
    else if (['--org','--csv','--report','--snapshot','--website','--products'].includes(key) && argv[i + 1] && !argv[i + 1].startsWith('--')) out[key.slice(2)] = argv[++i];
    else throw new Error(`Unknown or incomplete option: ${key}`);
  }
  if (!out.org || !out.csv) throw new Error('Usage: node scripts/loadWebsiteDirectory.js --org ID --csv Units.csv [--report report.md] [--apply]');
  if (out.apply && (out.snapshot || out.website || out.products)) throw new Error('--apply cannot use snapshot, products, or a website override');
  if (out.website && !out.snapshot) throw new Error('--website is only for an offline snapshot dry run; database runs use the org setting');
  return out;
}
async function run(argv) {
  const args = options(argv);
  const rows = parseDirectoryCsv(await fs.readFile(args.csv, 'utf8'));
  let pool, units, mappings = [], website;
  if (args.snapshot) {
    if (!args.website) throw new Error('Snapshot dry runs require --website');
    const snapshot = JSON.parse(await fs.readFile(args.snapshot, 'utf8'));
    if (String(snapshot.org_id) !== args.org || !Array.isArray(snapshot.units)) throw new Error('Snapshot must identify this org and contain units');
    units = snapshot.units; mappings = snapshot.mappings || []; website = args.website;
  } else {
    const { getReadOnlyOrgPool } = require('../src/config/poolRegistry');
    pool = await getReadOnlyOrgPool(args.org);
    if (!pool) throw new Error('Read-only org pool unavailable');
    const [[org]] = await pool.execute('SELECT website_base_url FROM organization WHERE id=?', [args.org]);
    website = org?.website_base_url;
    units = await readUnits(pool, args.org); mappings = await readMappings(pool, args.org);
  }
  if (!websiteBase(website)) throw new Error('The organization public listings website is not configured');
  const products = args.products ? JSON.parse(await fs.readFile(args.products, 'utf8')) : await fetchProducts(website);
  let plan = planDirectory(rows, products, units, mappings, website);
  // Write the dry-run plan before any database mutation, including --apply runs.
  await fs.writeFile(args.report, reportMarkdown(plan));
  if (args.apply) {
    const { getOrgPool } = require('../src/config/poolRegistry');
    const writer = await getOrgPool(args.org), conn = await writer.getConnection();
    try {
      await conn.beginTransaction();
      const [[org]] = await conn.execute('SELECT website_base_url FROM organization WHERE id=? FOR UPDATE', [args.org]);
      if (org?.website_base_url !== website) throw new Error('Website setting changed; rerun the loader');
      plan = planDirectory(rows, products, await readUnits(conn, args.org), await readMappings(conn, args.org), website);
      await applyDirectory(conn, args.org, plan);
      await conn.commit();
    } catch (e) { await conn.rollback(); throw e; }
    finally { conn.release(); }
    await fs.writeFile(args.report, reportMarkdown(plan));
  }
  console.log(JSON.stringify({ mode: args.apply ? 'apply' : 'dry-run', ...counts(plan), report: args.report }));
  return plan;
}
if (require.main === module) run(process.argv.slice(2)).catch(e => { console.error(e.message); process.exitCode = 1; }).finally(async () => {
  await require('../src/config/poolRegistry').closePools(); process.exit(process.exitCode || 0);
});
module.exports = { run, options, readUnits, readMappings };
