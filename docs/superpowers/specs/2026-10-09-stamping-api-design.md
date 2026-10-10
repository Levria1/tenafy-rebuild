# Stamping API — design (2026-10-09)

Read-only public API so an external bot can pull everything needed to stamp a signed tenancy agreement
on IRD eTAX, plus the two data fields the payload needs. Context: `docs/stamp-duty-workflow-2026-10-09.md`
(the manual process) and `docs/etax-stamping-handoff.md` (the eTAX side, out of scope here).

Out of scope: any write endpoint (notice/paid/certificate/invoice), the Stamp Status column, eTAX automation.

## 1. Data

Per-org migration `backend/migrations-org/084_stamping_fields.sql` (idempotent via information_schema):

- ~~`property.landlord_br_no`~~ — dropped before deploy (2026-10-10): every entity's BR number is
  already typed into its lease templates' signature block, so the payload reads it from there.
- `tenant.id_type VARCHAR(16) NULL` — `'hkid' | 'passport' | 'other'`; NULL = not recorded.

Backend accepts both on create/update (`routes/property.js`, `routes/tenant.js`), mirroring how
`landlord_name` is handled (trim, empty → NULL, update only when the key is present). `id_type` outside the
allowed set → 400.

**Smart Extract** (`POST /api/tenant/parse`) additionally returns `fields.id_type`:
- `'passport'` when the MRZ parsed with `document_type === 'passport'`;
- `'hkid'` when the extracted `id_card` passes the HKID check-digit test;
- omitted otherwise (never guess).

## 2. Endpoints (mounted under `/api/public`, API key, a read-only key suffices)

### `GET /stamping/queue?signed_since=YYYY-MM-DD`
Signed contract periods, newest first. Rows = the Signing & Stamp Tracking page's rows with
`signed_status === 'signed'` — produced by the SAME `buildSigningRows` over the SAME inputs, so the two
cannot disagree. The input-loading query moves out of `routes/leasing.js` into a shared loader used by both.
`signed_since` is clamped to the tracker's earliest date (2026-09-01) exactly as the tracker clamps `from`.
Per row: `request_id, lease_id, lease_no, property_name, unit_name, tenant_name, period_start, period_end,
period_recorded, signed_method, signed_at`. OTA bookings (`requires_signature = 0`) never appear.

### `GET /stamping/:request_id`
The eTAX payload for one signed document. 404 unless the request exists in this org, `status = 3`, and its
lease is not deleted.

```
request_id, lease_id, lease_no, signature_method, signed_on (YYYY-MM-DD, HK date of completed_at),
duplicates: 0, applicant_capacity: 'landlord', payment_method: 'offline',
term: { start, end, months, exceeds_one_year, period_recorded },
rent: { field: 'monthly'|'total'|null, amount, monthly_rent, total_rent },
address: { flat, floor, block, building, estate, street, district, unit_name, street_address, confident },
tenants: [{ role: 'primary'|'additional', english_name, id_no, id_type, id_type_source }],
landlord: { english_name, br_no, source },
duty_estimate: { duty, tenant_share, rate, basis },
signed_pdf_url, warnings: [{ code, message }]
```

Rules (each one a pure function in `backend/src/services/stampingPayload.js`, unit-tested):

- **Term.** start = `term_start` ?? lease `start_date`. end = `term_stamp_end` ?? `term_end` ?? (lease
  `stamp_end_date` ?? lease `end_date`) — the stamped Term of Tenancy is what the contract prints and what
  eTAX wants. `term_start` NULL → `period_recorded:false` + warning `period_not_recorded`.
  `months` = whole calendar months when start + n months − 1 day === end, else null + warning
  `partial_month_term`. `exceeds_one_year` = end > (start + 12 months − 1 day). Exactly 12 months is NOT
  exceeding.
- **Rent.** Lease rent figure = `COALESCE(NULLIF(price,0), amount)`. Monthly schedules (`invoicing` in
  `'30','monthly'`) → `monthly_rent` = that figure. `invoicing` NULL/'' → the figure is a STAY TOTAL, not a
  monthly rent: `total_rent` = it, `monthly_rent` null, warning `stay_total_lease`. Any other schedule →
  everything null + warning `unsupported_invoicing`.
  Fixed-rent test: any non-deleted `lease_revision` with a non-null `price` different from the lease rent and
  `effective_from` within the term → not fixed, warning `rent_changes_during_term`. Rent-free test:
  `leasing.credits > 0` → warning `lease_has_credits` (treated as possibly rent-free).
  `field = 'monthly'` only if exceeds_one_year AND fixed AND no credits AND monthly_rent known; amount =
  monthly_rent. Otherwise `field = 'total'`, amount = total_rent (monthly_rent × months when both known),
  null if not computable (then `field` null too).
- **Duty estimate** (cross-check only; the IRD notice is the real figure). Term ≤ 1 year: 0.25% × total rent.
  > 1 to ≤ 3 years: 0.5% × average yearly rent; > 3 years: 1% × AYR (AYR = total ÷ term years, term years =
  months ÷ 12). Round UP to the whole dollar. Duplicates 0 → no HK$5. `tenant_share` = duty ÷ 2 (2 dp).
  Null when the inputs are null. Golden case: 12 × 19,000 = 228,000 → 570, share 285.
- **Address.** `street_address` and `district` from the property (trimmed — several have leading spaces).
  Unit `^\d{1,2}[A-Z]$` (`5A`) → floor `5`, flat `A`. Unit `^\d{1,2}/F$` (`25/F`) → floor `25`, flat null.
  Street with a comma: first part → `building` when it contains no digit (`Nam Pak Hong Building, 24 Bonham
  Strand West`), otherwise the whole thing is unparsed. Anything else (`Unit 26`, `3D-A`,
  `3/F Unit 1 (Room A and Room B)`, `12-B6 Pearl City Mansion, …`) → `confident:false`, fields null, raw
  values still returned, warning `address_unparsed`. Missing district → warning `missing_district`.
- **Tenants.** Primary + `leasing_additional_tenant`. `english_name` = company name, else first + last.
  `id_no` = trimmed `id_card`. `id_type` = recorded column (`id_type_source:'recorded'`); else inferred
  `'hkid'` if it passes the HKID check digit (`'inferred'`, warning `id_type_inferred`); else null
  (`'unknown'`, warning `id_type_unknown`). Never infer passport. Missing id_card → warning `missing_id_no`.
- **Landlord** (revised 2026-10-10). Read "Name: … Business Registration Number: NNNNNNNN" from the
  landlord signature block of the exact template version on `signature_request.template_id/version`
  (live `lease_template` row if still at that version, else the `lease_template_revision` snapshot;
  org-scoped). No template on the document → the property's allowed templates, only if they all agree
  (`landlord_from_property_template`; disagreeing → `landlord_ambiguous`). Else unit account name /
  property entity with `br_no` null (`missing_br_no`). A signed template with no BR line →
  `br_not_in_template`. Verified on prod data: all 8 current templates and every one of the 83
  template-bearing signed documents resolve to the right company and BR. Pearl City's property field
  says ACJ, its templates say Parcelle — the template wins.
- `signed_pdf_url` = `/api/public/stamping/<id>/document` when `signed_file_id` is set, else null +
  warning `no_signed_file` (paper recorded without a scan).

### `GET /stamping/:request_id/document`
Streams the signed PDF (`signed_file_id` → `file.item_name` under uploads), same org/status checks as above;
404 when absent. Mirrors `GET /api/signature/public/:token/pdf`.

## 3. Security
All three are GETs, so `authenticateApiKey` already lets a read-only key through and refuses nothing extra.
The payload carries tenant ID numbers; any key can already read `id_card` via `/tenants/:id`, so no new
exposure class. Give the bot its own key.

## 4. Live data at design time (tena_prod_v2, org 8300127259922432)
- 871 tenants with an id_card: 245 bracketed-HKID format, 626 other (many unbracketed, ambiguous).
- Unit names: mostly `<floor><letter>`; Tai Yuen `NN/F`; irregular: Pearl City `Unit NN`, Lai Yuen `Unit 10N`,
  Po Thai `3D-A`, Fuk Lo Tsun `3/F Unit 1 (…)`.
- Po Thai has no landlord_name; Mercer has no district.
