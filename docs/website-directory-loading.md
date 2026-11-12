# Website product directory

The unit website name is a second name for matching renter text. Product numbers
identify a listing even when its permalink changes. Multiple website copies can
map to one unit; `(org_id, product_id)` is the database primary key, so a product
cannot belong to two units in one org.

## Setup and review

Schema: `backend/migrations/045_unit_website_products.sql`. The equivalent,
idempotent `backend/migrations-org/086_unit_website_products.sql` is included for
the current `migrate:orgs` deployment workflow. They add `unit.website_name`,
`organization.website_base_url`, and `unit_website_product`. They contain no
org-specific seed data and opt nobody in.

Set **Settings → Landlord → Public listings website** to the organization's
public base URL. All Store API calls and old-link redirect checks are limited to
that host. Leaving it blank disables outbound website lookups. Staff can edit
the unit website name and the product list beside the existing listing URL in
the unit edit form. The first product is primary. Saving a primary product also
updates `unit.listing_url`; removing all mappings does not erase the existing
listing URL. A product assigned to another unit is rejected with 409.
The website setting has its own save button and org-scoped
`GET/PUT /api/user/setting/website` endpoint; changing it requires an org
superadmin and does not modify other landlord settings.

The owner must separately approve a live migration, a live loader `--apply`,
and a deployment. These instructions grant none of those approvals. Merge is
also a separate owner decision.

## Dry run (default)

From `backend`, after schema/configuration are in place:

```bash
node scripts/loadWebsiteDirectory.js --org ORG_ID --csv /path/to/Units.csv --report /path/to/report.md
```

This uses the SELECT-only org pool and reads the public WooCommerce Store API
without a key. It writes only the local Markdown report, never Tenafy data. Keep
the report outside the read-only source directory. The report lists each loaded
row, copy, row needing staff, and website product with no mapped unit. Printed
counts mean planned rows/products in dry run, not database changes.

Unit IDs come from the `/unit/<id>` suffix in the checked sheet, never inferred
from unit/property names. Only active, non-deleted units/properties are eligible.
Blank/unverified links or names, mismatched product names, duplicate name-to-unit
assignments and existing product ownership conflicts stay in `needs staff`.
Same-name website copies are added only after a primary sheet pair is confirmed.
Products for rows with no checked link are not guessed into a unit by name.

After a separate approval, the same command with `--apply` writes only the loaded
rows/copies. It obtains a writer only in that mode, locks the org, rechecks current
units/mappings and setting, and commits the batch transactionally. Re-running it
updates the same keys; it never silently transfers a product to another unit or
loads a needs-staff row. It sets each loaded unit's current primary permalink.

## Snapshot dry run and name replay

If a local database is unavailable, a SELECT-only snapshot can be used without
creating or migrating a database. The JSON shape is
`{"org_id":"...","units":[...],"mappings":[...]}`. Unit fields are those returned
by the exported `readUnits` function in the loader; mappings contain
`unit_id,product_id`. Include the real address/district/city fields for an accurate
baseline of the existing resolver. A normalized products JSON is the output of
`fetchProducts(baseUrl)` in `src/services/websiteProducts.js`.

```bash
node scripts/loadWebsiteDirectory.js --org ORG_ID --csv /path/to/Units.csv --snapshot /path/to/units.json --website https://your-website.example/ --products /path/to/products.json --report /path/to/report.md
node scripts/replayWebsiteDirectory.js --org ORG_ID --csv /path/to/Units.csv --snapshot /path/to/units.json --website https://your-website.example/ --products /path/to/products.json
```

The website override is permitted only for snapshot dry runs. `--apply` rejects
snapshot, website and products overrides. The replay derives its denominator
from active sheet rows with website names and links; it supplies aliases only for
rows accepted by the loader, reports before/after counts and each unresolved row,
and fails on any regression. It does not assume a target count or load disputed
aliases to improve the result.

## Measured review, 12 November 2026

Input: the owner's checked `Units.csv` (146 rows, 19 properties), a fresh public
Store API list (125 products), and an org-scoped, SELECT-only unit snapshot.
No usable local read-only database connection or local MySQL server was present.
No live schema, setting or directory data was changed.

| Dry-run group | Count |
|---|---:|
| Loaded units | 103 |
| Copies added | 13 |
| Needs staff | 43 |
| Website products with no unit | 9 |

Needs staff includes the six explicitly held rows (four duplicate Tai Yuen A/B
assignments and two unverified Po Thai pages), plus 37 other inactive/missing-link
rows. Unmatched website products remain unmatched even if their name resembles
a unit lacking a checked link.

Name replay: **98/109 before → 103/109 after, zero regressions**. The before count
was independently confirmed against untouched `main` at `36d99e9`, with the actual
public unit scope and location fields. The prompt's earlier 85/109 was not
reproduced. The only six unresolved rows after loading are the held Tai Yuen A/B
and Po Thai rows. It is not possible to identify each duplicated Tai Yuen name
confidently as two different units without a staff decision.

Migration SQL has not been executed against a local or live MySQL instance in
this review; transactional loader/editor behavior is covered with fake pools,
and website behavior uses stubbed HTTP in automated tests. Real-database
migration/unique-key verification remains a pre-deployment check after approval.
