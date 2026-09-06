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
  // DATE and DATETIME come back as STRINGS. TIMESTAMP deliberately does not.
  //
  // These three column types mean different things in this schema and only one of them
  // is an absolute instant:
  //
  //   DATE      a calendar date, no zone at all (invoice.due_on, leasing.start_date)
  //   DATETIME  a HONG KONG wall clock (service.preferred_date_*, viewing times)
  //   TIMESTAMP a real instant (created_at, updated_at)
  //
  // Without this, mysql2 turns the first two into JavaScript Dates by reading them
  // against the process timezone, which is UTC on the droplet. A DATETIME meaning
  // "6am in Hong Kong" is then serialised to the browser as 06:00Z, and a browser in
  // Hong Kong draws 2pm. Measured on service S3293, whose stored 06:00-16:00 window
  // was displayed as 2pm to midnight the following day.
  //
  // That was not only a display fault. The staff edit form loaded the shifted value and
  // saved it back, so every open-and-save pushed the window eight hours later, and it
  // composed the end from the start date. 141 of 1,702 requests had ended up with an end
  // BEFORE their start, all reading 08:00:00 -> 07:59:59.
  //
  // Returning them as strings keeps the stored wall clock intact end to end. TIMESTAMP
  // stays a Date because it IS an instant and must be rendered in the reader's zone.
  //
  // NOT process.env.TZ, which looks like the one-line version of this and would
  // reinterpret every DATETIME already stored. See utils/orgTime.js.
  dateStrings: ['DATE', 'DATETIME'],
  supportBigNumbers: true,
  bigNumberStrings: true
});

pool.on('connection', () => {
  console.log('Connected to MySQL database');
});

module.exports = pool;