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

## Fix — built, not released

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
The owner's standing instruction requires explicit approval before push/merge/deploy.
