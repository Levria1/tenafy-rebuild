/**
 * Decoding MySQL bit(1) columns.
 *
 * mysql2 returns bit(1) as a one-byte Buffer, and a Buffer is an object, so
 * `Boolean(buffer)` and `!!buffer` are **true even when the bit is 0**. Nothing warns
 * you: the value looks present and reads as "yes".
 *
 * HOW IT BIT, 2026-09-03. The lease edit page populated its form with
 * `tenant_posted: !!d.tenant_posted` from a bare `SELECT l.*`. All eleven bit(1)
 * notification flags therefore rendered as ticked whatever was stored, while
 * `payment_receipt` — the one flag stored as tinyint(1) rather than bit(1) — rendered
 * correctly. A lease created with two notifications selected showed all nine on review.
 *
 * The display was the smaller half. Because the boxes rendered ticked, saving the lease
 * for any unrelated reason submitted them as true and the PUT wrote 1, so opening a lease
 * and changing the rent silently switched on every invoice email to the tenant and the
 * landlord. 203 leases carry all nine flags, 201 of them edited after creation.
 *
 * Sending was never affected: the scheduler compares `tenant_checkin = 1` in SQL, where
 * MySQL does the comparison and the Buffer never reaches JavaScript.
 *
 * So: decode explicitly, at the point a row leaves the API, and never let a raw bit reach
 * a `!!`. `utils/checkinWindow.js` delegates here so the two cannot drift.
 */

/** Every bit(1) column on `leasing`, verified against information_schema 2026-09-04. */
const LEASING_BIT_COLUMNS = [
  'tenant_posted', 'landlord_posted', 'landlord_due', 'tenant_due',
  'landlord_overdue', 'tenant_overdue', 'landlord_expired',
  'tenant_checkin', 'tenant_checkout', 'tenant_renewal', 'tenant_deposit_posted',
];

/**
 * A bit(1), however the driver handed it over, as a real boolean.
 *
 * Order matters: the Buffer case must be tested before any generic truthiness, which is
 * the whole point of the function.
 */
function bitToBool(value) {
  if (value == null) return false;
  if (Buffer.isBuffer(value)) return value.length > 0 && value[0] !== 0;
  if (typeof value === 'boolean') return value;
  // A bit(1) is 0 or 1. A negative or non-finite number is not a value this column can
  // hold, so it is malformed input rather than "on".
  if (typeof value === 'number') return Number.isFinite(value) && value > 0;
  if (typeof value === 'string') {
    const t = value.trim().toLowerCase();
    return t !== '' && t !== '0' && t !== 'false';
  }
  // Fail CLOSED. An earlier draft ended `return Boolean(value)`, which made every object
  // and array read as enabled. These flags decide whether email goes to a tenant or a
  // landlord, so an unrecognised shape must mean "no", not "yes".
  return false;
}

/**
 * Replace the bit(1) columns on a lease row with booleans, in place of the Buffers.
 *
 * Applied where a row is serialised for a client rather than in the frontend, so every
 * consumer of the endpoint benefits and a new page cannot reintroduce the bug. Returns
 * the same object; a missing column is left absent rather than invented as `false`, so a
 * partial SELECT does not start reporting flags it never fetched.
 */
function decodeLeasingBits(row) {
  if (!row || typeof row !== 'object') return row;
  for (const column of LEASING_BIT_COLUMNS) {
    if (Object.prototype.hasOwnProperty.call(row, column)) {
      row[column] = bitToBool(row[column]);
    }
  }
  return row;
}

const decodeLeasingBitsAll = (rows) => (Array.isArray(rows) ? rows.map(decodeLeasingBits) : rows);

module.exports = { bitToBool, decodeLeasingBits, decodeLeasingBitsAll, LEASING_BIT_COLUMNS };
