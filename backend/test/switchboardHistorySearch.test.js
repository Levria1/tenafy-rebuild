const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../src/services/switchboardHistorySearch');
const statement = {id_suffix:'a'.repeat(32),date:'2026-11-19',amount_minor:1380000,digits:2,currency:'HKD',direction:'received'};
const mapping = {bank_account_id:'10',currency_id:'30'};

test('unlinked history requires exclusive registry ownership, correct pool and no foreign anchors', async () => {
  const run = async (mode) => {
    const master = {execute:async sql=> {
      if(mode==='failure') throw Error('unavailable');
      if(sql.includes('status=1')) return mode==='missing' ? [[]] : [[{id:'1',db_name:'org_db'}]];
      return [mode==='shared' ? [{id:'1'},{id:'2'}] : [{id:'1'}]];
    }};
    const pool = {execute:async sql=>sql.includes('DATABASE()') ? [[{database_name:mode==='wrong_pool'?'other_db':'org_db'}]] : [[{n:mode==='foreign'?1:0}]]};
    return h.resolveHistoryScope(pool,'1',master);
  };
  assert.equal((await run('ok')).allowUnlinked,true);
  for(const mode of ['failure','missing','shared','wrong_pool','foreign']) assert.equal((await run(mode)).allowUnlinked,false,mode);
  assert.equal(h.ownership('1',{allowUnlinked:true}).params.at(-1),1);
  assert.equal(h.ownership('1',{allowUnlinked:'true'}).params.at(-1),0);
});

test('history pagination tokens reject tampering, expiry and another org/bank/row/query', t => {
  const hash=h.queryScope('1',mapping,statement), row={id:'9007199254740994',created_sql:'2026-11-19 12:00:00',distance:43200};
  const token=h.encodeCursor(row,hash);
  assert.equal(h.decodeCursor(token,hash).id,row.id);
  for(const scope of [h.queryScope('1',mapping,statement,'all'),h.queryScope('1',mapping,statement,30),h.queryScope('2',mapping,statement),h.queryScope('1',{...mapping,bank_account_id:'11'},statement),
    h.queryScope('1',mapping,{...statement,id_suffix:'b'.repeat(32)}),h.queryScope('1',mapping,{...statement,reference:'PAY123456'})]) {
    assert.throws(()=>h.decodeCursor(token,scope),e=>e.status===400);
  }
  for(const value of [token+'x',token+'.extra','forged',{},'x'.repeat(1601)]) assert.throws(()=>h.decodeCursor(value,hash),e=>e.status===400);
  const now=Date.now();t.mock.method(Date,'now',()=>now+11*60000);
  assert.throws(()=>h.decodeCursor(token,hash),e=>e.status===400);
});

test('reference search excludes generic words and escapes punctuation before generating regex', () => {
  for(const reference of ['rent','payment','12345','x'.repeat(100)]) assert.equal(h.referencePattern({reference}),null);
  assert.ok(h.referencePattern({reference:'PAY-ABC-123456'}).includes('P[[:space:]-]*A'));
});


test('message windows allow six or thirty calendar days and explicit all history', () => {
  assert.deepEqual(h.messageWindow(statement), {days:6,start:'2026-11-14',end:'2026-11-19',end_exclusive:'2026-11-20'});
  assert.equal(h.messageWindow(statement,30).start,'2026-10-21');
  assert.deepEqual(h.messageWindow(statement,'all'),{days:'all',start:null,end:null,end_exclusive:null});
  assert.equal(h.messageWindow({...statement,date:'2024-03-01'},6).start,'2024-02-25');
  for(const days of [0,1,7,31,365,'30',{},-1]) assert.throws(()=>h.messageWindow(statement,days),e=>e.status===400);
});
