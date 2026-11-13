const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { parseDirectoryCsv, planDirectory, counts, applyDirectory, reportMarkdown } = require('../src/services/websiteDirectoryLoader');
const { validateWebsiteProducts, saveUnitWebsiteProducts } = require('../src/services/unitWebsiteDirectory');
const { run } = require('../scripts/loadWebsiteDirectory');
const BASE = 'https://listings.example/';
const row = (id, name, link = `${BASE}product/${id}/`, notes = '') => ({ 'Property name in Tenafy': 'Building', 'Unit name in Tenafy': `Unit ${id}`, 'Unit link in Tenafy': `https://tenafy.example/property/1/unit/${id}`, 'Unit name on website': name, 'Unit link on website': link, 'Unit status': 'Active', 'Property status': 'Active', Notes: notes });
const unit = id => ({ id: String(id), name: String(id), active_status: 1, property_status: 1, deleted: 0, property_deleted: 0 });
const product = (id, name, linkId = id) => ({ product_id: String(id), name, slug: String(linkId), permalink: `${BASE}product/${linkId}/` });

test('CSV handles quoted commas, escaped quotes, CRLF, BOM, and missing headers', () => {
  const headers = Object.keys(row(1, 'name'));
  const csv = '\uFEFF' + headers.join(',') + '\r\nBuilding,"Unit, ""A""",https://tenafy.example/property/1/unit/1,Name,https://listings.example/product/1/,Active,Active,"Line one\nline two"\r\n';
  const out = parseDirectoryCsv(csv);
  assert.equal(out[0]['Unit name in Tenafy'], 'Unit, "A"'); assert.match(out[0].Notes, /\n/);
  assert.throws(() => parseDirectoryCsv('bad\nheaders'), /missing required/);
});
test('Tai Yuen A/B duplicate pairs and unverified Po Thai stay in needs staff', () => {
  const rows = [row(1,'Tai Yuen A'),row(2,'Tai Yuen A'),row(3,'Tai Yuen B'),row(4,'Tai Yuen B'),row(5,'Unverified',undefined,'website name unverified'),row(6,'Unverified',undefined,'website name unverified')];
  const out = planDirectory(rows, [], [1,2,3,4,5,6].map(unit), [], BASE);
  assert.deepEqual(counts(out), { loaded: 0, copies: 0, needs_staff: 6, no_unit: 0 });
  assert.equal(out.needsStaff.filter(r => /more than one/.test(r.reason)).length, 4);
});
test('loader trims malformed links, adds same-name copies, and reports unmatched products', () => {
  const out = planDirectory([row(1, 'Studio A', ` ${BASE}product/10/) `)], [product(10,'Studio A'),product(11,'Studio A'),product(12,'Other')], [unit(1)], [], BASE);
  assert.deepEqual(counts(out), { loaded: 1, copies: 1, needs_staff: 0, no_unit: 1 });
  assert.equal(out.loaded[0].primary.product_id, '10'); assert.equal(out.copies[0].product_id, '11');
  assert.match(reportMarkdown(out), /Copies added \(1\)/);
});
test('missing links/products, inactive units, and another unit’s assigned product are excluded', () => {
  const rows = [row(1,'A',''),row(2,'B'),row(3,'C'),row(4,'D')];
  const units = [unit(1),unit(2),{...unit(3),active_status:0},unit(4)];
  const out = planDirectory(rows, [product(4,'D')], units, [{product_id:'4',unit_id:'99'}], BASE);
  assert.equal(out.loaded.length, 0); assert.equal(out.needsStaff.length, 4);
  assert.ok(out.needsStaff.some(r=>/another unit/.test(r.reason)));
});
test('the loader CLI defaults to dry run and writes no SQL or pool connection with snapshots', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'website-loader-'));
  try {
    const r = row(1,'Studio A');
    await fs.writeFile(path.join(dir,'Units.csv'),Object.keys(r).join(',')+'\n'+Object.values(r).join(',')+'\n');
    await fs.writeFile(path.join(dir,'units.json'),JSON.stringify({org_id:'org',units:[unit(1)]}));
    await fs.writeFile(path.join(dir,'products.json'),JSON.stringify([product(1,'Studio A')]));
    const args = ['--org','org','--csv',path.join(dir,'Units.csv'),'--snapshot',path.join(dir,'units.json'),'--website',BASE,'--products',path.join(dir,'products.json'),'--report',path.join(dir,'report.md')];
    const out = await run(args); assert.equal(out.loaded.length,1);
    assert.match(await fs.readFile(path.join(dir,'report.md'),'utf8'), /Loaded \(1\)/);
    await assert.rejects(run([...args,'--apply']), /cannot use snapshot/);
  } finally { await fs.rm(dir,{recursive:true,force:true}); }
});
test('apply only writes planned units and copies, preserves the product owner, and is repeatable', async () => {
  const plan = planDirectory([row(1,'Studio A')],[product(1,'Studio A'),product(2,'Studio A')],[unit(1)],[],BASE);
  const calls = [], pool = {execute:async(sql,args)=>{ calls.push({sql,args}); return [[]]; }};
  await applyDirectory(pool,'org',plan); await applyDirectory(pool,'org',plan);
  assert.equal(calls.filter(c=>/INSERT INTO/.test(c.sql)).length,4);
  assert.ok(calls.filter(c=>/INSERT INTO/.test(c.sql)).every(c=>!c.sql.split('ON DUPLICATE KEY UPDATE')[1].includes('unit_id=')));
  assert.ok(calls.every(c=>c.args.includes('org')));
});
test('staff editor validates BIGINTs, duplicate product ids and the website host', () => {
  assert.throws(()=>validateWebsiteProducts('A',[{product_id:'1'},{product_id:'1'}],BASE));
  assert.throws(()=>validateWebsiteProducts('A',[{product_id:'2',name:'A',permalink:'https://evil.example/'}],BASE),/website host/);
  assert.throws(()=>validateWebsiteProducts('A',[{product_id:'2',name:'A',permalink:BASE}],null),/organization/);
  assert.equal(validateWebsiteProducts('A',[{product_id:'9007199254740993',name:'A',permalink:BASE}],BASE)[0].product_id,'9007199254740993');
});
test('staff editor refuses an existing product owner before any update, and rolls back', async () => {
  const calls=[];
  const conn={beginTransaction:async()=>calls.push('begin'),rollback:async()=>calls.push('rollback'),commit:async()=>calls.push('commit'),release:()=>{},execute:async(sql,args)=>{
    calls.push(sql);
    if(/FROM organization/.test(sql))return [[{website_base_url:BASE}]];
    if(/FROM unit u/.test(sql)){assert.deepEqual(args,['1','org']);return [[{id:'1'}]];}
    if(/FROM unit_website_product/.test(sql))return [[{unit_id:'other'}]];
    throw Error('Unexpected write');
  }};
  await assert.rejects(saveUnitWebsiteProducts({getConnection:async()=>conn},'org','1','A',[{product_id:'2',name:'A',permalink:BASE}]),/already assigned/);
  assert.ok(calls.includes('rollback')); assert.ok(!calls.includes('commit')); assert.ok(!calls.some(s=>/^DELETE|^UPDATE|^INSERT/.test(s)));
});
