const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const { authenticate } = require('../middleware/auth');
const pool = require('../config/database');
const { v4: uuidv4 } = require('uuid');

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, './uploads');
  },
  filename: function (req, file, cb) {
    const uniqueName = uuidv4() + path.extname(file.originalname);
    cb(null, uniqueName);
  }
});

const upload = multer({ storage: storage });

router.use(authenticate);

// POST /api/image/upload - Upload image
router.post('/image/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ code: 415, message: 'Please upload pictures in PNG, JPG, JPEG format' });
    }
    
    const orgId = req.user.orgId;
    const filename = req.file.filename;
    const originalName = req.file.originalname;
    
    await pool.execute(
      'INSERT INTO file_info (org_id, item_name, filename, file_type, created_at) VALUES (?, ?, ?, ?, NOW())',
      [orgId, filename, originalName, 'image']
    );
    
    res.json({ 
      code: 200, 
      message: 'OK',
      data: { 
        state: 'SUCCESS',
        title: filename,
        url: '/api/file/preview/' + filename
      } 
    });
  } catch (error) {
    console.error('Upload image error:', error);
    res.status(500).json({ code: 500, message: 'Failed to upload image' });
  }
});

// POST /api/file/upload - Upload any file
router.post('/file/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ code: 400, message: 'No file uploaded' });
    }
    
    const orgId = req.user.orgId;
    const filename = req.file.filename;
    const originalName = req.file.originalname;
    
    await pool.execute(
      'INSERT INTO file_info (org_id, item_name, filename, file_type, created_at) VALUES (?, ?, ?, ?, NOW())',
      [orgId, filename, originalName, 'file']
    );
    
    res.json({ 
      code: 200, 
      message: 'OK',
      data: { 
        state: 'SUCCESS',
        title: filename,
        url: '/api/file/download/' + filename
      } 
    });
  } catch (error) {
    console.error('Upload file error:', error);
    res.status(500).json({ code: 500, message: 'Failed to upload file' });
  }
});

module.exports = router;