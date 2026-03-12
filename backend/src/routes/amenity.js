const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const pool = require('../config/database');

// POST /api/amenity/list - List amenities with filtering + pagination
router.post('/list', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { search, category, type } = req.body || {};
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;

    let whereClause = 'org_id = ? AND enabled = 1';
    const params = [orgId];

    if (search) {
      whereClause += ' AND display_name LIKE ?';
      params.push('%' + search + '%');
    }
    if (category !== undefined && category !== null && category !== '') {
      whereClause += ' AND category = ?';
      params.push(Number(category));
    }
    if (type !== undefined && type !== null && type !== '') {
      whereClause += ' AND type = ?';
      params.push(Number(type));
    }

    const [amenities] = await pool.execute(
      `SELECT id, org_id, display_name, category, type, enabled, order_id
       FROM amenity WHERE ${whereClause}
       ORDER BY category, type, order_id
       LIMIT ${limit} OFFSET ${offset}`,
      params
    );

    const [countResult] = await pool.execute(
      `SELECT COUNT(*) as total FROM amenity WHERE ${whereClause}`,
      params
    );

    res.json({ code: 200, data: { content: amenities, totalElements: Number(countResult[0].total) } });
  } catch (error) {
    console.error('List amenities error:', error);
    res.status(500).json({ code: 500, message: 'Failed to list amenities' });
  }
});

// GET /api/amenity/:id - Get single amenity
router.get('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;

    const [[amenityRow]] = await pool.execute(
      'SELECT id, org_id, display_name, category, type, enabled, order_id FROM amenity WHERE id = ? AND org_id = ?',
      [id, orgId]
    );

    if (!amenityRow) {
      return res.status(404).json({ code: 404, message: 'Amenity not found' });
    }

    res.json({ code: 200, data: amenityRow });
  } catch (error) {
    console.error('Get amenity error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get amenity' });
  }
});

// POST /api/amenity - Create amenity
router.post('/', authenticate, async (req, res) => {
  try {
    const { display_name, category, type } = req.body;
    const orgId = req.user.orgId;

    if (!display_name) {
      return res.status(400).json({ code: 400, message: 'Display name is required' });
    }

    // Auto-generate order_id: max + 1 for this category
    const [[maxOrder]] = await pool.execute(
      'SELECT MAX(order_id) as max_order FROM amenity WHERE org_id = ? AND category = ?',
      [orgId, category ?? 0]
    );
    const nextOrder = (Number(maxOrder?.max_order) || 0) + 1;

    const id = (BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000))).toString();

    await pool.execute(
      'INSERT INTO amenity (id, org_id, display_name, category, type, enabled, order_id) VALUES (?, ?, ?, ?, ?, 1, ?)',
      [id, orgId, display_name, category ?? 0, type ?? 1, nextOrder]
    );

    res.json({ code: 200, message: 'Amenity created', data: { id } });
  } catch (error) {
    console.error('Create amenity error:', error);
    res.status(500).json({ code: 500, message: 'Failed to create amenity' });
  }
});

// PUT /api/amenity/:id - Update amenity
router.put('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { display_name, category, type } = req.body;
    const orgId = req.user.orgId;

    // Check exists
    const [[existing]] = await pool.execute(
      'SELECT id, category FROM amenity WHERE id = ? AND org_id = ?',
      [id, orgId]
    );
    if (!existing) {
      return res.status(404).json({ code: 404, message: 'Amenity not found' });
    }

    // If category changed, assign new order_id in the new category
    let orderUpdate = '';
    const updateParams = [];
    if (category !== undefined && Number(category) !== Number(existing.category)) {
      const [[maxOrder]] = await pool.execute(
        'SELECT MAX(order_id) as max_order FROM amenity WHERE org_id = ? AND category = ?',
        [orgId, category]
      );
      const nextOrder = (Number(maxOrder?.max_order) || 0) + 1;
      orderUpdate = ', order_id = ?';
      updateParams.push(nextOrder);
    }

    await pool.execute(
      `UPDATE amenity SET display_name = ?, category = ?, type = ?${orderUpdate} WHERE id = ? AND org_id = ?`,
      [display_name, category ?? existing.category, type ?? 1, ...updateParams, id, orgId]
    );

    res.json({ code: 200, message: 'Amenity updated' });
  } catch (error) {
    console.error('Update amenity error:', error);
    res.status(500).json({ code: 500, message: 'Failed to update amenity' });
  }
});

// DELETE /api/amenity/:id - Soft delete (set enabled = 0)
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;
    await pool.execute('UPDATE amenity SET enabled = 0 WHERE id = ? AND org_id = ?', [id, orgId]);
    res.json({ code: 200, message: 'Amenity deleted' });
  } catch (error) {
    console.error('Delete amenity error:', error);
    res.status(500).json({ code: 500, message: 'Failed to delete amenity' });
  }
});

module.exports = router;
