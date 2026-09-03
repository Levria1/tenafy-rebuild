// What a person's name may contain, and why the rule is enforced twice.
//
// Commas were the trigger: a middle name stored as "Marie, Balthazar, Geoffroy" renders
// as "Edouard Marie, Balthazar, Geoffroy Chenain" in a contract party clause, which is
// wrong on a document someone signs. Parentheses go the same way, by operator decision.
//
// The filter is Unicode-aware (\p{L}) and NOT [A-Za-z]. The portfolio already holds
// Zoltán and SCHÖNERT, and an ASCII rule would mangle them. Hyphens and apostrophes stay
// because Anne-Marie and O'Brien are names, not typos, and the period stays for
// suffixes and initials: "Ulpo Jr." and "Edouard Marie Balthazar G." are both real
// records here, and rejecting them would block staff from saving an existing tenant.
//
// Enforced in two places on purpose:
//   nameProblem()      rejects bad input at the API boundary, so staff see WHICH character
//                      is the problem and fix it, rather than having their typing silently
//                      altered under them.
//   sanitiseNamePart() cleans on the way OUT to a document. Existing rows still contain
//                      commas until the backfill runs, and a signed lease must not carry
//                      them in the meantime.
//
// Deliberately NOT applied to `company_name` (which needs "Ltd." and "&"), nor to the
// payee rows that routes/accounting.js auto-creates from bank statement text: those hold
// reference numbers that payment matching depends on.

function sanitiseNamePart(value) {
  if (typeof value !== 'string') return null;
  const sanitised = value
    .replace(/[^\p{L}\s'’.-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  return sanitised || null;
}

/**
 * Why this input cannot be stored, or null if it is fine.
 *
 * Returns the offending characters in the message. "Name cannot contain a comma" sends
 * someone hunting; naming the character does not. An empty or absent value is allowed:
 * middle names are optional, and this is not the place to decide which parts are required.
 */
function nameProblem(value, label = 'Name') {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') return `${label} must be text.`;
  const bad = [...new Set(value.match(/[^\p{L}\s'’.-]/gu) || [])];
  if (bad.length === 0) return null;
  return `${label} cannot contain ${bad.map(c => `"${c}"`).join(' ')}. `
       + 'Use letters, spaces, hyphens and apostrophes only.';
}

function joinPersonName(first, middle, last) {
  return [first, middle, last]
    .map(sanitiseNamePart)
    .filter(Boolean)
    .join(' ');
}

function personOrCompanyName(tenant) {
  if (Number(tenant.type) === 1 && tenant.company_name) {
    return String(tenant.company_name).trim();
  }
  return joinPersonName(tenant.first_name, tenant.middle_name, tenant.last_name);
}

module.exports = { sanitiseNamePart, nameProblem, joinPersonName, personOrCompanyName };
