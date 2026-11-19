# Stored Switchboard history for Xero review — 0.3

Built on 2026-11-19 in `feat/xero-stored-history` (Tenafy) and
`feat/stored-switchboard-history` (connector). This change is not deployed.
The existing ACJ Savings organisation/bank/HKD configuration remains in place.
No new migration or configuration change is needed for the history search.

## What staff see

Find Tenafy leads searches retained WhatsApp/email text in a six-calendar-day
window ending on the bank transaction date, alongside existing exact-amount
financial leads. For 19 November, this means 14–19 November inclusive. If no
message hits exist, it automatically searches 30 calendar days (21 October–19
November). When recent hits exist but none is right, staff can click Search 30
days. These bounded modes exclude older or future-dated stored messages and
nearby context. Staff may explicitly select Search all history to remove the date
filter, then Search 30 days to narrow again. Automatic expansion stops at thirty
days; all history is never selected automatically. Message results
include the contact name/phone/email when available, timestamp, author role,
matching excerpt, one preceding/following message, and an Open conversation link.
The helper displays ten hits per page with More messages and Previous messages.
Results are ordered by distance from the statement date, then message time/ID.
The selected mode/dates, coverage count and first/last stored timestamps describe what was searched.

Search recognises exact numeric amount spellings, including `13,800.00`,
`13 800`, `HKD13800` and `13.8k`, without confusing `113800`, `13800.01` or
`13800xxxx` with `13800`. It searches the full message before selecting a bounded
excerpt, including amounts after character 4,000, within the selected dates (or all retained text when explicitly selected). SQL runs have
execution time limits; failures show unavailable rather than an empty search.

An explicitly supplied bank reference of 6–64 alphanumeric characters containing
a digit can also match stored text, allowing spaces/hyphens. The current browser
reader still treats summary spans as unclassified text; it does not invent a bank
reference from them. Search does not infer who paid from a name/amount alone.

## Scope and provenance

History search is organisation-wide, independently of financial candidates'
bank/property/currency filters. This intentionally includes prospects, vendors
and conversations with no tenant link. A message is a lead, not proof of payment,
currency, direction or invoice allocation. Staff inspect the surrounding evidence.
Internal channels and system/tool messages are excluded.

Every query checks tenant and inquiry ownership and excludes foreign or conflicting
links. Since `chat_session` has no org_id, unlinked sessions require server-side
proof that the active organisation exclusively owns the selected database, the
actual pool points to that database, and no external session has foreign anchors.
If this proof fails, only positively owned tenant/inquiry sessions are returned
and the helper labels the search incomplete. A request cannot enable this scope.
No ownership backfill, schema migration or customer-message write is performed.

The date filter uses Tenafy's stored message timestamps, not today's date. The
current chat logger dates copies at ingestion; historical backfills must preserve
original sent timestamps before claiming exact source-date coverage. No backfill
is performed by this change.

This searches only text already copied into Tenafy. It does not query the external
Switchboard archive, download attachments, perform OCR on deposit slips, or infer
payment confirmation. Missing results do not prove that a payment did not happen.
Splits, combined payments, fees and partial-payment finance matching remain future
work. No Xero field editing or final confirmation is enabled.

## API and browser behaviour

The existing staff-authenticated, permission-checked and rate-limited `POST
/api/integrations/xero/browser/lookup` now returns the first history page.
`POST /api/integrations/xero/browser/history` accepts the same validated identity
and optional `cursor`/`lookback_days` (numeric 6, numeric 30 or string `"all"`), revalidates org/bank/currency bindings, and returns only
history in the common version-1 envelope. No financial scan is repeated for pages.
Cursors are signed, expire after ten minutes, and are bound to organisation,
bank, currency, statement identity, amount, reference and selected date window.
Changing the window restarts at page one; pagination preserves that window. They are keyset pages,
not a frozen snapshot; newly copied messages may require refreshing the lookup.

The optional Tenafy host permission and same-origin staff-tab bridge now allow
three fixed operations: binding, lookup and history. Credentials remain in the
browser. All evidence renders through textContent. Conversation links are built
from validated numeric IDs on the fixed Tenafy origin. No URL in message text is
fetched. Pages replace previous excerpts rather than accumulating customer data.
A message page cannot extend the five-minute financial proposal lifetime.
Navigation, reconnecting, removed/changed rows and superseding requests discard
stale results. Staff alone confirm entries in Xero.

## Token usage

Search executes SQL regular-expression queries and returns up to ten bounded
excerpts plus nearby replies per page. It does not invoke an LLM: zero LLM tokens
per lookup/history search, whether six days, thirty days or all retained history.
All history increases database work, not model token consumption. Query execution
time limits, rate limits and pagination still apply. Financial candidate ranking
also uses local code. A future AI assessment would consume tokens for only the
selected evidence sent to it; no such AI/OCR stage is implemented here.

## Verification

- Seven focused backend checks pass for identity, HTTP auth/permission, forged
  scope, ownership proof, references and cursor expiry/tampering/query binding.
- Real scratch MySQL passes with migration 089 twice, financial isolation,
  inquiry/unlinked ownership, foreign/conflicting anchors, long messages,
  six/thirty-day boundaries, future-message exclusion in bounded modes, explicit
  all-history results with unchanged org/channel/role restrictions, automatic empty-result
  expansion, explicit expansion, context date limits and cross-window cursors,
  numeric boundaries, reference-only hits, surrounding context and two pages
  without duplicates. No financial rows change.
- Seven helper unit checks and four synthetic browser flows pass, including
  contact/context links, pagination, stale message pages, plain-text rendering,
  same-origin cookies, removed rows, row amount changes, tab switching, six/thirty/all-history
  selection/page reset and retention of the selected window across pages.
- Full backend: 1,956 tests, 1,950 pass, the same four known failures and two
  optional MySQL skips. The MySQL fixture was run separately.
- Read-only production probe after the window limit: the sample amount had no
  hits in six days, so expanded to thirty, covering 8,594 stored messages in
  approximately 374 ms. No hits in that window. Only aggregate counts were
  printed; no production files, rows or processes changed.
- Nineteen focused checks including existing matcher/payment regressions pass.


Synthetic browser checks intercept Chrome APIs and endpoints. Real staff-PC
extension runtime and live Xero picker behaviour are not claimed tested.

## Release and staff update

Review/approve the Tenafy backend branch and the connector helper together. The
new endpoint requires a backend release before the 0.3 helper's pagination works.
Do not reapply the full historical overlay patch to a host already on PR #22;
carry the incremental branch changes instead. Push, merge and deployment require
the owner's approval for this change. No migration is needed for this increment.

After the approved release, copy the new ZIP's inner-folder contents over the
existing loaded helper folder containing manifest.json. Reload the extension in
chrome://extensions, reopen its panel, and verify version 0.3.0. Keeping the same
folder retains the extension ID and local account mappings. Connect Tenafy,
Read this Xero tab, then Find Tenafy leads. Review messages and confirm in Xero.
