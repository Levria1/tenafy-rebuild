/**
 * leasing.contract_type — the tenant's renewal intent. Mandatory on every lease.
 *
 * 0 is not one of the values. It was the historical fallback from `contract_type || 0`
 * on create, and it is the worst state a lease can be in, because the two systems that
 * read it disagree about what it means:
 *
 *   - the posting plan special-cases only NR, so anything else (0 included) becomes
 *     advertisable at lead_days_other, and the unit goes to market;
 *   - the renewal ask counts only [1, 4] as undecided, so a 0 returns `already_decided`
 *     and the tenant is never asked.
 *
 * The unit is therefore listed while nobody is chasing the answer. Eleven leases reached
 * that state before this guard existed.
 *
 * Requiring a choice is safe because UC (4) means "unconfirmed". Nobody has to guess:
 * "I don't know yet" is itself a recordable answer, and one the renewal ask acts on.
 */

const CONTRACT_TYPE_LABELS = { 1: 'MR', 2: 'MTM', 3: 'NR', 4: 'UC' };
const VALID_CONTRACT_TYPES = [1, 2, 3, 4];

const CONTRACT_TYPE_REQUIRED_MESSAGE =
  'Tenant Status is required. Choose MR (May Renew), MTM (Month To Month), ' +
  'NR (Not Renewing), or UC (Unconfirmed) if the tenant has not decided yet.';

/**
 * Coerce a submitted contract_type to 1-4, or null when it is anything else.
 *
 * Deliberately stricter than Number(). Number(true) is 1 and Number(['3']) is 3, so a
 * bare Number() would let a boolean or an array through looking like a deliberate MR or
 * NR. Every rejection here has to land on "make the caller state an intent" rather than
 * on a silent guess. Mirrors definedNumber() in utils/renewalAsk.js, which exists for
 * the same reason.
 */
function parseContractType(value) {
  if (typeof value === 'number') {
    return VALID_CONTRACT_TYPES.includes(value) ? value : null;
  }
  // Rules out null, undefined, booleans, arrays and objects in one line.
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  if (!Number.isInteger(n)) return null;
  return VALID_CONTRACT_TYPES.includes(n) ? n : null;
}

module.exports = {
  CONTRACT_TYPE_LABELS,
  VALID_CONTRACT_TYPES,
  CONTRACT_TYPE_REQUIRED_MESSAGE,
  parseContractType,
};
