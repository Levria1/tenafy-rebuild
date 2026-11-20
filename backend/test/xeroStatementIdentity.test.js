const test=require('node:test');
const assert=require('node:assert/strict');
const {identityFor,matchesCandidate,identitySql}=require('../src/utils/xeroStatementIdentity');
const bank=extra=>({direction:'received',...extra});
test('amount-only is allowed only without usable identity; named failures never broaden',()=>{
  assert.equal(identityFor(bank({})).mode,'amount_only');
  assert.equal(identityFor(bank({payee:'Rent'})).mode,'amount_only');
  const p=identityFor(bank({description:'/ORDP/MAHESWARI RHEA/BREF/123/REMI/November rent'}));
  assert.equal(p.mode,'name');
  assert.ok(matchesCandidate(p,{tenant_name:'Rhea Maheswari'}));
  assert.ok(!matchesCandidate(p,{tenant_name:'Jo Ann'}));
  assert.equal(identityFor(bank({description:'/ORDP/MAHESWARI...' })).mode,'identity_unreadable');
  assert.equal(identityFor(bank({payee:'Rhea Maheswari',description:'/ORDP/Other Person/BREF/123'})).mode,'identity_conflict');
  assert.equal(identityFor(bank({payee:'Rhea Maheswari',description:'/ORDP/MAHESWARI RHEA/BREF/123'})).mode,'name');
});
test('name and business reference must both match; outgoing sender is not beneficiary',()=>{
  const p=identityFor(bank({payee:'Ms. Rhea Maheswari',reference:'TRIV-35671'}));
  assert.equal(p.mode,'name_and_reference');
  assert.ok(matchesCandidate(p,{tenant_name:'Rhea Maheswari',code:'TRIV35671'}));
  assert.ok(!matchesCandidate(p,{tenant_name:'Other Person',code:'TRIV35671'}));
  assert.ok(!matchesCandidate(p,{tenant_name:'Rhea Maheswari',code:'TRIV35672'}));
  assert.equal(identityFor(bank({direction:'spent',description:'/ORDP/Own Company/BREF/123'})).payee,null);
  assert.equal(identityFor(bank({direction:'spent',description:'/BENM/Other Person/BREF/123'})).payee,'Other Person');
  const ref=identityFor(bank({reference:'ABC-123456'}));
  assert.ok(matchesCandidate(ref,{note:'Receipt ABC-123456 received'}));
  assert.ok(!matchesCandidate(ref,{note:'Receipt ZABC1234567'}));
  assert.match(identitySql(p,{names:['t.name'],references:['i.code']}).sql,/ AND /);
});
