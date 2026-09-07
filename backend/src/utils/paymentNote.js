/**
 * Payment note repair — collapse a note that says the same thing twice.
 *
 * WHY
 * ---
 * Xero staging builds an accounting note by joining the bank transaction's
 * `Reference` and its concatenated line-item `Description`s with ' — ', because
 * both feed invoice matching and categorisation (see services/xeroSync.js).
 * Tane's Xero data puts the SAME sentence in both fields, so the stored note
 * reads:
 *
 *   TRIV34982 Rental payment for Sept. 1 - 30, 2026 — TRIV34982 Rental payment for Sept. 1 - 30, 2026
 *
 * A receipt for a single invoice prints that verbatim. Receipts covering more
 * than one invoice never showed it, because those use each line's own invoice
 * note and never read the payment note at all.
 *
 * THE RULE, and why it is this narrow
 * -----------------------------------
 * Collapse only when the note splits into EXACTLY two parts that are equal once
 * trimmed. On the live database that is 567 of 709 notes containing the join.
 * The remaining 142 are genuine, e.g.
 *
 *   "Tane Monthly Payments - $306,308 — CL Salary | Nam Pak Hong | Office Rent"
 *   "ch_3Tfu7tAmLMLva0Qs0df2mA2i | pi_3Tfu7tAmLMLva0Qs0MDLydnx — Stripe Fee"
 *
 * Trimming is included because four rows differ only by a stray newline, which a
 * reader still sees as the same text twice.
 *
 * Case is deliberately NOT ignored. One row differs only by "mercer"/"Mercer",
 * and collapsing it is not worth the rule that would allow it: Stripe charge and
 * payment intent ids are case-sensitive, so two ids differing only in case are
 * two different objects, not one repeated.
 *
 * A note whose own halves contain the separator splits into more than two parts
 * and is left alone.
 */

const NOTE_JOIN = ' — ';

function collapseDuplicateNote(note) {
  if (typeof note !== 'string') return note;
  const parts = note.split(NOTE_JOIN);
  if (parts.length !== 2) return note;
  const left = parts[0].trim();
  if (!left || left !== parts[1].trim()) return note;
  return left;
}

module.exports = { collapseDuplicateNote, NOTE_JOIN };
