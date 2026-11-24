const test=require('node:test'),assert=require('node:assert/strict');
const {prepare,previewAllocation}=require('../src/services/xeroFillReview');
const id=n=>`${String(n).padStart(8,'0')}-abcd-abcd-abcd-123456789abc`;
const current=()=>({identity:{statement:{date:'2026-11-19',amount_minor:750000,currency:'HKD'}},expires_at:'2099-01-01',source_status:{invoices:'ok',accounting:'ok',leases:'ok'},matching:{mode:'name'},candidates:[{id:'1',kind:'invoice',tenant_name:'Test Tenant',code:'INV1',property_name:'Test Property',outstanding_minor:750000}]});
const remote={Invoices:[],BankTransactions:[],Accounts:[{AccountID:id(1),Status:'ACTIVE',Type:'REVENUE',Code:'200',Name:'Rental income',TaxType:'NONE'},{AccountID:id(2),Status:'ACTIVE',Type:'BANK',Code:'090',Name:'Bank'}],TaxRates:[{Status:'ACTIVE',TaxType:'NONE',Name:'No Tax',EffectiveRate:0}],TrackingCategories:[{TrackingCategoryID:id(3),Status:'ACTIVE',Name:'Property',Options:[{TrackingOptionID:id(4),Status:'ACTIVE',Name:'Test Property'}]}],Contacts:[{ContactID:id(5),ContactStatus:'ACTIVE',Name:'Test Tenant'}]};
const run=(body={},options={})=>prepare({},'1',{candidate:{kind:'invoice',id:'1'},...body},{lookup:async()=>current(),getRemote:async(_p,org,path)=>{assert.equal(org,'1');return structuredClone(remote);},...options});
test('fill preparation rechecks the match and supplies only active, uniquely named Xero choices',async()=>{
 const data=await run();assert.equal(data.path,'create_details');assert.equal(data.financial_writes,false);assert.equal(data.defaults.contact_id,id(5));assert.equal(data.defaults.property_option_id,id(4));assert.equal(data.catalogue.accounts.length,1);assert.equal(data.fields.amount_minor,750000);assert.equal(data.fields.reference,'INV1');
});
test('stale, incomplete, unselected and lease candidates cannot prepare a new transaction',async()=>{
 for(const c of [{kind:'lease',id:'1'},{kind:'invoice',id:'999'},{kind:'invoice',id:1}])await assert.rejects(run({candidate:c}));
 const incomplete=current();incomplete.source_status.accounting='unavailable';await assert.rejects(run({}, {lookup:async()=>incomplete}));
});
test('a balance difference blocks create preparation before contacting Xero',async()=>{
 const value=current();
 value.candidates[0].outstanding_minor=749999;
 await assert.rejects(run({}, {lookup:async()=>value,getRemote:()=>assert.fail('Split should not prepare a create draft')}), /balance differs/);
});

test('allocation preview caps payment at the open balance and keeps the excess unallocated',async()=>{
 const request = {expected_org_id:'1',invoice_code:'INV-100',ui_org_slug:'verified-org',
   xero_account_id:'a'.repeat(32),statement:{id_suffix:'b'.repeat(32),date:'2026-11-20',direction:'received',currency:'HKD',amount_minor:1063600}};
 const pool = {execute:async(sql,params)=>{
   if (sql.includes('FROM xero_browser_binding')) return [[{ui_org_slug:'verified-org',xero_tenant_id:'x',connected_tenant_id:'x'}]];
   if (sql.includes('FROM xero_account_map')) return [[{bank_account_id:'11',tenafy_account_setting_id:'12',currency:'HKD'}]];
   if (sql.includes('FROM currency')) return [[{id:'13',detail:{code:'HKD'}}]];
   assert.ok(sql.includes('p.bank_account_id=?'));
   assert.deepEqual(params,['11','1','13',0,'INV-100','HKD']);
   return [[{id:'14',invoice_code:'INV-100',outstanding:'10550.00',first_name:'Test',last_name:'Tenant'}]];
 }};
 const over = await previewAllocation(pool,'1',request);
 assert.equal(over.invoice_minor,1055000);
 assert.equal(over.bank_unallocated_minor,8600);
 assert.equal(over.invoice_remaining_minor,0);
 assert.equal(over.financial_writes,false);
 const under = await previewAllocation(pool,'1',{...request,statement:{...request.statement,amount_minor:1054999}});
 assert.equal(under.bank_unallocated_minor,0);
 assert.equal(under.invoice_remaining_minor,1);
 await assert.rejects(previewAllocation({},'2',request),{status:409});
});
test('existing Xero entries return Find & Match without reading create catalogues',async()=>{
 const value=current();value.candidates=[{id:'2',kind:'accounting',xero_transaction_id:id(9),transaction_code:'PAY2'}];
 const result=await run({candidate:{kind:'accounting',id:'2'}},{lookup:async()=>value,getRemote:()=>assert.fail('No create catalogue for an existing entry')});assert.equal(result.path,'find_and_match');
 delete value.candidates[0].xero_transaction_id;await assert.rejects(run({candidate:{kind:'accounting',id:'2'}},{lookup:async()=>value}));
});
test('duplicate display names and archived records are not silently mapped',async()=>{
 const dup=structuredClone(remote);dup.Contacts.push({...dup.Contacts[0],ContactID:id(6)});dup.TrackingCategories[0].Options.push({...dup.TrackingCategories[0].Options[0],TrackingOptionID:id(7)});dup.Accounts[0].Status='ARCHIVED';
 const data=await run({}, {getRemote:async()=>dup});assert.deepEqual(data.catalogue.contacts,[]);assert.equal(data.defaults.contact_id,null);assert.equal(data.defaults.property_option_id,null);assert.deepEqual(data.catalogue.accounts,[]);
});
test('remote errors are sanitised and text searches are bounded',async()=>{
 await assert.rejects(run({}, {getRemote:async()=>{throw Object.assign(new Error('private upstream response'),{status:403});}}),e=>e.status===503&&!e.message.includes('private'));
 await assert.rejects(run({contact_query:'x'}),e=>e.status===400);
});

test('existing Xero invoice or bank reference routes to Find & Match instead of Create',async()=>{
 const data=structuredClone(remote);data.Invoices=[{InvoiceNumber:'INV1',Status:'AUTHORISED'}];const result=await run({}, {getRemote:async()=>data});assert.equal(result.path,'find_and_match');assert.equal(result.existing_xero_entry,true);
});
test('review metadata has one deadline and cancels pending GETs',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let signal;
 const pending=run({}, {getRemote:async(_p,_o,_path,_params,opts)=>{signal=opts.signal;assert.equal(opts.timeoutMs,12000);return new Promise(()=>{});}});
 await new Promise(setImmediate);t.mock.timers.tick(12001);
 await assert.rejects(pending,e=>e.status===503);assert.equal(signal.aborted,true);
});
