# FAQ property tagging and website publishing design

Date: 2026-08-20

## Goals and non-goals

Feature A lets staff make an FAQ or rule apply only to named properties. The critical requirement is containment: a property-specific answer, especially payment instructions, must never reach a tenant unless the tenant's property is known and matches the entry.

Feature B lets the WordPress marketing site render selected FAQs from the same database without treating the existing partner-facing `public` visibility as approval for open-internet publication.

This design does not change the per-organisation database model: `req.pool` remains the organisation boundary and no new table carries `org_id`.

## Decisions

### A. Property scoping

Use a join table from `chat_knowledge` to `property`, not the unused `tags` JSON column. Application validation prevents nonexistent or soft-deleted property IDs; property renames are automatically reflected because names are read from `property`; indexed rows are queryable and enforce one link per entry/property. JSON would permit typos and stale names and is awkward to index and join. Leave `tags` unchanged for future free-form taxonomy; do not overload it with property identity.

An entry with zero rows in the join table is explicitly **global** and applies to every property. One or more links makes it **property-scoped** and applicable to any of those linked properties only.

The partner feed is filtered on the server:

- With no `property_id`, `rules`, `faqs`, and `prompt_block` contain global entries only. Property-scoped bodies are never returned.
- With a valid `property_id`, those fields contain global entries plus entries linked to exactly that property.
- The no-property response includes `property_topics`, containing scoped entry IDs, kinds, and allowed active property IDs/names, but neither titles nor bodies. Omitting staff-authored text is a structural metadata boundary: a title containing an account number cannot escape it. When scoped topics exist and a question may need knowledge content, TaneChat must establish the building and fetch again with the selected property ID: it may use the unique active-lease phone resolution defined below, but otherwise must ask. It must not infer a property from a likely answer, choose the only apparent topic match, or answer from prior cached scoped content.
- A supplied property ID that does not exist returns `400 INVALID_PROPERTY`; it never falls back to global or another property. TaneChat must resolve ambiguous names to an ID or ask the tenant.
- TaneChat must keep response variants isolated by organisation and property ID. It must construct a turn's prompt only from the current property's response. A property change invalidates the previous prompt before another answer is generated.

This makes scoped answer bodies unavailable at the point where the property is unknown, rather than relying on an LLM instruction to ignore dangerous text.

### B. Website publication

Add a separate `publish_website` boolean to `chat_knowledge`. Do not add a third `visibility` value: partner sharing and website publishing are independent audiences, so an enum would create coupled combinations and unclear precedence. All existing rows receive the default `0`; therefore all 29 currently partner-visible rows keep their meaning and none becomes internet-published. Website output also requires `kind = 'faq'`, `status = 1`, and `publish_website = 1`; rules can never be published even if the flag is set accidentally.

Use a keyless, CORS-enabled website endpoint that resolves an explicit, stable public organisation slug to an organisation pool and serves only website-published FAQs. This is preferable to the existing API-key mechanism: `apiKeyAuth` distinguishes only `read_only`, and every read-only key can call all GET routes under the 63-route public router, including tenants, leases, invoices, payments, accounting, and `/chat/knowledge`. Storing such a key on WordPress would turn a website compromise into tenant-database access. Per-key endpoint scoping would be a valid future platform project, but would require MASTER `api_keys` scope columns, middleware enforcement, both super-admin key-management surfaces, migration/default policy for the five existing keys, and regression tests before WordPress work. That prerequisite is disproportionate when the selected FAQ content is intentionally public.

The slug does not exist today and must be added to the MASTER `organizations` table before this endpoint can work. Keep the slug rather than substituting the existing organisation ID. Although either value can select a pool and neither is a secret, the numeric ID is an internal database identity already propagated through authenticated records and integrations; putting it in a permanent public URL unnecessarily couples the website contract to that identity. A purpose-built slug is readable, independently stable across a database restore or organisation reprovisioning, and can be rotated deliberately if a public URL must change. It is a locator only and grants no authority.

The public route is narrow by construction: it has its own pre-auth router/handler, accepts only the organisation slug and optional property ID, and its query hard-codes active `kind = 'faq'` rows with `publish_website = 1`. It cannot return rules or dispatch to another public route. Allow CORS only for configured website origins (plus normal non-browser server-to-server access); do not use `*`. Apply an IP-and-organisation rate limit (60 requests/minute with a short burst), request timeouts and response-size limits, and put the response behind the existing reverse proxy/CDN. An attacker can scrape FAQ text already rendered on the open website; they gain no unpublished, rule, or tenant data. Public cache headers and conditional requests reduce origin load, while the limiter and CDN absorb abusive request rates rather than pretending a broadly privileged key prevents DoS.

Property scoping applies to website FAQs too. The initial page shows global published FAQs and a property selector when published scoped FAQs exist. After a visitor selects a property, WordPress requests that property variant and shows global plus matching scoped FAQs. Scoped bodies are not sent or rendered before selection; the site must not combine variants. This is the same containment rule as the chatbot.

## Data model and migrations

### FAQ categories and ordering

FAQs store one fixed category key: `payments`, `moving_in`, `moving_out`, `maintenance`, `building_access`, `lease_renewal`, or `other` (default). The UI displays friendly labels. Rules do not carry a category: they shape behaviour rather than website FAQ navigation, and falsely categorising them would make topic routing less precise. The fixed code-owned list prevents staff-authored secrets such as account numbers entering unknown-property metadata, while restoring enough safe topic information for the bot to decide whether it must establish a building. `property_topics` therefore includes `category` for FAQs. A staff-managed category list may follow later, but is not v1 because it would require safe-key governance, rename/version semantics, and protection against sensitive free text.

`sort_order` is editable as an integer in the existing table/modal. A number field is chosen over drag-to-reorder because it fits the current filtered table without page restyling and remains unambiguous across Public/Internal filters and search results. Zero is a valid explicit value and is never treated as empty; ordering remains `sort_order ASC, created_at ASC`.

### MASTER migration 045: organisation public slug

Create `backend/migrations/045_organization_public_slug.sql`. This is deliberately under `backend/migrations/`, not `backend/migrations-org/`: from the `backend/` directory, `npm run migrate` runs `backend/migrate.js`, which reads that directory and connects to the configured main/MASTER database. `npm run migrate:orgs` runs the separate `backend/migrate-orgs.js` against every active organisation database and must not own this column.

Use a nullable column so an unconfigured organisation fails closed, a case-insensitive unique index, and a database format constraint. The public format is 3–63 lowercase ASCII characters, beginning and ending with a letter or digit, with single hyphens allowed between groups. Application validation uses the same regex, `^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){1,61}[a-z0-9]$`, before writing or resolving a slug.

```sql
-- 045_organization_public_slug.sql  (MASTER)

ALTER TABLE organizations
  ADD COLUMN public_slug VARCHAR(63)
    CHARACTER SET ascii COLLATE ascii_general_ci NULL AFTER display_name,
  ADD CONSTRAINT chk_organizations_public_slug
    CHECK (public_slug IS NULL OR public_slug REGEXP '^[a-z0-9]([a-z0-9]|-[a-z0-9]){1,61}[a-z0-9]$'),
  ADD UNIQUE KEY uq_organizations_public_slug (public_slug);

-- Before deployment, insert one reviewed, explicit UPDATE per existing organisation ID:
-- UPDATE organizations SET public_slug = 'tenafy' WHERE id = <reviewed-id> AND public_slug IS NULL;
```

Do not derive public URLs silently from `display_name`: transliteration, punctuation removal, and collision suffixes create unstable or surprising names. The deployment migration must contain a reviewed explicit ID-to-slug mapping for every organisation intended to publish. Multiple `NULL` values are allowed. An active organisation with `public_slug IS NULL` simply has no website endpoint; no fallback to ID, database name, display name, or another organisation is permitted. Unknown, null, inactive, or `public_api_enabled = 0` slug resolution returns the same `404`, avoiding an organisation-enumeration distinction.

No new management UI is required for the initial three organisations: reviewed migration values are enough and minimize accidental URL changes. However, new organisation provisioning must accept or generate a reviewed unique slug and store it in the MASTER insert before website publication can be enabled. Until a later authenticated master-admin surface is built with collision preview and explicit URL-change warnings, subsequent slug changes are operator-controlled MASTER migrations. The master organisation read API may expose `public_slug` to authenticated master admins, but ordinary per-org settings cannot edit it.

### Per-organisation migration 071

Create `backend/migrations-org/071_chat_knowledge_property_and_website.sql`. Exact migration DDL:

```sql
-- 071_chat_knowledge_property_and_website.sql  (PER-ORG)

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'chat_knowledge' AND COLUMN_NAME = 'publish_website');
SET @s := IF(@c = 0,
  'ALTER TABLE chat_knowledge ADD COLUMN publish_website TINYINT(1) NOT NULL DEFAULT 0 AFTER visibility',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'chat_knowledge' AND COLUMN_NAME = 'category');
SET @s := IF(@c = 0,
  'ALTER TABLE chat_knowledge ADD COLUMN category VARCHAR(32) NOT NULL DEFAULT ''other'' AFTER kind',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;

SET @t := (SELECT COUNT(*) FROM information_schema.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'chat_knowledge_property');
SET @s := IF(@t = 0,
  'CREATE TABLE chat_knowledge_property (
     chat_knowledge_id BIGINT NOT NULL,
     property_id BIGINT NOT NULL,
     created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
     PRIMARY KEY (chat_knowledge_id, property_id),
     KEY idx_ckp_property (property_id, chat_knowledge_id),
     CONSTRAINT fk_ckp_knowledge FOREIGN KEY (chat_knowledge_id) REFERENCES chat_knowledge(id) ON DELETE CASCADE
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
  'SELECT 1');
PREPARE st FROM @s; EXECUTE st; DEALLOCATE PREPARE st;
```

The migration performs no backfill. Existing entries have no join rows (global) and `publish_website = 0` (not website-published), preserving current behavior.

This would introduce the first foreign key in a schema with 116 tables and currently zero foreign-key constraints. That departure is intentional only for `chat_knowledge_id`: `ON DELETE CASCADE` guarantees link cleanup when knowledge is hard-deleted and removes an application cleanup obligation. Do not add the proposed property FK. Property deletion is soft deletion in this codebase, so `ON DELETE RESTRICT` would never fire in the normal path and would add deploy risk without enforcing the desired rule. The migration must be rehearsed against schema copies of all three organisation databases before `npm run migrate:orgs`; a constraint-creation failure causes that command to exit non-zero and blocks the application deploy, even though its runner continues far enough to report failures for every org.

Soft-deleted properties remain represented by join rows. Query policy is explicit:

- Property selection and POST/PUT validation use only `property.deleted_at IS NULL`; staff cannot create new links to deleted properties.
- Partner and website eligibility joins use only `property.deleted_at IS NULL`; deleted properties, their topic metadata, and their scoped bodies are never served.
- Staff knowledge reads retain links to deleted properties with a left join that does not filter them out, returning a `deleted: true` marker. This preserves an honest view of stored scope and lets the UI show what must be re-scoped.

If every linked property is soft-deleted, the join rows remain, so the entry does not become global; it is served to nobody. This is the safe failure direction, but the staff list and edit form must flag it as **Scoped only to deleted properties — currently invisible**. The property soft-delete route must run the same `409 PROPERTY_HAS_KNOWLEDGE` preflight before setting `deleted_at`; staff must re-scope or delete linked knowledge first. This preflight, not a property FK, enforces deletion safety.

## API contracts

### Staff CRUD: additive fields

All staff knowledge reads add `publish_website`, `property_ids`, resolved `properties`, and the FAQ `category`; `sort_order` remains present and is now editable. POST, PUT, and bulk writes accept these fields. Existing clients that omit them create an unpublished global entry; on PUT, omission preserves scope and publication state so an older client cannot silently erase either.

```json
{
  "kind": "faq",
  "category": "payments",
  "title": "Where do I pay rent?",
  "body": "Pay to account ...",
  "visibility": "public",
  "status": 1,
  "publish_website": true,
  "property_ids": [42]
}
```

```json
{
  "id": 91,
  "kind": "faq",
  "title": "Where do I pay rent?",
  "body": "Pay to account ...",
  "visibility": "public",
  "publish_website": true,
  "property_ids": [42],
  "properties": [{"id": 42, "display_name": "Nam Pak Hong"}]
}
```

POST/PUT validate all property IDs in one transaction and return `400 INVALID_PROPERTY` without changing either table if any ID is invalid. IDs are deduplicated. Bulk requests gain the same optional fields and transaction semantics per existing bulk operation. `publish_website: true` is rejected unless `kind` is `faq`; changing a published FAQ to a rule atomically clears the flag.

Add authenticated `GET /knowledge/properties`, returning `[{"id":42,"display_name":"Nam Pak Hong"}]`, ordered by display name then ID.

### Partner feed: additive protocol, safer variant semantics

`GET /api/public/chat/knowledge` remains valid. It returns the same top-level fields, but after scoped entries exist its legacy/no-query variant includes global content only. That is intentionally safe and does not change any of today's 29 partner-visible rows because they migrate as global. Add optional `property_id=<bigint>`.

```json
{
  "version": "etag-for-this-org-and-property-variant",
  "property_context": null,
  "rules": [{"id": 1, "title": "...", "body": "..."}],
  "faqs": [{"id": 30, "title": "...", "body": "..."}],
  "prompt_block": "existing rendering of global entries only",
  "property_topics": [
    {
      "id": 91,
      "kind": "faq",
      "category": "payments",
      "properties": [{"id": 42, "display_name": "Nam Pak Hong"}]
    }
  ]
}
```

For `?property_id=42`, `property_context` is `{"id":42,"display_name":"Nam Pak Hong"}`, `rules`, `faqs`, and `prompt_block` contain global plus property 42 content, and `property_topics` is omitted. Existing field shapes are unchanged. The new query parameter and fields are additive; no current row disappears. Support for actually using future scoped entries requires partner work and coordination. ETags are computed per complete response variant, include scope links and property names, and `If-None-Match` continues to return `304`. The absent-table fallback treats the join table as absent/global during a rolling deployment; migration must precede application rollout.

### Phone-assisted property resolution

Recommend that TaneChat call the existing authenticated `GET /api/public/tenants/lookup?phone=<number>` first and, only when its extended response has exactly one distinct active property, pass that canonical `property_id` to `/chat/knowledge` as already designed. Do not add `phone` to the knowledge endpoint. Keeping contact classification and lease traversal in the existing lookup gives the rule one server-side owner, while keeping the knowledge feed independent of tenant PII, reusable by non-WhatsApp clients, and cacheable solely by organisation/property. Server-side phone resolution inside the knowledge feed would couple a read-mostly content endpoint to tenant and lease semantics, put phone numbers into more request logs and telemetry, and complicate ETags without improving the trustworthiness of the match.

The existing lookup needs an additive response extension because today it selects only one best lease per matched tenant and returns a property name, not the canonical property ID or the full set of active properties. It must reuse `conversationKey()` from `backend/src/utils/renewalAsk.js` for input and stored-phone comparison: strip non-digits and compare exactly the last eight digits. Remove the lookup's separate 7-or-8-digit suffix behavior so there is one definition of a WhatsApp conversation. Inputs with fewer than eight digits cannot resolve. For all matching tenant records, inspect every non-deleted lease active on the organisation's current date and return distinct active properties, deduplicated by property ID. Several active leases in the same building produce one candidate and are not ambiguous for property scoping. Several tenants or leases that collapse to one property are likewise safe for property selection; more than one distinct property is ambiguous regardless of which lease appears most relevant.

```json
{
  "matched": true,
  "classification": "existing",
  "count": 1,
  "tenants": [{"tenant_id":"17","name":"...","classification":"existing","lease":{"...":"existing fields"}}],
  "active_properties": [{"id":42,"display_name":"Nam Pak Hong"}],
  "property_resolution": "unique"
}
```

`property_resolution` is `unique` only when `active_properties` has exactly one distinct property, `ambiguous` when it has more than one, and `none` otherwise. The existing fields remain for compatibility. TaneChat may auto-scope only on `unique`; it passes the returned ID unchanged, fetches that property variant, and prefixes an answer using scoped knowledge with the returned building name, for example **For Nam Pak Hong — ...**. Naming the building is a cheap, useful error-detection measure: a recycled/shared number or stale record becomes visible in the same message instead of silently selecting bank details. It is mitigation, not consent or authentication, and must never turn an ambiguous result into a guess. If the user corrects the building, discard the auto-scoped prompt, ask/select explicitly, and refetch before answering.

A phone number identifies a conversation, not a person. Numbers are recycled, handsets and SIMs are shared, and possession does not prove tenancy or identity. Therefore phone matching may only choose a property boundary for otherwise authorised, partner-visible knowledge. It must not authenticate the sender; disclose tenant, lease, invoice, payment, balance, access-control, or other personal/account data; perform an action; or relax any permission. The blast radius of a wrong unique match is still material: the sender could receive a property-specific FAQ or rule, including the wrong building's bank account details. Server-side body filtering, the visible building prefix, immediate correction/refetch, and fallback rules reduce that risk but do not make the phone an identity credential. Content that is unsafe even when disclosed to an arbitrary occupant of the correctly named building does not belong in this feed.

The fallback matrix is strict:

- Missing or blank sender phone, fewer than eight digits, or no tenant match: ask which building.
- A matched prospect with no lease, a former tenant with only past leases, or a future tenant with no currently active lease: ask which building; do not infer from past or upcoming property history.
- A matched tenant with no active lease: ask which building.
- More than one distinct active property, including the nine known phone numbers spanning buildings: ask which building and resolve the reply to a canonical ID; never pick the newest lease, first row, or most frequent property.
- One or several active leases whose distinct property set is the same single building: auto-resolution is allowed because lease multiplicity does not change property scope.
- An invalid/deleted property returned because of concurrent change, or `400 INVALID_PROPERTY` from the knowledge feed: discard it, refresh once, then ask; never fall back to globals as though resolution succeeded.

The reported production coverage sets expectations rather than weakening these rules: 65 of 313 active leases have a tenant with no phone, so roughly 21% of active-lease rows cannot benefit from phone resolution, and at least nine numbers are genuinely cross-building. Asking remains a normal path, not an exceptional error.

### Website feed: new contract

Add keyless `GET /api/website/:org_slug/faqs`, outside the API-key-authenticated public router and optionally accepting `property_id`. The slug is a public locator, not a secret or authorization token. It never returns rules. With no property it returns global published FAQs plus active property choices, but no scoped bodies. With a property it returns global plus matching scoped FAQs.

The wire shape uses the same `{code, data}` envelope as the rest of the API; the fields below sit
inside `data`.

```json
{
  "version": "etag-for-website-property-42",
  "property_context": {"id":42,"display_name":"Nam Pak Hong"},
  "faqs": [
    {"id":91,"title":"Where do I pay rent?","body":"Pay to account ...","updated_at":"2026-08-20T08:00:00.000Z"}
  ],
  "available_properties": [
    {"id":42,"display_name":"Nam Pak Hong"}
  ]
}
```

`available_properties` contains only non-deleted properties with at least one active website-published scoped FAQ. A missing/unknown organisation is `404`; an invalid or soft-deleted property is `400 INVALID_PROPERTY`; a valid property with no scoped FAQ still returns globals. Responses send a variant-specific `ETag`, `Cache-Control: public, max-age=60, stale-while-revalidate=300`, an origin-specific `Access-Control-Allow-Origin` only for configured website origins, and honor `If-None-Match`. WordPress and the CDN cache each organisation/property variant for at most 60 seconds and revalidate; an edit changes the ETag, so it appears within 60 seconds without a purge — with the caveat that `stale-while-revalidate=300` permits a caller that opts into stale content to keep serving the previous copy for up to five minutes while it revalidates.

## Staff UI

The shared `KnowledgePage` form gains a searchable, multi-select **Properties** control populated from `/knowledge/properties`. Empty selection is labelled **Global — all properties** beneath the control. Selected properties appear as names, not editable text, so renames and typos cannot create scope drift.

Each list row shows a prominent scope badge: `Global` or `Property: Nam Pak Hong` / `3 properties`, with the full names visible in a tooltip or expanded row. FAQ rows also have a **Publish on website** switch; rules do not. The FAQ list shows `Website` / `Not on website` status at a glance. The form warns that property-specific content is withheld until the property is known, and saving a payment-related scoped entry requires no special exception to that rule.

Deleted linked properties remain visible to staff with a `Deleted` badge but are absent from the selector for new links. If all links are deleted, show the blocking warning **Scoped only to deleted properties — currently invisible**. Titles remain unrestricted staff content because they are needed in authenticated CRUD and selected-property responses; the unknown-property partner response structurally omits them, so containment does not depend on title-writing guidance.

## Implementation plan

1. **Add and rehearse MASTER and per-org schema.** Add `backend/migrations/045_organization_public_slug.sql` with the column, constraint, unique index, and reviewed ID-to-slug updates; verify every organisation intended for website publication has exactly one expected slug and all others remain `NULL`. Run `npm run migrate` from `backend/` against MASTER and verify duplicate/invalid slugs fail. Separately add `backend/migrations-org/071_chat_knowledge_property_and_website.sql` with the guarded column and join table above, including only the deliberately chosen knowledge CASCADE. Before deployment, restore schema copies of all three organisation databases and run 071 twice against each; inspect the constraint, indexes and defaults and confirm all existing rows remain global and unpublished. In deployment run MASTER migration 045, then `npm run migrate:orgs`, and do not deploy the application unless both succeed.

2. **Extend and test staff data access and soft-deletion safety.** Touch `backend/src/routes/chat.js`, `backend/src/routes/property.js`, and focused files under `backend/test/`; add active-property listing, joined read fields that retain deleted links, validation, transactional create/update/bulk/delete behavior, and a `409 PROPERTY_HAS_KNOWLEDGE` response before the property route performs its actual soft delete. Staff must re-scope or delete those entries first. Verify with `node --test test/*.test.js`, including invalid and soft-deleted IDs, duplicate IDs, empty/global scope, multi-property scope, omitted PUT fields, rule publication rejection, rollback, knowledge deletion cascading its links, the soft-delete preflight, deleted-link staff markers, and all-properties-deleted invisibility using the hand-rolled fake pool.

3. **Make the partner boundary safe and extend contact lookup before exposing the UI.** Touch `backend/src/routes/public.js`, import/reuse `conversationKey()` from `backend/src/utils/renewalAsk.js`, and add public-route tests. Implement knowledge variants, text-free topic metadata, active-property validation, variant ETags, and prompt rendering from only eligible rows. Add `active_properties` and `property_resolution` to tenant lookup by considering all current, non-deleted leases and deduplicating property IDs; replace its local 7-or-8-digit matching with the shared exact-last-eight rule. Verify byte-level absence of scoped titles and bodies from unknown and wrong-property responses, presence for the exact active property, exclusion for soft-deleted properties, global compatibility, `304` per variant, and absent-table behavior. Test missing/short/unmatched phones, formatting variants, former/future/prospect cases, multiple leases in one property, multiple matched tenants in one property, and cross-property ambiguity. Deploy migrations, then backend. At this point existing behavior works and scoped writes are safe even before partner adoption.

4. **Add staff controls.** Touch `frontend/src/components/chatbot/KnowledgePage.jsx` and its existing test location if present; add selectors, badges, website switch, and payload handling shared by FAQ/rule pages. Verify create/edit/global/multi-property flows, long/duplicate display names, rule restrictions, and that an older record renders as Global / Not on website. Deploy after task 3.

5. **Add and test the isolated website endpoint and provisioning invariant.** Add a pre-auth website router rather than placing the handler behind `apiKeyAuth`; resolve `organizations.public_slug` only among active, public-API-enabled organisations, then select its pool. Implement an FAQ-only query, active-property variants, configured-origin CORS, rate limiting, response limits, public cache headers, ETags, and validation. Update organisation provisioning to validate and persist a unique slug (or leave it `NULL` and website-disabled until an operator migration assigns one); include the slug in authenticated master-admin reads. Verify format and collision rejection, null/unknown/inactive/disabled slugs returning indistinguishable `404`s, rules and unflagged/inactive FAQs never appearing, scoped bodies withheld without selection, soft-deleted properties excluded, unknown slugs unable to select another org, disallowed browser origins receiving no CORS grant, limits returning `429`, ETags changing on edits/scope changes/renames, and pool selection never crossing organisations.

6. **Integrate WordPress.** In the separately managed WordPress integration, add fetch/render logic, organisation/property cache keys, selector behavior, HTML escaping, and stale/error handling. No credential is stored. Verify against staging that source/API failures retain the last safe cached page, edits appear within 60 seconds, the browser origin is accepted while unrelated origins receive no CORS grant, and scoped content never appears before selection. Release only after editorial review of the selected FAQs.

7. **Coordinate and enable partner scoped answers.** Give the WhatsApp partner the lookup-plus-knowledge contract and safety rules below. Have it call tenant lookup, auto-pass `property_id` only for `property_resolution: unique`, visibly name the auto-selected building in scoped replies, discard/refetch on correction, and ask in every `none` or `ambiguous` case. Test missing/no-match/prospect/former/future, unique, same-building multi-lease, cross-building, changed, invalid, recycled/shared-number simulation, and corrected-property conversations in staging. Only then allow staff to scope operational answers. Existing global operation does not wait for this step.

## Risks and what could go wrong

- **Wrong bank account reaches a tenant.** Flat or cross-property caches, prompt reuse after a property change, or client-side filtering could leak an answer. Mitigation: bodies are filtered server-side, ETags/cache keys include org and property, and property changes force a refetch and prompt rebuild.
- **The bot guesses the building.** A phone may select a property only when all matching current leases collapse to one distinct active property; it is not identity evidence. Missing, unmatched, past/future/prospect, or multi-property results require an explicit question and canonical ID resolution. Unknown responses contain no scoped title or body.
- **A recycled or shared phone silently selects the wrong building.** Last-eight matching identifies a conversation, not a person, and a wrong unique database match could expose property-specific instructions including bank details. Mitigation: it never authorises personal data or actions, scoped replies visibly begin with the selected building, corrections invalidate/refetch the prompt, and content unsuitable for arbitrary occupants is excluded from the feed.
- **Existing internal rules reach the public web.** Reusing `visibility = 'public'` would expose 24 rules. Mitigation: independent default-off flag plus an invariant that the website query selects FAQs only.
- **An old staff client erases scope.** Treating omitted PUT fields as empty would globalise sensitive content. Mitigation: omission preserves values; explicit `property_ids: []` is required to make an entry global.
- **Partial writes create unintended global content.** Inserting knowledge before failed link validation would leave zero links. Mitigation: validate and replace links in one transaction, rolling back on any failure.
- **Property soft deletion makes scoped content silently invisible.** Normal deletion sets `property.deleted_at`; an FK RESTRICT would be inert, and retaining links safely prevents globalisation but an entry whose properties are all deleted is served nowhere. Mitigation: the actual soft-delete route performs a `409` preflight; every serving join excludes deleted properties; staff reads retain and label deleted links and prominently flag all-deleted scope.
- **Stale cache serves old payment details.** ETags must include bodies, updates, links, and property names; cache keys must include the property variant. Keep website TTL at 60 seconds and require the partner to revalidate on its normal feed cadence.
- **Metadata reveals sensitive text.** A staff title can contain an account number, so guidance is insufficient. Mitigation: unknown-property `property_topics` contains IDs, kinds, and active property identity only; it structurally omits both title and body. Staff-authored text appears only after an exact property is selected or in authenticated staff CRUD.
- **The public website endpoint is scraped or flooded.** FAQ content can already be copied from the rendered site; the meaningful risk is origin load, not confidentiality. Mitigation: a FAQ-only hard-coded query, configured-origin CORS, IP-and-org rate limiting, bounded responses/timeouts, public 60-second caching, conditional ETags, and CDN/reverse-proxy protection. Never substitute an existing read-only API key, because it can read tenant and partner-rule data.
- **A website slug is missing, duplicated, or resolves unpredictably.** The MASTER table currently has no slug. Mitigation: migration 045 adds a constrained unique public locator with explicit reviewed backfill; null/unrecognised/inactive/disabled values fail closed with `404`, and there is no fallback to organisation ID, display name, or database name.
- **Migration/application skew causes errors or unsafe fallback.** Run 071 before deploying writers. The partner route may preserve the existing missing-table fallback, but must never interpret a missing join table after scoped data is in use; deployment health checks must confirm 071 on every org database.
- **Stored markup becomes website XSS.** WordPress must render titles and bodies as escaped text or through a strict allowlist sanitizer, never raw database HTML.

## WhatsApp partner communication

Tell the partner before staff creates the first scoped entry:

- **Breaking change — action required:** tenant phone lookup now rejects fewer than eight digits. Replace every seven-digit lookup with an eight-digit-or-longer phone value; matching always uses the exact last eight digits after formatting is removed. A short query returns `400` with an eight-digit requirement.

- The existing no-query endpoint remains live and current rows are unchanged, but it intentionally returns global answer bodies only.
- First call the existing authenticated tenant lookup with the sender phone. It now returns `active_properties` and `property_resolution`, using the shared last-eight-digit `conversationKey()` rule across every current non-deleted lease.
- Treat the phone as conversation routing only, never authentication. Do not reveal tenant/account data or take an action because it matched.
- Auto-select only `property_resolution: unique`. Multiple leases in the same building are one property and are safe for scoping; zero or multiple distinct properties require asking which building.
- To answer after a property is known, call the same endpoint with canonical `property_id`; keep org/property cache variants separate and rebuild the prompt on property changes.
- Prefix an auto-scoped knowledge reply with the selected building (for example, **For Nam Pak Hong — ...**). If corrected, discard the prompt and refetch the corrected variant before answering.
- If the phone is missing/short/unmatched, or lookup finds only a prospect, former/future tenant, no current lease, or more than one active property, ask which building. If `property_context` is null, scoped topics exist, and the question may require knowledge content, ask as well. Never guess, answer from metadata, prefer a “best” lease, or reuse another property's cached prompt.
- Handle `400 INVALID_PROPERTY` by asking/refreshing property identity, not by falling back.
- Honor per-variant ETags. Complete staging acceptance tests for unknown, known, ambiguous, invalid, and changed-property conversations before scoped content is enabled.

No coordination is needed merely to deploy the additive fields while all entries remain global. Coordination is mandatory before relying on property-scoped answers.

## Revision notes

- Replaced the nonexistent least-privilege website credential with an isolated keyless FAQ endpoint because current read-only keys can read the full public API surface.
- Made soft deletion explicit in every property join, added the real soft-delete preflight, and surfaced entries scoped only to deleted properties.
- Kept only the knowledge-link CASCADE as the schema's first foreign key and removed the inert property RESTRICT after accounting for multi-org migration failure risk.
- Removed staff-authored titles from unknown-property metadata so sensitive-text containment is structural rather than guidance-only.
- Added a constrained, unique `organizations.public_slug` in a MASTER migration, explicit reviewed backfill/fail-closed behavior, and provisioning/operational ownership; retained slug rather than exposing the internal organisation ID.
- Added phone-assisted property resolution through the existing tenant lookup, reusing the exact last-eight-digit conversation rule, returning all distinct active properties, and requiring fallback for every non-unique case.
- Made the phone trust boundary explicit: it routes a conversation but does not authenticate a person; auto-scoped replies name the selected building so wrong resolution is visible and correctable.
