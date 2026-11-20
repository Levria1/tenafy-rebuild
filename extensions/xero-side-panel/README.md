# Tenafy reconciliation review

Version0.4.0 adds automatic setup for the ten enabled Xero bank accounts and identity-first matching. It loads
verified account/currency mappings from Tenafy instead of asking each staff member
to enter bank settings. This backend/helper increment is built but not deployed;
wait for its approved release before installing it. The released package is0.3.
No Xero fields or final confirmation controls are edited.

## Updating the helper

Extract the new ZIP, open its inner folder containing manifest.json, and copy the
files over the contents of the existing loaded helper folder. Click Reload in
chrome://extensions, reopen the panel, and verify version 0.4.0. Keeping the same
folder retains the extension ID and local mapping settings.

## First: send the mapping identity (no connection needed)

Open the bank's Reconcile tab in Xero, click the helper toolbar icon, then click
**Read this Xero tab**. Copy the panel's **Xero organisation: … · Bank account: …**
line (or send a screenshot of that line). It contains the observed UI slug and
normalised account UUID. This reading step works before Connect Tenafy is set up.
The API organisation ID and ACJ HSBC S* (April Eve) account UUID are already known
from Tenafy's connection; Xero's read-only Accounts API confirms ACJ Savings is HKD.
The screenshot/API UI organisation code has now been verified and saved. Bank,
property and currency bindings for ACJ Savings are configured; other banks need verification.

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
   UUID. The bank and currency load automatically from the verified enabled mapping.
   A bank outside that set remains blocked until its server setup is reviewed.
5. Click **Find Tenafy leads** on a current line. Review alternatives, source
   availability and copied evidence. Staff perform any matching/creation directly
   in Xero; this version does not offer field filling or candidate selection.

Scroll/change pages normally. The reader follows DOM updates and labels absent
lines. Reattach after a full navigation/reload. Switching away from the attached
Xero tab clears the queue. Results are discarded if row identity changes or a
request was cancelled/superseded; expired proposals require another lookup.

Server-verified enabled mappings are authoritative. Old per-staff saved mappings
do not override them. Amounts accept unsigned digits with valid comma
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

The staff-tab bridge has four fixed operations: GET the browser binding and bank catalogue,
POST a read-only lookup, and POST a read-only history page. It uses same-origin browser credentials inside an isolated script
on the exact Tenafy origin. No arbitrary URL/path, token extraction, cookie API,
external key storage or backend CORS relaxation is added. The backend verifies the
expected organisation against its authenticated session; client mappings grant no
access. See [Chrome host permissions](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions)
and [content-script request origins](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests).

Supporting evidence searches six calendar days ending on the bank transaction
date, including owned inquiry contacts and safely scoped unlinked sessions. For
19 November this is 14–19 November. With no hits it automatically widens to thirty
days (21 October–19 November). Click Search 30 days to widen when recent hits
exist but none is right. The six/thirty-day modes exclude messages/context
outside the selected dates. Search all history explicitly removes that date
filter; Search 30 days narrows it again. Automatic expansion never selects all
history. These database searches use zero LLM tokens; OCR or AI assessment would
be a separate future feature.
The panel shows contacts, one preceding/following reply and a conversation link.
More messages/Previous messages replace the displayed page. Coverage shows the
stored message count and date range. Foreign/internally scoped messages are
excluded; uncertain ownership produces a visible incomplete-search notice.

This is not a live external Switchboard archive or slip-image/OCR search. Currency,
who paid, and invoice allocation require staff review. Financial candidates still
require exact gross amounts in the mapped bank/currency; splits, part payments and
fees need review. Scores are not payment confirmation. Category/tracking/tax
filling and live Xero picker behaviour remain future work.

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

## Identity-first matching in the pending 0.4 build

Named bank lines filter by payer/beneficiary name, and recognised business references
filter exact reference tokens. Both must match when both are present. A failed
identity match does not show unrelated people who happen to have the same amount.
Amount-only fallback is labelled unverified and is available only when no usable
name/reference exists. Unclassified or truncated identity needs manual review.
Name aliases, third-party payers and unfamiliar bank formats can need manual review.
This does not add automatic filling or final confirmation.
