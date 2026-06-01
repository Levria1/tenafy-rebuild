/**
 * Find the most recent meter reading for a unit before a given date.
 *
 * Used by:
 *  - GET /api/utility/last-meter-reading (frontend prefill)
 *  - POST /api/leasing back-fill of check_in_meter when the request omits it
 *
 * Behaviour:
 *  - Only considers meters mapped to this specific unit (master/property meters
 *    are excluded — they aren't tenant-scoped so we can't attribute the value).
 *  - If multiple meters on the unit have readings, picks the one with the most
 *    recent reading_date overall.
 *  - Resolves the "from tenant" by looking up whoever was leasing the unit on
 *    the reading_date (helps the UI show "auto-filled from Yetong Du's checkout").
 *
 * Returns null if no qualifying reading exists.
 *
 * @param {Pool} pool         MySQL2 pool (org-scoped)
 * @param {string|bigint} unitId
 * @param {string} beforeDate ISO date (exclusive upper bound). Defaults to today.
 * @returns {Promise<null | {
 *   reading_value: number,
 *   reading_date: string,
 *   reading_type: number,
 *   reading_type_label: string,
 *   meter_id: string,
 *   meter_number: string,
 *   from_tenant_id: string | null,
 *   from_tenant_name: string | null,
 *   notes: string | null
 * }>}
 */
async function findLastMeterReadingForUnit(pool, unitId, beforeDate) {
  if (!unitId) return null;
  const cutoff = beforeDate || new Date().toISOString().split('T')[0];

  // Most recent reading across all unit-mapped meters on this unit, before `cutoff`.
  // Strict `<` so a same-day move-in doesn't include its own move-out reading.
  const [[row]] = await pool.execute(
    `SELECT mr.reading_value, mr.reading_date, mr.reading_type,
            mr.tenant_id AS from_tenant_id, mr.notes,
            m.id AS meter_id, m.meter_number
       FROM utility_meter_reading mr
       JOIN utility_meter m ON mr.meter_id = m.id
      WHERE m.unit_id = ? AND mr.reading_date < ?
      ORDER BY mr.reading_date DESC, mr.created_at DESC
      LIMIT 1`,
    [String(unitId), cutoff]
  );

  if (!row) return null;

  // Optional: resolve a friendly name for the tenant who logged it
  let fromTenantName = null;
  if (row.from_tenant_id) {
    try {
      const [[t]] = await pool.execute(
        `SELECT first_name, middle_name, last_name, company_name, type
           FROM tenant WHERE id = ?`,
        [row.from_tenant_id]
      );
      if (t) {
        fromTenantName = Number(t.type) === 1 && t.company_name
          ? t.company_name
          : [t.first_name, t.middle_name, t.last_name].filter(Boolean).join(' ').trim() || null;
      }
    } catch { /* non-fatal */ }
  }

  const typeLabels = { 0: 'Move-In', 1: 'Move-Out', 2: 'Period', 3: 'Regular' };

  return {
    reading_value: Number(row.reading_value),
    reading_date: row.reading_date instanceof Date
      ? row.reading_date.toISOString().split('T')[0]
      : String(row.reading_date).split('T')[0],
    reading_type: Number(row.reading_type),
    reading_type_label: typeLabels[Number(row.reading_type)] || `type=${row.reading_type}`,
    meter_id: String(row.meter_id),
    meter_number: row.meter_number,
    from_tenant_id: row.from_tenant_id ? String(row.from_tenant_id) : null,
    from_tenant_name: fromTenantName,
    notes: row.notes || null,
  };
}

module.exports = { findLastMeterReadingForUnit };
