// การล็อครายผู้ใช้อยู่ในฐานข้อมูลแล้ว (userController -> ACCOUNT_LOCKOUT_*)
// middleware นี้เหลือแค่จำกัดต่อ IP กันการไล่เดาหลาย username
// ค่าจำนวนครั้ง/เวลาอ่านจากตาราง Setting ทุกครั้งที่ตรวจ (แก้ในตารางแล้วมีผลภายใน 1 นาที)
const { getSetting } = require('../services/settingsService');

const windowMs = () => getSetting('LOGIN_LOCK_MINUTES') * 60 * 1000;
const maxPerIp = () => getSetting('LOGIN_MAX_FAILS_PER_IP');
const maxResetFailsPerIp = () => getSetting('PASSWORD_RESET_MAX_FAILS_PER_IP');

const failures = new Map();

const now = () => Date.now();

function getEntry(key) {
  const e = failures.get(key);
  if (!e) return null;
  if (e.lockedUntil && e.lockedUntil <= now()) { failures.delete(key); return null; }
  if (!e.lockedUntil && now() - e.first > windowMs()) { failures.delete(key); return null; }
  return e;
}

function recordFailure(key, max) {
  const e = getEntry(key) || { count: 0, first: now(), lockedUntil: 0 };
  e.count += 1;
  if (e.count >= max) e.lockedUntil = now() + windowMs();
  failures.set(key, e);
}

setInterval(() => { for (const k of failures.keys()) getEntry(k); }, 60 * 1000).unref();

const ipOf = (req) => String(req.ip || req.socket?.remoteAddress || 'unknown');

function loginRateLimit(req, res, next) {
  const ipKey = `ip:${ipOf(req)}`;
  const entry = getEntry(ipKey);

  if (entry && entry.lockedUntil > now()) {
    const until = entry.lockedUntil;
    const minutes = Math.max(1, Math.ceil((until - now()) / 60000));
    res.set('Retry-After', String(Math.ceil((until - now()) / 1000)));
    return res.status(429).json({
      success: false,
      code: 'TOO_MANY_ATTEMPTS',
      message: `เข้าสู่ระบบผิดหลายครั้งเกินไป กรุณาลองใหม่ในอีก ${minutes} นาที`,
    });
  }

  res.on('finish', () => {
    if (res.statusCode === 401) recordFailure(ipKey, maxPerIp());
  });
  return next();
}

function passwordResetRateLimit(req, res, next) {
  const ipKey = `reset-ip:${ipOf(req)}`;
  const entry = getEntry(ipKey);
  if (entry && entry.lockedUntil > now()) {
    const minutes = Math.max(1, Math.ceil((entry.lockedUntil - now()) / 60000));
    res.set('Retry-After', String(Math.ceil((entry.lockedUntil - now()) / 1000)));
    return res.status(429).json({
      success: false,
      code: 'TOO_MANY_ATTEMPTS',
      message: `ลองตั้งรหัสผ่านใหม่ผิดหลายครั้งเกินไป กรุณาลองใหม่ในอีก ${minutes} นาที`,
    });
  }

  res.on('finish', () => {
    if (res.statusCode === 400) recordFailure(ipKey, maxResetFailsPerIp());
  });
  return next();
}

const resetLoginRateLimit = () => failures.clear();

module.exports = { loginRateLimit, passwordResetRateLimit, resetLoginRateLimit };
