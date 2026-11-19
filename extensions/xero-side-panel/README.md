# Tenafy reconciliation review

Version 0.2 adds read-only Tenafy suggestions to the owner's working toolbar helper.
The matching backend was released on 2026-11-19 via PR #22 and migration 089.
Local Xero reading works independently; suggestions require verified server-side
organisation/bank/currency mappings. Those mappings are not automatically seeded. This package never
edits a Xero field or clicks OK, Save or Reconcile.

## First: send the mapping identity (no connection needed)

Open the bank's Reconcile tab in Xero, click the helper toolbar icon, then click
**Read this Xero tab**. Copy the panel's **Xero organisation: … · Bank account: …**
line (or send a screenshot of that line). It contains the observed UI slug and
normalised account UUID. This reading step works before Connect Tenafy is set up.
The API organisation ID and ACJ HSBC S* (April Eve) account UUID are already known
from Tenafy's connection; Xero's read-only Accounts API confirms ACJ Savings is HKD.
We still need to verify the observed UI slug/account pair and configure bank links.

If the organisation reads "unverified", copy the active organisation's settings
link containing `/app/!<slug>/settings`. Never send passwords, session cookies or
login tokens. Do not infer currency from a bare dollar symbol.

## Staff setup (once server mappings are configured)

1. Extract the ZIP into a new folder. In Chrome's extension management page, load
   that folder with **Load unpacked**. Disable the old helper to avoid duplicate
   toolbar entries. No Python installation is required.
2. Sign in to Tenafy normally and keep that tab open in the same browser profile.
   Open Xero's bank Reconcile tab and click the extension toolbar icon.
3. Click **Connect Tenafy**. Chrome asks for optional access only to
   `https://platform.tenafy.com/*`. The helper retrieves the verified organisation
   binding through the signed-in Tenafy tab; it never reads/copies the login token.
4. Click **Read this Xero tab**. The panel shows the observed UI slug and account
   UUID. Enter the verified ISO bank currency and click **Map current account**.
   This stores only non-secret mapping metadata locally. It does not change the
   server mapping; mismatches are rejected by the backend.
5. Click **Find Tenafy leads** on a current line. Review alternatives, source
   availability and copied evidence. Staff perform any matching/creation directly
   in Xero; this version does not offer field filling or candidate selection.

Scroll/change pages normally. The reader follows DOM updates and labels absent
lines. Reattach after a full navigation/reload. Switching away from the attached
Xero tab clears the queue. Results are discarded if row identity changes or a
request was cancelled/superseded; expired proposals require another lookup.

The old `accounts.js` mapping list remains a fallback for local reading. Saved
panel mappings take precedence. Amounts accept unsigned digits with valid comma
grouping and a decimal point. Currency is explicit, never inferred from an amount.
Lookup supports the backend's zero/two-decimal currencies and unambiguous ISO or
English named-month dates; unsupported formats remain for manual review.

## Redacted structure and selector plan

The supplied read-only inspection covered two lines in one account, one Spent and one Received. The controls were in the top-level document, and both line IDs survived reload and scrolling.

| Surface | Selector or rule |
| --- | --- |
| Page and account | `/BankRec/BankRec.aspx?accountID=<id>`. Normalise account ID case and hyphens. Resolve a unique UI slug from Xero links matching `/app/!<slug>/settings`. The UI slug’s relationship to the API tenant ID still needs confirmation. |
| Statement line | `#statementLines > .line[id^="sl"]` with a 32-hex suffix. Scope each line to the organisation and bank account. |
| Date and amounts | Direct child `.bank-transaction`. Read the date under `.line-details > span.font-size-small`. Within the bank transaction, use the populated `.amount-spent > span` or `.amount-received > span`. |
| Reference and counterparty | Summary spans vary. The panel displays them as unclassified text. Verify the labelled detail markup from the row’s **More information** control before assigning Payee, Reference or Description. |
| Pagination | `nav.xui-pagination`. The inspection saw a complete two-item range with no page controls. Verify navigation and row recycling on a larger account. |
| Find & Match | Row-local `a.find` opens the direct-child `.findMatch`. Verify stable candidate identifiers and selection behaviour before implementing candidate selection. |
| Create | Scope the visible controls to the row’s `.statement.create`. Who, What and Why use `paidTo<suffix>_value`, `paidAccount<suffix>_value` and `paidDesc<suffix>`. Tracking and tax inputs are under `.tracking`. Verify picker selection and the committed values, including blank placeholder handling. |
| Staff confirmation | The observed final OK control was `a.okayButton`. Any future fill should resolve the line again and verify account, date, direction, currency and amount before editing. Staff perform final confirmation. |

## Connection and review limits

The staff-tab bridge has two fixed operations: GET the browser binding and POST a
read-only lookup. It uses same-origin browser credentials inside an isolated script
on the exact Tenafy origin. No arbitrary URL/path, token extraction, cookie API,
external key storage or backend CORS relaxation is added. The backend verifies the
expected organisation against its authenticated session; client mappings grant no
access. See [Chrome host permissions](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions)
and [content-script request origins](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests).

Supporting messages are copied, bounded excerpts for linked tenants, not a complete
live Switchboard search. Matching currently returns exact gross-amount leads only.
Splits, part payments, fees, unlinked contacts and missing metadata require further
review. Scores are not payment confirmation. Category/tracking/tax autofill maps,
actual picker commits, active Find & Match candidate IDs and larger-account
pagination/row-removal behaviour still need controlled testing on the staff PC.

The synthetic browser test verifies panel state, real same-origin fetch with a fake
staff cookie, plaintext evidence and stale-result rejection. Chrome APIs/HTTPS
endpoints are intercepted; the real extension permission prompt, side-panel runtime
and live account mappings are not claimed tested. No live financial actions occurred.

## Source and developer checks

Imported from the owner's [tenafy-toolbar-fix.zip](https://drive.google.com/file/d/1qNAwPqLmi1N7-fb5dP27YJ1IV_GQv8Ct/view)
on 2026-11-19. Original ZIP SHA-256:
`be63663d10b30347905f7e3d2c7c02ffbb110fd4845e54a9c070528c4b0c77a8`.
The Drive original is unchanged. Backend contract: `docs/xero-browser-lookup.md`.

From the repository root:

```bash
node --test extensions/xero-side-panel/statement.test.mjs extensions/xero-side-panel/lookup.test.mjs
python scripts/check-xero-helper-ui.py  # playwright, synthetic endpoints only
```
