const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const path=require('path');
const crypto=require('crypto');
const mysql=require('mysql2/promise');
const express=require('express');
const {loadLeaseTenants,validateSigners}=require('../src/services/leaseTenants');
const fixture=require('../test-support/joint-tenant-preview/base-template.json');
const socket=process.env.STAMP_TEST_SOCKET;

test('scratch MySQL: migration twice, org-safe parties, explicit template upgrade, version snapshots and conflicts',
 {skip:!socket,timeout:60000},async t=>{
 assert.match(socket,/^\/tmp\/tenafy-(?:pr18-mysql|stamp-[a-z0-9-]+)\/mysql\.sock$/);
 const admin=await mysql.createConnection({socketPath:socket,user:'root',multipleStatements:true});
 const database='joint_test_'+crypto.randomBytes(6).toString('hex');
 await admin.query(`CREATE DATABASE ${database}`);
 const pool=mysql.createPool({socketPath:socket,user:'root',database,multipleStatements:true,supportBigNumbers:true,bigNumberStrings:true,connectionLimit:4});
 t.after(async()=>{await pool.end();await admin.query(`DROP DATABASE ${database}`);await admin.end();});
 await pool.query(`
 CREATE TABLE property(id BIGINT PRIMARY KEY,org_id BIGINT);
 CREATE TABLE unit(id BIGINT PRIMARY KEY,property_id BIGINT);
 CREATE TABLE leasing(id BIGINT PRIMARY KEY,unit_id BIGINT,tenant_id BIGINT,deleted_at DATETIME NULL);
 CREATE TABLE tenant(id BIGINT PRIMARY KEY,org_id BIGINT,first_name VARCHAR(255),middle_name VARCHAR(255),last_name VARCHAR(255),company_name VARCHAR(255),type INT,id_card VARCHAR(255),id_type VARCHAR(30),email VARCHAR(255),phone VARCHAR(255),deleted_at DATETIME NULL);
 CREATE TABLE leasing_additional_tenant(leasing_id BIGINT,tenant_id BIGINT);
 CREATE TABLE signature_party(id BIGINT PRIMARY KEY,signer_name VARCHAR(255));
 CREATE TABLE lease_template(id BIGINT PRIMARY KEY,org_id BIGINT,name VARCHAR(255),description TEXT,body_html LONGTEXT,header_html LONGTEXT,footer_html LONGTEXT,page_size VARCHAR(20),is_default INT,status INT,version INT,created_by BIGINT,updated_at DATETIME NULL,created_at DATETIME DEFAULT CURRENT_TIMESTAMP,deleted_at DATETIME NULL);
 CREATE TABLE lease_template_revision(id BIGINT PRIMARY KEY,template_id BIGINT,version INT,body_html LONGTEXT,header_html LONGTEXT,footer_html LONGTEXT,edited_by BIGINT,edited_at DATETIME DEFAULT CURRENT_TIMESTAMP);
 CREATE TABLE property_lease_template(org_id BIGINT,property_id BIGINT,template_id BIGINT);
 INSERT INTO property VALUES(1,1),(2,2);INSERT INTO unit VALUES(10,1),(20,2);
 INSERT INTO leasing VALUES(100,10,1,NULL),(200,20,9,NULL);
 INSERT INTO tenant(id,org_id,first_name,middle_name,last_name,type,company_name,id_card,email) VALUES
 (1,1,'Alice','Mei','Wong',0,NULL,'TEST-A','a@example.invalid'),
 (2,1,'Bob',NULL,'Chan',1,'','TEST-B','b@example.invalid'),
 (9,2,'Foreign',NULL,'Tenant',0,NULL,'FOREIGN-ID','foreign@example.invalid');
 INSERT INTO leasing_additional_tenant VALUES(100,2),(100,1),(100,9);
 INSERT INTO signature_party VALUES(1,'Historical signer');
 `);
 const migration=fs.readFileSync(path.join(__dirname,'../migrations-org/088_joint_tenant_templates.sql'),'utf8');
 await pool.query(migration);await pool.query(migration);
 const [[old]]=await pool.query('SELECT * FROM signature_party');
 assert.equal(old.signer_name,'Historical signer');assert.equal(old.tenant_id,null);
 await assert.rejects(()=>loadLeaseTenants(pool,'2','100'),e=>e.status===404);
 let tenants=await loadLeaseTenants(pool,'1','100');
 assert.deepEqual(tenants.map(t=>t.id),['1','2','9']);
 assert.deepEqual(tenants.map(t=>t.display_name),['Alice Mei Wong','Bob Chan','']);
 assert.equal(JSON.stringify(tenants).includes('FOREIGN-ID'),false);
 assert.throws(()=>validateSigners(tenants,tenants.map(t=>({tenant_id:t.id,signer_name:t.display_name,signer_email:t.email,role:'tenant'}))));
 await pool.execute('DELETE FROM leasing_additional_tenant WHERE leasing_id=100 AND tenant_id=9');
 tenants=await loadLeaseTenants(pool,'1','100');assert.equal(tenants.length,2);
 await pool.execute(`INSERT INTO lease_template(id,org_id,name,body_html,page_size,is_default,status,version) VALUES(1,1,'Fixture',?,'A4',0,1,3)`,[fixture.body_html]);
 await pool.execute(`INSERT INTO lease_template(id,org_id,name,body_html,page_size,is_default,status,version) VALUES(2,2,'Foreign','Foreign body','A4',0,1,1)`);
 const stub=(rel,exports)=>{const id=require.resolve(rel);require.cache[id]={id,filename:id,loaded:true,exports};};
 stub('../src/middleware/auth',{authenticate:(req,res,next)=>{req.user={orgId:'1',id:'7'};req.pool=pool;next();}});
 stub('../src/utils/activityLog',{logActivity:async()=>{}});
 delete require.cache[require.resolve('../src/routes/leaseTemplate')];
 const app=express();app.use(express.json({limit:'1mb'}));app.use('/api/lease-template',require('../src/routes/leaseTemplate'));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.on('listening',r));
 t.after(()=>new Promise(r=>server.close(r)));
 const call=async(method,route,body)=>{
  const r=await fetch(`http://127.0.0.1:${server.address().port}/api/lease-template${route}`,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:r.status,body:await r.json()};
 };
 const preview=await call('POST','/tenant-upgrade',{body_html:fixture.body_html});assert.equal(preview.status,200);
 let [[current]]=await pool.query('SELECT * FROM lease_template WHERE id=1');
 assert.equal(current.version,3);assert.equal(current.tenant_layout,null);assert.equal(current.body_html,fixture.body_html);
 const candidate={...preview.body.data,expected_version:3};
 assert.equal((await call('PUT','/2',candidate)).status,404);
 assert.equal((await call('PUT','/1',candidate)).status,200);
 [[current]]=await pool.query('SELECT * FROM lease_template WHERE id=1');
 assert.equal(current.version,4);assert.match(current.body_html,/TENANT_PARTIES/);
 assert.deepEqual(current.tenant_layout,candidate.tenant_layout);
 const [[history]]=await pool.query('SELECT * FROM lease_template_revision WHERE template_id=1 AND version=3');
 assert.equal(history.body_html,fixture.body_html);assert.equal(history.tenant_layout,null);
 assert.equal((await call('PUT','/1',candidate)).status,409);
 const [[count]]=await pool.query('SELECT COUNT(*) AS n FROM lease_template_revision WHERE template_id=1');assert.equal(Number(count.n),1);
 assert.equal((await call('PUT','/1',{expected_version:4,description:'Edited description'})).status,200);
 const [[snap]]=await pool.query('SELECT * FROM lease_template_revision WHERE template_id=1 AND version=4');
 assert.deepEqual(snap.tenant_layout,candidate.tenant_layout);
 const duplicate=await call('POST','/1/duplicate',{});assert.equal(duplicate.status,200);
 const [[copy]]=await pool.execute('SELECT * FROM lease_template WHERE id=?',[duplicate.body.data.id]);
 assert.deepEqual(copy.tenant_layout,candidate.tenant_layout);assert.equal(copy.version,1);
 const [[copySnapshot]]=await pool.execute('SELECT * FROM lease_template_revision WHERE template_id=?',[copy.id]);
 assert.deepEqual(copySnapshot.tenant_layout,candidate.tenant_layout);
 const [[foreign]]=await pool.query('SELECT * FROM lease_template WHERE id=2');assert.equal(foreign.body_html,'Foreign body');
 });
