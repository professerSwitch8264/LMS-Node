const { logger } = require('../utils/logger');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { getSetting } = require('../services/settingsService');

const ISSUER = 'wanthai-lms';

let secret = process.env.JWT_SECRET;
if (!secret || secret.length < 32) {
  secret = crypto.randomBytes(48).toString('hex');
  logger.warn('⚠️ JWT_SECRET is missing or shorter than 32 characters — using a random secret. Everyone must log in again after a server restart. Set JWT_SECRET in .env.');
}

// อ่านจาก Setting ทุกครั้งที่ออก token (แก้ในตารางแล้วมีผลกับ token ที่ออกใหม่)
const expiresIn = () => `${getSetting('SESSION_HOURS')}h`;
const mfaPendingMinutes = () => getSetting('MFA_PENDING_MINUTES');

// เปลี่ยนรหัสผ่านหรือรีเซ็ต MFA แล้ว token เก่าใช้ไม่ได้ทันที
const passwordVersion = (passwordHash, mfaSecretEnc = '') =>
  crypto.createHash('sha256').update(`${passwordHash || ''}|${mfaSecretEnc || ''}`).digest('hex').slice(0, 16);

// token ใช้งานจริง — ออกให้หลังผ่าน MFA เท่านั้น
function signUserToken({ username, roleId, passwordHash, mfaSecretEnc }) {
  return jwt.sign(
    { sub: String(username).toUpperCase(), role: roleId, pv: passwordVersion(passwordHash, mfaSecretEnc), typ: 'access', mfa: true },
    secret,
    { algorithm: 'HS256', expiresIn: expiresIn(), issuer: ISSUER },
  );
}

// token ชั่วคราวหลังรหัสผ่านถูก ใช้ได้เฉพาะขั้นตั้งค่า/ยืนยัน MFA ตอน login
function signMfaPendingToken({ username, passwordHash, mfaSecretEnc }) {
  return jwt.sign(
    { sub: String(username).toUpperCase(), pv: passwordVersion(passwordHash, mfaSecretEnc), typ: 'mfa_pending' },
    secret,
    { algorithm: 'HS256', expiresIn: `${mfaPendingMinutes()}m`, issuer: ISSUER },
  );
}

function verifyUserToken(token) {
  try {
    return jwt.verify(token, secret, { algorithms: ['HS256'], issuer: ISSUER });
  } catch (err) {
    const e = new Error(err.name === 'TokenExpiredError' ? 'Token expired' : 'Invalid token');
    e.code = err.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID';
    throw e;
  }
}

function getTokenExpiry(token) {
  const decoded = jwt.decode(token);
  return decoded?.exp ? new Date(decoded.exp * 1000).toISOString() : null;
}

module.exports = {
  signUserToken,
  signMfaPendingToken,
  verifyUserToken,
  getTokenExpiry,
  passwordVersion,
  get EXPIRES_IN() { return expiresIn(); },
};
