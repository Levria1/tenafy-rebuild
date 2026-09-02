const test = require('node:test');
const assert = require('node:assert');
const {
  parseContractType,
  VALID_CONTRACT_TYPES,
  CONTRACT_TYPE_LABELS,
  CONTRACT_TYPE_REQUIRED_MESSAGE,
} = require('../src/utils/contractType');

// ── the four real values ────────────────────────────────────────────────────

test('accepts each of MR, MTM, NR and UC as a number', () => {
  assert.equal(parseContractType(1), 1);
  assert.equal(parseContractType(2), 2);
  assert.equal(parseContractType(3), 3);
  assert.equal(parseContractType(4), 4);
});

test('accepts the same values as strings, which is how a form posts them', () => {
  assert.equal(parseContractType('1'), 1);
  assert.equal(parseContractType('4'), 4);
  assert.equal(parseContractType(' 2 '), 2);
});

test('every valid value has a label, and vice versa', () => {
  assert.deepEqual(VALID_CONTRACT_TYPES, [1, 2, 3, 4]);
  assert.deepEqual(Object.keys(CONTRACT_TYPE_LABELS).map(Number).sort(), VALID_CONTRACT_TYPES);
});

// ── 0 is the whole point of this module ─────────────────────────────────────

test('0 is refused, as a number and as a string', () => {
  // The historical `contract_type || 0` fallback. A lease in this state is
  // advertised by the posting plan and skipped by the renewal ask.
  assert.equal(parseContractType(0), null);
  assert.equal(parseContractType('0'), null);
});

test('absent values are refused rather than defaulted', () => {
  assert.equal(parseContractType(undefined), null);
  assert.equal(parseContractType(null), null);
  assert.equal(parseContractType(''), null);
  assert.equal(parseContractType('   '), null);
});

// ── things that would sneak past a bare Number() ────────────────────────────

test('booleans are refused even though Number(true) is 1', () => {
  // Number(true) === 1 would read as a deliberate MR.
  assert.equal(parseContractType(true), null);
  assert.equal(parseContractType(false), null);
});

test('arrays are refused even though Number(["3"]) is 3', () => {
  assert.equal(parseContractType(['3']), null);
  assert.equal(parseContractType([]), null);
});

test('objects are refused', () => {
  assert.equal(parseContractType({}), null);
  assert.equal(parseContractType({ contract_type: 1 }), null);
});

test('out-of-range and non-integer values are refused', () => {
  assert.equal(parseContractType(5), null);
  assert.equal(parseContractType(-1), null);
  assert.equal(parseContractType(1.5), null);
  assert.equal(parseContractType('1.5'), null);
  assert.equal(parseContractType(NaN), null);
  assert.equal(parseContractType(Infinity), null);
});

test('junk strings are refused', () => {
  assert.equal(parseContractType('MR'), null);
  assert.equal(parseContractType('abc'), null);
});

// ── the message the operator actually sees ──────────────────────────────────

test('the rejection message names UC as the escape hatch', () => {
  // Requiring a choice is only reasonable because "I do not know yet" is itself
  // a choice. If the message stops saying so, the rule becomes a trap.
  assert.match(CONTRACT_TYPE_REQUIRED_MESSAGE, /UC/);
  assert.match(CONTRACT_TYPE_REQUIRED_MESSAGE, /Unconfirmed/);
});

// ── the two readers this guard exists to keep honest ────────────────────────

test('a refused value can never reach the renewal ask as "already decided"', () => {
  // renewalAsk treats [1, 4] as undecided and everything else as settled. Any
  // value this parser lets through must therefore be a real intent, or a lease
  // goes to market with nobody chasing the tenant.
  const { renewalAskEligibility } = require('../src/utils/renewalAsk');
  for (const value of VALID_CONTRACT_TYPES) {
    const parsed = parseContractType(value);
    const result = renewalAskEligibility(
      { end_date: '2026-12-31', start_date: '2026-01-01', contract_type: parsed, renewal_reply: null },
      { today: '2026-11-20' }
    );
    // MR and UC get asked; MTM and NR are genuinely decided.
    const shouldAsk = parsed === 1 || parsed === 4;
    assert.equal(result.eligible, shouldAsk, `contract_type ${parsed}`);
    if (!shouldAsk) assert.equal(result.reason, 'already_decided');
  }
});
