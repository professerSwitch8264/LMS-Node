// ค่าการล็อคบัญชี — อ่านจากตาราง Setting ทุกครั้งที่ใช้ (แก้ในตารางแล้วมีผลภายใน 1 นาที)
const { getSetting } = require('../services/settingsService');

module.exports = {
  // กรอกรหัสผ่านผิดติดกันกี่ครั้งถึงล็อคบัญชี
  get MAX_FAILS() { return getSetting('ACCOUNT_LOCKOUT_MAX_FAILS'); },
  // ล็อคบัญชีกี่นาที (ครบเวลาแล้วปลดล็อคเองตอน login ครั้งถัดไป)
  get LOCK_MINUTES() { return getSetting('ACCOUNT_LOCKOUT_MINUTES'); },
};
