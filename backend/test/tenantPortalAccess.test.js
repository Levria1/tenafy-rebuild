const test = require('node:test');
const assert = require('node:assert');
const {
  resolveTenantIds,
  loadActiveAccount,
  isEligibleToRegister,
  currentLeaseUnits,
} = require('../src/utils/tenantPortalAccess');

// A fake pool records the SQL it is handed. Returning rows is not enough: a stub that
// answers any query would keep passing after the WHERE clause lost a predicate, which is
// precisely how a missing `status = 1` or `deleted_at IS NULL` reaches production. So the
// tests below assert on the SQL as well as on the result.
function poolReturning(handlers) {
  const calls = [];
  return {
    calls,
    execute: async (sql, params) => {
      calls.push({ sql, params });
      for (const [pattern, rows] of handlers) if (pattern.test(sql)) return [rows];
      throw new Error('unexpected SQL: ' + sql.slice(0, 80));
    },
  };
}

// ── resolveTenantIds ────────────────────────────────────────────────────────

test('one email spanning several tenant rows returns all of them', async () => {
  // Eiji Tsuchizawa has 4 rows in production because re-leasing creates a new one.
  const pool = poolReturning([[/FROM tenant/, [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }]]]);
  assert.deepEqual(await resolveTenantIds(pool, '830', 'e@t.com'), ['1', '2', '3', '4']);
});

test('ids come back as strings, since they are Snowflake bigints', async () => {
  const pool = poolReturning([[/FROM tenant/, [{ id: '1786501447565576536' }]]]);
  assert.deepEqual(await resolveTenantIds(pool, '830', 'e@t.com'), ['1786501447565576536']);
});

test('resolveTenantIds scopes by org, matches email case-insensitively, and skips deleted rows', async () => {
  const pool = poolReturning([[/FROM tenant/, [{ id: 1 }]]]);
  await resolveTenantIds(pool, '830', 'MiXeD@Case.COM');
  const { sql, params } = pool.calls[0];
  assert.match(sql, /t\.org_id = \?/);
  assert.match(sql, /LOWER\(t\.email\) = LOWER\(\?\)/);
  // A soft-deleted tenant is usually a merge or a mistake; its history must stop being
  // reachable the moment staff remove it, not when the token expires.
  assert.match(sql, /t\.deleted_at IS NULL/);
  assert.deepEqual(params, ['830', 'MiXeD@Case.COM']);
  // The read rule ("has held a lease") is re-applied on every request, not just at
  // registration: a tenant whose only lease is later deleted must lose access.
  assert.match(sql, /FROM leasing l/);
  assert.match(sql, /leasing_additional_tenant/);
});

test('a blank identity never reaches the database', async () => {
  const pool = poolReturning([]);
  assert.deepEqual(await resolveTenantIds(pool, '830', ''), []);
  assert.deepEqual(await resolveTenantIds(pool, '', 'a@b.com'), []);
  assert.deepEqual(await resolveTenantIds(null, '830', 'a@b.com'), []);
  assert.equal(pool.calls.length, 0);
});

// ── loadActiveAccount: the kill switch ──────────────────────────────────────

test('an active account loads, carrying its session generation', async () => {
  const pool = poolReturning([[/tenant_portal_account/, [{ id: 7, status: 1, token_version: 4 }]]]);
  assert.deepEqual(await loadActiveAccount(pool, '830', 'a@b.com'),
    { id: '7', status: 1, tokenVersion: 4 });
});

test('a missing session generation reads as 0 rather than NaN', async () => {
  // A NaN here would never equal the token's v and would lock everyone out.
  const pool = poolReturning([[/tenant_portal_account/, [{ id: 7, status: 1, token_version: null }]]]);
  assert.equal((await loadActiveAccount(pool, '830', 'a@b.com')).tokenVersion, 0);
});

test('a disabled account is refused even with a validly signed token', async () => {
  // Status 2 is the staff kill switch. If this were only checked at login, disabling a
  // compromised account would not end the session actually being abused.
  const pool = poolReturning([[/tenant_portal_account/, [{ id: 7, status: 2 }]]]);
  assert.equal(await loadActiveAccount(pool, '830', 'a@b.com'), null);
});

test('an unverified account cannot be used', async () => {
  const pool = poolReturning([[/tenant_portal_account/, [{ id: 7, status: 0 }]]]);
  assert.equal(await loadActiveAccount(pool, '830', 'a@b.com'), null);
});

test('a missing account returns null rather than throwing', async () => {
  const pool = poolReturning([[/tenant_portal_account/, []]]);
  assert.equal(await loadActiveAccount(pool, '830', 'a@b.com'), null);
});

// ── isEligibleToRegister ────────────────────────────────────────────────────

test('a tenant who has held a lease may register', async () => {
  const pool = poolReturning([[/EXISTS/, [{ ok: 1 }]]]);
  assert.equal(await isEligibleToRegister(pool, '830', 'a@b.com'), true);
});

test('a prospect who never leased may not register', async () => {
  // ~125 of these exist: chatbot enquiries with an email and no lease.
  const pool = poolReturning([[/EXISTS/, [{ ok: 0 }]]]);
  assert.equal(await isEligibleToRegister(pool, '830', 'a@b.com'), false);
});

test('eligibility counts additional tenants and ignores lease dates', async () => {
  const pool = poolReturning([[/EXISTS/, [{ ok: 1 }]]]);
  await isEligibleToRegister(pool, '830', 'a@b.com');
  const sql = pool.calls[0].sql;
  assert.match(sql, /leasing_additional_tenant/, 'a spouse or flatmate has held a lease too');
  assert.match(sql, /t\.deleted_at IS NULL/);
  assert.match(sql, /l\.deleted_at IS NULL/);
  assert.ok(!/start_date/.test(sql) && !/end_date/.test(sql),
    'read access is "has leased ever", so it must not filter on lease dates');
  assert.ok(!/l\.status/.test(sql),
    'an archived lease still qualifies its holder for read access');
});

// ── currentLeaseUnits: the write rule ───────────────────────────────────────

test('a live lease yields a unit a repair can be raised against', async () => {
  const pool = poolReturning([[/FROM leasing/, [
    { lease_id: 9, unit_id: 5, unit_name: '3D', property_id: 2, property_name: 'Fuk Lo Tsun' },
  ]]]);
  const units = await currentLeaseUnits(pool, '830', ['1'], '2026-09-03');
  assert.equal(units.length, 1);
  assert.equal(units[0].unit_id, '5');
});

test('the write rule requires an ACTIVE lease, not merely one whose dates span today', async () => {
  // Not redundant with the date window. Production holds 1,803 leases at status 0, and 3
  // of them are live by date. Filtering on dates alone hands those three a write path.
  const pool = poolReturning([[/FROM leasing/, []]]);
  await currentLeaseUnits(pool, '830', ['1'], '2026-09-03');
  const sql = pool.calls[0].sql;
  assert.match(sql, /l\.status = 1/);
  assert.match(sql, /l\.start_date <= \?/);
  assert.match(sql, /l\.end_date IS NULL OR l\.end_date >= \?/);
  assert.match(sql, /l\.deleted_at IS NULL/);
  assert.match(sql, /p\.deleted_at IS NULL/);
});

test('an additional tenant on a current lease may raise a repair', async () => {
  const pool = poolReturning([[/FROM leasing/, []]]);
  await currentLeaseUnits(pool, '830', ['1'], '2026-09-03');
  assert.match(pool.calls[0].sql, /leasing_additional_tenant/);
});

test('a past tenant gets no units, so cannot raise a repair', async () => {
  const pool = poolReturning([[/FROM leasing/, []]]);
  assert.deepEqual(await currentLeaseUnits(pool, '830', ['1'], '2026-09-03'), []);
});

test('a tenant with no ids never reaches the database', async () => {
  const pool = poolReturning([]);
  assert.deepEqual(await currentLeaseUnits(pool, '830', [], '2026-09-03'), []);
  assert.equal(pool.calls.length, 0);
});

test('every tenant id is bound as a parameter, twice, for both membership paths', async () => {
  const pool = poolReturning([[/FROM leasing/, []]]);
  await currentLeaseUnits(pool, '830', ['11', '22'], '2026-09-03');
  const { sql, params } = pool.calls[0];
  assert.ok(!/IN \(11/.test(sql), 'ids must never be interpolated into the SQL');
  // org, then ids for the named-tenant test, then ids again for the additional-tenant
  // subquery, then the two date bounds.
  assert.deepEqual(params, ['830', '11', '22', '11', '22', '2026-09-03', '2026-09-03']);
});

test('the org is always part of the lease lookup', async () => {
  // Without this a tenant id from another org would resolve units here.
  const pool = poolReturning([[/FROM leasing/, []]]);
  await currentLeaseUnits(pool, '830', ['1'], '2026-09-03');
  assert.match(pool.calls[0].sql, /p\.org_id = \?/);
});

// ── findings from the external review (codex + grok), pinned ────────────────

test('a payee row sharing the email is NOT folded into the tenant identity', async () => {
  // category 2 = payee: someone the business PAYS (owner, vendor). Their invoices are
  // not a tenant's to read, so the row must be excluded even on a matching email.
  const pool = poolReturning([[/FROM tenant/, [{ id: 1 }]]]);
  await resolveTenantIds(pool, '830', 'a@b.com');
  assert.match(pool.calls[0].sql, /t\.category IS NULL OR t\.category = 1/);
});

test('registration eligibility also excludes payee rows', async () => {
  const pool = poolReturning([[/EXISTS/, [{ ok: 1 }]]]);
  await isEligibleToRegister(pool, '830', 'a@b.com');
  assert.match(pool.calls[0].sql, /t\.category IS NULL OR t\.category = 1/);
});

test('today defaults to the org clock rather than a caller-supplied date', async () => {
  // A route must never be able to pass a request value here: a departed tenant supplying
  // a date inside their old tenancy would get back a unit someone else now occupies.
  const pool = poolReturning([[/FROM leasing/, []]]);
  await currentLeaseUnits(pool, '830', ['1']);      // no date argument at all
  const { params } = pool.calls[0];
  const supplied = params.slice(-2);
  assert.equal(supplied[0], supplied[1], 'both date bounds use the same day');
  assert.match(supplied[0], /^\d{4}-\d{2}-\d{2}$/, 'and it is a real YYYY-MM-DD from the clock');
});
