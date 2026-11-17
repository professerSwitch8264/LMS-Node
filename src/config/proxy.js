// TRUST_PROXY: backend อยู่หลัง reverse proxy (IIS / nginx / Caddy) ที่ทำ HTTPS ให้
// ตั้งแล้ว express จะอ่าน IP จริงของผู้ใช้จาก X-Forwarded-For (การแบนตาม IP ตอน login จึงแยกรายคน)
//
// ค่าที่รับ:
//   (ว่าง)              ไม่มี proxy — ใช้ IP ที่ต่อเข้ามาตรง ๆ
//   1, 2, ...           จำนวนชั้นของ proxy หน้า backend (ปกติ 1)
//   loopback / IP / subnet คั่นด้วย comma  เช่น loopback,10.0.0.5 — เชื่อเฉพาะ proxy ที่อยู่ในรายการ
// ไม่รับ "true": จะเชื่อ X-Forwarded-For จากทุกคน ทำให้ปลอม IP หนีการแบนได้

const { logger } = require('../utils/logger');

function parseTrustProxy(raw) {
  const value = String(raw ?? '').trim();
  if (!value || value === '0' || value.toLowerCase() === 'false') return false;
  if (/^\d+$/.test(value)) return Number(value);
  if (value.toLowerCase() === 'true') {
    logger.warn('⚠️ TRUST_PROXY=true is not allowed (anyone could fake their IP). Using 1 (one proxy in front) instead.');
    return 1;
  }
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

module.exports = { parseTrustProxy };
