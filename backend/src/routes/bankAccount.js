const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');

function newId() {
  return (BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000))).toString();
}

function nullable(value) {
  return value === '' || value === undefined ? null : value;
}

function payload(body) {
  return {
    label: body.label ? String(body.label).trim() : '',
    beneficiary_name: nullable(body.beneficiary_name),
    bank_name: nullable(body.bank_name),
    account_number: nullable(body.account_number),
    branch_code: nullable(body.branch_code),
    bank_code: nullable(body.bank_code),
    swift: nullable(body.swift),
    currency: nullable(body.currency),
    notes: nullable(body.notes),
    status: body.status ?? 1,
  };
}

// GET /api/bank-account - List active bank accounts
router.get('/', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const [rows] = await req.pool.execute(
      `SELECT *
         FROM bank_account
        WHERE org_id = ? AND status = 1 AND deleted_at IS NULL
        ORDER BY label`,
      [orgId]
    );
    res.json({ code: 200, data: rows });
  } catch (error) {
    console.error('List bank accounts error:', error);
    res.status(500).json({ code: 500, message: 'Failed to list bank accounts' });
  }
});

// GET /api/bank-account/:id - Get bank account
router.get('/:id', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const [rows] = await req.pool.execute(
      'SELECT * FROM bank_account WHERE id = ? AND org_id = ? AND deleted_at IS NULL',
      [req.params.id, orgId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ code: 404, message: 'Bank account not found' });
    }
    res.json({ code: 200, data: rows[0] });
  } catch (error) {
    console.error('Get bank account error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get bank account' });
  }
});

// POST /api/bank-account - Create bank account
router.post('/', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const data = payload(req.body || {});
    if (!data.label) {
      return res.status(400).json({ code: 400, message: 'label is required' });
    }

    const id = newId();
    await req.pool.execute(
      `INSERT INTO bank_account
          (id, org_id, label, beneficiary_name, bank_name, account_number,
           branch_code, bank_code, swift, currency, notes, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        id, orgId, data.label, data.beneficiary_name, data.bank_name, data.account_number,
        data.branch_code, data.bank_code, data.swift, data.currency, data.notes, data.status,
      ]
    );

    res.json({ code: 200, message: 'Bank account created', data: { id } });
  } catch (error) {
    console.error('Create bank account error:', error);
    res.status(500).json({ code: 500, message: 'Failed to create bank account' });
  }
});

// PUT /api/bank-account/:id - Update bank account
router.put('/:id', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const data = payload(req.body || {});
    if (!data.label) {
      return res.status(400).json({ code: 400, message: 'label is required' });
    }

    const [result] = await req.pool.execute(
      `UPDATE bank_account
          SET label = ?, beneficiary_name = ?, bank_name = ?, account_number = ?,
              branch_code = ?, bank_code = ?, swift = ?, currency = ?, notes = ?,
              status = ?, updated_at = NOW()
        WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
      [
        data.label, data.beneficiary_name, data.bank_name, data.account_number,
        data.branch_code, data.bank_code, data.swift, data.currency, data.notes,
        data.status, req.params.id, orgId,
      ]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ code: 404, message: 'Bank account not found' });
    }
    res.json({ code: 200, message: 'Bank account updated' });
  } catch (error) {
    console.error('Update bank account error:', error);
    res.status(500).json({ code: 500, message: 'Failed to update bank account' });
  }
});

// DELETE /api/bank-account/:id - Soft delete bank account
router.delete('/:id', authenticate, async (req, res) => {
  const orgId = req.user.orgId;
  const conn = await req.pool.getConnection();
  try {
    await conn.beginTransaction();
    const [result] = await conn.execute(
      'UPDATE bank_account SET status = 0, deleted_at = NOW(), updated_at = NOW() WHERE id = ? AND org_id = ? AND deleted_at IS NULL',
      [req.params.id, orgId]
    );
    if (result.affectedRows === 0) {
      await conn.rollback();
      return res.status(404).json({ code: 404, message: 'Bank account not found' });
    }
    await conn.execute(
      'UPDATE property SET bank_account_id = NULL, updated_at = NOW() WHERE org_id = ? AND bank_account_id = ?',
      [orgId, req.params.id]
    );
    await conn.execute(
      'UPDATE xero_account_map SET bank_account_id = NULL, updated_at = NOW() WHERE org_id = ? AND bank_account_id = ?',
      [orgId, req.params.id]
    );
    await conn.commit();
    res.json({ code: 200, message: 'Bank account deleted' });
  } catch (error) {
    await conn.rollback();
    console.error('Delete bank account error:', error);
    res.status(500).json({ code: 500, message: 'Failed to delete bank account' });
  } finally {
    conn.release();
  }
});

module.exports = router;
