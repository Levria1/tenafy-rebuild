# Renewal reply corrections across lease periods

Owner reported Gilman 5A showing Extend / paperwork due alongside NR. Read-only
investigation found a September Extend reply for an October end date still on a
lease subsequently extended to December. The tenant confirmed Leaving in November;
contract_type already correctly showed NR, but renewal_reply still showed Extend.
This suppressed the unit from both inquiry and advertising availability results.

## Approved live correction

Owner approved fixing the issue in Discord 1573180908280873012. Corrected only
lease LEA2748's renewal_reply to Leaving and renewal_reply_at to the confirmed
November reply time. NR, lease end, rent and financial rows were preserved. The
historical September renewal_ask was hashed before/after and remained identical.
A compare-and-set transaction, private backup and activity audit record the change.
The automation audit identifies Codex and the exact Discord approval; no staff
account was impersonated. Read-only checks now include the unit in both inquiry
and advertising availability. No tenant messages were sent.

Backup: `/home/ubuntu/backups/tenafy-gilman5a-renewal-1795146149873`.

## Permanent code fix — built, not released

- Lease edits compare against the row's existing values in the same UPDATE. A
  changed end date, tenant or unit clears the previous reply and its timestamp.
  An unrelated save or unchanged date preserves it.
- An explicit staff contract-intent change supersedes the old answer: NR records
  Leaving; returning to MR/MTM/UC clears the prior reply. Re-saving NR also repairs
  a conflicting Extend flag. A simultaneous period change clears the old reply
  rather than transferring it to a new period. Historical asks are never changed.
- Renewal assignments precede date/identity/intent assignments because MySQL
  evaluates single-table UPDATE assignments left to right. Ownership checks and
  existing edit permissions remain in force.
- The Vacancy page excludes settled asks from its current action map. A current
  Leaving reply takes precedence over historical ask labels. An applied ask whose
  reply no longer matches the lease shows a changed-lease warning rather than an
  instruction to extend. Genuine current Extend replies remain visible.

There is no migration, new dependency, bulk backfill or automatic tenant message.
This change concerns the lease-edit endpoint and Vacancy rendering. The approved
one-lease correction is live, but the running page can still show a historical
ask tag until the code/frontend release. The owner's standing rule requires a
separate explicit OK before pushing, merging or deploying this code change.

## Verification

Two behavioural status tests pass. Scratch MySQL invokes the real lease PUT
handler: unrelated/unchanged saves, extension resets, staff NR overrides, existing
NR/Extend conflicts, returning to undecided, tenant/unit changes, preserved
historical asks, audit entries and refusal to edit another org's lease all pass.
The fixture uses only a disposable local socket; it must never run on live data.

Full backend: 1,959 tests, 1,952 pass, four unchanged known failures, three optional
MySQL skips. The new MySQL fixture passes separately. Production frontend build
passes. Synthetic browser checks exercise the actual built Vacancy page with fake
API data: Leaving shown, settled-cycle paperwork hidden, genuine Extend retained,
stale applied reply shown as changed lease. All intercepted API traffic is read-only.

```bash
cd backend
node --test test/renewalReplyEdit.test.js test/renewalAskSettled.test.js
STAMP_TEST_SOCKET=/tmp/tenafy-pr18-mysql/mysql.sock node --test test/renewalReplyEditMysql.test.js
cd ../frontend
npm run build
python scripts/check-renewal-status.py  # Playwright/Chromium required
```

A future approved release must build/restart the frontend as well as restart the
backend. No live migration is needed. Preserve the live one-lease correction and
September history; do not re-run the guarded correction script after it succeeds.
