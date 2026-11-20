const test=require('node:test'),assert=require('node:assert/strict');
const {getCatalog}=require('../src/services/xeroBankCatalog');
const lookup=require('../src/services/xeroBrowserLookup');
const uuid=i=>String(i).padStart(8,'0')+'-aaaa-bbbb-cccc-123456789abc';
const tenant='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const fixture=()=>{
 let ignored=false,connection=tenant;
 const rows=Array.from({length:10},(_,i)=>({xero_account_id:uuid(i+1),xero_account_name:'Account '+i,tenafy_account_setting_id:String(100+i),ledger_enabled:1,bank_account_id:null}));
 const accounts=rows.map(r=>({AccountID:r.xero_account_id,Name:r.xero_account_name,CurrencyCode:'HKD',Type:'BANK',Status:'ACTIVE',BankAccountNumber:'same untrusted number'}));
 const calls=[];
 const pool={execute:async(sql,params)=>{
  calls.push({sql,params});
  if(sql.includes('FROM xero_browser_binding'))return [[{ui_org_slug:'test-org',xero_tenant_id:tenant,connected_tenant_id:connection}]];
  if(sql.includes('FROM xero_account_map')){assert.match(sql,/m\.org_id=\?/);assert.match(sql,/m\.ignored=0/);return [ignored?rows.slice(1):rows];}
  throw Error('Unexpected query');
 }};
 return {pool,rows,accounts,calls,setIgnored:()=>ignored=true,setConnection:value=>connection=value};
};

test('ten enabled banks are catalogued by account IDs and verified currencies without bank-number guessing',async()=>{
 const f=fixture();const result=await getCatalog(f.pool,'1',{getRemote:async()=>({Accounts:f.accounts})});
 assert.equal(result.accounts.length,10);assert.equal(result.unavailable.length,0);
 assert.ok(result.accounts.every(a=>a.currency==='HKD'&&a.bank_account_id===null));
 assert.ok(f.calls.every(c=>/^SELECT/.test(c.sql)));assert.ok(!JSON.stringify(result).includes('untrusted number'));
});

test('remote metadata is cached but ignored mappings are always re-read',async t=>{
 const f=fixture(),xero=require('../src/services/xeroClient');let requests=0;
 t.mock.method(xero,'xeroApiGet',async()=>{requests++;return {Accounts:f.accounts};});
 assert.equal((await getCatalog(f.pool,'1')).accounts.length,10);
 f.setIgnored();assert.equal((await getCatalog(f.pool,'1')).accounts.length,9);assert.equal(requests,1);
});

test('inactive, absent, duplicate, disabled and conflicting bank metadata fails closed',async()=>{
 for(const mode of ['inactive','absent','duplicate','ledger-disabled','bank-conflict','shared-ledger','currency']){
  const f=fixture();
  if(mode==='inactive')f.accounts[0].Status='ARCHIVED';
  if(mode==='absent')f.accounts.shift();
  if(mode==='duplicate')f.accounts.push({...f.accounts[0]});
  if(mode==='ledger-disabled')f.rows[0].ledger_enabled=0;
  if(mode==='bank-conflict')Object.assign(f.rows[0],{bank_account_id:'5',active_bank_id:'5',configured_currency:'USD'});
  if(mode==='shared-ledger')f.rows[1].tenafy_account_setting_id=f.rows[0].tenafy_account_setting_id;
  if(mode==='currency')f.accounts[0].CurrencyCode='ZZZ';
  const result=await getCatalog(f.pool,'1',{getRemote:async()=>({Accounts:f.accounts})});
  assert.ok(result.unavailable.length>=1,mode);assert.ok(!result.accounts.some(a=>a.xero_account_id===uuid(1).replace(/-/g,'')),mode);
 }
});

test('catalogue rejects reconnects and remote failures without exposing transport errors',async()=>{
 const f=fixture();
 await assert.rejects(getCatalog(f.pool,'1',{getRemote:async()=>{f.setConnection('other');return{Accounts:f.accounts};}}),e=>e.status===409);
 const next=fixture();
 await assert.rejects(getCatalog(next.pool,'1',{getRemote:async()=>{throw Object.assign(new Error('private transport detail'),{status:403});}}),e=>e.status===503&&!e.message.includes('private'));
});

test('bank-less lookup verifies currency and ledger identity before searching',async()=>{
 const sqls=[];
 const pool={execute:async(sql)=>{
  sqls.push(sql);
  if(sql.includes('FROM xero_browser_binding'))return [[{ui_org_slug:'test-org',xero_tenant_id:tenant,connected_tenant_id:tenant}]];
  if(sql.includes('FROM xero_account_map'))return [[{bank_account_id:null,tenafy_account_setting_id:'100',currency:null}]];
  if(sql.includes('FROM currency'))return [[{id:'30',detail:{code:'HKD'}}]];
  throw Error('No financial read on invalid currency');
 }};
 const body={expected_org_id:'1',ui_org_slug:'test-org',xero_account_id:uuid(1),statement:{id_suffix:'a'.repeat(32),date:'2026-11-20',direction:'received',currency:'USD',amount_minor:100}};
 await assert.rejects(lookup.lookup(pool,'1',body,{getCatalog:async()=>({org_id:'1',ui_org_slug:'test-org',accounts:[{xero_account_id:uuid(1).replace(/-/g,''),account_setting_id:'100',currency:'HKD'}]})}),e=>e.status===409);
 assert.ok(!sqls.some(sql=>sql.includes('FROM invoice')));
});


test('remote outages are remembered briefly and verification has one bounded response deadline',async t=>{
 const f=fixture(),xero=require('../src/services/xeroClient');let requests=0;
 t.mock.method(xero,'xeroApiGet',async()=>{requests++;throw Error('service down');});
 for(let i=0;i<2;i++) await assert.rejects(getCatalog(f.pool,'1'),e=>e.status===503);
 assert.equal(requests,1,'Do not hammer Xero while down');
 const pending=fixture(),start=Date.now();
 await assert.rejects(getCatalog(pending.pool,'1',{getRemote:()=>new Promise(()=>{}),timeoutMs:10}),e=>e.status===503);
 assert.ok(Date.now()-start<1000);
});
