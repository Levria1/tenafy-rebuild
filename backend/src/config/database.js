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
  supportBigNumbers: true,
  bigNumberStrings: true
});

pool.on('connection', () => {
  console.log('Connected to MySQL database');
});

module.exports = pool;