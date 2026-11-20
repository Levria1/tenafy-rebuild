# Ten enabled accounts in the Xero helper — 0.4 build

Owner selected the ten currently enabled accounts in Discord1573217841350582455.
The twenty Ignore entries must remain unchanged. This increment is built and
verified, not pushed or deployed. Live helper remains v0.3 until this release is
approved. No new migration or financial configuration rewrite is needed.

## Scope and verified source

Live read-only inventory and the existing Xero Accounts GET confirm all ten are
ACTIVE/HKD with distinct enabled Tenafy ledger mappings:

- ACJ HSBC Current and Savings
- Naos Current and Savings
- Parcelle Current and Savings
- Tane Current and Savings
- Stripe Account
- Tane Wise Account

Only ACJ Savings has a structured bank/property setup. Several Xero current-account
bank-number fields conflict with the numbers in Tenafy ledger names; some units'
old payment instructions also differ within one property. Bank numbers/display
names are therefore not used as identity and are not copied or guessed. Account
identity comes from the exact Xero AccountID and existing enabled ledger mapping;
currency/status come from Xero. No bank records, payment instructions, property
links, currency rate snapshots or Ignore flags are changed.

## Backend

GET `/api/integrations/xero/browser/accounts` uses the same authenticated staff,
accounting-view/create permission, rate limits and no-store as existing helper
reads. Returns only enabled, unambiguous ledger mappings whose Xero account is an
active bank with supported verified currency. It returns no account numbers,
credentials or ignored account list. Invalid/disabled/shared-ledger/currency
conflicts are reported unavailable. The UI-org/API-tenant binding is rechecked.

Xero account metadata is cached for five minutes per pool/org/tenant, including
its actual verification timestamp. Mapping/Ignore changes are read fresh each
request. Failed remote verification is remembered for thirty seconds; an eight-
second response deadline bounds verification waits (an already pending upstream
request stays shared). Xero transport errors are sanitised as service failures,
not misreported as the staff member lacking permission. Existing OAuth refresh
uses the normal integration client when required; no Xero financial writes occur.

A lookup with no structured bank record uses its verified Xero account currency
and exact existing Tenafy ledger ID. Current ACJ Savings behaviour is retained.
For other accounts, candidate invoice/lease properties must have explicit-currency
posted activity on that exact ledger. Accounting candidates are scoped to that
ledger, org, currency and direction. Other-org/account/unknown-currency history
stays excluded. For Wise, historical entries with missing currency_type remain
unverified/excluded rather than being relabelled HKD. A valid bank mapping does
not prove that an individual payment matches an invoice.

Existing signed message cursors now also bind ledger/Xero account identity, so
accounts without a structured bank ID cannot share a page token. The six/thirty/
all message search modes, no financial writes and staff confirmation remain.

## Helper

Version0.4 loads the verified account catalogue on Connect Tenafy. After Read this
Xero tab, bank and currency are selected automatically by account ID. No staff
member needs to type HKD or repeatedly configure per-account local mappings.
Unconfigured/ignored banks are blocked with setup guidance; old local mappings
cannot override the server. Connection progress is explicit and errors are
highlighted. Only a fixed same-origin catalogue GET is added; no credential is
read/copied by the extension. The installed website session is still used.

This increment also implements the owner's identity-first rule from Discord
1573217966592495718. A usable bank payer/beneficiary name filters financial records
and stored-message contacts before the result limit. Name comparison supports
case, accents and reordered full-name words; it does not use fuzzy similarity.
Recognised invoice/lease/payment references filter exact reference tokens. If both
are supplied, both must match. A named/reference lookup with no result never
widens to unrelated same-amount records. Amount-only leads are allowed only when
there is no usable name/reference, and are labelled unverified.

The reader forwards recognised structured bank text such as /ORDP/ for received
payments and beneficiary tags for spent payments. It does not treat an outgoing
ORDP sender as the beneficiary. Unclassified summary spans, truncated identity or
conflicting names block amount-only fallback and require manual review. No raw
unclassified summary is sent to the matching API. Stored-message matches require
the matching session/tenant name or reference; nearby context stays in that same
session and date window. This conservative rule can omit aliases, third-party
payers or contacts whose name is not recorded; staff must review those manually.
Identity text is pinned in responses and signed page cursors, so changed bank
text cannot reuse a prior proposal or page.

Calibrated confidence, automatic session/tab resume, longer sign-in and field
autofill remain separate requirements. Scores rank filtered leads, not payment
probabilities. The helper does not edit Xero fields or click OK/Save/Reconcile.

## Verification

- Fifteen focused backend API/history/catalogue tests pass, including viewer
  access, no configuration-write access, bank/currency/tenant changes, disabled/
  duplicate/shared ledgers, ignored mappings, caching, bounded waits and failures.
- Scratch MySQL passes existing migration089 twice and real financial/history
  isolation. Added another enabled bank with no property bank record: it resolves
  through its exact ledger, returns only that ledger's eligible leads, and refuses
  another org/ignored mapping. Identity cases find the correct payer behind twelve
  nearer unrelated amount matches, handle reversed/accented/company names and
  exact references, reject name/reference conflicts and unreadable identity, and
  preserve explicit amount-only fallback. No financial rows are written by lookups.
- Nine helper units and seven synthetic browser flows pass. The real panel/modules
  load ten fake accounts, detect/switch HKD and USD banks, block an unconfigured
  bank, reject changed-organisation catalogues, paginate and discard stale rows.
  Endpoints/Chrome APIs are intercepted; staff-PC Chrome runtime is not claimed.
- A source-in-memory read-only probe against production records/Xero metadata
  resolves all ten enabled banks with matching source status and read-only
  capabilities. No code/configuration/payment records are installed or changed.
- Full backend1,967 tests /1,960 pass /four unchanged known failures /three optional
  MySQL skips. Real MySQL fixture ran separately.

## Release

Review/deploy the backend and distribute helper0.4 together; existing0.3 still
works with ACJ Savings, and can manually map supported banks after backend release.
No application frontend rebuild or live migration is required. The owner's standing
rule requires explicit permission for this change's push/merge/deploy. Keep the
current released Drive package untouched until the new build is approved.

After release, copy the ZIP inner folder over the existing loaded helper folder,
Reload in chrome://extensions, reopen panel and verify0.4.0. Keep Tenafy signed in,
Connect Tenafy, then Read this Xero tab. Mapping is automatic for the ten selected
accounts. Twenty ignored accounts remain ignored.
