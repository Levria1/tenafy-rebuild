/**
 * Withdrawing a request, and adding to one.
 *
 * Deliberately no edit endpoint. Once a vendor is booked against a description, letting
 * a tenant rewrite it sends them to a job that no longer exists, with nothing in the
 * record showing it changed. See migrations-org/079.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '').replace(/^\s*\/\/.*$/gm, '');

const ROUTES = stripComments(read('../src/routes/tenantPortal.js'));
const PAGE = stripComments(read('../../frontend/src/app/tenant-portal/repairs/page.js'));
const MIGRATION = read('../migrations-org/079_tenant_service_followups.sql');

const handler = (name) => {
  const start = ROUTES.indexOf(`router.post('/service/:id/${name}'`);
  assert.ok(start > -1, `the ${name} route is missing`);
  const rest = ROUTES.slice(start + 10);
  const end = rest.search(/\nrouter\.(get|post|put|delete)\(/);
  return rest.slice(0, end === -1 ? undefined : end);
};

// ── append, never overwrite ─────────────────────────────────────────────────

test('there is no endpoint that rewrites a submitted request', () => {
  // The whole design rests on this. An edit route appearing later would quietly undo it.
  assert.ok(!/router\.(put|patch)\('\/service/.test(ROUTES),
    'a route now edits a submitted repair request in place');
});

test('a follow-up is inserted, never merged into the description', () => {
  const code = handler('note');
  assert.match(code, /INSERT INTO service_activity/);
  assert.ok(!/UPDATE service SET[\s\S]{0,200}additional_info/.test(code),
    'the follow-up is being written into the original description');
});

// ── ownership and status ────────────────────────────────────────────────────

for (const name of ['note', 'cancel']) {
  test(`${name} resolves the request through the tenant's own ids`, () => {
    assert.match(handler(name), /loadOwnRequest\(req, req\.params\.id\)/);
  });

  test(`${name} answers 404 for anything that is not theirs`, () => {
    // Same answer for missing, deleted and someone else's; anything finer confirms an id.
    assert.match(handler(name), /if \(!request\) return res\.status\(404\)/);
  });
}

test('loadOwnRequest scopes by org, tenant and deleted_at, and rejects non-numeric ids', () => {
  const start = ROUTES.indexOf('async function loadOwnRequest');
  const fn = ROUTES.slice(start, ROUTES.indexOf('const MAX_NOTE_LENGTH'));
  assert.match(fn, /\/\^\\d\+\$\//);
  assert.match(fn, /s\.org_id = \?/);
  assert.match(fn, /s\.reported_by IN \(\$\{idsIn\(req\)\}\)/);
  assert.match(fn, /s\.deleted_at IS NULL/);
});

test('cancelling is refused once the request is past Received', () => {
  // Withdrawing work already scheduled is a conversation, not a button.
  const code = handler('cancel');
  assert.match(code, /Number\(request\.status\) !== 0/);
});

test('cancelling re-checks the status inside the UPDATE', () => {
  // Staff can pick the job up between the SELECT and the UPDATE. affectedRows is the
  // proof that this request won the race; trusting the earlier read would let a tenant
  // withdraw a job somebody had already started.
  const code = handler('cancel');
  assert.match(code, /UPDATE service SET status = 3[\s\S]{0,160}?AND status = 0/);
  assert.match(code, /result\.affectedRows !== 1/);
});

test('a follow-up is refused on a withdrawn request', () => {
  assert.match(handler('note'), /Number\(request\.status\) === 3/);
});

// ── the tenant/staff boundary ───────────────────────────────────────────────

test('tenant-written activity is marked, and carries no staff author', () => {
  // created_by holds a STAFF user id. Writing 0 there would be a lie every LEFT JOIN
  // silently accepts, so 079 makes it nullable and `source` marks the side.
  for (const name of ['note', 'cancel']) {
    const code = handler(name);
    assert.match(code, /NULL, 'tenant'/, `${name} does not mark the row as tenant-written`);
  }
});

test('the portal returns only tenant-written activity', () => {
  // service_activity is the staff timeline: vendor quotes, pricing, assignee chatter.
  const start = ROUTES.indexOf("router.get('/service'");
  const list = ROUTES.slice(start, ROUTES.indexOf("router.post('/service'", start));
  assert.match(list, /sa\.source = 'tenant'/);
  assert.ok(!/sa\.\*/.test(list), 'the portal selects every activity column');
});

// ── staff are told ──────────────────────────────────────────────────────────

test('submitting, updating and withdrawing all raise a notification', () => {
  // Before this, a repair landed in the Pending queue silently.
  const submit = ROUTES.slice(ROUTES.indexOf("router.post('/service'"), ROUTES.indexOf('router.post(\'/service/:id/note\''));
  for (const [label, code] of [['submit', submit], ['note', handler('note')], ['cancel', handler('cancel')]]) {
    assert.match(code, /createNotification\(req\.pool, \{/, `${label} raises no notification`);
  }
});

test('the submission notification is raised after the commit', () => {
  // Inside the transaction, a notification failure would roll back a repair the tenant
  // has already been told was submitted.
  const submit = ROUTES.slice(ROUTES.indexOf("router.post('/service'"), ROUTES.indexOf("router.post('/service/:id/note'"));
  assert.ok(submit.indexOf('await conn.commit()') < submit.indexOf('createNotification'),
    'the notification is raised before the commit');
});

// ── migration ───────────────────────────────────────────────────────────────

test('the migration is guarded and makes created_by nullable', () => {
  assert.match(MIGRATION, /IS_NULLABLE/);
  assert.match(MIGRATION, /MODIFY created_by BIGINT NULL/);
  for (const col of ['source', 'created_by_tenant']) {
    assert.ok(MIGRATION.includes(`COLUMN_NAME = '${col}'`), `${col} is not guarded`);
  }
});

// ── the screen ──────────────────────────────────────────────────────────────

test('the page only offers what the server said is allowed', () => {
  // can_cancel and can_comment are computed server-side so the two cannot disagree.
  assert.match(ROUTES, /can_cancel: Number\(r\.status\) === 0/);
  assert.match(ROUTES, /can_comment: Number\(r\.status\) !== 3/);
  assert.match(PAGE, /r\.can_cancel/);
  assert.match(PAGE, /r\.can_comment/);
});

test('the page tells the tenant their original text is preserved', () => {
  assert.match(PAGE, /never changed/i);
});

test('a rejected withdrawal reloads instead of leaving a stale button', () => {
  const code = PAGE.slice(PAGE.indexOf('const cancelRequest'), PAGE.indexOf('if (loading)'));
  assert.match(code, /catch[\s\S]{0,200}load\(\)/);
});

// ── found by external review, after the first pass shipped ──────────────────

test('the filer is recorded, not the lease\'s named tenant', () => {
  // On a couple's lease the spouse is an additional tenant with their own portal login.
  // Recording the named tenant meant a repair the spouse filed was attributed to their
  // partner: the spouse could not see or withdraw it, the partner could withdraw one they
  // never made, and staff rang the wrong person back.
  const submit = ROUTES.slice(ROUTES.indexOf("router.post('/service'"), ROUTES.indexOf("router.post('/service/:id/note'"));
  assert.match(submit, /reporterId,\s*contactPhone/);
  assert.ok(!/unit\.lease_tenant_id \|\| req\.tenantPortal\.tenantIds\[0\], contactPhone/.test(submit),
    'the lease tenant is still being recorded as the reporter');
});

test('visibility covers every home the tenant holds a lease on', () => {
  // Recording the filer accurately is not enough on its own: both people on a lease
  // should see repairs for their own home, and every request filed BEFORE this change
  // carries the named tenant as reporter.
  assert.match(ROUTES, /async function visibleUnitIds\(req\)/);
  const fn = ROUTES.slice(ROUTES.indexOf('async function visibleUnitIds'), ROUTES.indexOf('async function loadOwnRequest'));
  assert.match(fn, /leaseIsTheirs\(ph\)/, 'additional tenants are excluded from visibility');
  assert.ok(!/l\.status = 1/.test(fn), 'reading is restricted to current leases');

  // All three read paths must agree, or a spouse sees a request they cannot open.
  for (const marker of ['loadOwnRequest', "router.get('/service'", 'photo/:fileId']) {
    const idx = ROUTES.indexOf(marker);
    assert.ok(idx > -1, `${marker} is missing`);
    assert.match(ROUTES.slice(idx, idx + 1600), /s\.unit_id IN \(/, `${marker} does not honour lease-based visibility`);
  }
});

test('cancelling is one transaction', () => {
  // As two autocommit statements a failed INSERT left the request cancelled with nothing
  // explaining why, a 500 for the tenant, and a 409 on their retry.
  const code = handler('cancel');
  assert.match(code, /beginTransaction\(\)/);
  assert.match(code, /await conn\.commit\(\)/);
  assert.match(code, /rollback\(\)/);
});

test('a note cannot land on a request cancelled mid-flight', () => {
  // Checked only on the earlier SELECT, a note submitted while a withdrawal was in flight
  // still landed. The rule now lives in the writing statement.
  const code = handler('note');
  assert.match(code, /INSERT INTO service_activity[\s\S]{0,400}?SELECT \?/);
  assert.match(code, /s\.status <> 3/);
  assert.match(code, /written\.affectedRows !== 1/);
});
