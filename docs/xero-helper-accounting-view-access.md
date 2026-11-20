# Read-only helper access for accounting viewers

## Diagnosis (2026-11-20)

Owner's screenshot reports Your Tenafy account does not have reconciliation access.
The displayed Tane Residence Limited profile matches the active shared Tane Team
account. It has ACCOUNTING_LIST, but not ACCOUNTING_CREATE. Read-only inspection
confirmed role assignments; no permissions were changed. Public and direct backend
binding requests work for the existing owner/manager profiles, isolating the failure
to this account's permission gate rather than a login or extension-install issue.

The helper's binding/lookup/history routes currently require ACCOUNTING_CREATE,
matching the write-capable Xero reconciliation workflow. The helper itself performs
only SELECT queries and never creates/approves payments, so this gate prevents
legitimate accounting viewers from connecting.

## Fix — deployed 2026-11-20

Allow ACCOUNTING_LIST OR ACCOUNTING_CREATE for the browser helper's reads. Existing
org authentication, mapping checks, source isolation, pre-auth/staff rate limits,
no-store and read-only capabilities stay in place. Binding/currency configuration
writes still require Super Admin. Other Xero/accounting write routes keep their
existing CREATE/EDIT/DELETE/approve permissions. No role grants, schema migration,
new credentials, cookie changes, CORS change or extension update is required.

HTTP regression verifies accounting viewers can GET binding and POST lookup/history,
responses stay scoped/read-only/no-store, viewer configuration writes are 403,
unrelated permissions fail, and org/currency/cursor/rate protections remain enforced.
The seven focused browser API/history tests pass. This is a backend-only change.
Owner approved push/merge/deploy in Discord 1573185159572889662. Tenafy
[PR #24](https://github.com/Levria1/tenafy-rebuild/pull/24) merged `07adcc5` after
CodeQL JavaScript/TypeScript, Python and aggregate checks passed. Connector
[PR #2](https://github.com/Levria1/Xero-Tenafy-Connector/pull/2) merged `be4e9de`.
Only the backend was restarted; no frontend/extension/configuration was changed.

## Live verification

Using the actual shared-account profile and public cookie-authenticated HTTPS:
binding/lookup/thirty-day/all-history/pagination pass; configuration PUTs remain
403, anonymous access remains 401, wrong org is 409 and forged cursor is 400.
Responses are no-store/read-only. Direct role inspection confirms accounting view
is still present and payment create is still absent. No financial writes occurred.
The live suite remains 1,912 tests / 1,905 pass / the same five existing failures /
two optional MySQL skips, exactly matching the fresh pre-release baseline. Internal
and public health/login return 200.

Private rollback copy: `/home/ubuntu/backups/tenafy-deploy-20261120-035735-helper-access`.
The installed v0.3 helper/ZIP/Drive link is unchanged. Return to Xero, keep the
signed-in Tenafy tab open, and click Connect Tenafy again. Map the account in HKD
if needed, then Find Tenafy leads. No reinstall or new login token is required.
The separately prepared stale-renewal code fix was not part of this release.
