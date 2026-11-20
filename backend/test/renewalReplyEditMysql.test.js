const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const mysql=require('mysql2/promise');
const socket=process.env.STAMP_TEST_SOCKET;

test('scratch MySQL: real lease edits reconcile current replies atomically and preserve history/ownership', {skip:!socket,timeout:60000},async t=>{
  assert.match(socket,/^\/tmp\/tenafy-(?:pr18-mysql|stamp-[a-z0-9-]+)\/mysql\.sock$/);
  const admin=await mysql.createConnection({socketPath:socket,user:'root',multipleStatements:true});
  const db='renewal_edit_'+crypto.randomBytes(6).toString('hex');await admin.query(`CREATE DATABASE ${db}`);
  const pool=mysql.createPool({socketPath:socket,user:'root',database:db,multipleStatements:true,dateStrings:true});
  t.after(async()=>{await pool.end();await admin.query(`DROP DATABASE ${db}`);await admin.end();});
  await pool.query(`
    CREATE TABLE property(id BIGINT PRIMARY KEY,org_id BIGINT);
    CREATE TABLE unit(id BIGINT PRIMARY KEY,property_id BIGINT);
    CREATE TABLE tenant(id BIGINT PRIMARY KEY,first_name VARCHAR(30),last_name VARCHAR(30));
    CREATE TABLE leasing(id BIGINT PRIMARY KEY,unit_id BIGINT,tenant_id BIGINT,start_date DATE,end_date DATE,
      contract_type INT,renewal_reply INT,renewal_reply_at DATETIME,deleted_at DATETIME NULL,updated_at DATETIME,note TEXT,amount DECIMAL(12,2),lease_no VARCHAR(50));
    CREATE TABLE renewal_ask(id BIGINT PRIMARY KEY,lease_id BIGINT,reply_intent INT,lease_end_at_ask DATE);
    CREATE TABLE activity_log(id BIGINT AUTO_INCREMENT PRIMARY KEY,org_id BIGINT,user_id BIGINT,username VARCHAR(50),action VARCHAR(30),entity_type VARCHAR(50),entity_id VARCHAR(50),description VARCHAR(500),details JSON,ip_address VARCHAR(100));
    CREATE TABLE signature_request(id BIGINT,status INT,signature_method VARCHAR(50),template_id BIGINT,signed_file_id BIGINT,
      original_file_id BIGINT,term_start DATE,term_end DATE,term_stamp_end DATE,completed_at DATETIME,sent_at DATETIME,expires_at DATETIME,lease_id BIGINT,org_id BIGINT,created_at DATETIME);
    INSERT INTO property VALUES(1,1),(2,2);
    INSERT INTO unit VALUES(10,1),(11,2),(12,1);
    INSERT INTO tenant VALUES(20,'Test','Tenant'),(21,'Next','Tenant');
    INSERT INTO leasing VALUES(100,10,20,'2025-03-22','2026-10-21',1,1,'2026-09-07 10:31:05',NULL,NOW(),NULL,13500,NULL),
      (101,11,20,'2025-03-22','2026-10-21',1,1,'2026-09-07 10:31:05',NULL,NOW(),NULL,13500,NULL);
    INSERT INTO renewal_ask VALUES(200,100,1,'2026-10-21');
  `);
  const route=require('../src/routes/leasing').stack.find(l=>l.route?.path==='/:id'&&l.route.methods.put);
  const handler=route.route.stack.at(-1).handle;
  const put=async(body,id='100',orgId='1')=>{
    const response={statusCode:200,status(code){this.statusCode=code;return this;},json(data){this.data=data;return this;}};
    await handler({body,params:{id},pool,user:{id:'999',orgId,username:'Test staff'},headers:{}},response);
    return response;
  };
  const row=async(id=100)=>(await pool.execute('SELECT * FROM leasing WHERE id=?',[id]))[0][0];
  const originalReply='2026-09-07 10:31:05';
  assert.equal((await put({note:'unrelated edit',end_date:'2026-10-21',contract_type:1})).statusCode,200);
  assert.equal((await row()).renewal_reply,1);assert.equal((await row()).renewal_reply_at,originalReply);
  assert.equal((await put({end_date:'2026-12-21',contract_type:1})).statusCode,200);
  assert.equal((await row()).renewal_reply,null);assert.equal((await row()).renewal_reply_at,null,'new period clears reply and timestamp');
  assert.equal((await put({contract_type:3})).statusCode,200);
  assert.equal((await row()).renewal_reply,2,'explicit staff NR records leaving');assert.ok((await row()).renewal_reply_at);
  const leavingTime=(await row()).renewal_reply_at;
  await put({contract_type:3,note:'same intent'});assert.equal((await row()).renewal_reply_at,leavingTime,'unchanged intent preserves evidence time');
  await pool.execute('UPDATE leasing SET renewal_reply=1,renewal_reply_at=? WHERE id=100',[originalReply]);
  await put({contract_type:3});assert.equal((await row()).renewal_reply,2,'explicit NR repairs an existing contradiction');
  await put({contract_type:1});assert.equal((await row()).renewal_reply,null,'returning to undecided clears leaving');
  await pool.execute('UPDATE leasing SET renewal_reply=1,renewal_reply_at=? WHERE id=100',[originalReply]);
  await put({tenant_id:'21'});assert.equal((await row()).renewal_reply,null,'answer cannot transfer to another tenant');
  await pool.execute('UPDATE leasing SET renewal_reply=1,renewal_reply_at=? WHERE id=100',[originalReply]);
  await put({unit_id:'12'});assert.equal((await row()).renewal_reply,null,'answer cannot transfer to another unit');
  const foreignBefore=await row(101);assert.equal((await put({contract_type:3},'101')).statusCode,404);assert.deepEqual(await row(101),foreignBefore);
  const [[history]]=await pool.execute('SELECT * FROM renewal_ask WHERE id=200');
  assert.deepEqual(history,{id:200,lease_id:100,reply_intent:1,lease_end_at_ask:'2026-10-21'});
  const [[counts]]=await pool.execute('SELECT COUNT(*) AS n FROM activity_log');assert.equal(counts.n,8,'only successful staff edits audited');
});
