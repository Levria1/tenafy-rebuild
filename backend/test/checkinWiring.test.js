/**
 * The check-in send is wired correctly into the routes.
 *
 * checkinWindow.test.js proves the DECISION is right. It cannot prove the routes
 * ask the question properly, and that gap is where the original bug lived: the
 * create endpoint knew perfectly well the lease was pending and simply never
 * mentioned it. A helper test suite would have stayed green throughout.
 *
 * Exercising the real endpoints needs Express, a MySQL pool and an SMTP stub, so
 * this reads the source instead — the same approach noServerClockDates.test.js
 * takes for the Hong Kong clock, and for the same reason: the realistic regression
 * is a later edit that drops an argument, not someone rewriting the logic.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const LEASING = path.join(__dirname, '..', 'src', 'routes', 'leasing.js');
const SCHEDULER = path.join(__dirname, '..', 'src', 'services', 'scheduler.js');

const read = (p) => fs.readFileSync(p, 'utf8');

// Pull out each `maybeSendCheckin(...)` call with its argument list, by walking
// brackets rather than regex-matching — the object literal argument spans lines
// and contains its own braces.
function callSites(source, name) {
  const out = [];
  const needle = `${name}(`;
  let from = 0;
  for (;;) {
    const start = source.indexOf(needle, from);
    if (start === -1) break;
    from = start + needle.length;
    // Skip the declaration itself — `async function maybeSendCheckin(...)` matches
    // the same needle, and its destructured parameter list looks enough like a call
    // argument to fool a naive check.
    if (/(^|[^\w$.])(async\s+)?function\s+$/.test(source.slice(Math.max(0, start - 24), start))) continue;
    if (/[\w$.]/.test(source[start - 1] || '')) continue;
    let depth = 0;
    for (let i = start + needle.length - 1; i < source.length; i++) {
      const ch = source[i];
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) {
          out.push({
            index: start,
            line: source.slice(0, start).split('\n').length,
            args: source.slice(start + needle.length, i),
          });
          break;
        }
      }
    }
  }
  return out;
}

test('both lease endpoints send check-in through the shared helper', () => {
  const src = read(LEASING);
  // One definition + two call sites. If a third appears, it needs the same audit
  // as these two, so make adding one a deliberate act.
  const defs = (src.match(/async function maybeSendCheckin\s*\(/g) || []).length;
  assert.equal(defs, 1, 'maybeSendCheckin should be defined exactly once');

  const calls = callSites(src, 'maybeSendCheckin');
  assert.equal(calls.length, 2,
    'expected exactly two call sites: lease create and lease confirm');
});

test('every check-in call site states the lease state', () => {
  // The gate fails closed, so a call that omits leaseState sends nothing at all.
  // That is the safe failure, but it is still a silent one — pin it here so the
  // omission is a red test rather than a tenant who never hears from us.
  const src = read(LEASING);
  const calls = callSites(src, 'maybeSendCheckin');
  assert.ok(calls.length >= 2, 'expected at least two call sites');
  // Accepts both `leaseState: x` and the shorthand `leaseState` — the create site
  // uses the shorthand because the local variable is already named for the field.
  const passes = (args, key) => new RegExp(`\\b${key}\\s*[,:}]`).test(args);

  for (const call of calls) {
    assert.ok(passes(call.args, 'leaseState'),
      `maybeSendCheckin at leasing.js:${call.line} must pass leaseState — without it the `
      + 'send is refused and the tenant silently waits for the 07:00 sweep');
    assert.ok(passes(call.args, 'startDate'), `maybeSendCheckin at leasing.js:${call.line} must pass startDate`);
    assert.ok(passes(call.args, 'tenantCheckin'), `maybeSendCheckin at leasing.js:${call.line} must pass tenantCheckin`);
  }
});

test('the create endpoint never claims a pending lease is active', () => {
  // The original bug in one assertion. `leaseState` at that call site is the
  // variable derived from the request body, not a literal — hardcoding 'active'
  // there would mail every unconfirmed tenant.
  const src = read(LEASING);
  const calls = callSites(src, 'maybeSendCheckin');
  const literalActive = calls.filter(c => /leaseState\s*:\s*'active'/.test(c.args));
  assert.equal(literalActive.length, 1,
    "only the confirm endpoint may pass leaseState: 'active' as a literal — it has just "
    + 'written that value to the row; every other caller must pass the real state');
});

test('the confirm endpoint sends check-in after it flips the state, not before', () => {
  // Order matters: called before the UPDATE, the row still reads 'pending' to
  // anything that re-reads it, and the literal 'active' would be a lie rather than
  // a restatement of what was just written.
  const src = read(LEASING);
  const flip = src.indexOf("UPDATE leasing SET lease_state = 'active'");
  assert.ok(flip > -1, 'confirm endpoint should still flip lease_state');
  const call = callSites(src, 'maybeSendCheckin').find(c => /leaseState\s*:\s*'active'/.test(c.args));
  assert.ok(call && call.index > flip,
    'the confirm endpoint must call maybeSendCheckin after the lease_state UPDATE');
});

test('the follow-up logs under its own type, or it can never dedup', () => {
  // Both legs render the SAME Checkin-Tenant template. If the follow-up logged
  // itself as 'Checkin-Tenant' too, its own dedup check could not tell the first
  // email apart from its own — so it would either never send or send every night.
  const svc = read(path.join(__dirname, '..', 'src', 'services', 'emailService.js'));
  assert.match(svc, /const CHECKIN_FOLLOWUP_TYPE = '(?!Checkin-Tenant')/,
    'the follow-up must log under a type distinct from Checkin-Tenant');
  const { CHECKIN_FOLLOWUP_TYPE } = require('../src/services/emailService');
  assert.notEqual(CHECKIN_FOLLOWUP_TYPE, 'Checkin-Tenant');

  // And the sender must actually pass it through, not just declare it.
  const fn = svc.slice(svc.indexOf('async function sendCheckinFollowUpToTenant'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /logType:\s*CHECKIN_FOLLOWUP_TYPE/, 'the follow-up sender must set logType');
  // Either form: a direct template send, or the per-channel sendTenantNotice
  // (WhatsApp ticks, migration 085), which takes the template type positionally.
  assert.match(body, /templateType:\s*'Checkin-Tenant'|sendTenantNotice\(pool, orgId, leaseId, 'Checkin-Tenant'/,
    'the follow-up must still render the Check-In template');
});

test('the follow-up reads the send date on the Hong Kong clock', () => {
  // email_log.sent_at is a TIMESTAMP rendered in the connection's timezone (UTC in
  // production). The 07:00 HK sweep writes rows stamped 23:00 the previous day, so
  // a bare DATE(sent_at) puts the first email a day earlier than it went — which
  // shifts the gap calculation the follow-up depends on.
  const svc = read(path.join(__dirname, '..', 'src', 'services', 'emailService.js'));
  const fn = svc.slice(svc.indexOf('async function lastSentOrgDate'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /orgTimeSql\(/, 'lastSentOrgDate must convert sent_at onto the operator clock');
  assert.doesNotMatch(body, /DATE\(\s*MAX\(sent_at\)\s*\)/, 'raw DATE(sent_at) is a day out overnight');
});

test('the sweep never sends both check-in legs in one run', () => {
  const src = read(SCHEDULER);
  const job = src.slice(src.indexOf('async function sendCheckinEmailsForOrg'));
  const body = job.slice(0, job.indexOf('\n}\n'));
  // Leg one must hand back to the loop rather than falling through into leg two.
  //
  // Anchored between `sent++` and the first line of leg two, NOT on the enclosing
  // if-block: the block's own early-exit guard (`if (!isWithinCheckinWindow) continue`)
  // sits inside it, and an earlier version of this test matched that one instead —
  // it passed happily with the real `continue` deleted.
  const afterSend = body.indexOf('sent++;');
  const legTwo = body.indexOf('followUpDays <= 0');
  assert.ok(afterSend > -1 && legTwo > afterSend, 'the check-in sweep was restructured');
  assert.match(body.slice(afterSend, legTwo), /continue;/,
    'after sending the first check-in email the sweep must continue, not fall through to the follow-up');
  assert.match(body, /followUpDays <= 0\) continue/,
    'a template with no date_second must not reach the follow-up path at all');
});

test('the scheduler and the routes share one window comparison', () => {
  // The drift this whole change exists to prevent. If the scheduler ever computes
  // its own trigger date again, the two paths can disagree about which day a
  // 14-day lead opens on and nothing else will notice.
  const src = read(SCHEDULER);
  assert.match(src, /require\('\.\.\/utils\/checkinWindow'\)/,
    'scheduler must use utils/checkinWindow rather than its own date arithmetic');

  const job = src.slice(src.indexOf('async function sendCheckinEmailsForOrg'));
  const body = job.slice(0, job.indexOf('\n}\n'));
  assert.match(body, /isWithinCheckinWindow\(/, 'the check-in sweep must use the shared window');
  assert.doesNotMatch(body, /setDate\(/,
    'hand-rolled date arithmetic is back in the check-in sweep — use isWithinCheckinWindow');
});
