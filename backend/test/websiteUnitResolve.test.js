const test = require('node:test');
const assert = require('node:assert/strict');
const { scoreUnits, loadUnitsWithMarketable } = require('../src/services/unitResolver');
const websiteProducts = require('../src/services/websiteProducts');
const BASE = 'https://listings.example/';
const units = [
  { id:'1',name:'7D',property_id:'1',property_name:'Nam Pak Hong',website_name:'Bonham Strand West Studio D' },
  { id:'2',name:'4B',property_id:'2',property_name:"Gilman's Bazaar",website_name:'Central Studio 4B' },
  { id:'3',name:'1A',property_id:'2',property_name:"Gilman's Bazaar",website_name:'Central 1-Bedroom 1A' },
  { id:'4',name:'1B',property_id:'2',property_name:"Gilman's Bazaar",website_name:'Central 1-Bedroom 1B' },
  { id:'5',name:'26/F',property_id:'3',property_name:'Tai Yuen Apartments',website_name:'Tai Yuen C' },
  { id:'6',name:'7/F',property_id:'3',property_name:'Tai Yuen Apartments',website_name:'Tai Yuen D' },
  { id:'7',name:'8A',property_id:'4',property_name:'Cleverly',website_name:'Cleverly Studio A' },
  { id:'8',name:'3A',property_id:'5',property_name:'Hollywood',website_name:'Hollywood 3/F Studio A' },
  { id:'9',name:'7B',property_id:'1',property_name:'Nam Pak Hong',website_name:'Bonham Strand West Studio B' },
].map(u=>({...u,marketable:true}));

test('website full names resolve without new fuzzy rules, common descriptors, or 1Bedroom/1B collisions', () => {
  for (const u of units) {
    const out=scoreUnits(u.website_name,units);
    assert.equal(out.status,'confident',u.website_name); assert.equal(out.match.unit_id,u.id,u.website_name);
    assert.deepEqual(out.unmatched,[]);
  }
});
test('units without a website name retain their full previous result', () => {
  const plain=units.map(({website_name,...u})=>u);
  const empty=plain.map(u=>({...u,website_name:null}));
  for(const q of ['Nam Pak Hong 7D','Cleverly 8A','Central Studio 4B','not found','7D','Tai Yuen flat 26'])assert.deepEqual(scoreUnits(q,empty),scoreUnits(q,plain));
});
test('database unit load includes website_name and preserves public org scope', async () => {
  const result=await loadUnitsWithMarketable({execute:async(sql,args)=>{
    assert.match(sql,/u\.website_name/);assert.match(sql,/p\.org_id = \?/);assert.match(sql,/u\.active_status = 1/);assert.match(sql,/p\.status = 1/);assert.match(sql,/u\.deleted_at IS NULL/);
    assert.deepEqual(args,['org']);return [[{...units[0],website_name:'Bonham Strand West Studio D'}]];
  }},'org');
  assert.equal(result[0].website_name,'Bonham Strand West Studio D');
});

async function call(body,{mapped='1',setting=BASE,request,rows=units}={}) {
  const calls=[];
  const pool={execute:async(sql,args)=>{
    calls.push({sql,args});
    if(/SELECT u\.id, u\.name, u\.property_id/.test(sql))return [rows];
    if(/SELECT u\.id AS unit_id, u\.listing_url/.test(sql))return [[{unit_id:'2',listing_url:`${BASE}product/exact/`}]];
    if(/SELECT website_base_url/.test(sql))return [[{website_base_url:setting}]];
    if(/SELECT unit_id FROM unit_website_product/.test(sql)){assert.deepEqual(args,['org','41']);return [mapped?[{unit_id:mapped}]:[]];}
    throw Error(`Unexpected SQL ${sql}`);
  }};
  const previous=websiteProducts.recogniseWebsiteListing;
  let httpCalls=0;
  websiteProducts.recogniseWebsiteListing=websiteProducts.createWebsiteResolver({request:async url=>{
    httpCalls++;
    if(request)return request(url);
    return {status:200,headers:{},body:JSON.stringify([{id:41,name:'Bonham Strand West Studio D',slug:'copy-2-2-2',permalink:`${BASE}product/copy-2-2-2/`}])};
  }});
  try {
    delete require.cache[require.resolve('../src/routes/public')];
    const router=require('../src/routes/public');
    const handler=router.stack.find(l=>l.route?.path==='/units/resolve').route.stack.at(-1).handle;
    const res={statusCode:200,status(n){this.statusCode=n;return this;},json(value){this.body=value;return this;}};
    await handler({body,pool,apiKey:{orgId:'org'}},res);
    assert.equal(res.statusCode,200);
    return {data:res.body.data,httpCalls,calls};
  } finally {websiteProducts.recogniseWebsiteListing=previous;}
}

test('exact current link wins before any website HTTP', async () => {
  const out=await call({listing_url:`${BASE}product/exact/?fbclid=x`});
  assert.equal(out.data.match.unit_id,'2');assert.equal(out.data.resolved_by,'listing_url');assert.equal(out.httpCalls,0);
});
test('website copy and product query resolve to their mapped active unit and include website_listing', async () => {
  for(const listing_url of [`${BASE}product/copy-2-2-2/`,`${BASE}?p=41`,`${BASE}?product_id=41`]){
    const out=await call({listing_url});
    assert.equal(out.data.status,'confident');assert.equal(out.data.match.unit_id,'1');assert.equal(out.data.resolved_by,'listing_url');assert.equal(out.data.website_listing.product_id,'41');
  }
});
test('unmapped or inactive mapped products return website metadata with no match', async () => {
  for(const mapped of [null,'inactive']){
    const out=await call({listing_url:`${BASE}?p=41`},{mapped});
    assert.equal(out.data.status,'none');assert.equal(out.data.match,null);assert.equal(out.data.website_listing.name,'Bonham Strand West Studio D');
  }
});
test('unmapped products fall through to text while keeping website metadata', async () => {
  const out=await call({listing_url:`${BASE}?p=41`,unit_text:'Cleverly 8A'},{mapped:null});
  assert.equal(out.data.match.unit_id,'7');assert.equal(out.data.resolved_by,'unit_text');assert.equal(out.data.website_listing.product_id,'41');
});
test('foreign host, timeout, and no setting fall through with no error', async () => {
  for(const opts of [{setting:null},{request:async()=>{throw Error('timeout');}}]){
    const out=await call({listing_url:`${BASE}?p=41`,unit_text:'Cleverly 8A'},opts);
    assert.equal(out.data.match.unit_id,'7');assert.equal(out.data.resolved_by,'unit_text');
    if(opts.setting===null)assert.equal(out.httpCalls,0);
  }
  const out=await call({listing_url:'https://elsewhere.example/product/a/',unit_text:'Cleverly 8A'});
  assert.equal(out.httpCalls,0);assert.equal(out.data.match.unit_id,'7');
});
test('unit_id always wins, including unknown id, without contacting website', async () => {
  for(const unit_id of ['2','other-org']){
    const out=await call({unit_id,listing_url:`${BASE}?p=41`,unit_text:'Cleverly 8A'});
    assert.equal(out.data.resolved_by,'unit_id');assert.equal(out.httpCalls,0);assert.equal(out.data.match?.unit_id||null,unit_id==='2'?'2':null);
  }
});
