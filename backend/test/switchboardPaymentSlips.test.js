const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const client = require('../src/services/switchboardPaymentSlips');

test('direct slip bridge scopes the integration and verifies exact attachment content', async t => {
  const keys = ['TANECHAT_SLIP_API_KEY','TANECHAT_SLIP_ORG_ID'];
  const old = keys.map(key=>process.env[key]);
  t.after(()=>keys.forEach((key,index)=>{ if (old[index]===undefined) delete process.env[key]; else process.env[key]=old[index]; }));
  process.env.TANECHAT_SLIP_API_KEY = 'synthetic-key';
  process.env.TANECHAT_SLIP_ORG_ID = '101';
  const message = 'aaf8e774-8a12-4b06-9891-50a7a9b021cd';
  const attachment = '16137da3-9cdb-40e3-97fd-7e2278691d63';
  const bytes = Buffer.from('%PDF-1.4\nfixture');
  const item = { message_id:message,attachment_id:attachment,channel:'email',type:'application/pdf',
    size:bytes.length,received_at:'2026-11-23T09:00:00Z',name:'receipt.pdf' };
  const response = { ...item,base64:bytes.toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex') };
  let count=0;
  const fetchImpl = async (url,opts) => {
    count++;
    assert.equal(url.protocol,'https:');
    assert.equal(opts.redirect,'error');
    assert.equal(opts.headers['X-API-Key'],'synthetic-key');
    if (url.pathname.endsWith('/payment-slips')) {
      if (url.searchParams.has('from')) {
        assert.equal(url.searchParams.get('from'),'2026-11-13');
        assert.equal(url.searchParams.get('to'),'2026-11-28');
      } else assert.equal(url.searchParams.get('conversation_id'),message);
      return Response.json({ items:[{ ...item,storage_url:'/private-path' }],truncated:false });
    }
    assert.ok(url.pathname.endsWith(`/payment-slips/${message}/${attachment}`));
    return Response.json(response);
  };
  await assert.rejects(client.list('102',{ date:'2026-11-20' },fetchImpl),{status:503});
  assert.equal(count,0);
  assert.deepEqual((await client.list('101',{ date:'2026-11-20' },fetchImpl)).items,[item]);
  assert.deepEqual((await client.list('101',{ conversationId:message },fetchImpl)).items,[item]);
  assert.deepEqual((await client.download('101',message,attachment,fetchImpl)).file.buffer,bytes);
  const different = async () => Response.json({ ...response,sha256:'0'.repeat(64) });
  await assert.rejects(client.download('101',message,attachment,different),{status:502});
  await assert.rejects(client.download('101','../secret',attachment,fetchImpl),{status:400});
});
