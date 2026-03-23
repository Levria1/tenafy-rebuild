require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');
const config = require('./config');
const { startScheduler } = require('./services/scheduler');

const app = express();

app.use(helmet());
app.use(cors({
  origin: [config.frontendUrl, 'http://localhost:3000', 'http://192.168.1.31:3000'],
  credentials: true
}));
app.use(morgan('dev'));
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
app.use('/api/property-owner', require('./routes/propertyOwner'));
app.use('/api/service-vendor', require('./routes/serviceVendor'));
app.use('/api/role', require('./routes/role'));
app.use('/api/file', require('./routes/file'));
app.use('/api/amenity', require('./routes/amenity'));
app.use('/api/email-template', require('./routes/emailTemplate'));
app.use('/api/smtp-account', require('./routes/smtpAccount'));
app.use('/api/notification', require('./routes/notification'));
app.use('/api/tenant-portal', require('./routes/tenantPortal'));
app.use('/api/pdf', require('./routes/pdf'));
app.use('/api/storage', require('./routes/storage'));
app.use('/api/public', require('./routes/public'));
app.use('/api/cleaning', require('./routes/cleaning'));
app.use('/api/utility', require('./routes/utility'));

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

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