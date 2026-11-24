# Xero review fill0.5 — local draft

Owner requested implementation in Discord1573265663022334043. This work is built
on host feat/xero-review-autofill and connector feat/review-autofill. It is not
pushed, merged, deployed or installed on staff PCs. Production is still host
1352c6b/runtime2c990f6 and helper0.4. A separate change-specific release approval
is required under the owner's standing rule.

## Behaviour

- POST /api/integrations/xero/browser/prepare-fill re-runs existing org/bank/
  currency/identity-scoped lookup and accepts only the selected current invoice
  or existing accounting candidate. Leases are evidence and do not auto-create.
- Existing accounting Xero IDs, matching Xero InvoiceNumber, or matching bank
  transaction Reference on the selected bank route to Find & Match. Other
  reference spellings are not a complete duplicate-detection guarantee.
- Xero read-only GETs load active account codes, tax rates, tracking options and
  contact IDs. Duplicate display names are omitted rather than guessed. Contact
  searches are bounded; a full100-result page requires a narrower query.
- Preparation inherits helper accounting view/create access, no-store and org
  scope; a six-per-minute staff limit bounds upstream work. Metadata has one
  twelve-second deadline, cancellation and transport timeouts. Optional timeout/
  signal support in xeroClient affects only callers that pass those options.
- Explicit account/tax/tracking choices can be remembered on the PC. Actual live
  catalogue IDs/names are revalidated. Reference/description remain editable.
- Open details → Preview changes → approve overwrites → Fill for review. Before
  filling, preparation runs again; changed invoice details, existing entries or
  different option IDs/names require another review.
- Driver binds the exact Xero tab/document/org/account/row, date, direction,
  two-decimal currency, gross amount and bank summary. Rechecks surround each
  edit. Row disappearance, unknown bindings, multiple detail lines, duplicate
  options, changed preview or unverified total stop the action. Dropdowns use
  actual options and check committed hidden/native values, never direct hidden
  value writes. Partial unsaved edits are reported honestly.
- Staff keep Save Transaction, OK, Save and Reconcile. No Xero financial write
  API is called. No automatic transaction selection or blanket highest-score fill.
- Slips use an explicitly staff-selected downloaded file (PNG/JPEG/PDF ≤5MB).
  Xero upload success still requires staff verification. Copied Switchboard text
  cannot supply original slip bytes; automatic attachment retrieval is not built.

## Verification and limits

Seven prepare tests cover fresh/stale/partial candidates, existing entries,
active/duplicate choices, sanitised failures and cancellation/deadline. The HTTP
helper test confirms viewer access, anonymous401/no-access403 and no-store.
Eleven helper units pass. Nine synthetic panel flows exercise fresh preparation,
choice/preview/fill wiring and read-only inspection. Eleven isolated Xero-shaped DOM
checks exercise field filling, explicit overwrite approval, identity changes,
incorrect totals, missing controls, Find & Match, custom hidden commits and
staff-selected slips, spent-beneficiary labels and text dates. Save/reconciliation counters remain zero.
Full backend suite before the added cancellation test:1973 total1966 pass,
four unchanged known failures, three optional MySQL skips. The added seventh
prepare test passes separately. No new schema or financial-row mutation is needed.

A source-in-memory read-only probe against production records and Xero GETs
passed preparation:185 active non-bank account choices,4 tax rates,1 tracking
category,1 contact. No product code was installed or financial records written.
An initial probe created duplicate pool instances concurrently and lost its SSH
connection; its exact owned process was terminated, production health stayed200.
The corrected single-pool probe with transport cancellation completed normally.

Actual expanded-form selectors and committed picker values on the staff PC are
still unverified. Screenshots cannot establish those bindings. The adapter uses
known row controls plus unique labels/table headers and stops if unavailable.
Before rollout use the test helper's read-only inspector and compare the reported
structure. Then run one controlled unsaved fill, checking all committed fields
and upload preview, and cancel it. Do not claim synthetic tests prove live Xero
picker compatibility. The inspector requires no new backend deployment and omits
input values, customer text and attachment bytes.

## Sources

Official Xero API contracts used for read-only preparation:
- https://developer.xero.com/documentation/api/accounting/contacts
- https://developer.xero.com/documentation/api/accounting/accounts
- https://developer.xero.com/documentation/api/accounting/taxrates
- https://developer.xero.com/documentation/api/accounting/trackingcategories

## Packaging

Only thirteen explicit reviewed runtime/README files are packaged. New modules:
fill.mjs and review.mjs. Tests, host data, credentials and node_modules are excluded.
Keep the released0.4 Drive download intact. This draft is for controlled testing.
# Combined helper 0.5.2

This build combines account-wide matching and slip review with unsaved Xero
draft fill. The fill endpoint requires the open invoice balance to equal the
bank line. Existing Xero invoices or transactions take the Find & Match path.

For a different amount or a payer paying on behalf of the tenant, an authorised
staff member can enter the exact invoice reference in **Check allocation by
invoice reference**. The preview checks the organisation, bank scope, direction
and currency. It calculates the proposed allocation using integer minor units.
It shows any bank amount left unallocated or invoice balance left due. A prior
entry with a blank currency label is allowed only with the same linked currency
record and is explicitly flagged. Staff settle the full bank transaction in
Xero and handle remaining credit or invoice allocation in Tenafy. The preview
does not create a credit, payment or draft.

Use **Search around bank date** for the seven days before and after the transfer.
When a conversation link is known, use the direct slip flow for its attachments
where the Switchboard key allows it. For unsupported channels such as WhatsApp
groups, staff can inspect the original in Switchboard and import it for review.
