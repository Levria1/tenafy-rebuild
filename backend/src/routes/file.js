const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { authenticate } = require('../middleware/auth');

const { v4: uuidv4 } = require('uuid');

// Storage directories — check both local uploads and legacy AWS backup storage
const UPLOADS_DIR = path.join(__dirname, '../../uploads');
const LEGACY_STORAGE_DIR = process.env.LEGACY_STORAGE_DIR || 'D:/Tane/AWS Backup/frontend/tane/storage';

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    if (!fs.existsSync(UPLOADS_DIR)) {
      fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    }
    cb(null, UPLOADS_DIR);
  },
  filename: function (req, file, cb) {
    const uniqueName = uuidv4() + path.extname(file.originalname);
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB per file
});

// MIME type lookup
const MIME_TYPES = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.bmp': 'image/bmp', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.pdf': 'application/pdf',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska', '.webm': 'video/webm', '.wmv': 'video/x-ms-wmv',
};

// GET /api/file/preview/:identifier - Serve file for preview
// identifier can be a file ID (bigint) or a filename
router.get('/preview/:identifier', async (req, res) => {
  try {
    const { identifier } = req.params;
    let filename = null;
    let mimeType = null;

    // Check if identifier is a numeric file ID
    if (/^\d+$/.test(identifier)) {
      const [files] = await req.pool.execute('SELECT item_name, mime_type, extension FROM file WHERE id = ?', [identifier]);
      if (files.length > 0) {
        filename = files[0].item_name;
        mimeType = files[0].mime_type;
      }
    }

    // If not found by ID, treat identifier as a filename
    if (!filename) {
      filename = identifier;
    }

    // Try to find the file in various locations
    let filePath = null;
    const possiblePaths = [
      path.join(UPLOADS_DIR, filename),
      path.join(LEGACY_STORAGE_DIR, filename),
    ];

    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        filePath = p;
        break;
      }
    }

    if (!filePath) {
      return res.status(404).json({ code: 404, message: 'File not found' });
    }

    // Determine MIME type
    if (!mimeType || mimeType === 'null') {
      const ext = path.extname(filename).toLowerCase();
      mimeType = MIME_TYPES[ext] || 'application/octet-stream';
    }

    // Set headers and stream file
    res.setHeader('Content-Type', mimeType.toLowerCase());
    res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache for 24h
    const stat = fs.statSync(filePath);
    res.setHeader('Content-Length', stat.size);

    const readStream = fs.createReadStream(filePath);
    readStream.pipe(res);
  } catch (error) {
    console.error('File preview error:', error);
    res.status(500).json({ code: 500, message: 'Failed to preview file' });
  }
});

// GET /api/file/download/:identifier - Download file
router.get('/download/:identifier', async (req, res) => {
  try {
    const { identifier } = req.params;
    let filename = null;
    let originalName = null;

    if (/^\d+$/.test(identifier)) {
      const [files] = await req.pool.execute('SELECT item_name, filename AS original_name FROM file WHERE id = ?', [identifier]);
      if (files.length > 0) {
        filename = files[0].item_name;
        originalName = files[0].original_name || filename;
      }
    }

    if (!filename) {
      filename = identifier;
      originalName = identifier;
    }

    let filePath = null;
    const possiblePaths = [
      path.join(UPLOADS_DIR, filename),
      path.join(LEGACY_STORAGE_DIR, filename),
    ];

    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        filePath = p;
        break;
      }
    }

    if (!filePath) {
      return res.status(404).json({ code: 404, message: 'File not found' });
    }

    res.download(filePath, originalName);
  } catch (error) {
    console.error('File download error:', error);
    res.status(500).json({ code: 500, message: 'Failed to download file' });
  }
});

router.use(authenticate);

// POST /api/file/image/upload - Upload image
router.post('/image/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ code: 415, message: 'Please upload pictures in PNG, JPG, JPEG format' });
    }

    const orgId = req.user.orgId;
    const savedFilename = req.file.filename;
    const originalName = req.file.originalname;
    const ext = path.extname(originalName);
    const mimeType = req.file.mimetype || MIME_TYPES[ext.toLowerCase()] || 'application/octet-stream';
    const fileSize = req.file.size;
    const id = BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000));

    await req.pool.execute(
      'INSERT INTO file (id, item_name, filename, extension, mime_type, file_size, storage_engine, org_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())',
      [id.toString(), savedFilename, originalName, ext.replace('.', ''), mimeType.toUpperCase(), fileSize, 'local', orgId]
    );

    res.json({
      code: 200,
      message: 'OK',
      data: {
        state: 'SUCCESS',
        id: id.toString(),
        title: savedFilename,
        url: '/api/file/preview/' + id.toString()
      }
    });
  } catch (error) {
    console.error('Upload image error:', error);
    res.status(500).json({ code: 500, message: 'Failed to upload image' });
  }
});

// POST /api/file/upload - Upload any file
router.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ code: 400, message: 'No file uploaded' });
    }

    const orgId = req.user.orgId;
    const savedFilename = req.file.filename;
    const originalName = req.file.originalname;
    const ext = path.extname(originalName);
    const mimeType = req.file.mimetype || 'application/octet-stream';
    const fileSize = req.file.size;
    const id = BigInt(Date.now()) * BigInt(1000000) + BigInt(Math.floor(Math.random() * 1000000));

    await req.pool.execute(
      'INSERT INTO file (id, item_name, filename, extension, mime_type, file_size, storage_engine, org_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())',
      [id.toString(), savedFilename, originalName, ext.replace('.', ''), mimeType.toUpperCase(), fileSize, 'local', orgId]
    );

    res.json({
      code: 200,
      message: 'OK',
      data: {
        state: 'SUCCESS',
        id: id.toString(),
        title: savedFilename,
        url: '/api/file/download/' + id.toString()
      }
    });
  } catch (error) {
    console.error('Upload file error:', error);
    res.status(500).json({ code: 500, message: 'Failed to upload file' });
  }
});

module.exports = router;
