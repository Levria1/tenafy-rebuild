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
| GET | `/units/available` | `?date=YYYY-MM-DD&propertyId=` | Units with no active lease on date |

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

### Available units on a specific date
```bash
curl -H "X-API-Key: pk_..." \
  "http://YOUR_DROPLET:3001/api/public/units/available?date=2026-05-01"
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
