# Tenafy Migration Plan — Original Java → Node.js/Next.js Rebuild

## Migration Status Legend
- Done = Fully implemented and working
- Partial = Page exists but needs refinement
- Missing = Not yet started

---

## Authentication & Onboarding

| Original Page | Rebuilt Path | Status |
|---------------|-------------|--------|
| Login | `login/page.js` | Done |
| Register | `register/page.js` | Done |
| Account Activation | `register/activation/[code]/page.js` | Done |
| Forgot Password | `forget-password/page.js` | Done |
| Sub-user Activation | `user/create/activation/[code]/page.js` | Done |

## Dashboard

| Original Page | Rebuilt Path | Status |
|---------------|-------------|--------|
| Dashboard (9 widgets) | `dashboard/page.js` | Done |

## Properties & Units

| Original Page | Rebuilt Path | Status |
|---------------|-------------|--------|
| Property List | `property/page.js` | Done |
| Property Create | `property/create/page.js` | Done |
| Property Detail | `property/[id]/detail/page.js` | Done |
| Property Edit | `property/[id]/edit/page.js` | Done |
| Unit Detail (General) | `property/[id]/unit/[unitid]/page.js` | Done |
| Unit Create | `property/[id]/unit/create/page.js` | Done |
| Unit Edit | `property/[id]/unit/[unitid]/edit/page.js` | Done |
| Unit Furnishing | `property/[id]/unit/[unitid]/furnishing/page.js` | Done |
| Unit Service Cost | `property/[id]/unit/[unitid]/service-cost/page.js` | Done |
| Unit Service History | `property/[id]/unit/[unitid]/service-history/page.js` | Done |
| Unit Maintenance | `property/[id]/unit/[unitid]/maintenance/page.js` | Done |
| Unit Inventory | `property/[id]/unit/[unitid]/inventory-history/page.js` | Done |

## Contacts

| Original Page | Rebuilt Path | Status |
|---------------|-------------|--------|
| Contacts Hub | `contacts/page.js` | Done |
| Tenant List | `contacts/tenants/page.js` | Done |
| Tenant Create | `contacts/tenant/create/page.js` | Done |
| Tenant Detail | `contacts/tenant/[id]/detail/page.js` | Done |
| Tenant Edit | `contacts/tenant/[id]/edit/page.js` | Done |
| Payee List | `contacts/payees/page.js` | Done |
| Payee Create | `contacts/payee/create/page.js` | Done |
| Payee Detail | `contacts/payee/[id]/detail/page.js` | Done |
| Payee Edit | `contacts/payee/[id]/edit/page.js` | Done |
| Property Owner Create | `contacts/property-owner/create/page.js` | Done |
| Property Owner Detail | `contacts/property-owner/[id]/detail/page.js` | Done |
| Property Owner Edit | `contacts/property-owner/[id]/edit/page.js` | Done |
| Property Owner Tags | `contacts/property-owner/[id]/tags/page.js` | Done |
| Service Vendor List | `contacts/service-vendors/page.js` | Done |
| Service Vendor Create | `contacts/service-vendor/create/page.js` | Done |
| Service Vendor Detail | `contacts/service-vendor/[id]/detail/page.js` | Done |
| Service Vendor Edit | `contacts/service-vendor/[id]/edit/page.js` | Done |
| Groups List | `contacts/groups/page.js` | Done |
| Group Create | `contacts/group/create/page.js` | Done |
| Group Edit | `contacts/group/[id]/edit/page.js` | Done |
| Email Send | `contacts/email/send/page.js` | Done |

## Leasing

| Original Page | Rebuilt Path | Status |
|---------------|-------------|--------|
| Lease List | `leasing/page.js` | Done |
| Lease Create | `leasing/create/page.js` | Done |
| Lease Detail | `leasing/[id]/detail/page.js` | Done |
| Lease Edit | `leasing/[id]/edit/page.js` | Done |
| Lease Calendar View | `leasing/calendar-view/page.js` | Done |

## Accounting & Invoicing

| Original Page | Rebuilt Path | Status |
|---------------|-------------|--------|
| Accounting Summary | `accounting/page.js` | Done |
| Account Create | `accounting/accounts/create/page.js` | Done |
| Account Detail | `accounting/accounts/[id]/detail/page.js` | Done |
| Account Edit | `accounting/accounts/[id]/edit/page.js` | Done |
| Account Lines | `accounting/lines/page.js` | Done |
| Invoice List | `invoices/page.js` | Done |
| Invoice Create | `invoices/create/page.js` | Done |
| Invoice Detail | `invoices/[id]/detail/page.js` | Done |
| Invoice Edit | `invoices/[id]/edit/page.js` | Done |
| Owner Accounting | `owner/accounting/page.js` | Done |
| Owner Invoices | `owner/invoices/page.js` | Done |

## Services & Maintenance

| Original Page | Rebuilt Path | Status |
|---------------|-------------|--------|
| Service List | `services/page.js` | Done |
| Service Create | `services/create/page.js` | Done |
| Service Detail | `services/[id]/detail/page.js` | Done |
| Service Edit | `services/[id]/edit/page.js` | Done |

## Payments

| Original Page | Rebuilt Path | Status |
|---------------|-------------|--------|
| Payment List | `payment/page.js` | Done |
| Payment Create | `payment/create/page.js` | Done |

## Settings

| Original Page | Rebuilt Path | Status |
|---------------|-------------|--------|
| Settings Hub (tabs) | `settings/page.js` | Done |
| Amenity Create | `settings/amenity/create/page.js` | Done |
| Amenity Detail | `settings/amenity/[id]/page.js` | Done |
| Email Template Create | `settings/email-templates/create/page.js` | Done |
| Email Template Edit | `settings/email-templates/[id]/edit/page.js` | Done |
| Role Create | `settings/role/create/page.js` | Done |
| Role Edit | `settings/role/[id]/edit/page.js` | Done |
| User Create | `settings/users/create/page.js` | Done |
| User Edit | `settings/users/[id]/edit/page.js` | Done |
| Accounts Tab | `settings/page.js` | Partial |
| Landlord Tab | `settings/page.js` | Partial |
| Payments Tab | `settings/page.js` | Partial |
| Personal Tab | `settings/page.js` | Partial |
| Sequences Tab | `settings/page.js` | Done |

## Notifications

| Original Page | Rebuilt Path | Status |
|---------------|-------------|--------|
| Notifications | `notifications/page.js` | Done |

## Tenant Portal (New — Separate Product)

| Page | Rebuilt Path | Status |
|------|-------------|--------|
| Tenant Login | `tenant-portal/login/page.js` | Done |
| Tenant Dashboard | `tenant-portal/dashboard/page.js` | Done |
| Tenant Leases | `tenant-portal/leases/page.js` | Done |
| Tenant Invoices | `tenant-portal/invoices/page.js` | Done |
| Tenant Profile | `tenant-portal/profile/page.js` | Done |

## NOT YET MIGRATED

| Original Module | Description | Priority |
|----------------|-------------|----------|
| Public Listings | Entire tenafy-listing microservice — property marketplace for prospective tenants | Low (separate project) |
| Listing Review | Admin review of submitted listings | Low |
| Advertising | Ad management within listings | Low |
| Quota Management | Admin storage/email usage monitoring | Low |

## Database Migrations Needed

| Table | Purpose | Status |
|-------|---------|--------|
| `unit_maintenance` | Maintenance records per unit | Done — `backend/migrations/001_create_unit_maintenance.sql` |
| `unit_inventory_history` | Inventory tracking per unit | Done — `backend/migrations/002_create_unit_inventory_history.sql` |
| `property_owner_tag` | Owner tagging taxonomy | Done — `backend/migrations/003_create_property_owner_tags.sql` |
| `property_owner_tag_map` | Owner-to-tag mapping | Done — `backend/migrations/003_create_property_owner_tags.sql` |
| `property.payment_instructions` | Payment instructions text field on property | Done — `backend/migrations/004_add_payment_instructions_to_property.sql` |

## Backend Feature Gaps

| Feature | Description | Status |
|---------|-------------|--------|
| Overdue invoice scheduler | Auto-update invoice status 0→2 when past due | Missing |
| PDF generation | Generate PDFs for leases and invoices | Missing |
| Additional tenants on lease | Join to `leasing_additional_tenant` table | Done |
| Bulk email | Email all tenants (filtered) | Missing |
| File upload to S3/storage | Currently local only | Missing |
