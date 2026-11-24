# Payment slips for Xero reconciliation

Switchboard remains the source for the original message. The Chrome helper can
find attachments near a bank date in the configured Payments inbox or list the
attachments from a Switchboard conversation link. Tenafy fetches the selected
original server to server through Switchboard's payment slip integration.
The staff upload control remains available for files from other sources.

Tenafy keeps a private, organisation-scoped copy of the supplied original.
It deduplicates exact file bytes per organisation. The existing Google Cloud
Vision integration reads PNG/JPEG, or up to five pages of a PDF. When OCR fails
or a field is unclear, staff can fill in the values from the original.

Accounting Create is required for import, verification and confirmation.
Accounting readers can find and review verified slips. An imported slip becomes
searchable only after staff verify its amount, currency and transfer date.
The reconciliation lookup returns separate slip leads for identical amounts
and currencies within seven days of the statement date. These fields alone
do not confirm that a transfer belongs to the bank line.

Staff preview the original and confirm a bank line, with an optional eligible
invoice. Confirmation records the staff member, slip, bank account and bank
line. The helper checks the current Xero draft and stages the exact reviewed
file in its attachment control. Staff verify the upload before saving the
draft. For a form that cannot be tied to the selected row, staff can download
the exact original and use Xero's attachment picker themselves.

Release the Switchboard slip route and configure the dedicated integration key
and Payments mailbox scope on that instance. In Tenafy set
`TANECHAT_SLIP_ORG_ID` to the Tenafy organisation authorised to use that instance and
`TANECHAT_SLIP_API_KEY` to the matching dedicated credential. The request
uses the existing `TANECHAT_API_URL` HTTPS integration address and never
passes the key to Chrome. Keep the regular messaging key separate.

Apply organisation migration 090 and install the matching 0.4.6 helper.
Verify OCR and attachment staging on an unsaved Xero draft. The integration
fetches selected files on demand. Xero OAuth permissions are unchanged.
