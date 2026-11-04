require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');
const config = require('./config');
const { signatureJsonParser, payloadTooLargeResponse } = require('./middleware/signatureBody');
const { startScheduler } = require('./services/scheduler');

const app = express();

// Production sits behind nginx on the same box, which appends the visitor's
// address to X-Forwarded-For. Without this every request looked like it came
// from 127.0.0.1: the portal login/registration and viewing-booking rate limits
// counted ALL visitors as one (one tenant's failed logins could lock out every
// other tenant), and express-rate-limit logged ERR_ERL_UNEXPECTED_X_FORWARDED_FOR
// on each request. 'loopback' trusts only a proxy on this machine, so a header
// forged by a client is ignored: req.ip is the address nginx itself saw.
// Never set this to `true` — that would trust whatever the client sends.
app.set('trust proxy', 'loopback');

app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));
app.use(cors({
  origin: [config.frontendUrl, 'http://localhost:3000', 'http://192.168.1.31:3000'],
  credentials: true
}));
app.use(morgan('dev'));
// Parse larger base64 signature uploads before the generic 100 KB parser.
app.post('/api/signature/public/:token/sign', signatureJsonParser);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/master', require('./routes/master'));
app.use('/api/user', require('./routes/user'));
app.use('/api/user', require('./routes/settings'));
app.use('/api/property', require('./routes/property'));
app.use('/api/tenant', require('./routes/tenant'));
app.use('/api/leasing', require('./routes/leasing'));
app.use('/api/accounting', require('./routes/accounting'));
app.use('/api/invoice', require('./routes/invoice'));
app.use('/api/service', require('./routes/service'));
app.use('/api/contact', require('./routes/contact'));
app.use('/api/payee', require('./routes/payee'));
app.use('/api/bank-account', require('./routes/bankAccount'));
app.use('/api/property-owner', require('./routes/propertyOwner'));
app.use('/api/service-vendor', require('./routes/serviceVendor'));
app.use('/api/role', require('./routes/role'));
app.use('/api/file', require('./routes/file'));
app.use('/api/amenity', require('./routes/amenity'));
app.use('/api/email-template', require('./routes/emailTemplate'));
app.use('/api/whatsapp-template', require('./routes/whatsappTemplate'));
app.use('/api/smtp-account', require('./routes/smtpAccount'));
app.use('/api/notification', require('./routes/notification'));
app.use('/api/tenant-portal', require('./routes/tenantPortal'));
app.use('/api/pdf', require('./routes/pdf'));
app.use('/api/storage', require('./routes/storage'));
app.use('/api/public', require('./routes/public'));
app.use('/api/website', require('./routes/websitePublic'));
app.use('/api/integrations/xero', require('./routes/xero'));
app.use('/api/viewing-public', require('./routes/viewingPublic'));
app.use('/api/viewing', require('./routes/viewing'));
app.use('/api/ical', require('./routes/ical'));
app.use('/api/inquiry', require('./routes/inquiry'));
app.use('/api/advertising', require('./routes/advertising'));
app.use('/api/lease-template', require('./routes/leaseTemplate'));
app.use('/api/signature', require('./routes/signature'));
app.use('/api/chat', require('./routes/chat'));
app.use('/api/cleaning', require('./routes/cleaning'));
app.use('/api/utility', require('./routes/utility'));
app.use('/api/booking-platform', require('./routes/bookingPlatform'));
app.use('/api/sales-agent', require('./routes/salesAgent'));
app.use('/api/activity-log', require('./routes/activityLog'));
app.use('/api/reports', require('./routes/reports'));

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use(payloadTooLargeResponse);
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ code: 500, message: 'Internal server error' });
});

const { closePools } = require('./config/poolRegistry');

const PORT = config.port;
app.listen(PORT, () => {
  console.log(`Tenafy API running on port ${PORT}`);
  startScheduler();
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  await closePools();
  process.exit(0);
});

module.exports = app;
