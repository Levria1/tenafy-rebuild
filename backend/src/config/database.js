const mysql = require('mysql2/promise');
const config = require('./index');

const pool = mysql.createPool({
  host: config.database.host,
  port: config.database.port,
  user: config.database.user,
  password: config.database.password,
  database: config.database.database,
  waitForConnections: config.database.waitForConnections,
  connectionLimit: config.database.connectionLimit,
  queueLimit: config.database.queueLimit,
  // DATE comes back as a STRING. DATETIME deliberately does NOT.
  //
  // A first attempt stringified both, and that was wrong, because DATETIME means two
  // different things in this schema:
  //
  //   appointment times (service.preferred_date_*, service_date_*, viewing times) hold a
  //     HONG KONG WALL CLOCK, written from a form
  //   audit stamps (24 columns: created_at, updated_at, deleted_at, activity_date...) hold
  //     UTC, because they are written with NOW() and NOW() on this server IS UTC
  //
  // Returning every DATETIME as a string fixes the first group and breaks the second: an
  // audit stamp was being read as an instant and correctly redrawn in Hong Kong, and as a
  // bare string it renders eight hours early instead.
  //
  // So DATETIME keeps arriving as a Date, and the wall-clock columns are pulled out with
  // DATE_FORMAT in the queries that need them, which is the only place the distinction is
  // actually known.
  //
  // DATE is unambiguous and safe: no time, no zone. As a Date it was built at local
  // midnight and toISOString() on it lands a day early anywhere east of UTC, which is a
  // latent off-by-one this removes.
  //
  // NOT process.env.TZ, which would reinterpret every DATETIME already stored.
  // See utils/orgTime.js.
  dateStrings: ['DATE'],
  supportBigNumbers: true,
  bigNumberStrings: true
});

pool.on('connection', () => {
  console.log('Connected to MySQL database');
});

module.exports = pool;