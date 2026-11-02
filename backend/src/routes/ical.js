const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const { authenticate } = require('../middleware/auth');
const { getMasterPool } = require('../config/poolRegistry');
const { KIND_ICAL, resolveOrgByIcalToken } = require('../middleware/viewingTokenAuth');
const { buildUnitCalendar } = require('../services/icalFeed');
const { hkDate } = require('../utils/inquiryFacts');

function ok(res, data) {
  return res.json({ code: 200, data });
}

function failClosed(res, message = 'Calendar temporarily unavailable', status = 503) {
  return res.status(status).type('text/plain; charset=utf-8').send(message);
}

function newIcalToken() {
  return `ical_${crypto.randomBytes(16).toString('hex')}`;
}

function stripTrailingIcs(req, res, next) {
  req.params.token = String(req.params.token || '').replace(/\.ics$/i, '');
  next();
}

function publicBaseUrl(req) {
  const configured = (process.env.PUBLIC_BASE_URL || '').trim();
  const origin = configured || `${req.protocol}://${req.get('host')}`;
  return origin.replace(/\/+$/, '');
}

function feedUrl(req, token) {
  return `${publicBaseUrl(req)}/api/ical/unit/${token}.ics`;
}

async function registerToken(masterConn, token, orgId) {
  await masterConn.execute(
    'INSERT INTO viewing_link_registry (token, org_id, kind, status) VALUES (?, ?, ?, 1)',
    [token, String(orgId), KIND_ICAL]
  );
}

async function generateTokenForUnit({ pool, orgId, unitId }) {
  const token = newIcalToken();
  const orgConn = await pool.getConnection();
  const masterConn = await getMasterPool().getConnection();
  let registryInserted = false;

  try {
    await orgConn.beginTransaction();
    await orgConn.execute(
      'UPDATE unit SET ical_token = ? WHERE id = ? AND ical_token IS NULL',
      [token, unitId]
    );
    await registerToken(masterConn, token, orgId);
    registryInserted = true;
    await orgConn.commit();
    return token;
  } catch (err) {
    try { await orgConn.rollback(); } catch {}
    if (registryInserted) {
      try { await masterConn.execute('UPDATE viewing_link_registry SET status = 0 WHERE token = ?', [token]); } catch {}
    }
    throw err;
  } finally {
    orgConn.release();
    masterConn.release();
  }
}

async function rotateTokenForUnit({ pool, orgId, unitId }) {
  const token = newIcalToken();
  const orgConn = await pool.getConnection();
  const masterConn = await getMasterPool().getConnection();
  let registryInserted = false;

  try {
    await orgConn.beginTransaction();
    const [rows] = await orgConn.execute(
      `SELECT u.id, u.ical_token
         FROM unit u
         JOIN property p ON u.property_id = p.id
        WHERE u.id = ? AND p.org_id = ? AND p.deleted_at IS NULL AND u.deleted_at IS NULL
        LIMIT 1`,
      [unitId, orgId]
    );
    if (!rows.length) {
      await orgConn.rollback();
      return null;
    }

    const oldToken = rows[0].ical_token;
    await orgConn.execute('UPDATE unit SET ical_token = ? WHERE id = ?', [token, unitId]);
    await registerToken(masterConn, token, orgId);
    registryInserted = true;
    if (oldToken) {
      await masterConn.execute('UPDATE viewing_link_registry SET status = 0 WHERE token = ?', [oldToken]);
    }
    await orgConn.commit();
    return token;
  } catch (err) {
    try { await orgConn.rollback(); } catch {}
    if (registryInserted) {
      try { await masterConn.execute('UPDATE viewing_link_registry SET status = 0 WHERE token = ?', [token]); } catch {}
    }
    throw err;
  } finally {
    orgConn.release();
    masterConn.release();
  }
}

// GET /api/ical/unit/:token.ics - public, fail-closed on broken feed state.
router.get('/unit/:token', stripTrailingIcs, resolveOrgByIcalToken, async (req, res) => {
  try {
    const token = req.params.token;
    const [units] = await req.pool.execute(
      'SELECT u.id, u.name FROM unit u WHERE u.ical_token = ? LIMIT 1',
      [token]
    );
    if (!units.length) {
      console.error('[ical] registry token resolved but unit token is missing:', token);
      return failClosed(res);
    }

    const unit = units[0];
    const [leases] = await req.pool.execute(
      `SELECT l.id AS lease_id,
              DATE_FORMAT(l.start_date, '%Y-%m-%d') AS start_date,
              DATE_FORMAT(l.end_date,   '%Y-%m-%d') AS end_date
         FROM leasing l
        WHERE l.unit_id = ? AND l.status = 1 AND l.deleted_at IS NULL
        ORDER BY l.start_date`,
      [unit.id]
    );

    const now = hkDate(new Date().toISOString());
    const dtstamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const body = buildUnitCalendar({
      calendarName: unit.name || `Unit ${unit.id}`,
      blocks: leases.map((row) => ({
        uid: row.lease_id,
        start_date: row.start_date,
        end_date: row.end_date,
      })),
      now,
      dtstamp,
    });

    res.status(200);
    res.set('Content-Type', 'text/calendar; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=300');
    res.set('Content-Disposition', `inline; filename="unit-${unit.id}.ics"`);
    return res.send(body);
  } catch (err) {
    console.error('[ical] feed error:', err);
    return failClosed(res);
  }
});

// GET /api/ical/tokens - authenticated unit feed list, minting missing tokens.
router.get('/tokens', authenticate, async (req, res) => {
  try {
    const [units] = await req.pool.execute(
      `SELECT u.id AS unit_id, u.name AS unit_name, u.ical_token,
              p.display_name AS property_name
         FROM unit u
         JOIN property p ON u.property_id = p.id
        WHERE p.org_id = ? AND p.deleted_at IS NULL AND u.deleted_at IS NULL
        ORDER BY p.display_name, u.name`,
      [req.user.orgId]
    );

    for (const unit of units) {
      if (!unit.ical_token) {
        unit.ical_token = await generateTokenForUnit({
          pool: req.pool,
          orgId: req.user.orgId,
          unitId: unit.unit_id,
        });
      }
    }

    ok(res, {
      base_url: publicBaseUrl(req),
      units: units.map((unit) => ({
        unit_id: String(unit.unit_id),
        unit_name: unit.unit_name,
        property_name: unit.property_name,
        feed_url: feedUrl(req, unit.ical_token),
      })),
    });
  } catch (err) {
    console.error('[ical] token list error:', err);
    res.status(500).json({ code: 500, message: 'Failed to load iCal tokens' });
  }
});

// POST /api/ical/tokens/:unitId/rotate - authenticated token rotation.
router.post('/tokens/:unitId/rotate', authenticate, async (req, res) => {
  try {
    const token = await rotateTokenForUnit({
      pool: req.pool,
      orgId: req.user.orgId,
      unitId: req.params.unitId,
    });
    if (!token) return res.status(404).json({ code: 404, message: 'Unit not found' });
    ok(res, { feed_url: feedUrl(req, token) });
  } catch (err) {
    console.error('[ical] token rotate error:', err);
    res.status(500).json({ code: 500, message: 'Failed to rotate iCal token' });
  }
});

module.exports = router;
