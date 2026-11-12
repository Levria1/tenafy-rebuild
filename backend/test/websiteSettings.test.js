const test = require('node:test');
const assert = require('node:assert/strict');
const router = require('../src/routes/settings');
const put = router.stack.find(l => l.route?.path === '/setting/website' && l.route.methods.put).route;
const get = router.stack.find(l => l.route?.path === '/setting/website' && l.route.methods.get).route;
function response() { return {statusCode:200,status(n){this.statusCode=n;return this;},json(body){this.body=body;return this;}}; }

test('website setting has an admin guard and does not let ordinary staff change the outbound host', () => {
  let next=false; const res=response();
  put.stack[1].handle({user:{orgId:'org',isSuperAdmin:false}},res,()=>{next=true;});
  assert.equal(next,false);assert.equal(res.statusCode,403);
});
test('website setting rejects unsafe URLs before any database write', async () => {
  for(const website_base_url of [undefined,42,'https://key@listings.example/','http://127.0.0.1/','https://listings.example:8443/']){
    const res=response();
    await put.stack.at(-1).handle({body:{website_base_url},pool:{execute:async()=>{throw Error('Must not write');}}},res);
    assert.equal(res.statusCode,400);
  }
});
test('website setting saves only its org-scoped field, and blank disables it', async () => {
  for(const value of ['https://listings.example/','']){
    const res=response(),calls=[];
    await put.stack.at(-1).handle({body:{website_base_url:value},user:{id:'admin',orgId:'org'},pool:{execute:async(sql,args)=>{calls.push({sql,args});return [{affectedRows:1}];}}},res);
    assert.equal(res.statusCode,200);
    assert.match(calls[0].sql,/SET website_base_url=\?,updated_at=NOW\(\) WHERE id=\?/);
    assert.deepEqual(calls[0].args,[value||null,'org']);
    assert.ok(!calls[0].sql.includes('display_name'));
  }
});
test('website setting reads only the caller org', async () => {
  const res=response();
  await get.stack.at(-1).handle({user:{orgId:'org'},pool:{execute:async(sql,args)=>{
    assert.deepEqual(args,['org']);assert.match(sql,/WHERE id=\?/);return [[{website_base_url:'https://listings.example/'}]];
  }}},res);
  assert.deepEqual(res.body.data,{website_base_url:'https://listings.example/'});
});
