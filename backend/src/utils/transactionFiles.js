/**
 * Receipts attached to an accounting transaction.
 *
 * WHY THIS EXISTS
 * ---------------
 * The Create Payment form has always had an upload box. The file reached the
 * server and a `file` row was written, but the form discarded the id it got back,
 * the accounting table had no column for it, and the transaction drawer rendered
 * the hard-coded words "No files attached". So a receipt attached to a Stripe
 * settlement went nowhere, and there was no way to look at it afterwards.
 *
 * 549 uploads sit within five minutes of a payment being created and are linked
 * to nothing at all.
 *
 * WHY object_file AND NOT A NEW COLUMN
 * ------------------------------------
 * `object_file(object_id, file_id)` already links files to any entity by its
 * Snowflake id, and 7,357 files are attached that way, including tenant repair
 * photos. A payment can carry several receipts, so a single `file` column on
 * `accounting` would be wrong anyway. There is no object_type column: ids are
 * Snowflakes and unique across tables.
 *
 * WHY THE FILES ARE MARKED PRIVATE
 * --------------------------------
 * /api/file/preview serves NON-private files to anonymous callers on purpose, so
 * that listing photos load without a login (routes/file.js). A payment receipt
 * can show a card tail, a bank reference or a payer's details, and a file id is a
 * timestamp-based Snowflake rather than a secret. Attaching one here therefore
 * flips is_private, exactly as the tenant ID scans do. Staff still see it: an
 * authenticated session for the owning org may preview any file type.
 */

// Only ever link files this org owns. A Snowflake id is guessable enough that
// accepting one unchecked would let a caller attach another org's file to their
// own transaction and then read it back through the preview route.
async function linkTransactionFiles(pool, orgId, accountingId, fileIds) {
  const ids = [...new Set((Array.isArray(fileIds) ? fileIds : [])
    .map(v => (v == null ? '' : String(v).trim()))
    .filter(v => /^\d+$/.test(v)))];
  if (!ids.length) return [];

  const placeholders = ids.map(() => '?').join(',');
  const [owned] = await pool.execute(
    `SELECT CAST(id AS CHAR) AS id FROM file
      WHERE id IN (${placeholders}) AND org_id = ? AND deleted_at IS NULL`,
    [...ids, orgId]
  );
  if (!owned.length) return [];

  for (const row of owned) {
    // A re-submit must not stack duplicate links for the same pair.
    const [[existing]] = await pool.execute(
      `SELECT COUNT(*) AS n FROM object_file
        WHERE object_id = ? AND file_id = ? AND deleted_at IS NULL`,
      [accountingId, row.id]
    );
    // COUNT(*) arrives as a STRING (the pools set bigNumberStrings) and '0' is truthy.
    if (Number(existing.n) > 0) continue;

    await pool.execute(
      `INSERT INTO object_file (object_id, file_id, created_at) VALUES (?, ?, NOW())`,
      [accountingId, row.id]
    );
    await pool.execute(
      'UPDATE file SET is_private = 1 WHERE id = ? AND org_id = ?', [row.id, orgId]
    );
  }
  return owned.map(r => r.id);
}

// Detach everything currently on a transaction. Soft delete: the file row and the
// bytes stay, so a receipt removed by mistake is recoverable.
async function unlinkTransactionFiles(pool, accountingId, fileId = null) {
  if (fileId) {
    const [res] = await pool.execute(
      `UPDATE object_file SET deleted_at = NOW()
        WHERE object_id = ? AND file_id = ? AND deleted_at IS NULL`,
      [accountingId, fileId]
    );
    return res.affectedRows;
  }
  const [res] = await pool.execute(
    'UPDATE object_file SET deleted_at = NOW() WHERE object_id = ? AND deleted_at IS NULL',
    [accountingId]
  );
  return res.affectedRows;
}

const IMAGE_MIME = /^IMAGE\//i;

async function listTransactionFiles(pool, orgId, accountingId) {
  // `of` is a RESERVED WORD in MySQL 8 — `FROM object_file of` is a syntax error
  // that only shows up at runtime. Aliased objf here and everywhere else.
  const [rows] = await pool.execute(
    `SELECT CAST(f.id AS CHAR) AS id, f.filename, f.item_name, f.mime_type, f.file_size,
            DATE_FORMAT(objf.created_at, '%Y-%m-%d %H:%i:%s') AS attached_at
       FROM object_file objf
       JOIN file f ON f.id = objf.file_id AND f.deleted_at IS NULL
      WHERE objf.object_id = ? AND objf.deleted_at IS NULL AND f.org_id = ?
      ORDER BY objf.created_at ASC, f.id ASC`,
    [accountingId, orgId]
  );
  return rows.map(r => ({
    id: r.id,
    filename: r.filename,
    mime_type: r.mime_type,
    file_size: Number(r.file_size) || 0,
    attached_at: r.attached_at,
    is_image: IMAGE_MIME.test(r.mime_type || ''),
    preview_url: `/api/file/preview/${r.id}`,
    download_url: `/api/file/download/${r.id}`,
  }));
}

module.exports = { linkTransactionFiles, unlinkTransactionFiles, listTransactionFiles };
