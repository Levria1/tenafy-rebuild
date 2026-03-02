const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const pool = require('../config/database');

// POST /api/amenity/list - List amenities
router.post('/list', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const { search } = req.body || {};
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    
    let whereClause = 'org_id = ?';
    const params = [orgId];
    
    if (search) {
      whereClause += ' AND name LIKE ?';
      params.push('%' + search + '%');
    }
    
    const [amenities] = await pool.execute(
      'SELECT * FROM amenity WHERE ' + whereClause + ' ORDER BY name LIMIT ' + limit + ' OFFSET ' + ((page - 1) * limit),
      params
    );
    
    const [countResult] = await pool.execute(
      'SELECT COUNT(*) as total FROM amenity WHERE ' + whereClause,
      params
    );
    
    res.json({ code: 200, data: { content: amenities, totalElements: countResult[0].total } });
  } catch (error) {
    console.error('List amenities error:', error);
    res.status(500).json({ code: 500, message: 'Failed to list amenities' });
  }
});

// GET /api/amenity/:id - Get amenity
router.get('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;
    
    const [amenities] = await pool.execute(
      'SELECT * FROM amenity WHERE id = ? AND org_id = ?',
      [id, orgId]
    );
    
    if (amenities.length === 0) {
      return res.status(404).json({ code: 404, message: 'Amenity not found' });
    }
    
    res.json({ code: 200, data: amenities[0] });
  } catch (error) {
    console.error('Get amenity error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get amenity' });
  }
});

// POST /api/amenity - Create amenity
router.post('/', authenticate, async (req, res) => {
  try {
    const { name, type, description, status } = req.body;
    const orgId = req.user.orgId;
    
    const [result] = await pool.execute(
      'INSERT INTO amenity (org_id, name, type, description, status, created_at) VALUES (?, ?, ?, ?, ?, NOW())',
      [orgId, name, type, description, status || 1]
    );
    
    res.json({ code: 200, message: 'Amenity created', data: { id: result.insertId } });
  } catch (error) {
    console.error('Create amenity error:', error);
    res.status(500).json({ code: 500, message: 'Failed to create amenity' });
  }
});

// PUT /api/amenity/:id - Update amenity
router.put('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, type, description, status } = req.body;
    const orgId = req.user.orgId;
    
    await pool.execute(
      'UPDATE amenity SET name = ?, type = ?, description = ?, status = ?, updated_at = NOW() WHERE id = ? AND org_id = ?',
      [name, type, description, status, id, orgId]
    );
    
    res.json({ code: 200, message: 'Amenity updated' });
  } catch (error) {
    console.error('Update amenity error:', error);
    res.status(500).json({ code: 500, message: 'Failed to update amenity' });
  }
});

// DELETE /api/amenity/:id - Delete amenity
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const orgId = req.user.orgId;
    await pool.execute('UPDATE amenity SET status = 0 WHERE id = ? AND org_id = ?', [id, orgId]);
    res.json({ code: 200, message: 'Amenity deleted' });
  } catch (error) {
    console.error('Delete amenity error:', error);
    res.status(500).json({ code: 500, message: 'Failed to delete amenity' });
  }
});

module.exports = router;
