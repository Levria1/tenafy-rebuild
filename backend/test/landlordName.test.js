const test = require('node:test');
const assert = require('node:assert');

const { VARIABLES, publicList } = require('../src/services/leaseTemplateVariables');

// The company name that prints on invoice/receipt headers. Mirrors the chain used at
// the three call sites in routes/pdf.js. `org.company_name` is deliberately NOT in
// the chain: it came from `org_setting`, a table that never existed, so it was always
// undefined — see migration 032_property_landlord_name.sql.
function companyNameFor(row) {
  return (row.unit_account_name || row.property_landlord_name) || '';
}

test('company name: unit account name wins over the property entity', () => {
  assert.equal(
    companyNameFor({ unit_account_name: 'Tane Residence Limited', property_landlord_name: 'ACJ Ventures Limited' }),
    'Tane Residence Limited'
  );
});

test('company name: falls back to the property entity when the unit has none', () => {
  // This is the 34-of-112 case that printed a blank header / a receipt titled "RECEIPT".
  assert.equal(companyNameFor({ unit_account_name: null, property_landlord_name: 'ACJ Ventures Limited' }), 'ACJ Ventures Limited');
  assert.equal(companyNameFor({ unit_account_name: '', property_landlord_name: 'Parcelle Limited' }), 'Parcelle Limited');
});

test('company name: empty string when neither is set (never undefined)', () => {
  assert.equal(companyNameFor({}), '');
  assert.equal(companyNameFor({ unit_account_name: null, property_landlord_name: null }), '');
});

test('LANDLORD_* variables are hidden from the Insert Variable menu', () => {
  const offered = publicList().filter(v => v.key.startsWith('LANDLORD_'));
  assert.deepEqual(offered, [], 'no LANDLORD_* variable may be offered — they always render blank');
  assert.ok(!publicList().some(v => v.group === 'Landlord'));
});

test('LANDLORD_* variables still RESOLVE, so old templates behave unchanged', () => {
  const landlordVars = VARIABLES.filter(v => v.key.startsWith('LANDLORD_'));
  assert.equal(landlordVars.length, 5);
  for (const v of landlordVars) {
    assert.equal(typeof v.resolve, 'function', `${v.key} must still resolve`);
    assert.equal(v.resolve({ org: {} }), '', `${v.key} resolves to empty, not undefined`);
  }
});

test('the variable groups users actually rely on are still exposed', () => {
  const groups = new Set(publicList().map(v => v.group));
  for (const g of ['Tenant', 'Property', 'Lease', 'Signature']) {
    assert.ok(groups.has(g), `${g} group must stay in the dropdown`);
  }
});
