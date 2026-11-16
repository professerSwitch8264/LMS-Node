// ค่าตั้งของ MFA (รหัส 6 หลักจากแอป Authenticator)
// ตัวเลขจำนวนครั้ง/เวลา อ่านจากตาราง Setting ทุกครั้งที่ใช้ (แก้ในตารางแล้วมีผลภายใน 1 นาที)
const { getSetting } = require('../services/settingsService');

// key สำหรับเข้ารหัส secret ของ MFA — ต้องแยกจาก JWT_SECRET และยาว 32 byte (base64)
function loadEncryptionKey() {
  const raw = String(process.env.MFA_ENCRYPTION_KEY || '').trim();
  const key = raw ? Buffer.from(raw, 'base64') : null;
  if (!key || key.length !== 32) {
    throw new Error('MFA_ENCRYPTION_KEY ต้องเป็นค่า base64 ยาว 32 byte — สร้างด้วย: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"');
  }
  if (process.env.JWT_SECRET && raw === String(process.env.JWT_SECRET).trim()) {
    throw new Error('MFA_ENCRYPTION_KEY ต้องไม่ซ้ำกับ JWT_SECRET');
  }
  return key;
}

module.exports = {
  loadEncryptionKey,
  MFA_ISSUER: String(process.env.MFA_ISSUER || 'LMS Wan Thai').trim(),
  get MFA_MAX_FAILS() { return getSetting('MFA_MAX_FAILS'); },
  get MFA_LOCK_MINUTES() { return getSetting('MFA_LOCK_MINUTES'); },
  get MFA_PENDING_MINUTES() { return getSetting('MFA_PENDING_MINUTES'); },
  get ACCOUNT_SETUP_LINK_HOURS() { return getSetting('ACCOUNT_SETUP_LINK_HOURS'); },
};
