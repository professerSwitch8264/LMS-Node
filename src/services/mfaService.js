// MFA แบบ TOTP (รหัส 6 หลักเปลี่ยนทุก 30 วินาที จากแอป Authenticator)
// - secret เก็บแบบเข้ารหัส AES-256-GCM สุ่ม IV ใหม่ทุกครั้ง ใช้ MFA_ENCRYPTION_KEY (แยกจาก JWT_SECRET)
// - รหัสผิดนับแบบ atomic ใน UPDATE เดียว ครบกำหนดล็อคชั่วคราว (เวลาจาก DB)
// - รหัสที่ใช้แล้วใช้ซ้ำไม่ได้ (เก็บช่วงเวลาล่าสุดใน mfa_last_step)
const crypto = require('crypto');
const { authenticator } = require('otplib');
const qrcode = require('qrcode');
const { TABLES } = require('../config/constants');
const MFA = require('../config/mfa');

const totp = authenticator.clone({ window: 1, step: 30, digits: 6 });
const CODE_PATTERN = /^\d{6}$/;

let cachedKey = null;
const getKey = () => {
  if (!cachedKey) cachedKey = MFA.loadEncryptionKey();
  return cachedKey;
};

function encryptSecret(secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const data = Buffer.concat([cipher.update(String(secret), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64')).join(':');
}

function decryptSecret(stored) {
  const [iv, tag, data] = String(stored || '').split(':').map((part) => Buffer.from(part, 'base64'));
  if (!iv || !tag || !data) throw new Error('Invalid MFA secret format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

const generateSecret = () => totp.generateSecret(20);

const buildQrDataUrl = (username, secret) =>
  qrcode.toDataURL(totp.keyuri(String(username), MFA.MFA_ISSUER, secret), { margin: 1, width: 220 });

const currentStep = (now = Date.now()) => Math.floor(now / 30000);

// ตรวจรหัส: คืน { ok, step } — ยอมคลาดเวลาได้ ±1 ช่วง และไม่รับช่วงที่ใช้ไปแล้ว
function verifyCode(secret, code, lastStep = null, now = Date.now()) {
  const clean = String(code || '').trim();
  if (!CODE_PATTERN.test(clean)) return { ok: false, step: null };
  const delta = totp.clone({ epoch: now }).checkDelta(clean, secret);
  if (delta === null || delta === undefined) return { ok: false, step: null };
  const step = currentStep(now) + delta;
  if (lastStep !== null && lastStep !== undefined && step <= Number(lastStep)) return { ok: false, step, replay: true };
  return { ok: true, step };
}

// ---------- ฐานข้อมูล (parameterized ทั้งหมด) ----------
const lockSql = (col) => `
  CASE WHEN ${col} > GETDATE() THEN 1 ELSE 0 END AS is_locked,
  DATEDIFF(SECOND, GETDATE(), ${col}) AS lock_seconds_left,
  CONVERT(varchar(10), ${col}, 103) + ' ' + CONVERT(varchar(5), ${col}, 108) AS lockout_until_text`;
const NOT_LOCKED = '(mfa_lockout_until IS NULL OR mfa_lockout_until <= GETDATE())';

async function getMfaState(pool, username) {
  const r = await pool.request()
    .input('u', username)
    .query(`SELECT username, mfa_secret_enc, mfa_enabled, mfa_last_step, ${lockSql('mfa_lockout_until')}
            FROM [${TABLES.USER}] WHERE UPPER(username) = @u`);
  return r.recordset?.[0] || null;
}

// เก็บ secret ใหม่ (ยังไม่เปิดใช้จนกว่าจะยืนยันรหัสครั้งแรก)
async function saveNewSecret(pool, username, secret) {
  await pool.request()
    .input('u', username)
    .input('enc', encryptSecret(secret))
    .query(`UPDATE [${TABLES.USER}]
            SET mfa_secret_enc = @enc, mfa_enabled = 0, mfa_last_step = NULL, updated_at = GETDATE()
            WHERE UPPER(username) = @u`);
}

// secret ที่รอยืนยัน: ถ้ามีอยู่แล้ว (ยังไม่ยืนยัน) คืนตัวเดิม ไม่สร้างใหม่
// กันกรณีเปิดหน้าตั้งค่าซ้ำ / รีเฟรช / React StrictMode เรียก 2 ครั้ง แล้ว QR ที่สแกนไปไม่ตรงกับ secret ใน DB
const readPendingSecret = (state) => {
  if (!state?.mfa_secret_enc || state.mfa_enabled) return null;
  try { return decryptSecret(state.mfa_secret_enc); } catch { return null; }
};

async function getOrCreatePendingSecret(pool, username) {
  const existing = readPendingSecret(await getMfaState(pool, username));
  if (existing) return existing;

  // บันทึกเฉพาะเมื่อยังไม่มี secret ที่รอยืนยัน (atomic) — ถ้า request อื่นบันทึกไปก่อน ใช้ของ request นั้น
  const secret = generateSecret();
  const r = await pool.request()
    .input('u', username)
    .input('enc', encryptSecret(secret))
    .query(`UPDATE [${TABLES.USER}]
            SET mfa_secret_enc = @enc, mfa_enabled = 0, mfa_last_step = NULL, updated_at = GETDATE()
            WHERE UPPER(username) = @u AND (mfa_secret_enc IS NULL OR mfa_enabled = 1)`);
  if ((r.rowsAffected || []).reduce((a, b) => a + b, 0) > 0) return secret;

  const raced = readPendingSecret(await getMfaState(pool, username));
  if (raced) return raced;
  // secret เดิมถอดรหัสไม่ได้ (เช่น เปลี่ยน MFA_ENCRYPTION_KEY) → เขียนทับ
  await saveNewSecret(pool, username, secret);
  return secret;
}

// ล้าง MFA ทั้งหมด (ใช้ตอน Admin รีเซ็ต หรือเปิดใช้งานบัญชีใหม่)
async function clearMfa(request, username) {
  await request
    .input('mfa_u', username)
    .query(`UPDATE [${TABLES.USER}]
            SET mfa_secret_enc = NULL, mfa_enabled = 0, mfa_last_step = NULL,
                mfa_failed_count = 0, mfa_lockout_until = NULL, updated_at = GETDATE()
            WHERE UPPER(username) = @mfa_u`);
}

async function registerFailure(pool, username) {
  const nextCount = `CASE WHEN mfa_lockout_until IS NOT NULL AND mfa_lockout_until <= GETDATE()
                          THEN 1 ELSE mfa_failed_count + 1 END`;
  const r = await pool.request()
    .input('u', username)
    .input('max', MFA.MFA_MAX_FAILS)
    .input('mins', MFA.MFA_LOCK_MINUTES)
    .query(`UPDATE [${TABLES.USER}]
            SET mfa_failed_count = ${nextCount},
                mfa_lockout_until = CASE WHEN ${nextCount} >= @max THEN DATEADD(MINUTE, @mins, GETDATE()) ELSE NULL END
            OUTPUT ${lockSql('inserted.mfa_lockout_until')}
            WHERE UPPER(username) = @u AND ${NOT_LOCKED}`);
  return r.recordset?.[0] || null;
}

// รหัสถูก: เปิดใช้ MFA และจดช่วงเวลาที่ใช้ — WHERE กันทั้งการล็อคและรหัสซ้ำแบบ atomic
async function markSuccess(pool, username, step) {
  const r = await pool.request()
    .input('u', username)
    .input('step', step)
    .query(`UPDATE [${TABLES.USER}]
            SET mfa_enabled = 1, mfa_last_step = @step, mfa_failed_count = 0, mfa_lockout_until = NULL
            WHERE UPPER(username) = @u AND ${NOT_LOCKED}
              AND (mfa_last_step IS NULL OR mfa_last_step < @step)`);
  return (r.rowsAffected || []).reduce((a, b) => a + b, 0) > 0;
}

// ตรวจรหัสของผู้ใช้ทั้ง flow: คืน { status: 'OK' | 'INVALID' | 'LOCKED' | 'NO_SECRET', lock }
async function checkUserCode(pool, username, code) {
  const state = await getMfaState(pool, username);
  if (!state || !state.mfa_secret_enc) return { status: 'NO_SECRET' };
  if (state.is_locked) return { status: 'LOCKED', lock: state };

  let secret;
  try {
    secret = decryptSecret(state.mfa_secret_enc);
  } catch {
    return { status: 'NO_SECRET' };
  }

  const result = verifyCode(secret, code, state.mfa_last_step);
  if (result.ok && await markSuccess(pool, username, result.step)) return { status: 'OK' };

  const failed = await registerFailure(pool, username);
  if (failed?.is_locked) return { status: 'LOCKED', lock: failed };
  if (!failed) {
    const latest = await getMfaState(pool, username);
    if (latest?.is_locked) return { status: 'LOCKED', lock: latest };
  }
  return { status: 'INVALID' };
}

module.exports = {
  CODE_PATTERN,
  encryptSecret,
  decryptSecret,
  generateSecret,
  buildQrDataUrl,
  verifyCode,
  currentStep,
  getMfaState,
  saveNewSecret,
  getOrCreatePendingSecret,
  clearMfa,
  checkUserCode,
};
