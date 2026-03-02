const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const pool = require('../config/database');
const fs = require('fs');
const path = require('path');

// Helper: get directory size in bytes
function getDirSize(dirPath) {
  try {
    if (!fs.existsSync(dirPath)) return 0;
    let total = 0;
    const files = fs.readdirSync(dirPath, { recursive: true });
    for (const file of files) {
      const filePath = path.join(dirPath, file);
      try {
        const stat = fs.statSync(filePath);
        if (stat.isFile()) total += stat.size;
      } catch {}
    }
    return total;
  } catch {
    return 0;
  }
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
}

// GET /api/storage/usage - Storage usage summary
router.get('/usage', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;

    // File count from DB
    const [[fileCount]] = await pool.execute(
      'SELECT COUNT(*) as count FROM file WHERE org_id = ?',
      [orgId]
    ).catch(() => [[{ count: 0 }]]);

    // Count images specifically
    const [[imageCount]] = await pool.execute(
      "SELECT COUNT(*) as count FROM file WHERE org_id = ? AND (file_type LIKE 'image%' OR name LIKE '%.jpg' OR name LIKE '%.png' OR name LIKE '%.jpeg')",
      [orgId]
    ).catch(() => [[{ count: 0 }]]);

    // Get the uploads directory size
    const uploadsDir = path.join(__dirname, '../../uploads');
    const orgUploadsDir = path.join(uploadsDir, String(orgId));
    const dirSize = getDirSize(fs.existsSync(orgUploadsDir) ? orgUploadsDir : uploadsDir);

    // Count invoices this month
    const [[invoiceCount]] = await pool.execute(
      "SELECT COUNT(*) as count FROM invoice WHERE org_id = ? AND MONTH(created_at) = MONTH(NOW()) AND YEAR(created_at) = YEAR(NOW())",
      [orgId]
    ).catch(() => [[{ count: 0 }]]);

    // Count total records by type
    const [[propertyCount]] = await pool.execute('SELECT COUNT(*) as count FROM property WHERE org_id = ? AND status = 1', [orgId]).catch(() => [[{ count: 0 }]]);
    const [[tenantCount]] = await pool.execute('SELECT COUNT(*) as count FROM tenant WHERE org_id = ? AND status = 1', [orgId]).catch(() => [[{ count: 0 }]]);
    const [[leasingCount]] = await pool.execute('SELECT COUNT(*) as count FROM leasing l JOIN unit u ON l.unit_id = u.id JOIN property p ON u.property_id = p.id WHERE p.org_id = ? AND l.status = 1 AND l.deleted_at IS NULL', [orgId]).catch(() => [[{ count: 0 }]]);
    const [[totalInvoiceCount]] = await pool.execute('SELECT COUNT(*) as count FROM invoice WHERE org_id = ?', [orgId]).catch(() => [[{ count: 0 }]]);

    res.json({
      code: 200,
      data: {
        storage: {
          usedBytes: dirSize,
          usedFormatted: formatBytes(dirSize),
          fileCount: fileCount.count,
          imageCount: imageCount.count,
          // Simulate a limit (e.g., 5GB per org)
          limitBytes: 5 * 1024 * 1024 * 1024,
          limitFormatted: '5 GB',
          usagePercent: Math.min(100, ((dirSize / (5 * 1024 * 1024 * 1024)) * 100).toFixed(1)),
        },
        activity: {
          invoicesThisMonth: invoiceCount.count,
          totalInvoices: totalInvoiceCount.count,
          totalProperties: propertyCount.count,
          totalTenants: tenantCount.count,
          activeLeases: leasingCount.count,
        },
      },
    });
  } catch (error) {
    console.error('Storage usage error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get storage usage' });
  }
});

// GET /api/storage/email/usage - Email usage this month
router.get('/email/usage', authenticate, async (req, res) => {
  try {
    const orgId = req.user.orgId;

    // Count email log entries this month (if you have an email_log table)
    const [[emailCount]] = await pool.execute(
      "SELECT COUNT(*) as count FROM email_log WHERE org_id = ? AND MONTH(sent_at) = MONTH(NOW()) AND YEAR(sent_at) = YEAR(NOW())",
      [orgId]
    ).catch(() => [[{ count: 0 }]]);

    const [[totalEmailCount]] = await pool.execute(
      'SELECT COUNT(*) as count FROM email_log WHERE org_id = ?',
      [orgId]
    ).catch(() => [[{ count: 0 }]]);

    res.json({
      code: 200,
      data: {
        sentThisMonth: emailCount.count,
        totalSent: totalEmailCount.count,
        // Simulate a monthly limit
        monthlyLimit: 1000,
        usagePercent: Math.min(100, ((emailCount.count / 1000) * 100).toFixed(1)),
      },
    });
  } catch (error) {
    console.error('Email usage error:', error);
    res.status(500).json({ code: 500, message: 'Failed to get email usage' });
  }
});

module.exports = router;
