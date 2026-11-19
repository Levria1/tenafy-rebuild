const test=require('node:test');
const assert=require('node:assert/strict');
const blocks=require('../src/services/tenantTemplateBlocks');
const vars=require('../src/services/leaseTemplateVariables');
const {validateSigners,loadLeaseTenants}=require('../src/services/leaseTenants');
const {personOrCompanyName}=require('../src/utils/personName');
const fixture=require('../test-support/joint-tenant-preview/base-template.json');
const alice={id:'1',first_name:'Alice',middle_name:'Mei',last_name:'Wong',type:0,id_card:'TEST-A',email:'alice@example.invalid',phone:'0000'};
const bob={id:'2',first_name:'Bob',last_name:'Chan',type:0,id_card:'TEST-B',email:'bob@example.invalid',phone:'0001'};
const tenants=()=>[alice,bob].map(t=>({...t,display_name:personOrCompanyName(t)}));
const input=()=>tenants().map(t=>({tenant_id:t.id,signer_name:t.display_name,signer_email:t.email,role:'tenant'}));
const ctx=list=>({...vars.sampleContext(),tenant:list[0],additionalTenants:list.slice(1),tenants:list,realRender:true});

test('template conversion preserves one-tenant content and metadata while overlaying signature markers',()=>{
 const converted=blocks.upgradeTemplate(fixture.body_html);
 const c=ctx([alice]);c.tenantLayout=JSON.stringify(converted.tenant_layout);
 const html=vars.substitute(converted.body_html,c);
 const unwrap=s=>s.replace(/<span style="display:inline-block;width:0;overflow:visible;white-space:nowrap;">(<span[^>]*>SIGANCHOR[A-Z0-9]+<\/span>)<\/span>/g,'$1');
 assert.equal(unwrap(html),vars.substitute(fixture.body_html,{...c,tenantLayout:null}));
 assert.match(html,/width:0;overflow:visible/);
 const landlordPreview=vars.substitute('{{SIGNATURE_LANDLORD}}________________',{...c,realRender:false});
 assert.match(landlordPreview,/width:0;overflow:visible/);
 assert.match(landlordPreview,/SIGANCHORLANDLORD/);
 assert.doesNotMatch(landlordPreview,/min-width:160px/);
 assert.equal(converted.tenant_layout.parties.includes('{{TENANT_ID_CARD}}'),true);
 assert.throws(()=>blocks.upgradeTemplate(converted.body_html),/manual/);
 assert.throws(()=>blocks.upgradeTemplate('<p>{{TENANT_NAME}}</p>'),/manual/);
 assert.throws(()=>blocks.parseLayout({...converted.tenant_layout,parties:'{{TENANT_PARTIES}}'}));
});

test('two tenants produce two names, IDs and distinct signature anchors; a single tenant has no second section',()=>{
 const converted=blocks.upgradeTemplate(fixture.body_html);
 const c=ctx([alice,bob]);c.tenantLayout=converted.tenant_layout;
 const html=vars.substitute(converted.body_html,c);
 for(const name of ['Alice Mei Wong','Bob Chan','TEST-A','TEST-B'])assert.equal(html.split(name).length-1,2);
 for(const marker of ['SIGANCHORTENANT1','SIGANCHORTENANT2'])assert.equal(html.split(marker).length-1,1);
 assert.doesNotMatch(html,/<p>\s*<div/);
 assert.match(html,/grid-template-columns:repeat\(2/);
 const preview=vars.substitute('<p>{{TENANT_SIGNATURES}}</p>',{...c,realRender:false});
 assert.doesNotMatch(preview,/min-width:160px/);
 assert.match(preview,/SIGANCHORTENANT2/);
 assert.deepEqual(blocks.jointTemplateProblems([converted.body_html],2),[]);
 assert.equal(blocks.jointTemplateProblems([fixture.body_html],2).length,2);
 const one=ctx([alice]);one.tenantLayout=c.tenantLayout;
 assert.doesNotMatch(vars.substitute(converted.body_html,one),/TEST-B|SIGANCHORTENANT2|Tenant&nbsp;2/);
});

test('dynamic blocks escape contact input and report missing fields on each party',()=>{
 const c=ctx([alice,{...bob,last_name:'<script>alert(1)</script>',id_card:'',email:'',phone:'<img src=x onerror=alert(1)>'}]);
 const html=vars.substitute('<p>{{TENANT_PARTIES}}</p><p>{{TENANT_SIGNATURES}}</p>',c);
 assert.doesNotMatch(html,/<script>|<img/);assert.match(html,/&lt;img/);
 const missing=vars.findEmptyPlaceholders('{{TENANT_PARTIES}}',c);
 assert.deepEqual(missing.map(x=>x.key),['TENANT_2_ID_CARD','TENANT_2_EMAIL']);
 const company=ctx([{...alice,type:1,company_name:'Example & Company'}]);
 assert.match(vars.substitute('{{TENANT_PARTIES}}',company),/Example &amp; Company/);
 // Legacy variables keep their existing meanings.
 assert.equal(vars.substitute('{{TENANT_NAME}} / {{ADDITIONAL_TENANTS}}',ctx([alice,bob])),'Alice Mei Wong / Bob Chan');
});

test('send validation requires every tenant once and canonicalises order independently of the submitted list',()=>{
 const list=input();const extras={signer_name:'Guarantor',signer_email:'g@example.invalid',role:'guarantor'};
 const out=validateSigners(tenants(),[extras,list[1],list[0]]);
 assert.deepEqual(out.map(p=>p.tenant_id),['1','2',null]);
 assert.deepEqual(out.map(p=>p.signer_name),['Alice Mei Wong','Bob Chan','Guarantor']);
 for(const invalid of [[list[0]],[list[0],list[0]],list.map(p=>({...p,tenant_id:undefined})),[list[0],{...list[1],tenant_id:'999'}],[list[0],{...list[1],signer_email:''}],[list[0],{...list[1],signer_name:'Wrong name'}],[...list,{...extras,tenant_id:'2'}]]){
  assert.throws(()=>validateSigners(tenants(),invalid),e=>e.status===400);
 }
 const legacy={...list[0]};delete legacy.tenant_id;
 assert.equal(validateSigners(tenants().slice(0,1),[legacy])[0].tenant_id,'1');
 assert.throws(()=>validateSigners(tenants(),[list[0],{...list[1],role:'other',tenant_id:undefined}]),/Every lease tenant/);
});

test('a company name containing a placeholder stays literal, and a fourth tenant remains present',()=>{
 const c=ctx([{...alice,type:1,company_name:'Example {{TENANT_EMAIL}} & Company'}]);
 const html=vars.substitute('<p>{{TENANT_PARTIES}}</p>',c);
 assert.match(html,/Example \{\{TENANT_EMAIL\}\} &amp; Company/);
 const many=ctx([alice,bob,{...bob,id:'3',first_name:'Third'},{...bob,id:'4',first_name:'Fourth'}]);
 const all=vars.substitute('<p>{{TENANT_PARTIES}}</p><p>{{TENANT_SIGNATURES}}</p>',many);
 assert.match(all,/Fourth Chan/);assert.match(all,/SIGANCHORTENANT3/);assert.doesNotMatch(all,/SIGNATURE_TENANT_4/);
});

test('shared loader deduplicates tenant IDs and keeps unavailable linked parties visible as errors',async()=>{
 const calls=[];
 const pool={execute:async(sql,params)=>{
  calls.push({sql,params});
  return /SELECT l.tenant_id/.test(sql)?[[{tenant_id:'1'}]]:[[alice,{...bob,type:1,company_name:''},alice,{id:'9',first_name:null,last_name:null}]];
 }};
 const list=await loadLeaseTenants(pool,'org1','lease1');
 assert.deepEqual(list.map(t=>t.id),['1','2','9']);
 assert.equal(list[0].display_name,'Alice Mei Wong');
 assert.equal(list[1].display_name,'Bob Chan');
 assert.equal(list[2].display_name,'');
 assert.match(calls[0].sql,/p.org_id=\?/);assert.match(calls[1].sql,/t.org_id=\?/);
 assert.equal(calls[1].params.at(-1),'org1');
});

test('a joint request cannot send an out-of-date or missing preview snapshot',async()=>{
 const {renderFromTemplate,documentSnapshot}=require('../src/services/leasePdfRenderer');
 const c=ctx([alice,bob]);c.tenantLayout=null;
 const tpl={id:'1',version:1,body_html:'<p>{{TENANT_PARTIES}}</p><p>{{TENANT_SIGNATURES}}</p>',header_html:'',footer_html:'',page_size:'A4',tenant_layout:null};
 const initial=documentSnapshot(c,tpl);
 assert.equal(documentSnapshot(c,tpl),initial);
 assert.notEqual(documentSnapshot({...c,tenants:[alice,{...bob,id_card:'CHANGED'}]},tpl),initial);
 assert.notEqual(documentSnapshot(c,{...tpl,version:2}),initial);
 const pool={execute:async sql=>{assert.match(sql,/SELECT/);return [[tpl]];}};
 await assert.rejects(()=>renderFromTemplate({pool,orgId:'1',leaseId:'1',templateId:'1',context:c,requireAllTenants:true}),e=>e.status===400);
 await assert.rejects(()=>renderFromTemplate({pool,orgId:'1',leaseId:'1',templateId:'1',context:c,requireAllTenants:true,expectedSnapshot:'stale'}),e=>e.status===409);
 const wrong=input();wrong[1].signer_email='wrong@example.invalid';
 assert.throws(()=>validateSigners(tenants(),wrong),/email must match/);
});
