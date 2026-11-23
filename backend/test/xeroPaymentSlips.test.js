const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const mysql = require('mysql2/promise');
const slips = require('../src/services/xeroPaymentSlips');

test('OCR offers values only when the amount and currency are unambiguous', () => {
  const result = slips.suggestions('Amount paid: HKD 10,636.00\nTransfer date: 2026-11-20\nSender: Test Person\nReference: TEST-1234');
  assert.equal(result.amount_minor,1063600);
  assert.equal(result.transfer_date,'2026-11-20');
  assert.equal(result.transfer_reference,'TEST-1234');
  assert.equal(slips.suggestions('Amount: 10,636.00').amount_minor,null);
  assert.equal(slips.suggestions('Amount: HKD 995\nAmount paid: HKD 1000').amount_minor,null);
});

const socket = process.env.STAMP_TEST_SOCKET;
test('private slip flow deduplicates, verifies, scopes lookup and returns the original bytes', { skip:!socket }, async t => {
  assert.match(socket,/^\/tmp\/tenafy-(?:pr18-mysql|stamp-[a-z0-9-]+)\/mysql\.sock$/);
  const admin = await mysql.createConnection({ socketPath:socket,user:'root' });
  const database = 'slip_test_' + randomBytes(6).toString('hex');
  await admin.query(`CREATE DATABASE ${database}`);
  const pool = mysql.createPool({ socketPath:socket,user:'root',database,multipleStatements:true });
  t.after(async () => { await pool.end(); await admin.query(`DROP DATABASE ${database}`); await admin.end(); });
  const migration = fs.readFileSync(path.join(__dirname,'../migrations-org/090_xero_payment_slip.sql'),'utf8');
  await pool.query(migration);
  await pool.query(migration);
  const file = { mimetype:'image/png',originalname:'slip.png',
    buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC','base64') };
  let calls = 0;
  const ocr = { extractText:async () => { calls++; return 'Amount paid: HKD 10,636.00\nTransfer date: 2026-11-20'; } };
  const source = { source_channel:'email',source_reference:'fixture-message' };
  const imported = await slips.importSlip(pool,'1','7',file,source,ocr);
  const duplicate = await slips.importSlip(pool,'1','7',file,source,ocr);
  assert.equal(imported.id,duplicate.id);
  assert.equal(calls,1);
  assert.equal(imported.ocr_state,'extracted');
  await assert.rejects(slips.original(pool,'2',imported.id), { status:404 });
  const mapping = { xero_account_id:'a'.repeat(32) };
  const statement = { currency:'HKD',amount_minor:1063600,date:'2026-11-20',id_suffix:'1'.repeat(32) };
  assert.deepEqual(await slips.candidates(pool,'1',mapping,statement),[]);
  const verified = await slips.verify(pool,'1',imported.id,'7',{
    confirmed:true,currency:'HKD',amount:'10,636.00',transfer_date:'2026-11-20',
  });
  assert.ok(verified.verified_at);
  assert.equal((await slips.candidates(pool,'1',mapping,statement)).length,1);
  assert.deepEqual(await slips.candidates(pool,'2',mapping,statement),[]);
  assert.deepEqual(await slips.candidates(pool,'1',mapping,{ ...statement,amount_minor:1063500 }),[]);
  assert.deepEqual(await slips.candidates(pool,'1',mapping,{ ...statement,date:'2026-11-28' }),[]);
  assert.deepEqual((await slips.approve(pool,'1','7',imported.id,mapping,statement,null)).bytes,file.buffer);
  assert.deepEqual((await slips.approve(pool,'1','7',imported.id,mapping,statement,null)).bytes,file.buffer);
  const different = { ...statement,id_suffix:'2'.repeat(32) };
  await assert.rejects(slips.approve(pool,'1','7',imported.id,mapping,different,null), { status:409 });
  assert.deepEqual(await slips.candidates(pool,'1',mapping,different),[]);
});
