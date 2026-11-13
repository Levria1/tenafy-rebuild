const test = require('node:test');
const assert = require('node:assert/strict');
const { createWebsiteResolver, websiteBase, productId, fetchProducts, requestWebsite, exactWebsiteListing } = require('../src/services/websiteProducts');
const BASE = 'https://listings.example/';
const product = (id, slug = `unit-${id}`) => ({ id, slug, name: `Website studio ${id}`, permalink: `${BASE}product/${slug}/` });
const settingPool = value => ({ execute: async (sql, params) => {
  assert.match(sql, /website_base_url.*organization WHERE id = \?/); assert.deepEqual(params, ['org']);
  return [[{ website_base_url: value }]];
} });
function fixture(products = [product(41, 'unit-2-2-2')], extra = () => ({ status: 404, headers: {}, body: '' })) {
  const calls = [];
  const request = async url => {
    calls.push(url);
    if (url.pathname.endsWith('/wp-json/wc/store/v1/products')) return { status: 200, headers: {}, body: JSON.stringify(products) };
    return extra(url);
  };
  return { calls, request, resolve: createWebsiteResolver({ request }) };
}

test('website slug index supports repeated suffixes, ?p, ?product_id and normalized www hosts', async () => {
  const f = fixture();
  for (const link of [`${BASE}product/unit-2-2-2/`, `${BASE}?p=41`, `${BASE}?product_id=41`, 'http://www.LISTINGS.example/product/unit-2-2-2/']) {
    const out = await f.resolve(settingPool(BASE), 'org', link);
    assert.equal(out.product_id, '41'); assert.equal(out.name, 'Website studio 41');
  }
  assert.equal(f.calls.length, 1);
});
test('a second website copy is a recognized product in its own right', async () => {
  const f = fixture([product(41, 'first'), { ...product(42, 'copy'), name: 'Website studio 41' }]);
  assert.equal((await f.resolve(settingPool(BASE), 'org', `${BASE}product/copy/`)).product_id, '42');
});
test('a missing slug refreshes once and resolves a same-host 301 without forwarding query parameters', async () => {
  const f = fixture(undefined, () => ({ status: 301, headers: { location: '/product/unit-2-2-2/' }, body: '' }));
  const out = await f.resolve(settingPool(BASE), 'org', `${BASE}product/old/?token=secret#fragment`);
  assert.equal(out.product_id, '41'); assert.equal(f.calls.length, 3);
  assert.equal(f.calls.at(-1).href, `${BASE}product/old/`);
});
test('index remembers a previously seen slug when a product permalink changes', async () => {
  let time = 0, calls = 0;
  const resolve = createWebsiteResolver({ now: () => time, request: async () => {
    calls++; return { status: 200, headers: {}, body: JSON.stringify([product(41, calls === 1 ? 'old' : 'new')]) };
  } });
  await resolve(settingPool(BASE), 'org', `${BASE}product/old/`);
  time = 6 * 60 * 60 * 1000 + 1;
  assert.equal((await resolve(settingPool(BASE), 'org', `${BASE}product/old/`)).permalink, `${BASE}product/new/`);
  assert.equal(calls, 2);
});
test('refresh on a miss is bounded for the org cache and concurrent calls share a download', async () => {
  const f = fixture();
  await Promise.all(Array.from({ length: 5 }, () => f.resolve(settingPool(BASE), 'org', `${BASE}?p=41`)));
  assert.equal(f.calls.length, 1);
  await f.resolve(settingPool(BASE), 'org', `${BASE}?p=901`);
  await f.resolve(settingPool(BASE), 'org', `${BASE}?p=902`);
  assert.equal(f.calls.length, 2);
});
test('no org setting or a foreign host makes no outbound call', async () => {
  const f = fixture();
  for (const base of [null, '', 'bad']) assert.equal(await f.resolve(settingPool(base), 'org', `${BASE}?p=41`), null);
  for (const url of ['https://other.example/product/a/', 'https://listings.example.evil.test/product/a/', 'https://listings.example@evil.test/product/a/', 'ftp://listings.example/product/a/']) {
    assert.equal(await f.resolve(settingPool(BASE), 'org', url), null);
  }
  assert.equal(f.calls.length, 0);
});
test('redirects never leave the website host or exceed three requests', async () => {
  for (const location of ['https://evil.example/steal', 'https://listings.example:444/product/a/', 'file:///etc/passwd']) {
    const f = fixture(undefined, () => ({ status: 301, headers: { location }, body: '' }));
    assert.equal(await f.resolve(settingPool(BASE), 'org', `${BASE}product/old/`), null);
    assert.equal(f.calls.length, 3);
    assert.ok(f.calls.every(u => u.hostname === 'listings.example'));
  }
  const f = fixture(undefined, () => ({ status: 301, headers: { location: '/product/loop/' }, body: '' }));
  assert.equal(await f.resolve(settingPool(BASE), 'org', `${BASE}product/loop/`), null);
  assert.equal(f.calls.length, 5); // initial list, miss refresh, three redirect hops
});
test('timeout, malformed response, or missing settings column falls through', async () => {
  const resolve = createWebsiteResolver({ request: async () => { throw new Error('Website timeout'); } });
  assert.equal(await resolve(settingPool(BASE), 'org', `${BASE}?p=41`), null);
  assert.equal(await resolve({ execute: async () => { throw Error('missing column'); } }, 'org', `${BASE}?p=41`), null);
});
test('one three-second budget covers catalogue pagination, miss refresh and redirect hops', async () => {
  for (const paginate of [false,true]) {
    let time=0;const calls=[];
    const resolve=createWebsiteResolver({now:()=>time,request:async(url,options)=>{
      calls.push({url,timeout:options.timeoutMs});
      const catalogue=url.pathname.endsWith('/products');
      time+=1000;
      if(catalogue) return {status:200,headers:{},body:JSON.stringify(paginate&&url.searchParams.get('page')==='1'?Array.from({length:100},(_,i)=>product(i+1)):[product(41)])};
      return {status:301,headers:{location:'/product/still-missing/'},body:''};
    }});
    assert.equal(await resolve(settingPool(BASE),'org',`${BASE}product/missing/`),null);
    assert.equal(time,3000);assert.equal(calls.length,3);
    assert.deepEqual(calls.map(c=>c.timeout),[2000,2000,1000]);
    // The total-budget failure is remembered without another website call.
    assert.equal(await resolve(settingPool(BASE),'org',`${BASE}product/another/`),null);
    assert.equal(calls.length,3);
  }
});
test('failed websites are skipped for three minutes, then retried; cooldown is per org/base', async () => {
  let time=0,calls=0,down=true;
  const pool={execute:async()=>[[{website_base_url:BASE}]]};
  const resolve=createWebsiteResolver({now:()=>time,request:async()=>{
    calls++;if(down)throw Error('site down');
    return {status:200,headers:{},body:JSON.stringify([product(41)])};
  }});
  assert.equal(await resolve(pool,'org',`${BASE}?p=41`),null);
  for(let i=0;i<5;i++)assert.equal(await resolve(pool,'org',`${BASE}?p=41`),null);
  assert.equal(calls,1);
  down=false;
  assert.equal((await resolve(pool,'other-org',`${BASE}?p=41`)).product_id,'41');
  assert.equal(calls,2);
  time=180001;
  assert.equal((await resolve(pool,'org',`${BASE}?p=41`)).product_id,'41');
  assert.equal(calls,3);
});
test('a stalled catalogue is aborted by the real total budget and a later lookup returns immediately', async () => {
  let calls=0,aborted=false;
  const resolve=createWebsiteResolver({request:async(url,{signal})=>{
    calls++;signal.addEventListener('abort',()=>{aborted=true;},{once:true});
    return new Promise(()=>{}); // Stub transport ignores timeoutMs; total budget still bounds the await.
  }});
  const start=Date.now();
  assert.equal(await resolve(settingPool(BASE),'org',`${BASE}?p=41`),null);
  assert.ok(Date.now()-start>=2800&&Date.now()-start<5000);
  assert.equal(aborted,true);
  const next=Date.now();
  assert.equal(await resolve(settingPool(BASE),'org',`${BASE}?p=41`),null);
  assert.ok(Date.now()-next<500);assert.equal(calls,1);
});
test('concurrent website lookups share a failing request and all use the cooldown', async () => {
  let calls=0;
  const resolve=createWebsiteResolver({request:async()=>{calls++;await new Promise(r=>setTimeout(r,10));throw Error('offline');}});
  assert.deepEqual(await Promise.all(Array.from({length:5},()=>resolve(settingPool(BASE),'org',`${BASE}?p=41`))),[null,null,null,null,null]);
  assert.equal(calls,1);
  assert.equal(await resolve(settingPool(BASE),'org',`${BASE}?p=41`),null);assert.equal(calls,1);
});
test('an invalid escaped slug is an ordinary miss and does not put a healthy website in cooldown', async () => {
  const f=fixture();
  assert.equal(await f.resolve(settingPool(BASE),'org',`${BASE}product/bad%/`),null);
  assert.equal((await f.resolve(settingPool(BASE),'org',`${BASE}?p=41`)).product_id,'41');
});
test('Store API pagination, entity names, and product ids are validated', async () => {
  const calls = [];
  const products = await fetchProducts(BASE, async u => {
    calls.push(u.href);
    const rows = u.searchParams.get('page') === '1' ? Array.from({ length: 100 }, (_, i) => product(i + 1)) : [{ ...product(101), name: 'A &amp; B' }];
    return { status: 200, body: JSON.stringify(rows) };
  });
  assert.equal(products.length, 101); assert.equal(products.at(-1).name, 'A & B'); assert.equal(calls.length, 2);
  assert.equal(productId('9223372036854775808'), null);
  assert.equal(productId('41'), '41');
  assert.equal(productId(9007199254740992), null);
  for (const value of ['http://127.0.0.1/', 'https://localhost/', 'https://x.example:8443/', 'https://key@x.example/']) assert.equal(websiteBase(value), null);
});
test('exact current links return locally stored product metadata without HTTP', async () => {
  const pool = { execute: async (sql, args) => {
    assert.deepEqual(args, ['org','unit']); assert.match(sql, /WHERE org_id=\? AND unit_id=\?/);
    return [[{product_id:'41',name:'Studio A',permalink:`${BASE}product/unit-41/`}]];
  } };
  assert.equal((await exactWebsiteListing(pool,'org','unit',`${BASE}product/unit-41/?fbclid=x`)).product_id,'41');
});
test('the real HTTP adapter aborts a stalled request after two seconds (stub transport)', async () => {
  const https = require('node:https');
  const { EventEmitter } = require('node:events');
  const previous = https.get;
  https.get = (url, options) => {
    assert.equal(url.hostname,'listings.example');
    assert.deepEqual(Object.keys(options.headers).sort(),['Accept','User-Agent']);
    const req = new EventEmitter(); req.destroy = error => req.emit('error',error); return req;
  };
  try {
    const start = Date.now();
    await assert.rejects(requestWebsite(new URL(BASE)),/timeout/);
    assert.ok(Date.now()-start >= 1900 && Date.now()-start < 5000);
  } finally { https.get=previous; }
});
