/**
 * Which actions leave a record of who did them.
 *
 * Written after a real question could not be answered. A tenant received check-in
 * instructions for a lease nobody meant to activate, and establishing what happened meant
 * reading web-server logs and inferring cause from email timestamps — because confirming
 * a lease, the single action that flips a tenancy live and emails the tenant, wrote
 * nothing at all. 890 lease audit rows existed and not one was a confirmation.
 *
 * This does not demand logging everywhere. It pins the actions where "who did this"
 * is the first question someone will ask.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROUTES = path.join(__dirname, '../src/routes');
const read = (f) => fs.readFileSync(path.join(ROUTES, f), 'utf8');

// Slice one route handler out of a file.
function handler(file, marker) {
  const src = read(file);
  const at = src.indexOf(marker);
  assert.ok(at > -1, `${file} no longer has ${marker}`);
  const next = src.indexOf('\nrouter.', at + 10);
  return src.slice(at, next === -1 ? undefined : next);
}

// Every one of these changes a tenancy, moves money, decides who can get in, or sends
// something a person receives.
const MUST_LOG = [
  ['leasing.js',   "router.post('/:id/confirm'",              'confirming a lease'],
  ['leasing.js',   "router.post('/:id/move-out'",             'moving a tenant out'],
  ['leasing.js',   "router.put('/:id/settlement-notes'",      'editing settlement notes'],
  ['leasing.js',   "router.delete('/:id'",                    'deleting a lease'],
  ['invoice.js',   "router.post('/publish'",                  'publishing an invoice'],
  ['invoice.js',   "router.post('/write-off-bulk'",           'writing off invoices in bulk'],
  ['invoice.js',   "router.post('/:id/write-off'",            'writing off an invoice'],
  ['invoice.js',   "router.post('/:id/email-to-tenant'",      'emailing a tenant about money'],
  ['user.js',      "router.post('/'",                         'creating a staff user'],
  ['user.js',      "router.put('/:id'",                       'editing a staff user'],
  ['user.js',      "router.delete('/:id'",                    'deleting a staff user'],
  ['role.js',      "router.post('/'",                         'creating a role'],
  ['role.js',      "router.put('/:id'",                       'editing a role'],
  ['role.js',      "router.delete('/:id'",                    'deleting a role'],
  ['tenant.js',    "router.post('/:id/portal-invite'",       'inviting a tenant to the portal'],
  ['contact.js',   "router.post('/property-owner/create/user'", 'creating a user row for an owner'],
  ['signature.js', "router.post('/request/:id/cancel'",       'cancelling a signature request'],
  ['signature.js', "router.post('/request/:id/resend'",       'resending a signature request'],
];

for (const [file, marker, what] of MUST_LOG) {
  test(`${what} is recorded`, () => {
    assert.match(handler(file, marker), /logActivity\(req,/,
      `${file} ${marker} changes something important and leaves no trace of who did it`);
  });
}

test('the check-in email paths are both recorded', () => {
  // The manual button and the confirm endpoint were the two ways a tenant could receive
  // check-in instructions, and neither wrote anything.
  const leasing = read('leasing.js');
  assert.match(leasing, /logActivity\(req, 'EMAIL', 'lease'/);
  assert.match(leasing, /logActivity\(req, 'CONFIRM', 'lease'/);
});

test('every logged action interpolates only variables that exist', () => {
  // A logActivity call naming an undefined variable throws at runtime, on the success
  // path, AFTER the work is done. node --check cannot see it and the first draft of this
  // change had four.
  const routeStart = /router\.(get|post|put|patch|delete)\(/gi;
  const problems = [];
  for (const file of fs.readdirSync(ROUTES).filter(f => f.endsWith('.js'))) {
    const src = read(file);
    const starts = [...src.matchAll(routeStart)].map(m => m.index);
    for (const m of src.matchAll(/logActivity\(req,[^;]*?\);/gs)) {
      const before = starts.filter(p => p < m.index);
      const after = starts.filter(p => p > m.index);
      const body = src.slice(before.length ? before[before.length - 1] : 0,
                             after.length ? after[0] : src.length);
      for (const v of new Set([...m[0].matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)/g)].map(x => x[1]))) {
        if (v === 'req' || v === 'String') continue;
        const declared = new RegExp(`\\b(const|let|var)\\s+[^;\\n]*\\b${v}\\b|\\{[^}]*\\b${v}\\b[^}]*\\}\\s*=`);
        if (!declared.test(body)) {
          problems.push(`${file}:${src.slice(0, m.index).split('\n').length}  \${${v}}`);
        }
      }
    }
  }
  assert.deepEqual(problems, [], 'audit logging references variables that are not in scope:\n  ' + problems.join('\n  '));
});
