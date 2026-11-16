const { getPool } = require('./src/config/db');
const { TABLES } = require('./src/config/constants');
getPool()
  .then(pool => pool.request().query(`SELECT TOP 5 user_group FROM ${TABLES.USER}`))
  .then(res => console.log('Result:', res.recordset))
  .catch(err => console.error('Error:', err.message));
