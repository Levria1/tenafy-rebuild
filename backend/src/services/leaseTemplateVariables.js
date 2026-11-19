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

const { personOrCompanyName, sanitiseNamePart } = require('../utils/personName');
const { fullAddress } = require('../utils/propertyAddress');
const tenantBlocks = require('./tenantTemplateBlocks');

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
  // A bare 'YYYY-MM-DD' must be read as a CALENDAR date, not an instant:
  // new Date('2028-08-19') is UTC midnight, and toLocaleDateString then renders
  // it in LOCAL time — one day early on any server west of UTC. Build it from
  // the parts instead so the printed day always matches the stored day.
  let d;
  if (v instanceof Date) {
    d = v;
  } else {
    const s = String(v).slice(0, 10);
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(v);
  }
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

function fmtDateShort(v) {
  if (!v) return '';
  const s = String(v).slice(0, 10);
  return s;
}

// Government Stamp End Date default: the stamped term conventionally runs
// 2 years MINUS 1 DAY from the lease start (start 2026-08-20 -> 2028-08-19), so
// the stamped period is exactly two years inclusive. Returns 'YYYY-MM-DD' (wall
// clock, no TZ shift) or '' when the start date is missing/invalid.
function defaultStampEndDate(startDate) {
  if (!startDate) return '';
  const s = String(startDate).slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  let y, mo, d;
  if (m) {
    y = Number(m[1]); mo = Number(m[2]); d = Number(m[3]);
  } else {
    const dt = startDate instanceof Date ? startDate : new Date(startDate);
    if (isNaN(dt.getTime())) return '';
    y = dt.getFullYear(); mo = dt.getMonth() + 1; d = dt.getDate();
  }
  // +2 years, then -1 day, in UTC so no TZ can shift the calendar date.
  // The day is CLAMPED to the target month's length first, so a 29-Feb start
  // behaves like dayjs's .add(2,'year') and MySQL's DATE_ADD(... INTERVAL 2 YEAR)
  // (2024-02-29 -> 2026-02-28 -> minus a day -> 2026-02-27). Without the clamp the
  // backend default and the create-form prefill would disagree on leap days.
  const targetY = y + 2;
  const lastDayOfMonth = new Date(Date.UTC(targetY, mo, 0)).getUTCDate();
  const end = new Date(Date.UTC(targetY, mo - 1, Math.min(d, lastDayOfMonth)));
  end.setUTCDate(end.getUTCDate() - 1);
  const p = (n) => String(n).padStart(2, '0');
  return `${end.getUTCFullYear()}-${p(end.getUTCMonth() + 1)}-${p(end.getUTCDate())}`;
}

// The stamped end date actually in force for a lease: the stored value when set,
// otherwise the 2-years-minus-1-day default derived from the start date.
// Returns 'YYYY-MM-DD'. mysql2 hands back a DATE as a LOCAL-midnight Date, so we
// read wall-clock parts here — never toISOString(), which would shift the day on
// a non-UTC server (same convention as dateToWallClock elsewhere).
function ymd(v) {
  if (!v) return '';
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return '';
    const p = (n) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  const s = String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

// The end date the CONTRACT should show as its Term of Tenancy.
// Only SOME tenancies must be stamped for a longer term than the tenant actually
// stays, so the stamped date is an OPT-IN override (the tick box on the lease
// form): set -> print the stamped term; not set -> the contract's term simply IS
// the real tenancy term. It must NOT invent a 2-year term for an ordinary lease.
function effectiveStampEndDate(lease) {
  if (!lease) return '';
  return ymd(lease.stamp_end_date) || ymd(lease.end_date) || '';
}

/**
 * Point a lease context at ONE period of the tenancy, for documents that cover
 * an extension rather than the whole lease.
 *
 * stamp_end_date MUST be set explicitly, never left to fall through:
 * effectiveStampEndDate returns `stamp_end_date || end_date`, so a lease with
 * "Stamp for a longer term" ticked for its ORIGINAL period would otherwise
 * print that original stamped date as the extension's Term of Tenancy — a
 * wrong date on a legal document.
 *
 * Everything else — rent, tenant, property, unit — deliberately still comes
 * from the lease row, so an extension prints the current rent.
 *
 * Lives here rather than in leasePdfRenderer because that module requires
 * puppeteer at load time, which cannot be imported by the unit tests.
 */
function applyTermOverride(ctx, term) {
  if (!ctx || !ctx.lease) return ctx;
  if (!term || !term.start_date || !term.end_date) return ctx;
  ctx.lease = {
    ...ctx.lease,
    start_date: term.start_date,
    end_date: term.end_date,
    stamp_end_date: term.stamp_end_date || null,
  };
  return ctx;
}

// ── Page breaks inside a template ───────────────────────────────────────────
//
// Authors place {{PAGE_BREAK}} on its own line wherever a new page should start
// (the contract templates use one before Schedule I..V and SPECIAL CONDITIONS).
//
// It has to be a TEXT marker, not a class or style. The template editor is
// react-quill (`<ReactQuill value={bodyHtml} onChange={setBodyHtml}>`), which
// loads HTML through clipboard.convert() — that parses into Quill's Delta model
// using only REGISTERED formats and discards everything else, then hands back
// normalised HTML. So a class="page-break" or style="page-break-before" written
// into the stored HTML would disappear the first time someone opened the
// template and saved it. Plain text survives that round-trip, which is exactly
// why {{VARIABLE}} placeholders work — so the break rides along as one of them.
//
// PAGE_BREAK resolves to ITSELF in the variable registry, so substitution leaves
// the marker intact for this transform to convert afterwards.
const PAGE_BREAK_TOKEN = '{{PAGE_BREAK}}';

function blockText(html) {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Turn {{PAGE_BREAK}} markers into real page breaks.
 *
 * A marker sitting alone in a block REPLACES that block rather than nesting
 * inside it: `<div>` is not valid inside `<p>`, and browsers silently close the
 * paragraph early, which shifts the surrounding layout. A marker mixed into a
 * line of text is dropped — an author who typed it mid-sentence did not mean to
 * break the page there, and leaving the raw token visible in a signed contract
 * would be worse.
 */
function applyPageBreakMarkers(html) {
  if (!html) return html || '';
  let out = String(html).replace(/<(p|div)\b[^>]*>([\s\S]*?)<\/\1>/gi, (full, tag, inner) =>
    blockText(inner) === PAGE_BREAK_TOKEN ? '<div class="page-break"></div>' : full
  );
  // Any leftover marker (mixed into text, or outside a block) is removed so the
  // literal token can never print on a contract.
  if (out.includes(PAGE_BREAK_TOKEN)) {
    out = out.split(PAGE_BREAK_TOKEN).join('');
  }
  return out;
}

function joinName(first, middle, last, company, type) {
  return personOrCompanyName({ first_name: first, middle_name: middle, last_name: last, company_name: company, type });
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
  { key: 'TENANT_PARTIES', group: 'Tenant', label: 'All tenant names and identification details',
    sample: 'Alice Wong / Bob Wong', resolve: ctx => tenantBlocks.renderBlock('parties',ctx,substitute) },
  { key: 'TENANT_SIGNATURES', group: 'Signature', label: 'All tenant signature blocks (automatic count)',
    sample: 'One signature space per tenant', resolve: ctx => tenantBlocks.renderBlock('signatures',ctx,substitute) },
  // ── Tenant ─────────────────────────────────────────────────────────────
  { key: 'TENANT_NAME',       group: 'Tenant', label: 'Tenant full name',
    sample: 'Alice Wong',
    resolve: (ctx) => joinName(ctx.tenant?.first_name, ctx.tenant?.middle_name, ctx.tenant?.last_name, ctx.tenant?.company_name, ctx.tenant?.type) },
  { key: 'TENANT_FIRST_NAME', group: 'Tenant', label: 'Tenant first name',
    sample: 'Alice',
    resolve: (ctx) => ctx.tenant?.first_name || '' },
  { key: 'TENANT_LAST_NAME',  group: 'Tenant', label: 'Tenant last name',
    sample: 'Wong',
    resolve: (ctx) => ctx.tenant?.last_name || '' },
  { key: 'TENANT_MIDDLE_NAME', group: 'Tenant', label: 'Tenant middle name',
    sample: 'Marie',
    resolve: (ctx) => sanitiseNamePart(ctx.tenant?.middle_name) || '' },
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
      .map(t => joinName(t.first_name, t.middle_name, t.last_name, t.company_name, t.type))
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
    resolve: (ctx) => fullAddress(ctx.property) },
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
  // Government Stamp End Date — PAPERWORK ONLY. Some tenancies must be stamped
  // for a longer term (e.g. 2 years) than the tenant actually stays. This never
  // affects vacancy/invoicing/expiry — those use LEASE_END. Falls back to
  // start_date + 2 years - 1 day when the lease has no stamp date set.
  { key: 'STAMP_END_DATE', group: 'Lease', label: 'Term-of-Tenancy end (stamped term if set, else lease end)',
    sample: '19 August 2028',
    resolve: (ctx) => fmtDateLong(effectiveStampEndDate(ctx.lease)) },
  { key: 'STAMP_END_DATE_SHORT', group: 'Lease', label: 'Term-of-Tenancy end, short (2028-08-19)',
    sample: '2028-08-19',
    resolve: (ctx) => fmtDateShort(effectiveStampEndDate(ctx.lease)) },
  // Layout marker, not data. Resolves to ITSELF so it survives substitution and
  // is converted to a real break by applyPageBreakMarkers.
  { key: 'PAGE_BREAK', group: 'Layout', label: 'Page break — start a new page here',
    sample: '',
    resolve: () => PAGE_BREAK_TOKEN },
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
  { key: 'NOTICE_PERIOD', group: 'Lease', label: 'Renewal notice period (days)',
    sample: '60',
    resolve: (ctx) => ctx.lease?.notice_period_days != null ? String(ctx.lease.notice_period_days) : '' },
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
  if (ctx && (ctx.realRender || ctx.tenantLayout || ctx.alignSignatureLines)) {
    // White + small but reliably extractable; line-height:0 so it adds no height.
    const anchor = `<span style="color:#ffffff;font-size:8px;line-height:0;">${marker}</span>`;
    // Upgraded layouts put the marker immediately before an underline. Keep
    // its PDF text position, but reserve no width so the line starts below ink.
    return ctx.tenantLayout || ctx.alignSignatureLines
      ? `<span style="display:inline-block;width:0;overflow:visible;white-space:nowrap;">${anchor}</span>`
      : anchor;
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
  const expandedBlocks=new Map();
  // Quill wraps standalone tokens in paragraphs. Remove the entire wrapper
  // before expanding block HTML; <div> inside <p> would alter PDF spacing.
  const expanded=String(html).replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gi,(full,inner)=>{
    const text=blockText(inner).trim();
    if(!/^\{\{(?:TENANT_PARTIES|TENANT_SIGNATURES)\}\}$/.test(text))return full;
    const marker=`TENAFYBLOCK${require('crypto').randomUUID()}`;
    expandedBlocks.set(marker,BY_KEY[text.slice(2,-2)].resolve(ctx));
    return marker;
  });
  let result=expanded.replace(/\{\{\s*([A-Z0-9_]+)\s*\}\}/g, (full, key) => {
    const v = BY_KEY[key];
    if (!v) return full;       // leave unknown placeholders visible
    try {
      const val = v.resolve(ctx);
      return val == null ? '' : ctx.escapeTemplateValues&&!key.startsWith('SIGNATURE')&&key!=='PAGE_BREAK'
        ? tenantBlocks.escapeValue(val):String(val);
    } catch {
      return full;
    }
  });
  for(const [marker,value] of expandedBlocks)result=result.split(marker).join(value);
  return result;
}

/**
 * Which placeholders in a template resolve to nothing for this lease.
 *
 * A blank resolves to an empty string, so the document renders the LABEL with no value
 * after it — "I.D.No:" followed by white space. That reads as a broken template when it is
 * really missing data, and on a signed tenancy agreement an empty identification field is
 * a defect worth catching before it is sent rather than after.
 *
 * Returns [{ key, label }], deduplicated, in template order.
 */
function findEmptyPlaceholders(htmlParts, ctx) {
  const seen = new Set();
  const empty = [];
  for (const html of (Array.isArray(htmlParts) ? htmlParts : [htmlParts])) {
    if (!html) continue;
    for (const m of String(html).matchAll(/\{\{\s*([A-Z0-9_]+)\s*\}\}/g)) {
      const key = m[1];
      if (seen.has(key)) continue;
      const v = BY_KEY[key];
      if (!v || key === 'PAGE_BREAK') continue;   // layout markers are not data
      seen.add(key);
      let val;
      try { val = v.resolve(ctx); } catch { continue; }
      if (val == null || String(val).trim() === '') empty.push({ key, label: v.label });
    }
  }
  const all=(Array.isArray(htmlParts)?htmlParts:[htmlParts]).join('\n');
  if(/\{\{\s*TENANT_(?:PARTIES|SIGNATURES)\s*\}\}/.test(all)){
    for(const [i,t] of tenantBlocks.tenantsFor(ctx).entries()){
      for(const [field,label,value] of [['NAME','legal name',personOrCompanyName(t)],['ID_CARD','identification number',t.id_card],['EMAIL','email',t.email]]){
        if(!String(value||'').trim())empty.push({key:`TENANT_${i+1}_${field}`,label:`Tenant ${i+1}: ${label}`});
      }
    }
  }
  return empty;
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
      // Set so a template author can SEE the difference between the stamped
      // Term of Tenancy ({{STAMP_END_DATE}} → 2028-08-31) and the real term
      // ({{LEASE_END}} → 2027-08-31). With this null the two printed the same
      // date and the distinction was invisible in the preview.
      stamp_end_date: '2028-08-31',
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
// Groups withheld from the editor's "Insert Variable" menu. The Landlord group
// resolves from a table (`org_setting`) that does not exist in any org DB, so
// every LANDLORD_* variable renders as an empty string — inserting one silently
// blanks that line of the contract. No live template uses them (all of them type
// the landlord in literally, and the entity differs per property anyway), so they
// are offered only as a trap. They still RESOLVE, so any old template that
// referenced one behaves exactly as before. Re-expose once landlord details have
// a real store — see property.landlord_name (migration 032) for the invoice side.
const HIDDEN_GROUPS = new Set(['Landlord']);

function publicList() {
  return VARIABLES
    .filter(v => !HIDDEN_GROUPS.has(v.group))
    .map(({ key, label, group, sample }) => ({ key, label, group, sample }));
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
  applyTermOverride,
  fullAddress,
  findEmptyPlaceholders,
  applyPageBreakMarkers,
  PAGE_BREAK_TOKEN,
  // exported for tests
  defaultStampEndDate,
  effectiveStampEndDate,
};
