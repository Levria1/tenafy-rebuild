/**
 * Central registry of lease-template placeholder variables.
 *
 * Each entry has:
 *   - key:    the placeholder users type, e.g. {{TENANT_NAME}}
 *   - label:  human-readable name for the "Insert Variable" dropdown
 *   - group:  bucket the variable belongs to in the picker UI
 *   - sample: value used when previewing a template without a real lease
 *   - resolve(ctx): function that returns the actual value from a lease context
 *
 * The renderer (services/leasePdfRenderer.js) calls `resolveAll(ctx)` to get a
 * { key → value } map, then does a literal `{{KEY}}` replace through the HTML.
 *
 * Adding a new variable: add an entry below. Frontend "Insert Variable"
 * dropdown is fed by GET /api/lease-template/variables.
 */

// ───────────────────────────────────────────────────────────────────────────
// Formatters — keep money/dates consistent across every template.
// ───────────────────────────────────────────────────────────────────────────

function fmtMoney(v, currency) {
  if (v == null || v === '') return '';
  const num = Number(v) || 0;
  const cur = currency || 'HK$';
  return `${cur}${num.toLocaleString('en-HK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtDateLong(v) {
  if (!v) return '';
  const d = v instanceof Date ? v : new Date(v);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

function fmtDateShort(v) {
  if (!v) return '';
  const s = String(v).slice(0, 10);
  return s;
}

function joinName(first, last, company, type) {
  if (Number(type) === 1 && company) return company;
  return [first, last].filter(Boolean).join(' ').trim();
}

// ───────────────────────────────────────────────────────────────────────────
// Variable registry
// ───────────────────────────────────────────────────────────────────────────
//
// ctx shape passed to resolve():
//   {
//     lease:     row from leasing
//     tenant:    row from tenant
//     additionalTenants: array of tenant rows
//     unit:      row from unit
//     property:  row from property
//     org:       row from org_setting
//     today:     Date object
//     currency:  string (e.g. "HK$")
//   }

const VARIABLES = [
  // ── Tenant ─────────────────────────────────────────────────────────────
  { key: 'TENANT_NAME',       group: 'Tenant', label: 'Tenant full name',
    sample: 'Alice Wong',
    resolve: (ctx) => joinName(ctx.tenant?.first_name, ctx.tenant?.last_name, ctx.tenant?.company_name, ctx.tenant?.type) },
  { key: 'TENANT_FIRST_NAME', group: 'Tenant', label: 'Tenant first name',
    sample: 'Alice',
    resolve: (ctx) => ctx.tenant?.first_name || '' },
  { key: 'TENANT_LAST_NAME',  group: 'Tenant', label: 'Tenant last name',
    sample: 'Wong',
    resolve: (ctx) => ctx.tenant?.last_name || '' },
  { key: 'TENANT_EMAIL',      group: 'Tenant', label: 'Tenant email',
    sample: 'alice@example.com',
    resolve: (ctx) => ctx.tenant?.email || '' },
  { key: 'TENANT_PHONE',      group: 'Tenant', label: 'Tenant phone',
    sample: '+852 9123 4567',
    resolve: (ctx) => ctx.tenant?.phone || '' },
  { key: 'TENANT_ID_CARD',    group: 'Tenant', label: 'Tenant HKID / passport',
    sample: 'A123456(7)',
    resolve: (ctx) => ctx.tenant?.id_card || '' },
  { key: 'ADDITIONAL_TENANTS', group: 'Tenant', label: 'Additional tenants (comma-joined)',
    sample: 'Bob Wong, Charlie Wong',
    resolve: (ctx) => (ctx.additionalTenants || [])
      .map(t => joinName(t.first_name, t.last_name, t.company_name, t.type))
      .filter(Boolean).join(', ') },

  // ── Landlord / Org ─────────────────────────────────────────────────────
  { key: 'LANDLORD_NAME',    group: 'Landlord', label: 'Landlord / contact person',
    sample: 'Tane Property Management Ltd.',
    resolve: (ctx) => ctx.org?.contact_person || ctx.org?.company_name || '' },
  { key: 'LANDLORD_COMPANY', group: 'Landlord', label: 'Landlord company name',
    sample: 'Tane Property Management Ltd.',
    resolve: (ctx) => ctx.org?.company_name || '' },
  { key: 'LANDLORD_ADDRESS', group: 'Landlord', label: 'Landlord address',
    sample: '1/F, 88 Hennessy Road, Wan Chai, Hong Kong',
    resolve: (ctx) => ctx.org?.address || '' },
  { key: 'LANDLORD_PHONE',   group: 'Landlord', label: 'Landlord phone',
    sample: '+852 2123 4567',
    resolve: (ctx) => ctx.org?.phone || '' },
  { key: 'LANDLORD_EMAIL',   group: 'Landlord', label: 'Landlord email',
    sample: 'leasing@example.com',
    resolve: (ctx) => ctx.org?.email || '' },

  // ── Property / Unit ────────────────────────────────────────────────────
  { key: 'PROPERTY_NAME',    group: 'Property', label: 'Property name',
    sample: 'Fuk Lo Tsun',
    resolve: (ctx) => ctx.property?.display_name || '' },
  { key: 'PROPERTY_ADDRESS', group: 'Property', label: 'Property address (street)',
    sample: '88 Hennessy Road',
    resolve: (ctx) => ctx.property?.street_address || '' },
  { key: 'PROPERTY_DISTRICT', group: 'Property', label: 'District',
    sample: 'Causeway Bay',
    resolve: (ctx) => ctx.property?.district || '' },
  { key: 'PROPERTY_CITY',    group: 'Property', label: 'City / region',
    sample: 'Hong Kong Island',
    resolve: (ctx) => ctx.property?.city || '' },
  { key: 'PROPERTY_FULL_ADDRESS', group: 'Property', label: 'Full address (concatenated)',
    sample: '88 Hennessy Road, Causeway Bay, Hong Kong Island',
    resolve: (ctx) => [ctx.property?.street_address, ctx.property?.district, ctx.property?.city]
      .filter(Boolean).join(', ') },
  { key: 'UNIT_NAME',  group: 'Property', label: 'Unit name / number',
    sample: '3D',
    resolve: (ctx) => ctx.unit?.name || '' },
  { key: 'UNIT_BEDS',  group: 'Property', label: 'Bedrooms',
    sample: '2',
    resolve: (ctx) => ctx.unit?.beds != null ? String(ctx.unit.beds) : '' },
  { key: 'UNIT_BATHS', group: 'Property', label: 'Bathrooms',
    sample: '1',
    resolve: (ctx) => ctx.unit?.baths != null ? String(ctx.unit.baths) : '' },
  { key: 'UNIT_SIZE',  group: 'Property', label: 'Unit size (sq ft)',
    sample: '550 sq ft',
    resolve: (ctx) => ctx.unit?.size != null ? `${ctx.unit.size} sq ft` : '' },

  // ── Lease terms ────────────────────────────────────────────────────────
  { key: 'LEASE_NO', group: 'Lease', label: 'Lease number',
    sample: 'LEA3168',
    resolve: (ctx) => ctx.lease?.lease_no || '' },
  { key: 'LEASE_START', group: 'Lease', label: 'Lease start date (1 July 2026)',
    sample: '1 September 2026',
    resolve: (ctx) => fmtDateLong(ctx.lease?.start_date) },
  { key: 'LEASE_START_SHORT', group: 'Lease', label: 'Lease start (2026-09-01)',
    sample: '2026-09-01',
    resolve: (ctx) => fmtDateShort(ctx.lease?.start_date) },
  { key: 'LEASE_END', group: 'Lease', label: 'Lease end date',
    sample: '31 August 2027',
    resolve: (ctx) => fmtDateLong(ctx.lease?.end_date) },
  { key: 'LEASE_END_SHORT', group: 'Lease', label: 'Lease end (2027-08-31)',
    sample: '2027-08-31',
    resolve: (ctx) => fmtDateShort(ctx.lease?.end_date) },
  { key: 'LEASE_TERM_MONTHS', group: 'Lease', label: 'Lease term in months',
    sample: '12',
    resolve: (ctx) => {
      if (!ctx.lease?.start_date || !ctx.lease?.end_date) return '';
      const s = new Date(ctx.lease.start_date);
      const e = new Date(ctx.lease.end_date);
      const months = (e.getFullYear() - s.getFullYear()) * 12 + (e.getMonth() - s.getMonth());
      return String(Math.max(0, months));
    } },
  { key: 'RENT_AMOUNT', group: 'Lease', label: 'Monthly rent (formatted)',
    sample: 'HK$25,000.00',
    resolve: (ctx) => fmtMoney(ctx.lease?.price ?? ctx.lease?.amount, ctx.currency) },
  { key: 'RENT_DUE_DAY', group: 'Lease', label: 'Rent due day of month',
    sample: '1',
    resolve: (ctx) => ctx.lease?.due_date != null ? String(ctx.lease.due_date) : '' },
  { key: 'INVOICING_FREQUENCY', group: 'Lease', label: 'Invoicing schedule (monthly/weekly/…)',
    sample: 'Monthly',
    resolve: (ctx) => {
      const inv = String(ctx.lease?.invoicing || '').toLowerCase();
      const map = { '7':'Weekly','weekly':'Weekly','14':'Bi-weekly','bi-weekly':'Bi-weekly',
                    '30':'Monthly','monthly':'Monthly','60':'Bi-monthly','bi-monthly':'Bi-monthly',
                    '90':'Quarterly','quarterly':'Quarterly','180':'Bi-annually','bi-annually':'Bi-annually',
                    '365':'Annually','annually':'Annually' };
      return map[inv] || (inv ? inv : '');
    } },
  { key: 'DEPOSIT', group: 'Lease', label: 'Security deposit (formatted)',
    sample: 'HK$50,000.00',
    resolve: (ctx) => fmtMoney(ctx.lease?.deposit, ctx.currency) },
  { key: 'UTILITY_CREDIT', group: 'Lease', label: 'Utility credit (formatted)',
    sample: 'HK$0.00',
    resolve: (ctx) => fmtMoney(ctx.lease?.utility_credit, ctx.currency) },
  { key: 'CREDITS_NOTES', group: 'Lease', label: 'Credits / other notes',
    sample: '',
    resolve: (ctx) => ctx.lease?.credits || '' },
  { key: 'LEASE_NOTES', group: 'Lease', label: 'Lease notes',
    sample: '',
    resolve: (ctx) => ctx.lease?.note || '' },

  // ── Misc ───────────────────────────────────────────────────────────────
  { key: 'TODAY', group: 'Misc', label: 'Today (2026-06-08)',
    sample: fmtDateShort(new Date()),
    resolve: (ctx) => fmtDateShort(ctx.today) },
  { key: 'TODAY_FORMATTED', group: 'Misc', label: 'Today (8 June 2026)',
    sample: fmtDateLong(new Date()),
    resolve: (ctx) => fmtDateLong(ctx.today) },

  // ── Signature anchors ──────────────────────────────────────────────────
  // Place these in the template exactly where a signature should land (e.g.
  // just above the "Tenant Signature" line). On a REAL render they emit an
  // INVISIBLE white marker in the PDF text layer; the stamper locates it with
  // pdfAnchorFinder after signing and draws the signature image at that spot —
  // so the signature follows the text no matter how long the body is.
  // In a PREVIEW we show a visible dashed placeholder so the author sees where
  // signatures will land.
  { key: 'SIGNATURE_TENANT', group: 'Signature', label: 'Tenant signature (place above the signature line)',
    sample: '[ Tenant signature ]',
    resolve: (ctx) => sigAnchor(ctx, 'SIGANCHORTENANT1', 'Tenant signature') },
  { key: 'SIGNATURE_TENANT_2', group: 'Signature', label: '2nd tenant signature',
    sample: '[ 2nd tenant signature ]',
    resolve: (ctx) => sigAnchor(ctx, 'SIGANCHORTENANT2', '2nd tenant signature') },
  { key: 'SIGNATURE_TENANT_3', group: 'Signature', label: '3rd tenant signature',
    sample: '[ 3rd tenant signature ]',
    resolve: (ctx) => sigAnchor(ctx, 'SIGANCHORTENANT3', '3rd tenant signature') },
  { key: 'SIGNATURE_LANDLORD', group: 'Signature', label: 'Landlord signature (auto-stamped)',
    sample: '[ Landlord signature ]',
    resolve: (ctx) => sigAnchor(ctx, 'SIGANCHORLANDLORD', 'Landlord signature') },
  // Convenience alias for simple single-tenant templates.
  { key: 'SIGNATURE', group: 'Signature', label: 'Tenant signature (alias)',
    sample: '[ Tenant signature ]',
    resolve: (ctx) => sigAnchor(ctx, 'SIGANCHORTENANT1', 'Tenant signature') },
];

/**
 * Render a signature anchor. Real render (ctx.realRender) → invisible white
 * marker the pdfAnchorFinder can locate. Preview → visible dashed placeholder.
 */
function sigAnchor(ctx, marker, label) {
  if (ctx && ctx.realRender) {
    // White + small but reliably extractable; line-height:0 so it adds no height.
    return `<span style="color:#ffffff;font-size:8px;line-height:0;">${marker}</span>`;
  }
  return `<span style="display:inline-block;min-width:160px;border-bottom:1px dashed #999;color:#999;font-size:11px;text-align:center;">${label}</span>`;
}

const BY_KEY = Object.fromEntries(VARIABLES.map(v => [v.key, v]));

/**
 * Substitute every {{KEY}} placeholder in `html` with the resolved value.
 * Unknown placeholders are left as-is (so they're visible in the preview and
 * staff notice the typo).
 */
function substitute(html, ctx) {
  if (!html) return '';
  return String(html).replace(/\{\{\s*([A-Z0-9_]+)\s*\}\}/g, (full, key) => {
    const v = BY_KEY[key];
    if (!v) return full;       // leave unknown placeholders visible
    try {
      const val = v.resolve(ctx);
      return val == null ? '' : String(val);
    } catch {
      return full;
    }
  });
}

/**
 * Build a fake context for previewing a template without a real lease.
 * Used by GET /api/lease-template/:id/preview.
 */
function sampleContext() {
  return {
    lease: {
      lease_no: 'LEA3168',
      start_date: '2026-09-01',
      end_date: '2027-08-31',
      price: 25000, amount: 25000,
      deposit: 50000,
      utility_credit: 0,
      due_date: 1,
      invoicing: 'monthly',
      credits: '',
      note: '',
    },
    tenant: {
      first_name: 'Alice', last_name: 'Wong',
      email: 'alice@example.com', phone: '+852 9123 4567',
      id_card: 'A123456(7)', type: 0,
    },
    additionalTenants: [{ first_name: 'Bob', last_name: 'Wong', type: 0 }],
    unit: { name: '3D', beds: 2, baths: 1, size: 550 },
    property: {
      display_name: 'Fuk Lo Tsun',
      street_address: '88 Hennessy Road',
      district: 'Causeway Bay',
      city: 'Hong Kong Island',
    },
    org: {
      company_name: 'Tane Property Management Ltd.',
      contact_person: 'Tane Property Management Ltd.',
      address: '1/F, 88 Hennessy Road, Wan Chai, Hong Kong',
      phone: '+852 2123 4567',
      email: 'leasing@example.com',
    },
    today: new Date(),
    currency: 'HK$',
  };
}

/**
 * Frontend-friendly list for the "Insert Variable" dropdown.
 * Strips resolve functions (not serializable).
 */
function publicList() {
  return VARIABLES.map(({ key, label, group, sample }) => ({ key, label, group, sample }));
}

// Marker tokens emitted by the signature anchors (real render only). The
// stamper imports these so the two files never drift on the literal strings.
const SIGNATURE_MARKERS = {
  TENANT_1: 'SIGANCHORTENANT1',
  TENANT_2: 'SIGANCHORTENANT2',
  TENANT_3: 'SIGANCHORTENANT3',
  LANDLORD: 'SIGANCHORLANDLORD',
};

module.exports = {
  VARIABLES,
  substitute,
  sampleContext,
  publicList,
  SIGNATURE_MARKERS,
};
