const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseUnitAddress,
  isValidHkid,
  computeTerm,
  computeRent,
  estimateDuty,
  resolveLandlord,
  extractLandlordFromTemplate,
  buildStampingPayload,
} = require('../src/services/stampingPayload');

function hkid(prefix, digits) {
  const letters = prefix.toUpperCase().split('');
  const chars = letters.length === 1 ? [' ', letters[0]] : letters;
  const charValue = ch => (ch === ' ' ? 36 : ch.charCodeAt(0) - 55);
  let sum = charValue(chars[0]) * 9 + charValue(chars[1]) * 8;
  String(digits).split('').forEach((digit, i) => { sum += Number(digit) * (7 - i); });
  const check = (11 - (sum % 11)) % 11;
  return `${prefix}${digits}${check === 10 ? 'A' : check}`;
}

test('Tai Yuen golden case uses total rent and 0.25% duty', () => {
  const warnings = [];
  const term = computeTerm(
    { term_start: '2026-10-17', term_stamp_end: '2027-10-16' },
    { start_date: '2026-10-17', end_date: '2027-10-16' },
    warnings
  );
  const rent = computeRent({ price: 19000, amount: 0, invoicing: '30', credits: 0 }, term, [], warnings);
  assert.deepEqual(term, {
    start: '2026-10-17',
    end: '2027-10-16',
    months: 12,
    exceeds_one_year: false,
    period_recorded: true,
  });
  assert.deepEqual(rent, { field: 'total', amount: 228000, monthly_rent: 19000, total_rent: 228000 });
  assert.deepEqual(estimateDuty(term, rent), { duty: 570, tenant_share: 285, rate: 0.0025, basis: 'total_rent' });
});

test('one year and one day exceeds one year and warns for partial month', () => {
  const warnings = [];
  const term = computeTerm({ term_start: '2026-10-17', term_end: '2027-10-17' }, {}, warnings);
  assert.equal(term.exceeds_one_year, true);
  assert.equal(term.months, null);
  assert.ok(warnings.some(w => w.code === 'partial_month_term'));
});

test('24-month fixed lease uses monthly rent field and AYR duty', () => {
  const warnings = [];
  const term = computeTerm({ term_start: '2026-10-17', term_end: '2028-10-16' }, {}, warnings);
  const rent = computeRent({ price: 19000, invoicing: 'monthly', credits: 0 }, term, [], warnings);
  assert.equal(term.months, 24);
  assert.equal(term.exceeds_one_year, true);
  assert.deepEqual(rent, { field: 'monthly', amount: 19000, monthly_rent: 19000, total_rent: 456000 });
  assert.deepEqual(estimateDuty(term, rent), { duty: 1140, tenant_share: 570, rate: 0.005, basis: 'average_yearly_rent' });
});

test('NULL invoicing treats the lease figure as stay total', () => {
  const warnings = [];
  const term = computeTerm({ term_start: '2026-10-17', term_end: '2026-12-16' }, {}, warnings);
  const rent = computeRent({ amount: 38000, invoicing: null }, term, [], warnings);
  assert.equal(rent.field, 'total');
  assert.equal(rent.monthly_rent, null);
  assert.equal(rent.total_rent, 38000);
  assert.ok(warnings.some(w => w.code === 'stay_total_lease'));
});

test('signature request term overrides lease dates in the right order', () => {
  let warnings = [];
  assert.equal(computeTerm({ term_start: '2026-01-01', term_end: '2026-06-30', term_stamp_end: '2026-05-31' }, {}, warnings).end, '2026-05-31');
  warnings = [];
  assert.equal(computeTerm({ term_start: null, term_end: null }, { start_date: '2026-01-01', end_date: '2026-06-30', stamp_end_date: '2026-05-31' }, warnings).end, '2026-05-31');
});

test('address parser handles confident and manual-review shapes', () => {
  assert.deepEqual(parseUnitAddress('5A', 'Nam Pak Hong Building, 24 Bonham Strand West', 'Sheung Wan').floor, '5');
  assert.equal(parseUnitAddress('5A', 'Nam Pak Hong Building, 24 Bonham Strand West', 'Sheung Wan').flat, 'A');
  assert.equal(parseUnitAddress('25/F', 'Nam Pak Hong Building, 24 Bonham Strand West', 'Sheung Wan').flat, null);
  assert.equal(parseUnitAddress('25/F', 'Nam Pak Hong Building, 24 Bonham Strand West', 'Sheung Wan').floor, '25');
  assert.equal(parseUnitAddress('Unit 26', 'Nam Pak Hong Building, 24 Bonham Strand West', 'Sheung Wan').confident, false);
  assert.equal(parseUnitAddress('3D-A', 'Nam Pak Hong Building, 24 Bonham Strand West', 'Sheung Wan').confident, false);
  assert.equal(parseUnitAddress('3/F Unit 1 (Room A and Room B)', 'Nam Pak Hong Building, 24 Bonham Strand West', 'Sheung Wan').confident, false);
  const parsed = parseUnitAddress('5A', '  Nam Pak Hong Building, 24 Bonham Strand West  ', '  Sheung Wan  ');
  assert.equal(parsed.building, 'Nam Pak Hong Building');
  assert.equal(parsed.street, '24 Bonham Strand West');
  assert.equal(parsed.street_address, 'Nam Pak Hong Building, 24 Bonham Strand West');
  assert.equal(parsed.district, 'Sheung Wan');
});

// Signature blocks as the live templates print them (2026-10-09), markup simplified.
// Contract layout: one column. License layout: landlord and tenant side by side, so
// "Name:" appears twice on one line.
const CONTRACT_PARCELLE = '<p>Confirmed and Accepted all the terms and conditions contained herein by the Landlord:</p>'
  + '<p>{{SIGNATURE_LANDLORD}}_____________________________&nbsp;&nbsp;</p><p><span>Signature&nbsp;&nbsp;&nbsp;</span></p>'
  + '<p>Name: Parcelle Limited</p><p>Business Registration Number: 71930004</p><p>DATE: {{TODAY_FORMATTED}}</p>'
  + '<p>EMAIL: info@taneresidence.com</p><p>NUMBER: +852-62893882 (Whatsapp Msg Only)</p>';
const LICENSE_TANE = '<p><span>{{SIGNATURE_LANDLORD}}_____________________________</span><span>&nbsp;&nbsp;&nbsp;{{SIGNATURE_TENANT}}_____________________________</span></p>'
  + '<p>Signature&nbsp;&nbsp;&nbsp;Signature</p><p>Name:Tane Residence Ltd&nbsp;&nbsp;&nbsp;Name: {{TENANT_NAME}}</p>'
  + '<p>Business Registration Number:63461516&nbsp;&nbsp;&nbsp;I.D.No: {{TENANT_ID_CARD}}</p><p>DATE: {{TODAY_FORMATTED}}</p>';

test('landlord name and BR are read from the signature block of both template layouts', () => {
  assert.deepEqual(extractLandlordFromTemplate(CONTRACT_PARCELLE), { english_name: 'Parcelle Limited', br_no: '71930004' });
  assert.deepEqual(extractLandlordFromTemplate(LICENSE_TANE), { english_name: 'Tane Residence Ltd', br_no: '63461516' });
  // A "Name:" printed BEFORE the landlord signature (Schedule I's bank block) is not the landlord.
  const withBankBlock = '<p>Account Name/Beneficiary Name: Someone Else Limited</p>' + CONTRACT_PARCELLE;
  assert.deepEqual(extractLandlordFromTemplate(withBankBlock), { english_name: 'Parcelle Limited', br_no: '71930004' });
  // Older versions ran "Account Name/Number" straight on after the landlord's name.
  const oldLayout = '<p>{{SIGNATURE_LANDLORD}}</p><p>Name: ACJ Ventures Limited Account Name: x</p><p>Business Registration Number: 63225001</p>';
  assert.equal(extractLandlordFromTemplate(oldLayout).english_name, 'ACJ Ventures Limited');
});

test('landlord comes from the signed template, overriding a stale property entity', () => {
  // Live case: Pearl City's property says ACJ Ventures; its contracts print Parcelle.
  const warnings = [];
  assert.deepEqual(
    resolveLandlord({ signedTemplateHtml: CONTRACT_PARCELLE, unit: { account_name: 'ACJ Ventures Limited' }, property: { landlord_name: 'ACJ Ventures Limited' } }, warnings),
    { english_name: 'Parcelle Limited', br_no: '71930004', source: 'signed_template' }
  );
  assert.deepEqual(warnings, []);
});

test('a signed template without a BR line warns rather than borrowing one', () => {
  const warnings = [];
  const noBr = '<p>{{SIGNATURE_LANDLORD}}</p><p>Name: Parcelle Limited</p><p>DATE: {{TODAY_FORMATTED}}</p>';
  const got = resolveLandlord({ signedTemplateHtml: noBr, propertyTemplateHtmls: [LICENSE_TANE] }, warnings);
  assert.deepEqual(got, { english_name: 'Parcelle Limited', br_no: null, source: 'signed_template' });
  assert.ok(warnings.some(w => w.code === 'br_not_in_template'));
});

test('no template on the document: property templates are used only when they agree', () => {
  let warnings = [];
  assert.deepEqual(
    resolveLandlord({ propertyTemplateHtmls: [CONTRACT_PARCELLE, CONTRACT_PARCELLE.replace('Parcelle Limited', 'PARCELLE LIMITED')] }, warnings),
    { english_name: 'Parcelle Limited', br_no: '71930004', source: 'property_template' }
  );
  assert.ok(warnings.some(w => w.code === 'landlord_from_property_template'));

  warnings = [];
  const got = resolveLandlord({ propertyTemplateHtmls: [CONTRACT_PARCELLE, LICENSE_TANE], unit: { account_name: ' Parcelle Limited ' } }, warnings);
  assert.deepEqual(got, { english_name: 'Parcelle Limited', br_no: null, source: 'property' });
  assert.ok(warnings.some(w => w.code === 'landlord_ambiguous'));
  assert.ok(warnings.some(w => w.code === 'missing_br_no'));

  warnings = [];
  assert.deepEqual(resolveLandlord({ propertyTemplateHtmls: [] }, warnings), { english_name: null, br_no: null, source: 'property' });
  assert.ok(warnings.some(w => w.code === 'missing_landlord'));
});

test('HKID check digit accepts HKIDs and rejects wrong checks and passports', () => {
  const single = hkid('A', '123456');
  const double = hkid('AB', '123456');
  assert.equal(isValidHkid(`${single.slice(0, 7)}(${single.slice(7)})`), true);
  assert.equal(isValidHkid(single), true);
  assert.equal(isValidHkid(`${double.slice(0, 8)}(${double.slice(8)})`), true);
  assert.equal(isValidHkid(`${single.slice(0, 7)}${single.endsWith('0') ? '1' : '0'}`), false);
  assert.equal(isValidHkid('E12345678'), false);
  assert.equal(isValidHkid('EF37138591'), false);
});

test('buildStampingPayload assembles IDs as strings and warnings', () => {
  const payload = buildStampingPayload({
    request: { id: 123n, signature_method: 'paper', completed_at: '2026-10-18', term_start: '2026-10-17', term_end: '2027-10-16' },
    lease: { id: 456n, lease_no: 'LEA456', price: 19000, invoicing: '30' },
    unit: { name: '5A', account_name: 'Parcelle Limited' },
    property: { street_address: 'Nam Pak Hong Building, 24 Bonham Strand West', district: 'Sheung Wan', landlord_name: 'ACJ Ventures Limited' },
    tenants: [{ first_name: 'Ada', last_name: 'Lovelace', id_card: hkid('A', '123456') }],
    revisions: [],
    signedTemplateHtml: CONTRACT_PARCELLE,
  });
  assert.equal(payload.request_id, '123');
  assert.equal(payload.lease_id, '456');
  assert.equal(payload.tenants[0].id_type, 'hkid');
  assert.deepEqual(payload.landlord, { english_name: 'Parcelle Limited', br_no: '71930004', source: 'signed_template' });
});
