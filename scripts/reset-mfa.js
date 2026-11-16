// รีเซ็ต MFA ฉุกเฉิน — ใช้บนเครื่อง server เมื่อ Admin ทุกคนเข้าระบบไม่ได้ (เช่น โทรศัพท์หายพร้อมกัน)
//
//   node scripts/reset-mfa.js <username>
//
// ล้าง MFA และลิงก์ที่ค้างอยู่ของบัญชีนั้น (บัญชีต้องเปิดใช้งานอยู่)
// login ครั้งถัดไปด้วยรหัสผ่านเดิม ระบบจะให้สแกน QR ผูก MFA ใหม่
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { getPool } = require('../src/config/db');
const { TABLES } = require('../src/config/constants');
const { clearMfa } = require('../src/services/mfaService');

const username = String(process.argv[2] || '').trim().toUpperCase();
if (!username) {
  console.error('ใช้งาน: node scripts/reset-mfa.js <username>');
  process.exit(1);
}

(async () => {
  const pool = await getPool();
  const found = await pool.request().input('u', username)
    .query(`SELECT username, ISNULL(is_active, 0) AS is_active FROM [${TABLES.USER}] WHERE UPPER(username) = @u`);
  const user = found.recordset?.[0];
  if (!user) {
    console.error(`❌ ไม่พบผู้ใช้ ${username}`);
    process.exit(1);
  }
  if (!user.is_active) {
    console.error(`❌ บัญชี ${username} ปิดใช้งานอยู่ — ให้เปิดใช้งานจากหน้าผู้ใช้งานแทน`);
    process.exit(1);
  }
  await clearMfa(pool.request(), username);
  await pool.request().input('u', username)
    .query(`UPDATE [${TABLES.USER}] SET reset_token_hash = NULL, reset_token_expires = NULL, reset_token_purpose = NULL WHERE UPPER(username) = @u`);
  console.log(`✅ รีเซ็ต MFA ของ ${username} แล้ว — login ครั้งถัดไปจะให้สแกน QR ผูกโทรศัพท์ใหม่`);
  process.exit(0);
})().catch((err) => {
  console.error('❌', err.message);
  process.exit(1);
});
