# Automatic tenant sections and signing setup

Implemented locally on `feat/joint-tenant-contracts`, based on main `f0667a6` and
the approved formatting proof `2ede873`. Not deployed. No live templates,
contacts, leases, signing requests or tenant messages were changed.

## Staff workflow after release

1. Record each person as a tenant/contact, with their legal name, identification
   number and email. Select the primary tenant and Additional Tenants on the lease.
2. Once per contract template, open Settings → Lease Templates → Edit →
   **Preview tenant-block upgrade**. Compare the one-tenant and two-tenant PDFs.
   **Use this upgrade in the editor** stages the conversion; **Save changes**
   creates the new template version. It does not modify sent PDFs.
3. For new contracts, select the upgraded template in Review & Send. The template
   automatically renders the required tenant details and labelled signature
   spaces. All lease tenants are prefilled as required signers.
4. Required names/emails come from contact records. Correct missing/wrong details
   there and reload the page. Required tenants cannot be removed. Optional
   non-tenant signers can still be added as Guarantor or Other.
5. Review the PDF and send explicitly. The server verifies every required tenant,
   their names/emails and the preview snapshot. Changed source details require a
   refreshed preview. Each listed signer receives their own link; completion
   still requires all listed parties to sign.

## Template representation

New variables:

- `{{TENANT_PARTIES}}`: all tenant names and identification details.
- `{{TENANT_SIGNATURES}}`: labelled signature blocks for the same ordered tenants.

The upgrade recognises the approved Tane Residence-style paragraph layout. It
replaces only the tenant-details and tenant-signature sections and stores their
original HTML in `tenant_layout` JSON. A single tenant reuses those original
paragraphs; joint tenants repeat them, with two-column signature spaces. Long
names/emails wrap. Each template/revision stores its own layout recipe.

Unknown/custom source layouts are refused without saving anything. They require
a reviewed manual conversion using the new variables. New templates may insert
the variables directly and use the default block layout. Existing variables keep
their previous meanings. No existing template is converted by migration or startup.

Data values are escaped after name formatting. Generated block HTML is inserted
after ordinary substitutions so contact values cannot invoke another variable.
Quill's surrounding paragraph is removed when a token occupies the whole paragraph,
preventing invalid nested block markup from changing pagination. Dynamic signature
previews use production-size anchors; dashed legacy placeholders are too wide for
reliable two-column previewing.

The first three tenant signatures use the existing anchors. Further tenants and
non-tenant signers use the existing appended-signature mechanism, now paginated
when needed. Guarantors/Other do not take a mapped tenant's anchor. Historical
requests without tenant IDs retain their previous role-to-anchor interpretation.

## Identity and document history

`leaseTenants.loadLeaseTenants` loads a lease through its property organisation,
then resolves tenant records within that same organisation. Primary is first,
additional IDs are sorted numerically, and duplicate IDs are removed. A missing,
deleted or foreign linked record is returned with no personal data, rather than
silently omitting a required party. This blocks signing until staff repair it.
Company legal names use the existing person/company formatter and its person-name
fallback. Middle names are shared consistently between the contract and signers.

New signature-party rows record a nullable `tenant_id`. The server requires every
lease tenant once, checks names/emails against the contact records and canonicalises
order. Non-tenant signers carry no tenant ID and follow required tenants. Single-
tenant legacy callers may omit tenant_id; joint requests must supply it.

PDF preview returns `X-Document-Snapshot` and `X-Tenant-Template-Ready`. The snapshot
hash covers the source lease, tenants, property/unit, currency, printed date and
template content/version/layout, after applying the document's term override.
The updated frontend sends `document_snapshot`; a mismatch returns 409 before
PDF storage or signature-request creation. Joint requests require a snapshot.
An incompatible joint template is rejected before sending. Required fields in
dynamic blocks are checked individually, including each tenant's ID and email.

Template update uses a transaction, row lock and `expected_version`. The prior
HTML and layout recipe are snapshotted together. A stale edit returns 409 without
adding a revision. Template duplication retains the recipe and a version-1
snapshot. Future renders cannot rewrite an already-stored unsigned/signed PDF.
New signing PDFs are private; existing files are not reclassified.

## Migration and release boundary

Migration `088_joint_tenant_templates.sql` adds only:

- `signature_party.tenant_id`, nullable, with no historical backfill;
- `lease_template.tenant_layout`, nullable JSON;
- `lease_template_revision.tenant_layout`, nullable JSON.

It was run twice on disposable MySQL. Existing rows retain their old values.
Apply it through the normal organisation migration process only in an approved
release, before starting the new backend. No live migration was run here.

After release, upgrade each intended template through the preview/save workflow.
Do not roll the code back after adopting new variables without first planning
restoration of those templates to their prior versions. Keep historical files and
revisions. Pushing, merging, deployment and live data/template changes remain
subject to the owner's separate approval for that change.

## Validation

- Focused contract/request/stamper/signature tests: 45 pass.
- Full backend suite: 1,948 tests, 1,943 pass, four pre-existing failures,
  one optional MySQL test skipped (run separately on scratch MySQL). The same
  four failures were reproduced on unchanged main: three renewal-scheduler
  fixtures and the rent-period-note scheduler insert test.
- Scratch MySQL integration passes: migration twice, no foreign tenant data,
  explicit unsaved conversion, version snapshots, stale-save rejection, duplication
  and historical-row preservation.
- Three production-rendered cases (one tenant, two tenants, longer names/emails)
  preserve the approved layout, with the requested signature-underline correction.
  Markers occupy zero width in upgraded layouts so the underline begins beneath
  the signature. Ten single-tenant baseline pages are pixel-identical; only the
  signature page changes. The normal completion certificate is page 12. The other
  nine contract pages remain unchanged between cases. Real PDF geometry checks
  verify that every tenant signature aligns with its underline.
- Local Chromium smoke checks use intercepted synthetic APIs only: both tenants
  prefill, required rows cannot be removed, blank extras cannot be silently
  dropped, send includes both tenant IDs/snapshot, Quill-normalised source converts,
  both upgrade counts are previewed and the saved DTO preserves layout/version.
  Headless-shell does not paint embedded PDF viewers; PDF contents are separately
  rendered, rasterised and visually inspected.
- Frontend production build and targeted ESLint (Next core-web-vitals) pass. No live emails or
  signing requests were used for testing.

Useful commands:

```bash
cd backend
node --test test/jointTenantContracts.test.js test/jointTenantRequests.test.js test/jointTenantStamping.test.js test/signatureTerm.test.js test/signatureOverlap.test.js test/signatureUnicodeNames.test.js
# Disposable local scratch socket only:
STAMP_TEST_SOCKET=/tmp/tenafy-stamp-local/mysql.sock node --test test/jointTenantMysql.test.js
cd ..
node scripts/render-joint-tenant-preview.cjs
python scripts/check-joint-tenant-preview.py  # requires pymupdf
python scripts/check-joint-tenant-ui.py       # requires playwright; local Next on 127.0.0.1:4067
```
