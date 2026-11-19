const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('path');
const fs=require('fs');
const express=require('express');
const renderer=require('../src/services/leasePdfRenderer');
const names=['Alice Wong','Bob Chan'];
const tenants=names.map((name,i)=>({id:String(i+1),display_name:name,email:`tenant${i+1}@example.invalid`,id_card:'TEST-'+i}));
const signers=tenants.map(t=>({tenant_id:t.id,signer_name:t.display_name,signer_email:t.email,role:'tenant'}));
function stub(rel,exports){const id=require.resolve(rel);require.cache[id]={id,filename:id,loaded:true,exports};}

test('signature HTTP endpoint refuses omissions before side effects and snapshots all tenant IDs in PDF order',async t=>{
 const calls=[],recipients=[],files=[];let renders=0,renderedNames=[];
 const pool={execute:async(sql,params=[])=>{
  calls.push({sql,params:[...params]});
  if(/SELECT l.id,/.test(sql))return [[{id:'lease1',start_date:'2026-01-01',end_date:'2027-12-31'}]];
  if(/SELECT status FROM signature_request/.test(sql))return [[{status:1}]];
  if(/INSERT INTO file/.test(sql))files.push(path.join(__dirname,'../uploads',params[1]));
  return /^\s*SELECT/i.test(sql)?[[]]:[{affectedRows:1}];
 }};
 t.after(()=>files.forEach(p=>fs.rmSync(p,{force:true})));
 t.mock.method(console,'error',()=>{});
 t.mock.method(renderer,'loadLeaseContext',async()=>({tenants:tenants.map(t=>({...t}))}));
 t.mock.method(renderer,'renderFromTemplate',async opts=>{
  renders++;assert.equal(opts.requireAllTenants,true);
  assert.equal(opts.expectedSnapshot,'synthetic-preview');
  renderedNames=opts.context.tenants.map(t=>t.display_name);
  return {pdfBuffer:Buffer.from('%PDF-TEST '+renderedNames.join(', ')),templateId:'template1',version:1};
 });
 stub('../src/middleware/auth',{authenticate:(req,res,next)=>{req.user={orgId:'1',id:'7'};req.pool=pool;next();}});
 stub('../src/utils/activityLog',{logActivity:async()=>{}});
 stub('../src/config/mailer',{sendMail:async mail=>{recipients.push(mail.to);}});
 stub('../src/services/emailService',{loadTemplate:async()=>null,sendTemplateEmail:async()=>true});
 delete require.cache[require.resolve('../src/routes/signature')];
 const app=express();app.use(express.json());app.use('/api/signature',require('../src/routes/signature'));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.on('listening',r));
 t.after(()=>new Promise(r=>server.close(r)));
 const send=async parties=>{
  const r=await fetch(`http://127.0.0.1:${server.address().port}/api/signature/request`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({lease_id:'lease1',template_id:'template1',parties,document_snapshot:'synthetic-preview'})});
  return {status:r.status,body:await r.json()};
 };
 for(const bad of [[signers[0]],[signers[0],signers[0]],[signers[0],{...signers[1],tenant_id:'foreign'}],[signers[0],{...signers[1],signer_email:''}],[signers[0],{...signers[1],signer_name:'Other person'}]]){
  assert.equal((await send(bad)).status,400);
 }
 assert.equal(renders,0);assert.equal(calls.some(c=>/INSERT|UPDATE/.test(c.sql)),false);assert.equal(recipients.length,0);
 const good=await send([signers[1],signers[0]]);assert.equal(good.status,200);
 await new Promise(setImmediate);
 assert.equal(renders,1);assert.deepEqual(renderedNames,names);
 const rows=calls.filter(c=>/INSERT INTO signature_party/.test(c.sql));
 assert.deepEqual(rows.map(c=>c.params.at(-1)),['1','2']);
 assert.deepEqual(rows.map(c=>c.params[3]),names);
 assert.deepEqual(recipients,tenants.map(t=>t.email));
 assert.equal(files.length,1);assert.match(fs.readFileSync(files[0],'utf8'),/Alice Wong, Bob Chan/);
 assert.match(calls.find(c=>/INSERT INTO file/.test(c.sql)).sql,/is_private/);
});
