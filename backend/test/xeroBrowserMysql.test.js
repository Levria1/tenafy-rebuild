const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const mysql = require('mysql2/promise');
const { searchStoredHistory, resolveHistoryScope } = require('../src/services/switchboardHistorySearch');
const { validateStatement, lookup } = require('../src/services/xeroBrowserLookup');
const socket = process.env.STAMP_TEST_SOCKET;
const ACCOUNT = '12345678-abcd-1234-abcd-123456789abc';
const TENANT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

test('scratch MySQL: migration twice and lookup excludes other orgs, banks, currencies and paid invoices',
  { skip: !socket, timeout: 60000 }, async t => {
    assert.match(socket, /^\/tmp\/tenafy-(?:pr18-mysql|stamp-[a-z0-9-]+)\/mysql\.sock$/);
    const admin = await mysql.createConnection({ socketPath: socket, user: 'root', multipleStatements: true });
    const db = 'browser_test_' + crypto.randomBytes(6).toString('hex');
    await admin.query(`CREATE DATABASE ${db}`);
    const pool = mysql.createPool({ socketPath: socket, user: 'root', database: db, multipleStatements: true,
      supportBigNumbers: true, bigNumberStrings: true, connectionLimit: 4 });
    t.after(async () => { await pool.end(); await admin.query(`DROP DATABASE ${db}`); await admin.end(); });
    const migration = fs.readFileSync(path.join(__dirname, '../migrations-org/089_xero_browser_binding.sql'), 'utf8');
    await pool.query(migration); await pool.query(migration);
    await pool.query(`
      CREATE TABLE xero_connection(org_id BIGINT PRIMARY KEY,xero_tenant_id VARCHAR(64));
      CREATE TABLE xero_account_map(id BIGINT PRIMARY KEY,org_id BIGINT,xero_account_id VARCHAR(64),tenafy_account_setting_id BIGINT,bank_account_id BIGINT,ignored INT);
      CREATE TABLE bank_account(id BIGINT PRIMARY KEY,org_id BIGINT,currency VARCHAR(8),status INT,deleted_at DATETIME NULL);
      CREATE TABLE account_setting(id BIGINT PRIMARY KEY,org_id BIGINT,enabled BIT(1));
      CREATE TABLE currency(id BIGINT PRIMARY KEY,org_id BIGINT,detail JSON);
      CREATE TABLE property(id BIGINT PRIMARY KEY,org_id BIGINT,bank_account_id BIGINT,display_name VARCHAR(100),deleted_at DATETIME NULL);
      CREATE TABLE unit(id BIGINT PRIMARY KEY,property_id BIGINT,name VARCHAR(100));
      CREATE TABLE tenant(id BIGINT PRIMARY KEY,org_id BIGINT,first_name VARCHAR(100),middle_name VARCHAR(100),last_name VARCHAR(100),company_name VARCHAR(100),type INT,deleted_at DATETIME NULL);
      CREATE TABLE category_setting(id BIGINT PRIMARY KEY,org_id BIGINT,name VARCHAR(100));
      CREATE TABLE invoice(id BIGINT PRIMARY KEY,org_id BIGINT,property_id BIGINT,unit_id BIGINT,tenant_id BIGINT,category BIGINT,currency_id BIGINT,type INT,invoice_code VARCHAR(100),amount DECIMAL(15,2),due_on DATE,status INT,deleted_at DATETIME NULL);
      CREATE TABLE leasing(id BIGINT PRIMARY KEY,unit_id BIGINT,tenant_id BIGINT,currency_id BIGINT,lease_no VARCHAR(100),amount DECIMAL(15,2),price DECIMAL(15,2),deposit DECIMAL(15,2),start_date DATE,deleted_at DATETIME NULL);
      CREATE TABLE accounting(id BIGINT PRIMARY KEY,org_id BIGINT,property_id BIGINT,tenant_id BIGINT,category BIGINT,account_setting_id BIGINT,currency_id BIGINT,type INT,xero_transaction_id VARCHAR(64),transaction_code VARCHAR(100),note TEXT,payment_date DATE,amount DECIMAL(15,2),deleted_at DATETIME NULL,currency_type VARCHAR(8));
      CREATE TABLE accounting_line(id BIGINT PRIMARY KEY,accounting_id BIGINT,invoice_code VARCHAR(100),amount DECIMAL(15,2),deleted_at DATETIME NULL);
      CREATE TABLE inquiry(id BIGINT PRIMARY KEY,org_id BIGINT);
      CREATE TABLE chat_session(id BIGINT PRIMARY KEY,contact_id BIGINT,channel VARCHAR(20),inquiry_id BIGINT NULL,channel_user_id VARCHAR(100),viewer_name VARCHAR(100),viewer_phone VARCHAR(100),viewer_email VARCHAR(100));
      CREATE TABLE chat_message(id BIGINT PRIMARY KEY,session_id BIGINT,content TEXT,role VARCHAR(20),created_at DATETIME);
      INSERT INTO bank_account VALUES(10,1,'HKD',1,NULL),(11,1,'HKD',1,NULL),(12,2,'HKD',1,NULL);
      INSERT INTO account_setting VALUES(20,1,b'1');
      INSERT INTO currency VALUES(30,1,'{"HKD":7.8,"USD":1}'),(31,1,'{"code":"USD"}'),(32,2,'{"code":"HKD"}');
      INSERT INTO property VALUES(40,1,10,'Selected bank',NULL),(41,1,11,'Other bank',NULL),(42,2,12,'Foreign org',NULL);
      INSERT INTO unit VALUES(50,40,'A'),(51,41,'B'),(52,42,'C');
      INSERT INTO tenant VALUES(60,1,'Sample','Mei','Tenant',NULL,0,NULL),(61,1,'Other',NULL,'Bank',NULL,0,NULL),(62,2,'Foreign',NULL,'Person',NULL,0,NULL);
      INSERT INTO category_setting VALUES(70,1,'Rent');
      INSERT INTO invoice VALUES
        (100,1,40,50,60,70,30,0,'GOOD',13800,'2026-11-19',0,NULL),
        (101,1,41,51,61,70,30,0,'OTHERBANK',13800,'2026-11-19',0,NULL),
        (102,2,42,52,62,70,32,0,'FOREIGN',13800,'2026-11-19',0,NULL),
        (103,1,40,50,60,70,31,0,'USD',13800,'2026-11-19',0,NULL),
        (104,1,40,50,60,70,30,0,'PARTPAID',13800,'2026-11-19',0,NULL),
        (105,1,40,50,60,70,30,0,'DELETED',13800,'2026-11-19',0,NOW()),
        (106,1,40,50,60,70,30,1,'SPENT',13800,'2026-11-19',0,NULL),
        (107,1,40,50,60,70,30,0,'FOREIGN-ALLOCATION',13800,'2026-11-19',0,NULL),
        (108,1,40,50,60,70,30,0,'UNKNOWN-ALLOCATION',13800,'2026-11-19',0,NULL);
      INSERT INTO leasing VALUES
        (200,50,60,30,'GOODLEASE',13800,13800,27600,'2026-11-01',NULL),
        (201,51,61,30,'OTHERBANK',13800,13800,27600,'2026-11-01',NULL),
        (202,52,62,32,'FOREIGNLEASE',13800,13800,27600,'2026-11-01',NULL),
        (203,50,60,31,'USDLEASE',13800,13800,27600,'2026-11-01',NULL);
      INSERT INTO accounting VALUES
        (300,1,40,60,70,20,30,0,'known-xero-id','GOODPAYMENT','Sample note','2026-11-18',13800,NULL,'HKD'),
        (301,1,41,61,70,20,30,0,'other-bank','OTHERBANK',NULL,'2026-11-18',13800,NULL,'HKD'),
        (302,2,42,62,70,20,32,0,'foreign','FOREIGN',NULL,'2026-11-18',13800,NULL,'HKD'),
        (303,1,40,60,70,20,31,0,'usd','USD',NULL,'2026-11-18',13800,NULL,'USD'),
        (304,1,40,60,70,20,30,0,NULL,'PARTPAYMENT',NULL,'2026-11-18',100,NULL,'HKD'),
        (305,1,40,60,70,20,30,0,'same-ratecard-usd','USD SHARED RATE CARD',NULL,'2026-11-18',13800,NULL,'USD'),
        (306,1,40,60,70,20,30,0,'unknown-type','UNCONFIRMED CURRENCY',NULL,'2026-11-18',13800,NULL,NULL);
      INSERT INTO accounting_line VALUES(400,304,'PARTPAID',100,NULL),
        (401,305,'FOREIGN-ALLOCATION',-100,NULL),(402,306,'UNKNOWN-ALLOCATION',-100,NULL);
      INSERT INTO chat_session(id,contact_id,channel) VALUES(500,60,'whatsapp'),(501,61,'whatsapp'),(502,62,'email'),(503,60,'staff-internal');
      INSERT INTO chat_message VALUES
        (600,500,'Transferred HK$13,800.00 today','user','2026-11-19 10:00:00'),
        (601,501,'Other bank 13800','user','2026-11-19 10:00:00'),
        (602,502,'Foreign 13800','user','2026-11-19 10:00:00'),
        (603,503,'Internal 13800','user','2026-11-19 10:00:00');
    `);
    await pool.execute('INSERT INTO xero_connection VALUES(?,?)', ['1', TENANT]);
    await pool.execute('INSERT INTO xero_account_map VALUES(1,1,?,20,10,0)', [ACCOUNT]);
    await pool.execute('INSERT INTO xero_browser_binding(org_id,ui_org_slug,xero_tenant_id,updated_by) VALUES(1,?,?,99)', ['verified-org', TENANT]);
    const body = { ui_org_slug: 'verified-org', xero_account_id: ACCOUNT.toUpperCase(), org_id: '2',
      statement: { id_suffix: '1'.repeat(32), date: '2026-11-19', amount_minor: 1380000, currency: 'HKD', direction: 'received' } };
    await assert.rejects(lookup(pool, '1', body), e => e.status === 409);
    // A list of exchange rates is not proof of the amounts' denomination.
    await pool.execute('INSERT INTO xero_browser_currency_binding(org_id,currency_id,currency_code,updated_by) VALUES(1,30,?,99)', ['HKD']);
    const result = await lookup(pool, '1', body);
    assert.deepEqual(result.source_status, { invoices: 'ok', leases: 'ok', accounting: 'ok' });
    assert.deepEqual(result.candidates.map(c => c.id).sort(), ['100', '200', '300']);
    assert.equal(result.candidates[0].tenant_name, 'Sample Mei Tenant');
    assert.equal(result.candidates.find(c => c.id === '300').review_path, 'find_and_match_review');
    assert.deepEqual(result.evidence.hits.map(h => h.message_id).sort(), ['600', '601']);
    assert.equal(result.evidence.unavailable, undefined);
    assert.equal(result.ambiguity, true);
    assert.equal(result.capabilities.live_autofill, false);
    const spent = await lookup(pool, '1', { ...body, statement: { ...body.statement, direction: 'spent' } });
    assert.deepEqual(spent.candidates.map(c => c.id), ['106']);
    // Wider history includes same-org inquiry contacts, old text, long messages,
    // outbound staff replies and proven unlinked conversations; never foreign anchors.
    await pool.query(`INSERT INTO inquiry VALUES(700,1),(701,2);
      INSERT INTO chat_session(id,contact_id,channel,inquiry_id,viewer_name) VALUES
        (504,NULL,'whatsapp',700,'Prospect'),(505,NULL,'email',NULL,'Vendor'),
        (506,NULL,'whatsapp',701,'Foreign inquiry'),(507,60,'whatsapp',701,'Conflicting links');
      INSERT INTO chat_message VALUES
        (610,504,'previous context','user','2026-06-01 09:00:00'),
        (611,504,'paid 13.8k','assistant','2026-06-01 10:00:00'),
        (612,504,'next context','user','2026-06-01 11:00:00'),
        (613,505,'vendor 13 800.00','user','2026-11-19 12:00:00'),
        (614,506,'foreign inquiry 13800','user','2026-11-19 12:00:00'),
        (615,507,'conflict 13800','user','2026-11-19 12:00:00'),
        (616,504,'113800 138000 13800.01 13800xxxx','user','2026-11-19 12:00:00'),
        (617,504,'13800 system only','system','2026-11-19 12:00:00'),
        (618,504,'reference PAY-ABC-123456 only','user','2026-11-19 12:00:00');`);
    await pool.execute('INSERT INTO chat_message VALUES(619,504,?,?,?)', ['x'.repeat(5000)+' paid HKD13800 today','user','2026-11-19 13:00:00']);
    const statement = validateStatement(body.statement), mapping = { bank_account_id: '10', currency_id: '30' };
    const dedicated = { allowUnlinked: true, verification: 'dedicated_org_database' };
    const history = await searchStoredHistory(pool, '1', mapping, statement, { scope: dedicated });
    assert.deepEqual(history.hits.map(h => h.message_id).sort(), ['600','601','611','613','619']);
    assert.equal(history.coverage.messages, 9);
    assert.equal(history.coverage.date_window, null);
    const old = history.hits.find(h => h.message_id === '611');
    assert.equal(old.contact.inquiry_id, '700'); assert.equal(old.role, 'assistant');
    assert.deepEqual(old.context.map(c => c.message_id), ['610','612']);
    assert.match(history.hits.find(h => h.message_id === '619').snippet, /HKD13800/);
    const restricted = await searchStoredHistory(pool, '1', mapping, statement);
    assert.ok(!restricted.hits.some(h => h.message_id === '613'));
    const ref = await searchStoredHistory(pool, '1', mapping, {...statement, reference: 'PAYABC123456'}, {scope: dedicated});
    assert.deepEqual(ref.hits.find(h => h.message_id === '618').reasons, ['reference mentioned']);
    // Reference/amount spellings use the actual MySQL ICU engine, not JS approximations.
    const {amountPattern} = require('../src/services/switchboardHistorySearch');
    for (const [text, expected] of [['HK$13,800.00',1],['13800',1],['13.800k',1],['13\u00a0800',1],['HKD13800',1],
      ['13800.0',1],['113800',0],['13800.01',0],['13800xxxx',0],['x13800',0],['13,8000',0]]) {
      const [[matched]] = await pool.execute("SELECT REGEXP_LIKE(?,?,'i') AS n", [text,amountPattern(statement)]);
      assert.equal(Number(matched.n), expected, text);
    }
    for (let i=0;i<14;i++) await pool.execute('INSERT INTO chat_message VALUES(?,504,?,?,?)', [800+i,'paid 13800','user','2026-11-19 00:00:00']);
    let cursor, seen = [], pages = 0;
    do {
      const page = await searchStoredHistory(pool,'1',mapping,statement,{scope:dedicated,cursor});
      seen.push(...page.hits.map(h=>h.message_id)); cursor=page.next_cursor; pages++;
    } while(cursor && pages<5);
    assert.equal(pages,2); assert.equal(seen.length,19); assert.equal(new Set(seen).size,19);
    assert.equal(cursor,null);
    const first = await searchStoredHistory(pool,'1',mapping,statement,{scope:dedicated});
    await assert.rejects(searchStoredHistory(pool,'2',mapping,statement,{cursor:first.next_cursor}), e=>e.status===400);
    await assert.rejects(searchStoredHistory(pool,'1',mapping,{...statement,amount_minor:100},{cursor:first.next_cursor}), e=>e.status===400);
    // Registry proof is evaluated against the actual selected database.
    const master = {execute:async sql=>sql.includes('status=1') ? [[{id:'1',db_name:db}]] : [[{id:'1'}]]};
    assert.equal((await resolveHistoryScope(pool,'1',master)).allowUnlinked,false,'foreign anchors disable unlinked inclusion');
    await pool.query('DELETE FROM chat_session WHERE id IN (502,506,507)');
    assert.equal((await resolveHistoryScope(pool,'1',master)).allowUnlinked,true);
    const [[counts]] = await pool.query('SELECT (SELECT COUNT(*) FROM accounting) AS payments,(SELECT COUNT(*) FROM invoice) AS invoices');
    assert.equal(Number(counts.payments),7); assert.equal(Number(counts.invoices),9);
  });
