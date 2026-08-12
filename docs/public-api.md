# Tenafy Public API Reference

Read-only HTTP API for external integrations (e.g. your own AI assistant).

## Base URL

| Environment | URL |
|---|---|
| Production droplet | `http://YOUR_DROPLET_IP:3001` (or your reverse-proxy URL) |
| Local dev | `http://localhost:3001` |

All endpoints are prefixed with `/api/public/`.

## Authentication

Every request requires an `X-API-Key` header:

```
X-API-Key: pk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

### Setup

1. Master admin logs in at `/master/login`
2. Go to `/master/dashboard` → toggle **Public API** ON for the org
3. Go to `/master/api-keys` → **+ New API Key** → select org → save
4. Copy the key immediately (shown once only)

### Auth errors

| Code | Reason |
|---|---|
| 401 | Missing or invalid `X-API-Key` |
| 403 | Public API not enabled on the org, OR key is disabled |

## Response Format

All endpoints return JSON in this shape:

```json
{
  "code": 200,
  "data": ...,
  "meta": { "total": N, "date": "..." }
}
```

- List endpoints return `data` as an array, with `meta.total` = array length
- Detail endpoints return `data` as an object
- Errors return `{ "code": 4xx|5xx, "message": "..." }`

## Rate Limits & Pagination

- No pagination — every list endpoint returns ALL rows
- No rate limiting currently applied — use responsibly

---

## Endpoints

### Meta

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Confirm auth works; returns `{ ok, org_id, key_name, timestamp }` |

### Properties

| Method | Path | Query | Description |
|---|---|---|---|
| GET | `/properties` | `?date=YYYY-MM-DD` | All active properties + vacancy counts |
| GET | `/properties/:id` | | Property detail + amenities + gallery |

### Units

| Method | Path | Query | Description |
|---|---|---|---|
| GET | `/units` | `?property_id=&status=0\|1&active_status=0\|1` | All units (filtered) |
| GET | `/units/:id` | | Unit detail + current lease + tenant + amenities + gallery |
| GET | `/vacancies` | `?max_tier=3&property_id=&limit=50&target_date=YYYY-MM-DD` | Chatbot availability using advertising vacancy logic |
| GET | `/units/available` | `?date=YYYY-MM-DD&property_id=` | Deprecated; use `/vacancies` |

### Tenants & Contacts

| Method | Path | Query | Description |
|---|---|---|---|
| GET | `/tenants` | `?status=&category=1\|2` | All tenants (category 1 = tenant, 2 = payee) |
| GET | `/tenants/:id` | | Single tenant |
| GET | `/tenants/:id/leases` | | All leases for a tenant |
| GET | `/tenants/:id/invoices` | | All invoices for a tenant |
| GET | `/payees` | | Payees (tenants with category=2) |
| GET | `/payees/:id` | | Single payee |
| GET | `/property-owners` | | All property owners |
| GET | `/property-owners/:id` | | Single owner |
| GET | `/service-vendors` | | All service vendors |
| GET | `/service-vendors/:id` | | Single vendor |

### Leases

| Method | Path | Query | Description |
|---|---|---|---|
| GET | `/leases` | `?status=active\|upcoming\|inactive&unit_id=&tenant_id=` | All leases |
| GET | `/leases/expiring` | `?days=30` | Leases ending within N days |
| GET | `/leases/:id` | | Lease detail + additional tenants |

### Invoices & Payments

| Method | Path | Query | Description |
|---|---|---|---|
| GET | `/invoices` | `?status=0\|1\|2&tenant_id=&property_id=&unit_id=&from=&to=` | All invoices |
| GET | `/invoices/:id` | | Invoice detail + payment history + outstanding balance |
| GET | `/payments` | `?tenant_id=&from=&to=` | All payment/accounting records |

### Accounting

| Method | Path | Query | Description |
|---|---|---|---|
| GET | `/accounting` | `?type=0\|1&category=&tenant_id=&property_id=&from=&to=` | All entries (0=inflow, 1=outflow) |
| GET | `/accounting/:id` | | Entry detail + line items |

### Services

| Method | Path | Query | Description |
|---|---|---|---|
| GET | `/services` | `?status=&unit_id=&property_id=` | All service requests |
| GET | `/services/:id` | | Service detail + activity timeline |

### Utilities

| Method | Path | Query | Description |
|---|---|---|---|
| GET | `/utility/groups` | | All utility groups |
| GET | `/utility/bills` | `?group_id=` | All utility bills |
| GET | `/utility/bills/:id` | | Bill detail + all lines |
| GET | `/utility/meters` | `?group_id=&unit_id=` | All meters |
| GET | `/utility/meters/:id/readings` | | Reading history for a meter |
| GET | `/utility/settlements` | `?tenant_id=` | All checkout settlements |

### Cleaning

| Method | Path | Query | Description |
|---|---|---|---|
| GET | `/cleaning/cleaners` | | All cleaners |
| GET | `/cleaning/schedule` | `?week_of=YYYY-MM-DD` (required) | Cleaning schedule for week |

### Advertising posting plan

#### `GET /vacancies`

Requires `X-API-Key`; read-only keys are allowed. This is the public chatbot
availability endpoint and uses the same vacancy engine as Advertising -> Vacancy
and the posting plan. It applies customer-facing lead-time windows and priority
sorting (`page=false` internally).

Query parameters:

| Param | Default | Clamp | Description |
|---|---:|---:|---|
| `max_tier` | `3` | `1`-`3` | `1` vacant only, `2` vacant + NR, `3` all tiers |
| `property_id` | | | Optional property filter |
| `limit` | `50` | `1`-`200` | Maximum rows returned |
| `target_date` | | | Optional prospect move-in date. Must be `YYYY-MM-DD`; malformed values return `400` |

All tiers are included by default. Tier 3 rows are deliberately returned with
`availability.certain=false` so TaneChat can offer them with the configured
caveat instead of stating them as firm availability.

```json
{
  "code": 200,
  "data": {
    "vacancies": [{
      "unit_id": "123",
      "unit_name": "5B",
      "property_id": "456",
      "property_name": "Gilman's Bazaar",
      "label": "Gilman's Bazaar 5B",
      "unit_type": "apartment",
      "beds": 1,
      "baths": 1,
      "size": 320,
      "rent": "12000.00",
      "tier": 2,
      "tier_name": "NR",
      "intent": "NR",
      "availability": {
        "status": "from_date",
        "available_from": "2026-09-16",
        "days_until": 35,
        "certain": true
      },
      "gap_days": 29,
      "gap_warning": true,
      "available_after_target": false
    }],
    "count": 1,
    "phrasing": {
      "certain": "{units} available from {date}",
      "uncertain": "We may also have {units} available, however the tenant may renew, they're not sure",
      "earlier": "{units} is free from {date} — would you be able to start a little earlier? We try not to leave a flat empty too long."
    },
    "target_date": "2026-10-15",
    "max_gap_days": 10,
    "hard_max_gap_days": 20,
    "hidden_by_gap_cap": 0,
    "no_match_reason": null,
    "partner_forward": {
      "applies": false,
      "message": null
    }
  }
}
```

Availability rules:

| Tier | `tier_name` | Meaning | `availability` |
|---:|---|---|---|
| 1 | `VACANT` | Empty now and passes the minimum gap rule | `status="now"`, `available_from=null`, `days_until=0`, `certain=true` |
| 2 | `NR` | Tenant has confirmed they are not renewing | `status="from_date"`, `available_from=end_date+1`, `certain=true` |
| 3 | `MR/other` | May renew / month-to-month / unconfirmed | `status="from_date"`, `available_from=end_date+1`, `certain=false` |

If a non-vacant row has no `end_date`, `available_from` is `null` and
`certain` is `false`.

When `target_date` is supplied, each row also includes move-in fit fields and the
result order is re-ranked by best fit. `max_gap_days` is advisory only: it sets
`gap_warning` but does not hide the unit. The endpoint filters only on
`hard_max_gap_days`, after normal vacancy logic plus `max_tier` and
`property_id`, and before `limit`.

Fit fields:

| Field | Meaning |
|---|---|
| `gap_days` | `target_date - effectiveAvailableFrom`, in days |
| `gap_warning` | `true` only when `gap_days > max_gap_days`; advisory, not a cap |
| `available_after_target` | `true` when `gap_days` is negative and the prospect would need to wait |

Positive `gap_days` means the unit would sit empty before the prospect arrives,
so it is the lost-rent case. `0` is an exact fit. Negative `gap_days` means the
unit is not free until after the requested date; that is not a lost-rent warning,
but callers should explain the wait.

Hard gap cap fields:

| Field | Meaning |
|---|---|
| `hard_max_gap_days` | Positive gaps greater than this are hidden from inquiry answers |
| `hidden_by_gap_cap` | Count of rows removed by the hard cap; `0` when no `target_date` was supplied |
| `no_match_reason` | `null` when at least one unit is returned; otherwise one of the values below |
| `partner_forward.applies` | `true` when the returned vacancy list is empty, regardless of `no_match_reason` |
| `partner_forward.message` | Operator-authored text to send to partner agencies, or `null` when unset |

`no_match_reason` values:

| Value | Meaning |
|---|---|
| `all_beyond_hard_cap` | The endpoint had candidate vacancies, but the hard cap removed them all |
| `no_vacancies` | There were no candidate vacancies to offer |

Use `partner_forward.applies`, not `no_match_reason`, as the caller branch for
forwarding an inquiry to partner agencies. Both `all_beyond_hard_cap` and
`no_vacancies` are internally distinct reports but trigger the same partner
forwarding decision. `partner_forward` is always present, with or without
`target_date`; `message` is still returned when `applies=false` so callers can
pre-load it, but it must not be sent unless `applies=true`.

`partner_forward.message` has no default. The stored setting is nullable and
ships empty because this is outward-facing content sent to real partner agencies;
the operator must author it deliberately. If `partner_forward.applies=true` and
`partner_forward.message=null`, the caller must not send a partner-forward
message.

The message is returned verbatim and unsubstituted. Tenafy substitutes none of
these placeholders; the caller must fill them from chat context before sending:

| Placeholder | Meaning |
|---|---|
| `{customer_name}` | the enquirer's name |
| `{target_date}` | requested move-in date |
| `{budget}` | stated budget |
| `{requirements}` | free-text summary of what they asked for |
| `{area}` | area or district requested |

Tenafy only knows `{target_date}` at this point. The other values live in the
chat/inquiry layer, so server-side partial substitution is intentionally avoided.

Tier 1 (`VACANT`) rows are never hidden by `hard_max_gap_days`, even when their
positive gap is larger than the cap. Already-vacant units are sunk vacancy cost
and remain the most urgent units to offer. Rows with negative `gap_days` and rows
with `gap_days=null` are also not hidden by the cap.

Advertising settings expose `min_gap_days`, `max_gap_days`, `hard_max_gap_days`,
`lead_days_nr`, `lead_days_other`, and three inquiry override fields:
`inquiry_min_gap_days`, `inquiry_lead_days_nr`, and
`inquiry_lead_days_other`. The inquiry fields are nullable overrides, not
duplicate policy values. Leaving them unset keeps one shared availability policy
for Facebook advertising and chatbot inquiry answers. Setting one is an explicit
decision to let that audience diverge for that one field.

Precedence is: explicit backend argument > audience override > advertising
value. `GET /advertising/settings` returns the raw overrides as `null` when
unset, plus an `effective` block showing what is actually in force:

```json
{
  "min_gap_days": 40,
  "lead_days_nr": 60,
  "lead_days_other": 45,
  "inquiry_min_gap_days": null,
  "inquiry_lead_days_nr": 30,
  "inquiry_lead_days_other": null,
  "effective": {
    "advertising": {
      "min_gap_days": 40,
      "lead_days_nr": 60,
      "lead_days_other": 45
    },
    "inquiry": {
      "min_gap_days": 40,
      "lead_days_nr": 30,
      "lead_days_other": 45,
      "source": {
        "min_gap_days": "advertising",
        "lead_days_nr": "inquiry",
        "lead_days_other": "advertising"
      }
    }
  }
}
```

`PUT /advertising/settings` validates each numeric gap/lead field as an integer
from `0` to `365`, treats absent fields as unchanged, and rejects merged settings
where `max_gap_days > hard_max_gap_days` because the warning threshold would sit
above the hide threshold. The three `inquiry_*` overrides each accept either an
integer from `0` to `365` or `null`; send `null` to clear an override and fall
back to the advertising value.

#### `GET /units/available` (deprecated)

Requires `X-API-Key`; read-only keys are allowed. This endpoint remains for
existing TaneChat callers but now returns only tier-1 vacancies that pass the
advertising minimum-gap rule. New callers should use `GET /vacancies`.

Response headers include `Deprecation: true`. The JSON response keeps `data` as
the legacy unit array and adds top-level deprecation metadata:

```json
{
  "code": 200,
  "data": [{
    "unit_id": "123",
    "unit_name": "5B",
    "unit_type": "apartment",
    "amenity_type": null,
    "property_id": "456",
    "property_name": "Gilman's Bazaar",
    "street_address": "1 Gilman Street",
    "city": null,
    "state": null,
    "district": null,
    "country": null,
    "zip_code": null,
    "property_type": null,
    "last_lease_price": "12000.00",
    "last_lease_end_date": "2026-08-31"
  }],
  "meta": { "total": 1, "date": "2026-08-12" },
  "deprecated": true,
  "replacement": "/vacancies"
}
```

`date` is still accepted only for compatibility. If supplied and not today's
date, the endpoint returns `400` because the replacement vacancy engine does not
support arbitrary as-of dates. `property_id` and the legacy `propertyId` alias
are both accepted.

#### `GET /posting-plan`

Requires `X-API-Key`; read-only keys are allowed. The optional `date=YYYY-MM-DD`
query parameter selects the schedule date (today by default). The response `data`
matches the Advertising Scheduler plan and includes `date`, `weekday`, `day_name`,
`photo_root`, `min_gap_days`, `lead_days_nr`, `lead_days_other`, `tier_counts`,
`slot_count`, `extra_count`, `unfilled_slots`, and `posts`. Each post includes its
property and units, `tier`, `intent`, status, assigned forum/account, rendered post
text when ready, and `image_hint`. Each `image_hint` entry is `Property/Unit`
relative to `photo_root`, so local automation can locate the photo folder.

```json
{
  "code": 200,
  "data": {
    "date": "2026-08-11",
    "weekday": 2,
    "day_name": "Tuesday",
    "photo_root": "/photos",
    "min_gap_days": 40,
    "lead_days_nr": 60,
    "lead_days_other": 45,
    "tier_counts": { "vacant": 2, "nr": 1, "other": 3 },
    "slot_count": 7,
    "extra_count": 1,
    "unfilled_slots": [],
    "posts": [{ "tier": 1, "intent": "Unset", "image_hint": ["Property/Unit"] }]
  }
}
```

#### `POST /posting-plan/mark`

Requires a write-enabled `X-API-Key`; read-only keys receive `403`. Send the IDs
from a plan post (`property_id`, `template_id`, `forum_id`, `account_id`, and
`unit_ids`) plus optional `post_date` (`YYYY-MM-DD`), `source` (`roster` or
`urgent`), and `status` (`posted` or `skipped`). The response is
`{ "code": 200, "data": { "id": "POST_LOG_ID" } }`. Recording the result builds
the rotation history used by later plans. Call this endpoint after every posting;
otherwise rotation history never accumulates and the seven-day rotation cannot
work.

### Viewing negotiations

#### `GET /viewing-negotiations`

Requires `X-API-Key`; read-only keys are allowed. This is the board endpoint for
viewing relay rows. It does not replace `GET /viewing-negotiation/active`, whose
response shape is reserved for per-message phone routing.

Query parameters:

| Param | Description |
|---|---|
| `status` | `active`, `terminal`, or `all` (`active` default). `NEEDS_STAFF` is active because staff still need to act. |
| `state` | Optional comma-separated state filter, e.g. `AWAIT_TENANT,NEEDS_STAFF`. |
| `updated_since` | Optional ISO-ish timestamp lower bound on `updated_at`. |
| `limit` | Page size, default `50`, max `200`. |
| `cursor` | Opaque cursor from `meta.next_cursor`; uses keyset pagination, not offset. |

Each row contains stable keys for TaneChat rendering:

```json
{
  "negotiation_id": "123",
  "status": "active",
  "state": "AWAIT_TENANT",
  "needs_staff_reason": null,
  "awaiting": "tenant",
  "unit": { "id": "45", "label": "Gilman's Bazaar 5B", "address": "..." },
  "customer": { "name": "Alex", "phone": "+852..." },
  "tenant": { "id": "67", "name": "Tenant Name", "phone": "+852..." },
  "viewing": { "proposed_start_at": "2026-08-13T15:00:00", "timezone": "Asia/Hong_Kong" },
  "policy": { "opt_out_window_hours": 4, "require_explicit_confirmation": false, "source": "setting" },
  "timestamps": {
    "created_at": "...",
    "customer_asked_at": "...",
    "tenant_notified_at": "...",
    "auto_confirmed_at": "...",
    "updated_at": "..."
  },
  "next_deadline": { "kind": "opt_out_expiry", "due_at": "...", "overdue": false },
  "risk_flags": ["implicit_consent_pending"],
  "last_event": { "event_type": "tenant_opt_out_notice", "party": "tenant", "send_mode": "approve", "status": "draft", "created_at": "..." }
}
```

`meta.next_cursor` is present when another page is available. `next_deadline` is
computed from the same decision helpers used by the scheduler, so the board and
the hourly sweep should agree.

`needs_staff_reason` is `null` unless `state` is `NEEDS_STAFF`. Current reason
values are: `off_window`, `not_marketing`, `no_host`, `multi_unit`, `stale`,
`tenant_no_phone`, `window_no_phone`, `auto_confirm_no_staff`,
`slot_taken_at_confirm`, `slot_taken_at_reconfirm`, `max_rounds`,
`tenant_reply_after_confirm`, `reschedule_declined_after_commit`, `no_roster`,
and `confirm_no_staff`.

#### `GET /viewing-negotiation/active`

Requires `X-API-Key`; read-only keys are allowed. Given a WhatsApp phone number,
returns open negotiations that TaneChat can route replies into. The response is
purely for phone routing and is ordered routable-first, then newest-first, with
the negotiation awaiting that party first within each group. Each negotiation
entry includes `negotiation_id`, `party`, `state`, `needs_staff_reason`,
`awaiting`, and `routable`.

#### `POST /viewing-negotiation/:id/prospect-reply`
#### `POST /viewing-negotiation/:id/tenant-reply`

Requires a write-enabled `X-API-Key`. These endpoints accept parsed reply intent
from TaneChat and return the post-transition `state`, `needs_staff_reason`,
`awaiting`, routing phones, and generated outbound events. If the negotiation is
already closed to that sender, the `closed: true` response also includes
`needs_staff_reason`.

#### `GET /viewing-negotiation/drafts`

Requires `X-API-Key`; read-only keys are allowed. TaneChat polls this endpoint
for pending outbound drafts created by the viewing relay scheduler. This endpoint
does not send messages and does not mutate state.

Query parameters:

| Param | Description |
|---|---|
| `limit` | Page size, default `50`, clamped to `1`-`200`. |
| `max_age_hours` | Draft age window, default `168` hours, clamped to `1`-`8760`. |
| `party` | Optional `prospect` or `tenant` filter. Other values are ignored. |

Response:

```json
{
  "code": 200,
  "data": {
    "drafts": [{
      "event_id": "123",
      "negotiation_id": "456",
      "negotiation_state": "AWAIT_TENANT",
      "awaiting": "tenant",
      "party": "tenant",
      "to_phone": "+85255551234",
      "body": "Hi ...",
      "template_type": "Viewing-Tenant-OptOut",
      "event_type": "tenant_opt_out_notice",
      "send_mode": "approve",
      "idempotency_key": "456:tenant_opt_out_notice:1",
      "deadline_at": "2026-08-13T15:00:00",
      "created_at": "2026-08-13T11:00:00",
      "age_hours": 4,
      "unit": { "id": "789", "label": "Gilman's Bazaar 5B" },
      "customer": { "name": "Alex", "phone": "+852..." }
    }],
    "count": 1,
    "max_age_hours": 168
  }
}
```

TaneChat must send `body` verbatim to `to_phone` in that party's own thread, then
call `POST /viewing-negotiation/:id/draft-sent` with `event_id`. A draft
reappears until `draft-sent` is called. This is intentional at-least-once
behaviour: `draft-sent` is idempotent, and seeing a duplicate pending draft is
safer than silently missing an outbound message.

Viewing relay v2 adds three states: `AUTO_CONFIRMED` means the tenant opt-out
deadline elapsed and the viewing was booked automatically;
`TENANT_CANCELS_AFTER_X` means the occupant replied after confirmation and can no
longer make the time; `RESCHEDULE_AFTER_COMMIT` means the occupant replied after
confirmation with a new proposed time. A tenant reply is accepted on an
`AUTO_CONFIRMED` negotiation so the reversal path can run. Prospect replies on
terminal states are still refused as no longer active.

---

## Field Reference (commonly-needed enums)

| Field | Values |
|---|---|
| `invoice.status` | 0 = Open, 1 = Paid, 2 = Overdue |
| `accounting.type` | 0 = Inflow (CR), 1 = Outflow (DR) |
| `property.type` | 1 = Residential, 2 = Commercial |
| `tenant.category` | 1 = Tenant, 2 = Payee |
| `tenant.type` | 0 = Personal, 1 = Company |
| `tenant.status` | 0 = Pending, 1 = Active, 2 = Inactive |
| `tenant.sex` | 0 = null, 1 = Male, 2 = Female |
| `tenant.contract_type` | 1 = MR (May Renew), 2 = MTM, 3 = NR (Not Renewing), 4 = UC (Unconfirmed) |
| `leasing.type` | 0 = Fixed, 1 = Month-to-month |
| `unit.status` | 0 = Vacant, 1 = Occupied |
| `unit.active_status` | 0 = Inactive, 1 = Active |
| `unit.amenity_type` | 1 = Residential, 2 = Commercial |
| `service.status` | Numeric — see service module |
| `utility_meter.meter_type` | 0 = Electric, 1 = Water, 2 = Gas |
| `utility_meter.meter_category` | 0 = Master, 1 = Sub-meter |
| `utility_meter_reading.reading_type` | 0 = Move-In, 1 = Move-Out, 2 = Billing, 3 = Monthly |

---

## Example Requests

### Health check
```bash
curl -H "X-API-Key: pk_..." \
  http://YOUR_DROPLET:3001/api/public/health
```

### List all properties
```bash
curl -H "X-API-Key: pk_..." \
  http://YOUR_DROPLET:3001/api/public/properties
```

### Vacancies for chatbot availability
```bash
curl -H "X-API-Key: pk_..." \
  "http://YOUR_DROPLET:3001/api/public/vacancies?max_tier=3&limit=50"
```

### Deprecated available-units compatibility endpoint
```bash
curl -H "X-API-Key: pk_..." \
  "http://YOUR_DROPLET:3001/api/public/units/available"
```

### Tenants with outstanding invoices
```bash
# Step 1: get all open invoices grouped by tenant
curl -H "X-API-Key: pk_..." \
  "http://YOUR_DROPLET:3001/api/public/invoices?status=0"
```

### Leases expiring in next 60 days
```bash
curl -H "X-API-Key: pk_..." \
  "http://YOUR_DROPLET:3001/api/public/leases/expiring?days=60"
```

### Rent paid by tenant in date range
```bash
curl -H "X-API-Key: pk_..." \
  "http://YOUR_DROPLET:3001/api/public/payments?tenant_id=83001272599&from=2026-01-01&to=2026-03-31"
```

### Utility consumption for a unit
```bash
# Step 1: find the unit's meter
curl -H "X-API-Key: pk_..." \
  "http://YOUR_DROPLET:3001/api/public/utility/meters?unit_id=UNIT_ID"
# Step 2: pull that meter's readings
curl -H "X-API-Key: pk_..." \
  "http://YOUR_DROPLET:3001/api/public/utility/meters/METER_ID/readings"
```

---

## Security Notes

- **Every request is scoped to the org that owns the API key.** You cannot accidentally see another org's data — the DB pool itself is per-org.
- **All endpoints are GET-only.** Writes (create/update/delete) are intentionally not exposed via the public API.
- **Soft-deleted records are filtered out.** You'll never see records with `deleted_at IS NOT NULL`.
- **Key rotation**: generate a new key, then delete the old one via `/master/api-keys`. Last-used timestamp is visible on the admin page for audit.

---

## Hooking up an AI

For an LLM-based assistant (ChatGPT, Claude, etc.), provide as the system prompt / tool definitions:

1. This file as the schema reference
2. The API key as a configured secret
3. The base URL (droplet)
4. Instructions like: "Use the Tenafy Public API to answer questions about the property portfolio. Fetch data via GET requests with the X-API-Key header. Never attempt POST/PUT/DELETE."

If using function-calling / tools, declare one tool per endpoint (or a single generic `tenafy_get(path, query)` tool that the AI can invoke with the path and query params.)
