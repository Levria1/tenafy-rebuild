const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const publicRouter=require('../src/routes/public');
const { conversationKey }=require('../src/utils/renewalAsk');

function handler(router, routePath, method='get') {
  const layer=router.stack.find(x=>x.route&&x.route.path===routePath&&x.route.methods[method]);
  return layer.route.stack.at(-1).handle;
}
async function callKnowledge(propertyId=null) {
  const scopedTitle='SECRET TITLE ACCOUNT 999'; const scopedBody='SECRET BODY ACCOUNT 999';
  const pool={execute:async(sql,params=[])=>{
    if(sql.startsWith('SELECT id, display_name FROM property')) return [[{id:params[0],display_name:'Right Building'}]];
    if(sql.includes('SELECT DISTINCT ck.id')) return [[{id:'1',kind:'faq',category:'other',title:'Global question',body:'Global answer',tags:null,updated_at:new Date(0)}]];
    if(sql.includes('SELECT ck.id, ck.kind, ck.category')) return [[{id:'2',kind:'faq',category:'payments',property_id:'42',display_name:'Right Building',title:scopedTitle,body:scopedBody}]];
    throw new Error(`Unexpected SQL ${sql}`);
  }};
  let status=200,body=null,ended=false;const headers={};
  const res={setHeader:(k,v)=>headers[k]=v,status:n=>(status=n,res),json:v=>(body=v,v),end:()=>{ended=true;}};
  await handler(publicRouter,'/chat/knowledge')({query:propertyId==null?{}:{property_id:propertyId},headers:{},pool},res);
  return {status,body,wire:JSON.stringify(body),scopedTitle,scopedBody,ended};
}

test('unknown-property partner response contains no byte of scoped title or body',async()=>{
  const r=await callKnowledge();
  assert.equal(r.status,200);assert(!r.wire.includes(r.scopedTitle));assert(!r.wire.includes(r.scopedBody));
  assert.equal(r.body.data.property_topics[0].category,'payments');
});
test('different-property partner response contains no byte of scoped title or body',async()=>{
  const r=await callKnowledge('77');assert.equal(r.status,200);assert(!r.wire.includes(r.scopedTitle));assert(!r.wire.includes(r.scopedBody));
});
test('unknown and different-property website responses contain no byte of scoped title or body',async()=>{
  const registry=require('../src/config/poolRegistry');const originalMaster=registry.getMasterPool,originalOrg=registry.getOrgPool;
  const secretTitle='WEBSITE SECRET TITLE 777',secretBody='WEBSITE SECRET BODY 777';
  registry.getMasterPool=()=>({execute:async()=>[[{id:'ORG'}]]});
  registry.getOrgPool=async()=>({execute:async(sql,params=[])=>{
    if(sql.startsWith('SELECT id,display_name FROM property'))return [[{id:params[0],display_name:'Different Building'}]];
    if(sql.includes('SELECT DISTINCT ck.id,ck.category'))return [[{id:'1',category:'other',title:'Global FAQ',body:'Global answer',updated_at:new Date(0)}]];
    if(sql.includes('SELECT DISTINCT p.id'))return [[{id:'42',display_name:'Secret Building',title:secretTitle,body:secretBody}]];
    throw new Error(`Unexpected SQL ${sql}`);
  }});
  delete require.cache[require.resolve('../src/routes/websitePublic')];const website=require('../src/routes/websitePublic');
  const h=handler(website,'/:org_slug/faqs');
  for(const query of [{},{property_id:'77'}]){
    let body;const res={setHeader(){},status(){return this},json(v){body=v;return v},end(){}};
    await h({params:{org_slug:'valid-org'},query,headers:{},ip:'127.0.0.1',setTimeout(){}},res);
    const wire=JSON.stringify(body);assert(!wire.includes(secretTitle));assert(!wire.includes(secretBody));
  }
  registry.getMasterPool=originalMaster;registry.getOrgPool=originalOrg;
});
test('phone conversation matching requires eight digits and uses exact last eight',()=>{
  assert.equal(conversationKey('+852 9123 4567'),'91234567');assert.equal(conversationKey('1234567'),'1234567');
  const src=fs.readFileSync(path.join(__dirname,'../src/routes/public.js'),'utf8');
  assert.match(src,/digits\.length >= 8/);assert.doesNotMatch(src,/digits\.length >= 7/);assert.match(src,/at least 8 digits/);
});
test('all serving joins exclude deleted properties and website route is isolated and FAQ-only',()=>{
  const pub=fs.readFileSync(path.join(__dirname,'../src/routes/public.js'),'utf8');
  const web=fs.readFileSync(path.join(__dirname,'../src/routes/websitePublic.js'),'utf8');
  const index=fs.readFileSync(path.join(__dirname,'../src/index.js'),'utf8');
  assert.match(pub,/p\.deleted_at IS NULL/);assert.match(web,/p\.deleted_at IS NULL/);
  assert.match(web,/ck\.kind='faq'.*ck\.status=1.*ck\.publish_website=1/s);
  assert(index.indexOf("'/api/website'")!==index.indexOf("'/api/public'"));
});
test('PUT omission preserves scope, explicit empty array globalises, and zero sort order is distinct',()=>{
  const src=fs.readFileSync(path.join(__dirname,'../src/routes/chat.js'),'utf8');
  assert.match(src,/b\.property_ids === undefined \? null/);
  assert.match(src,/if \(propertyIds !== null\) await replaceKnowledgeProperties/);
  assert.match(src,/b\.sort_order === '' \|\| !Number\.isInteger\(n\)/);assert.doesNotMatch(src,/params\.push\(parseInt\(b\.sort_order\) \|\| 0\)/);
});
test('071 and MASTER migrations are guarded and do not globalise existing data',()=>{
  for(const file of ['../migrations-org/071_chat_knowledge_property_and_website.sql','../migrations-master/001_organization_public_slug.sql']){
    const sql=fs.readFileSync(path.join(__dirname,file),'utf8');assert.match(sql,/information_schema/);assert.match(sql,/IF\(/);
  }
  const sql=fs.readFileSync(path.join(__dirname,'../migrations-org/071_chat_knowledge_property_and_website.sql'),'utf8');
  assert.match(sql,/DEFAULT 0/);assert.doesNotMatch(sql,/INSERT INTO chat_knowledge_property/i);
});
