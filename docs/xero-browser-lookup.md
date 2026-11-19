# Xero Chrome helper: read-only Tenafy lookup

The expanded history search is built but not deployed; see
[xero-stored-history.md](xero-stored-history.md). The six-to-thirty-day retained text search and
pagination described there supersede the original copied-evidence limits below.
ACJ Savings is already configured in HKD for Hillier, Mercer, Jervois and Fuk Lo Tsun.

Original release status: code deployed on 2026-11-19 via [PR #22](https://github.com/Levria1/tenafy-rebuild/pull/22),
merge commit `6e0f0c7`. Owner approval: Discord 1572898459990884415. Migration 089
applied successfully to all three active org databases; both new binding tables
were verified empty. Health/login returned 200 internally and over public HTTPS;
anonymous binding access returned 401. Authenticated binding read passed, missing
or changed-organisation mappings returned 409, and missing currency returned 400.
No mappings or financial entries were written by smoke verification.

The Chrome helper v0.2 is in `extensions/xero-side-panel`. Installation on the staff
PC, actual UI slug verification, bank/property/currency setup and controlled Chrome
runtime tests remain pending. Staff can use Read this Xero tab before connecting
to display the UI slug/account ID. ACJ Savings' HKD currency and account UUID were
confirmed through the existing read-only Xero API connection.

CodeQL JavaScript/Python and aggregate security checks passed. An IP gate (120/min)
now precedes authentication/session/permission DB reads; the per-staff/org limit
is 30/min. The burst test verifies rejected traffic never resolves an org pool.

Live suite: 1,909 tests, 1,902 pass, five failures identical to its immediately
preceding baseline, two optional MySQL skips. Six helper tests passed on the live
host. Local results are below. No app frontend code changed, so the running Next
build was preserved. Backup: `/home/ubuntu/backups/tenafy-deploy-20261119-xero-6e0f0c7`.


This is the first backend slice of the owner's 2026-11-19 handoff. It supplies
ranked evidence for staff review. It neither writes payments nor calls a Xero
write endpoint, performs sync, creates signing requests or sends messages.
Category/account, tracking and tax autofill mappings remain future work.

## Verified browser observations supplied by the owner

The inspected account was ACJ Savings, displayed as ACJ HSBC S\\ (April Eve).
The page had one Spent and one Received line. Inspection was read-only.

| Element | Observed binding |
| --- | --- |
| Organisation menu | `button[aria-label^="Toggle Organization menu"]` |
| UI organisation slug | `/app/!<slug>/settings`; relationship to API tenant ID unverified |
| Account | `/BankRec/BankRec.aspx?accountID=<id>`; compare normalised UUIDs |
| Rows | `#statementLines > .line[id^="sl"]`; `sl` + 32 hex characters |
| Left panel | Direct child `.bank-transaction` |
| Date | `.line-details > span.font-size-small` |
| Direction/amount | Populated `.amount-spent > span` or `.amount-received > span` |
| More details | `button.more-details-button[aria-label="More information"]`; labelled fields |
| Create panel | Direct child `.statement.create`; scope inputs to visible active panel |
| Who / What / Why | `paidTo<key>_value`, `paidAccount<key>_value`, `paidDesc<key>` |
| Tabs | `.tabs a.t1` through `.t4`: Match, Create, Transfer, Discuss |
| Find & Match | `a.find` opens the row's direct child `.findMatch` |
| Final confirmation | `a.okayButton`; never click automatically |
| Tracking / tax | `.statement.create .tracking input`; Property and Tax Rate seen |
| Blank fields | `x-form-empty-field`; `.value` may contain placeholder text |

Controls were in the top-level document; the two iframes were hidden. Who's
picker was a document-level `.x-combo-list.autocompleter-contacts`; its inner list
was initially empty. A hidden companion input existed. What's picker was a
row-local `.autocomplete[id^="paidAccount"][id$="_suggestions"]` populated on
open with nested div options. Typing/filtering, option selection and committed
values have not been verified. Company was not verified.

One row was prefilled in all five fields, with Suggest previous entries checked;
the source of that prefill was unverified. Preserve/display existing values and
require staff to review any replacement. Both IDs survived scrolling/reload.
Pagination showed 1–2 of 2, so next-page controls, recycled rows, active Match
suggestions and safe row resolution after a neighbour disappears remain untested.

## Restricted API contract (version 1)

`POST /api/integrations/xero/browser/lookup`

Uses the existing staff authentication and `LANDLORD/ACCOUNTING_CREATE`
permission, matching reconciliation access. Tenant-portal tokens, master-admin
sessions without a selected staff organisation, and callers without permission
are refused. Scope comes from the authenticated organisation, never a posted
org ID. Responses are `Cache-Control: no-store`, limited to 30 operations per
minute per staff user/organisation. No new browser credentials or CORS exceptions
are added. The helper optionally requests host access only to platform.tenafy.com
and performs three fixed same-origin operations inside an isolated script on a
signed-in staff tab. Cookies stay in that browser session; no token is extracted.
The bridge was tested with synthetic endpoints/cookies and intercepted Chrome APIs;
the real extension permission prompt/runtime still needs staff-PC verification.
Never put backend or Switchboard service credentials in the extension.

Request (synthetic identifiers, **not live mappings**):

```json
{
  "expected_org_id": "1",
  "ui_org_slug": "verified-org",
  "xero_account_id": "12345678-abcd-1234-abcd-123456789abc",
  "statement": {
    "id_suffix": "11111111111111111111111111111111",
    "date": "2026-11-19",
    "direction": "received",
    "amount_minor": 1380000,
    "currency": "HKD",
    "reference": "optional bank reference",
    "description": "optional bank description",
    "payee": "optional observed payee"
  }
}
```

The helper supplies `expected_org_id` as a consistency assertion; a mismatch
returns 409 before searching, without changing the authenticated scope.
Amounts must be positive integers in minor units, with direction separate.
Dates must be real YYYY-MM-DD dates. Currency is mandatory; no HKD/default-org
fallback. Zero- and two-decimal currencies are supported according to Node's
currency metadata. Currencies requiring more than the ledger's two decimal places
are refused. Reference/description/payee are bounded text retained as optional
input; the history search can match explicit references but financial ranking is unchanged.

Response envelope: `{ code: 200, data: ... }`, containing:

- `version`, `proposal_key`, `issued_at`, `expires_at` (five-minute review window).
- `identity`: mapped organisation, normalised Xero bank ID, Tenafy bank/currency
  IDs and original statement suffix/date/direction/currency/minor amount.
- `status`: `leads`, `no_financial_lead`, `partial`, or `unavailable`.
- `candidates`: stable Tenafy IDs, source kind, references, display details,
  ordinal ranking scores/reasons and review path. Invoice balances use minor units.
- `ambiguity`: multiple leads exist; these can include related invoice/lease leads.
- `evidence`: at most ten copied-message excerpts with IDs, timestamps, source and
  `currency_verified: false`; availability/truncation flags. Message mentions are
  not scored as proof of who paid or which currency was meant.
- `source_status` for invoices, leases and accounting; raw SQL errors are hidden.
- `capabilities: { read_only: true, live_autofill: false, final_confirmation: "staff" }`.
- `notices` describing limitations; scores are not calibrated probabilities.

Mapping mismatches return 409; malformed identity/amount/currency returns 400.
Do not convert source failure into "no matching payment". Financial queries are
read-only, use bound parameters and restrict organisation, bank, currency and
direction. Invoice leads must still owe at least the statement amount. Existing
`trace_amount` ranking is reused with these stricter sources; legacy chat tracing
keeps its existing source functions.

`find_and_match_review` means a historical accounting candidate has a recorded
Xero transaction ID. It is a review/search hint, not proof that it settles the
current bank line or that an unreconciled Xero candidate is available. Invoice
leads use `create_review`; bare lease leads and unsynced accounting history use
`staff_review`. These labels never authorise creating, paying or matching anything.

## Explicit setup before use

Migration `089_xero_browser_binding.sql` adds empty organisation/currency metadata tables; it does
not alter existing bank mappings, seed guessed data or enable autofill. It passed
twice on scratch MySQL. It was applied in the owner-approved 2026-11-19 release. Future releases or mapping
changes require their own applicable approval/verified setup values.

1. Verify the Xero API organisation ID using the existing Xero connection and
   independently observe its UI slug. Superadmins can explicitly save the pair
   through `PUT /api/integrations/xero/browser/binding` with
   `{ ui_org_slug, xero_tenant_id }`. The tenant ID must match the existing connection.
   Read with `GET .../binding`, which also returns the authenticated `org_id`.
   Changing a connection invalidates the old binding.
2. Reuse Settings → Integrations → Xero → Account Mapping. A selected bank needs
   one active, non-ignored mapping to both a Tenafy account and an active bank.
   Preserve the complete existing mapping set; the old mapping save API replaces
   the full set, so never send just one entry blindly.
3. Verify the bank's explicit ISO currency code and its Tenafy currency ID.
   Legacy `currency.detail` often contains an FX-rate snapshot, not a currency code.
   Never overwrite that JSON or infer denomination from its list of rate keys.
   For such records, a superadmin can explicitly attest the denomination of stored
   invoice/lease amounts with `PUT .../currency` and
   `{ currency_id, currency_code, confirm_invoice_lease_currency: true }`.
   This writes only the separate `xero_browser_currency_binding` metadata table.
   A binding conflicting with an existing denomination is refused. Missing,
   conflicting or duplicate mappings block lookup. No conversion is attempted.
   Accounting history additionally needs a matching explicit `currency_type`;
   unknown currency types are excluded even if they share the same FX snapshot ID.
   Invoices with foreign/unknown-currency allocations are excluded because their
   remaining balance cannot be verified in the requested denomination.

### Production readiness checks (2026-11-19)

The existing Xero connection/cache identifies the Tane Residence API tenant and
ACJ HSBC S* (April Eve) bank UUID. A read-only Xero Accounts API call confirmed that ACJ Savings is HKD and its
UUID matches the saved cache. The UI slug relationship still requires explicit
verification. At preflight there were no structured Tenafy bank records and none
of the 19 active properties had bank links. The one current currency row was an
FX-rate snapshot. Deployment does not guess or seed these mappings; lookup stays
unavailable until owner-verified setup is completed.

## Current limits and next work

Only exact gross-amount financial leads are returned. Partial/split payments,
combined payouts, fees and missing bank/currency metadata require manual review
and future matcher work. A missing lead is not proof no payment exists. Accounting
history with no property/bank association is intentionally excluded.

Expanded copied Switchboard evidence searches full retained authorised WhatsApp/email
text within six days ending on the bank date, expandable to thirty, including positively owned inquiry contacts and safely verified unlinked
sessions, with signed pagination and bounded context. It is separate from the
bank-scoped financial candidate scan. See [stored-history details](xero-stored-history.md)
for ownership proof, coverage, limits and verification. No direct live Switchboard
search or attachment/OCR search is enabled.

The extension must render evidence as plain text. Use a MutationObserver/rescan
queue for dynamic rows, deduplicate by organisation+account+suffix, and discard
proposals on navigation/org/account switch. Immediately before any future fill,
resolve the exact row again and compare date, direction, currency and minor amount
with the proposal. Refresh expired proposals. Never retain a neighbour's positional
index or infer the current row from an amount alone. Missing/changed rows stop fill.

Separate Find & Match from Create. Active Match candidate identifiers and commit
behaviour remain unverified. Future Create filling requires explicit Fill for
review, a diff against prefilled fields, real picker selection, committed-value
verification and then dependent tracking/tax fields. Re-read after filling and
report unresolved fields. Never automatically click OK, Save or Reconcile.

Remaining integration inputs: actual verified UI slug/account ID/currency,
controlled staff-PC Chrome permission/runtime and picker tests, larger-page
pagination/row-removal tests, and category/ledger/tax/tracking mappings. The helper
request contract and staff-tab bridge are implemented. No live autofill has been
tested or enabled. The Chrome panel performs suggestions only; no Xero fields
are edited, and no Find & Match or final confirmation control is clicked.

## Verification

16 focused tests pass, including authentication/permissions, forged org/bank IDs,
mapping/currency conflicts, exact money/date validation and existing reconciliation
regression checks. Scratch MySQL verifies migration twice and real org/bank/currency,
direction, remaining-balance and copied-message isolation. Full backend: 1,953 tests,
1,947 pass, four known failures, two optional MySQL tests skipped (browser integration
run separately on scratch). Six helper unit tests and two synthetic browser flows
also pass. The browser checks cover account setup, same-origin staff-cookie fetch,
plaintext evidence, row disappearance, delayed stale responses and tab switching.
They intercept Chrome APIs and HTTPS endpoints; they do not claim a live runtime
or live mapping test.

```bash
cd backend
node --test test/xeroBrowserLookup.test.js test/paymentMatchService.test.js test/reconcileSplitPayInvoice.test.js
# Disposable local socket only; never use live DB credentials:
STAMP_TEST_SOCKET=/tmp/tenafy-pr18-mysql/mysql.sock node --test test/xeroBrowserMysql.test.js
npm test
```
