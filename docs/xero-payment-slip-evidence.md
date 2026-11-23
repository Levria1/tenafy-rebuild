# Payment slips for Xero reconciliation

Switchboard remains the source for the original message. Its existing
integration search and conversation endpoints return a media flag, but no
authorised attachment download. Staff can download an attachment in Switchboard
and import that file with its message reference in the Tenafy Chrome helper.

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

The rollout requires organisation migration 090, the matching Chrome helper,
and a controlled test on an unsaved Xero draft before enabling it for staff.
No Switchboard changes or Xero OAuth scope changes are needed for this flow.
Automatic attachment ingestion would need a supported Switchboard download
interface with per-organisation access and stable attachment IDs.
