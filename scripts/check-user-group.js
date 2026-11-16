// ตรวจค่า user_group ในตาราง User (ดู 5 แถวแรก) — ใช้ตอนตรวจข้อมูลหลังย้ายฐานข้อมูล
//
//   node scripts/check-user-group.js
//
// ใช้ฐานข้อมูลตาม DB_NAME ใน .env
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { getPool } = require('../src/config/db');
const { TABLES } = require('../src/config/constants');

getPool()
  .then((pool) => pool.request().query(`SELECT TOP 5 username, user_group FROM [${TABLES.USER}]`))
  .then((res) => {
    console.log('Result:', res.recordset);
    process.exit(0);
  })
  .catch((err) => {
    console.error('Error:', err.message);
    process.exit(1);
  });
