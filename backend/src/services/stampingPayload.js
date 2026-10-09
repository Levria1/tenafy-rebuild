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

function resolveIdType(tenant, warnings = []) {
  const recorded = trimOrNull(tenant && tenant.id_type);
  const idNo = trimOrNull(tenant && tenant.id_card);
  if (recorded) return { id_type: recorded, id_type_source: 'recorded' };
  if (!idNo) {
    addWarning(warnings, 'missing_id_no', 'Tenant ID number is not recorded.');
    return { id_type: null, id_type_source: 'unknown' };
  }
  if (isValidHkid(idNo)) {
    addWarning(warnings, 'id_type_inferred', 'Tenant ID type was inferred from a valid HKID check digit.');
    return { id_type: 'hkid', id_type_source: 'inferred' };
  }
  addWarning(warnings, 'id_type_unknown', 'Tenant ID type is not recorded and could not be inferred.');
  return { id_type: null, id_type_source: 'unknown' };
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

function resolveLandlord(unit, property, warnings = []) {
  const unitName = trimOrNull(unit && unit.account_name);
  const propertyName = trimOrNull(property && property.landlord_name);
  const englishName = unitName || propertyName;
  // The BR number is stored per PROPERTY, but the entity that signs (and that
  // invoices print) is the unit's account name when one is set. If the two name
  // different companies, the property's BR belongs to someone else — withhold it.
  // Live case: both Pearl City properties say ACJ Ventures, their units say Parcelle.
  const mismatch = Boolean(unitName && propertyName && unitName.toLowerCase() !== propertyName.toLowerCase());
  if (mismatch) addWarning(warnings, 'landlord_entity_mismatch', 'Unit account name differs from the property landlord entity, so the property BR number is not used.');
  const brNo = mismatch ? null : trimOrNull(property && property.landlord_br_no);
  if (!englishName) addWarning(warnings, 'missing_landlord', 'Landlord name is not recorded.');
  if (!brNo) addWarning(warnings, 'missing_br_no', 'Landlord BR number is not recorded for the resolved landlord.');
  return { english_name: englishName, br_no: brNo };
}

function tenantName(tenant) {
  return trimOrNull(tenant && tenant.company_name)
    || trimOrNull(`${tenant && tenant.first_name ? tenant.first_name : ''} ${tenant && tenant.last_name ? tenant.last_name : ''}`);
}

function buildStampingPayload({ request, lease, unit, property, tenants, revisions }) {
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
    duplicates: 0,
    applicant_capacity: 'landlord',
    payment_method: 'offline',
    term,
    rent,
    address: parseUnitAddress(unit && unit.name, property && property.street_address, property && property.district, warnings),
    tenants: payloadTenants,
    landlord: resolveLandlord(unit, property, warnings),
    duty_estimate: estimateDuty(term, rent),
    signed_pdf_url: signedPdfUrl,
    warnings,
  };
}

module.exports = {
  parseUnitAddress,
  isValidHkid,
  resolveIdType,
  computeTerm,
  computeRent,
  estimateDuty,
  resolveLandlord,
  buildStampingPayload,
};
