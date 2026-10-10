/**
 * The eTAX stamping payload for one signed tenancy document — everything IRD's
 * "Stamping on Property Document → Tenancy Agreement" form asks for, so a bot (or a
 * person) can file without retyping the contract. Spec:
 * docs/superpowers/specs/2026-10-09-stamping-api-design.md; the eTAX steps themselves:
 * docs/etax-stamping-handoff.md.
 *
 * Pure functions, no DB. Anything the data cannot settle is reported in `warnings`
 * rather than guessed — a stamping filing is a legal submission under the operator's
 * tax login, and a wrong one needs an IRD amendment to undo.
 *
 * The duty here is a cross-check only. The IRD payment notice is the real figure.
 */

function trimOrNull(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function ymd(value) {
  if (!value) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const p = n => String(n).padStart(2, '0');
    return `${value.getFullYear()}-${p(value.getMonth() + 1)}-${p(value.getDate())}`;
  }
  const text = String(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function addWarning(warnings, code, message) {
  if (!warnings.some(w => w.code === code)) warnings.push({ code, message });
}

function parseDate(date) {
  const text = ymd(date);
  if (!text) return null;
  const [y, m, d] = text.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function formatDate(date) {
  if (!date || Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function addDays(date, days) {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function addMonths(date, months) {
  const next = new Date(date.getTime());
  const day = next.getUTCDate();
  next.setUTCDate(1);
  next.setUTCMonth(next.getUTCMonth() + months);
  const last = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
  next.setUTCDate(Math.min(day, last));
  return next;
}

function monthSpan(start, end) {
  const s = parseDate(start);
  const e = parseDate(end);
  if (!s || !e || e < s) return null;
  const rough = (e.getUTCFullYear() - s.getUTCFullYear()) * 12 + (e.getUTCMonth() - s.getUTCMonth()) + 1;
  for (const n of [rough - 1, rough, rough + 1].filter(v => v >= 0)) {
    if (formatDate(addDays(addMonths(s, n), -1)) === ymd(end)) return n;
  }
  return null;
}

function numeric(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function money(value) {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.round(value * 100) / 100;
}

function parseUnitAddress(unitName, streetAddress, district, warnings = []) {
  const unit = trimOrNull(unitName);
  const street = trimOrNull(streetAddress);
  const dist = trimOrNull(district);
  const address = {
    flat: null, floor: null, block: null, building: null, estate: null, street: null,
    district: dist, unit_name: unit, street_address: street, confident: true,
  };

  if (unit && /^\d{1,2}[A-Z]$/i.test(unit)) {
    address.floor = unit.slice(0, -1);
    address.flat = unit.slice(-1).toUpperCase();
  } else if (unit && /^\d{1,2}\/F$/i.test(unit)) {
    address.floor = unit.replace(/\/F$/i, '');
  } else if (unit) {
    address.confident = false;
  }

  if (street && street.includes(',')) {
    const first = street.split(',')[0].trim();
    const rest = street.slice(street.indexOf(',') + 1).trim();
    if (first && rest && !/\d/.test(first)) {
      address.building = first;
      address.street = rest;
    } else {
      address.confident = false;
    }
  } else if (street) {
    address.street = street;
  }

  if (!dist) addWarning(warnings, 'missing_district', 'Property district is not recorded.');
  if (!address.confident) addWarning(warnings, 'address_unparsed', 'Unit or street address needs manual review before stamping.');
  return address;
}

function isValidHkid(value) {
  const clean = String(value || '').toUpperCase().replace(/[\s()]/g, '');
  const match = clean.match(/^([A-Z]{1,2})(\d{6})([0-9A])$/);
  if (!match) return false;
  const chars = match[1].length === 1 ? [' ', match[1]] : match[1].split('');
  const body = `${match[2]}${match[3]}`.split('');
  const charValue = ch => (ch === ' ' ? 36 : ch.charCodeAt(0) - 55);
  let sum = charValue(chars[0]) * 9 + charValue(chars[1]) * 8;
  for (let i = 0; i < 6; i++) sum += Number(body[i]) * (7 - i);
  const expected = (11 - (sum % 11)) % 11;
  const check = expected === 10 ? 'A' : String(expected);
  return check === body[6];
}

/**
 * What kind of document an ID number is, from its format alone (operator rule,
 * 2026-10-10). Measured on the 865 recorded numbers:
 *  - a valid HKID check digit → 'hkid' (265; brackets optional);
 *  - HKID-SHAPED but the check digit fails → 'passport' (168). These are mostly two
 *    letters + 7 digits — the mainland passport format ("EA1234567") — or a letter +
 *    7 digits (also an Indian passport format). A mistyped HKID lands here too, and is
 *    wrong for stamping either way; the recorded type can always be corrected by hand;
 *  - any other 6–12 character letter/digit code containing a digit → 'passport' (416);
 *  - anything else (phone numbers, emails, two IDs in one box) → null (16).
 */
function classifyIdNumber(value) {
  const raw = trimOrNull(value);
  if (!raw) return null;
  if (isValidHkid(raw)) return 'hkid';
  const clean = raw.toUpperCase().replace(/[\s()\-]/g, '');
  if (/^[A-Z]{1,2}\d{6}[0-9A]$/.test(clean)) return 'passport';
  if (/^[A-Z0-9]{6,12}$/.test(clean) && /\d/.test(clean)) return 'passport';
  return null;
}

function resolveIdType(tenant, warnings = []) {
  const recorded = trimOrNull(tenant && tenant.id_type);
  const idNo = trimOrNull(tenant && tenant.id_card);
  if (recorded) return { id_type: recorded, id_type_source: 'recorded' };
  if (!idNo) {
    addWarning(warnings, 'missing_id_no', 'Tenant ID number is not recorded.');
    return { id_type: null, id_type_source: 'unknown' };
  }
  const inferred = classifyIdNumber(idNo);
  if (inferred) {
    addWarning(warnings, 'id_type_inferred', 'Tenant ID type was not recorded; inferred from the number\'s format.');
    return { id_type: inferred, id_type_source: 'inferred' };
  }
  addWarning(warnings, 'id_type_unknown', 'Tenant ID type is not recorded and the number is not a recognisable ID format.');
  return { id_type: null, id_type_source: 'unknown' };
}

/**
 * Tenancies shorter than one calendar month are not stamped (operator, 2026-10-10).
 * Exactly one month (17 Oct → 16 Nov) IS stamped — consistent with the paperwork rule
 * that exactly one month needs a contract. Measured on the stamped end, since that is
 * the term the contract prints.
 */
function isUnderOneMonth(start, end) {
  const s = parseDate(start);
  const e = parseDate(end);
  if (!s || !e) return false;
  const oneMonthEnd = addDays(addMonths(s, 1), -1);
  return e < oneMonthEnd;
}

function computeTerm(request, lease, warnings = []) {
  const start = ymd(request && request.term_start) || ymd(lease && lease.start_date);
  const end = ymd(request && request.term_stamp_end) || ymd(request && request.term_end)
    || ymd(lease && lease.stamp_end_date) || ymd(lease && lease.end_date);
  const periodRecorded = Boolean(ymd(request && request.term_start));
  if (!periodRecorded) addWarning(warnings, 'period_not_recorded', 'Signature request did not record a stamped term start.');
  const months = start && end ? monthSpan(start, end) : null;
  if (start && end && months == null) addWarning(warnings, 'partial_month_term', 'Term is not an exact whole-month tenancy period.');
  const threshold = start ? formatDate(addDays(addMonths(parseDate(start), 12), -1)) : null;
  return { start, end, months, exceeds_one_year: Boolean(end && threshold && end > threshold), period_recorded: periodRecorded };
}

function computeRent(lease, term, revisions = [], warnings = []) {
  const price = numeric(lease && lease.price);
  const amount = numeric(lease && lease.amount);
  const figure = price && price !== 0 ? price : amount;
  const invoicing = trimOrNull(lease && lease.invoicing);
  let monthlyRent = null;
  let totalRent = null;

  if (invoicing === '30' || (invoicing && invoicing.toLowerCase() === 'monthly')) {
    monthlyRent = figure;
    totalRent = monthlyRent != null && term.months != null ? money(monthlyRent * term.months) : null;
  } else if (!invoicing) {
    totalRent = figure;
    addWarning(warnings, 'stay_total_lease', 'Lease has no invoicing schedule; rent figure is treated as total rent for the stay.');
  } else {
    addWarning(warnings, 'unsupported_invoicing', 'Lease invoicing schedule is not supported for automatic stamping.');
  }

  const base = figure;
  const hasRentChange = revisions.some((rev) => {
    const revPrice = numeric(rev.price);
    const effective = ymd(rev.effective_from);
    return rev.deleted_at == null && revPrice != null && base != null && revPrice !== base
      && effective && term.start && term.end && effective >= term.start && effective <= term.end;
  });
  if (hasRentChange) addWarning(warnings, 'rent_changes_during_term', 'Lease has a rent revision during the stamped term.');
  const credits = numeric(lease && lease.credits);
  const hasCredits = credits != null && credits > 0;
  if (hasCredits) addWarning(warnings, 'lease_has_credits', 'Lease has credits and may include rent-free or adjusted rent.');

  let field = null;
  let stampAmount = null;
  if (term.exceeds_one_year && !hasRentChange && !hasCredits && monthlyRent != null) {
    field = 'monthly';
    stampAmount = monthlyRent;
  } else if (totalRent != null) {
    field = 'total';
    stampAmount = totalRent;
  }
  return { field, amount: stampAmount == null ? null : money(stampAmount), monthly_rent: money(monthlyRent), total_rent: money(totalRent) };
}

function estimateDuty(term, rent) {
  if (!term || !rent || term.months == null || rent.total_rent == null || term.months <= 0) {
    return { duty: null, tenant_share: null, rate: null, basis: null };
  }
  const years = term.months / 12;
  let rate;
  let basis;
  if (!term.exceeds_one_year) {
    rate = 0.0025;
    basis = 'total_rent';
  } else if (years <= 3) {
    rate = 0.005;
    basis = 'average_yearly_rent';
  } else {
    rate = 0.01;
    basis = 'average_yearly_rent';
  }
  const taxable = basis === 'total_rent' ? rent.total_rent : rent.total_rent / years;
  // Round to cents BEFORE taking the ceiling: 0.0025 is not exact in binary, so a
  // product that should be 570 can land at 570.0000000001 and bill a dollar too much.
  const duty = Math.ceil(Math.round(taxable * rate * 100) / 100);
  return { duty, tenant_share: money(duty / 2), rate, basis };
}

// Template HTML → plain text, so the signature block reads as it prints.
function templateText(html) {
  return String(html || '')
    .replace(/<\s*(br|\/p|\/div|\/tr|\/td|\/li|\/h\d)\b[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The landlord's English name and BR number as printed in a lease template's
 * signature block, e.g. "Signature Name: Parcelle Limited Business Registration
 * Number: 71930004". The BR number is not stored anywhere else in Tenafy — every
 * entity's number is typed into its own templates — so this is the source of truth.
 *
 * Reads from the landlord signature anchor onwards, so a tenant-side "Name:" printed
 * before it cannot be mistaken for the landlord. License agreements print the two
 * signature columns side by side ("Name: Tane Residence Ltd Name: {{TENANT_NAME}}"),
 * hence the name stops at the next "Name:" or label. Older template versions put
 * "Account Name/Number" straight after the landlord name, so "Account" is a stop too.
 */
function extractLandlordFromTemplate(html) {
  const text = templateText(html);
  if (!text) return { english_name: null, br_no: null };
  let anchor = text.search(/\{\{\s*SIGNATURE_LANDLORD\s*\}\}/i);
  if (anchor < 0) anchor = text.search(/by the Landlord/i);
  const tail = anchor >= 0 ? text.slice(anchor) : text;
  const br = tail.match(/Business Registration (?:Number|No\.?)\s*:?\s*(\d{8})\b/i);
  const name = tail.match(/Name\s*:\s*(.+?)\s*(?=Name\s*:|Business Registration|Account\b|DATE\s*:|I\.?\s*D\.?\s*No|EMAIL\s*:|NUMBER\s*:|\{\{|$)/i);
  const englishName = name && !/[{}]/.test(name[1]) ? trimOrNull(name[1]) : null;
  return { english_name: englishName, br_no: br ? br[1] : null };
}

/**
 * Who the landlord is, in this order:
 *  1. the exact template version the contract was signed with — what the tenant saw;
 *  2. the property's allowed templates, when the document records none (a paper
 *     signing) and they all name the same entity — flagged, because it is inferred;
 *  3. the unit's account name / property's landlord_name, with no BR number.
 * Live 2026-10-09: both Pearl City properties' landlord_name says ACJ Ventures while
 * their contracts print Parcelle — the template is right, the property field is stale.
 */
function resolveLandlord({ signedTemplateHtml, propertyTemplateHtmls, unit, property } = {}, warnings = []) {
  const fallbackName = trimOrNull(unit && unit.account_name) || trimOrNull(property && property.landlord_name);

  if (signedTemplateHtml) {
    const found = extractLandlordFromTemplate(signedTemplateHtml);
    if (!found.br_no) addWarning(warnings, 'br_not_in_template', 'The signed template does not print a landlord Business Registration Number.');
    const englishName = found.english_name || fallbackName;
    if (!englishName) addWarning(warnings, 'missing_landlord', 'Landlord name is not recorded.');
    return { english_name: englishName, br_no: found.br_no, source: 'signed_template' };
  }

  const candidates = (propertyTemplateHtmls || [])
    .map(extractLandlordFromTemplate)
    .filter(c => c.english_name && c.br_no);
  // Same company spelled with different case is one landlord; keep the first spelling.
  const byKey = new Map();
  for (const c of candidates) {
    const key = `${c.english_name.toLowerCase()}|${c.br_no}`;
    if (!byKey.has(key)) byKey.set(key, c);
  }
  const distinct = [...byKey.values()];
  if (distinct.length === 1) {
    addWarning(warnings, 'landlord_from_property_template', 'The document records no template; landlord taken from the property\'s lease templates.');
    return { ...distinct[0], source: 'property_template' };
  }
  if (distinct.length > 1) addWarning(warnings, 'landlord_ambiguous', 'The property\'s lease templates name different landlords.');
  if (!fallbackName) addWarning(warnings, 'missing_landlord', 'Landlord name is not recorded.');
  addWarning(warnings, 'missing_br_no', 'No landlord Business Registration Number could be found for this document.');
  return { english_name: fallbackName, br_no: null, source: 'property' };
}

function tenantName(tenant) {
  return trimOrNull(tenant && tenant.company_name)
    || trimOrNull(`${tenant && tenant.first_name ? tenant.first_name : ''} ${tenant && tenant.last_name ? tenant.last_name : ''}`);
}

function buildStampingPayload({ request, lease, unit, property, tenants, revisions, signedTemplateHtml, propertyTemplateHtmls }) {
  const warnings = [];
  const term = computeTerm(request, lease, warnings);
  const rent = computeRent(lease, term, revisions || [], warnings);
  const payloadTenants = (tenants || []).map((tenant, index) => {
    const resolved = resolveIdType(tenant, warnings);
    const idNo = trimOrNull(tenant && tenant.id_card);
    if (!idNo) addWarning(warnings, 'missing_id_no', 'Tenant ID number is not recorded.');
    return {
      role: index === 0 ? 'primary' : 'additional',
      english_name: tenantName(tenant),
      id_no: idNo,
      id_type: resolved.id_type,
      id_type_source: resolved.id_type_source,
    };
  });
  if (!payloadTenants.length) addWarning(warnings, 'missing_tenant', 'Lease has no tenant recorded.');
  const signedPdfUrl = request.signed_file_id ? `/api/public/stamping/${String(request.id)}/document` : null;
  if (!signedPdfUrl) addWarning(warnings, 'no_signed_file', 'Signed request has no signed PDF file attached.');
  return {
    request_id: String(request.id),
    lease_id: String(lease.id),
    lease_no: lease.lease_no || null,
    signature_method: request.signature_method || 'esign',
    signed_on: ymd(request.completed_at),
    stamping_required: !isUnderOneMonth(term.start, term.end),
    not_required_reason: isUnderOneMonth(term.start, term.end) ? 'under_one_month' : null,
    duplicates: 0,
    applicant_capacity: 'landlord',
    payment_method: 'offline',
    term,
    rent,
    address: parseUnitAddress(unit && unit.name, property && property.street_address, property && property.district, warnings),
    tenants: payloadTenants,
    landlord: resolveLandlord({ signedTemplateHtml, propertyTemplateHtmls, unit, property }, warnings),
    duty_estimate: estimateDuty(term, rent),
    signed_pdf_url: signedPdfUrl,
    warnings,
  };
}

module.exports = {
  parseUnitAddress,
  isValidHkid,
  resolveIdType,
  classifyIdNumber,
  isUnderOneMonth,
  computeTerm,
  computeRent,
  estimateDuty,
  resolveLandlord,
  extractLandlordFromTemplate,
  buildStampingPayload,
};
