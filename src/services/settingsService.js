// ค่าตั้งด้านความปลอดภัยของการเข้าสู่ระบบ เก็บในตาราง Setting
// - แก้ค่าในตารางได้โดยตรง มีผลภายใน 1 นาที (โหลดใหม่ทุก 60 วินาที) ไม่ต้อง restart
// - getSetting อ่านจาก cache เท่านั้น (sync) — ลำดับ: ค่าในตาราง → ค่าใน .env → ค่าเริ่มต้น
// - ค่าผิด (ว่าง / ไม่ใช่ตัวเลข / เกินช่วง) จะไม่ทำให้ login พัง: เกินช่วงจะถูกตัดให้อยู่ในช่วง ไม่ใช่ตัวเลขใช้ค่าสำรอง
// - ไม่ require config/db เพื่อไม่ให้ require วนกัน (db.js เป็นคนเรียก initSettings(pool))
const { TABLES } = require('../config/constants');
const { logger } = require('../utils/logger');

const T = TABLES.SETTING;
const LEGACY = TABLES.LEGACY_SETTING;
const REFRESH_MS = 60 * 1000;

const DEFINITIONS = [
  { key: 'ACCOUNT_LOCKOUT_MAX_FAILS', env: 'ACCOUNT_LOCKOUT_MAX_FAILS', def: 5, min: 1, max: 100, description: 'กรอกรหัสผ่านผิดติดกันกี่ครั้งถึงล็อคบัญชี' },
  { key: 'ACCOUNT_LOCKOUT_MINUTES', env: 'ACCOUNT_LOCKOUT_MINUTES', def: 30, min: 1, max: 1440, description: 'ล็อคบัญชีกี่นาที' },
  { key: 'LOGIN_MAX_FAILS_PER_IP', env: 'LOGIN_MAX_FAILS_PER_IP', def: 20, min: 1, max: 1000, description: 'เข้าสู่ระบบผิดจาก IP เดียวกันกี่ครั้งถึงบล็อค IP' },
  { key: 'LOGIN_LOCK_MINUTES', env: 'LOGIN_LOCK_MINUTES', def: 15, min: 1, max: 1440, description: 'บล็อค IP กี่นาที (ใช้กับลิงก์ตั้งรหัสผ่านด้วย)' },
  { key: 'PASSWORD_RESET_MAX_FAILS_PER_IP', env: 'PASSWORD_RESET_MAX_FAILS_PER_IP', def: 10, min: 1, max: 1000, description: 'ใช้ลิงก์ตั้งรหัสผ่านผิดจาก IP เดียวกันกี่ครั้งถึงบล็อค IP' },
  { key: 'MFA_MAX_FAILS', env: 'MFA_MAX_FAILS', def: 5, min: 1, max: 20, description: 'กรอกรหัส MFA ผิดกี่ครั้งถึงล็อคชั่วคราว' },
  { key: 'MFA_LOCK_MINUTES', env: 'MFA_LOCK_MINUTES', def: 15, min: 1, max: 1440, description: 'ล็อค MFA กี่นาที' },
  { key: 'MFA_PENDING_MINUTES', env: 'MFA_PENDING_MINUTES', def: 5, min: 1, max: 30, description: 'หลังกรอกรหัสผ่านถูก มีเวลากรอกรหัส MFA กี่นาที' },
  { key: 'ACCOUNT_SETUP_LINK_HOURS', env: 'ACCOUNT_SETUP_LINK_HOURS', def: 24, min: 1, max: 168, description: 'ลิงก์เปิดใช้งานบัญชี / ผูก MFA ใช้ได้กี่ชั่วโมง' },
  { key: 'PASSWORD_RESET_EXPIRES_MINUTES', env: 'PASSWORD_RESET_EXPIRES_MINUTES', def: 15, min: 5, max: 1440, description: 'ลิงก์ตั้งรหัสผ่านใหม่ใช้ได้กี่นาที' },
  // JWT_EXPIRES_IN เดิมเขียนได้หลายแบบ (12h / 1d / 90m / 3600) จึงแปลงเป็นชั่วโมงเฉพาะตัวนี้
  { key: 'SESSION_HOURS', env: 'JWT_EXPIRES_IN', def: 12, min: 1, max: 72, description: 'เข้าสู่ระบบแล้วใช้งานได้กี่ชั่วโมงก่อนต้อง login ใหม่', parseEnv: (raw) => {
    const m = String(raw || '').trim().match(/^(\d+)\s*([smhd]?)$/i);
    if (!m) return null;
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    const hours = unit === 'd' ? n * 24 : unit === 'h' ? n : unit === 'm' ? n / 60 : n / 3600;
    return Math.max(1, Math.round(hours));
  } },
];
const BY_KEY = new Map(DEFINITIONS.map((d) => [d.key, d]));

let cache = new Map();
const warned = new Set();
let timer = null;

const warnOnce = (key, message) => {
  if (warned.has(key)) return;
  warned.add(key);
  logger.warn(`[settings] ${key}: ${message}`);
};

const toInt = (raw) => {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  if (!/^-?\d+$/.test(text)) return null;
  return Number(text);
};

const fallbackValue = (d) => {
  const fromEnv = d.parseEnv ? d.parseEnv(process.env[d.env]) : toInt(process.env[d.env]);
  return fromEnv === null ? d.def : Math.min(d.max, Math.max(d.min, fromEnv));
};

function getSetting(key) {
  const d = BY_KEY.get(key);
  if (!d) throw new Error(`Unknown setting: ${key}`);
  if (!cache.has(key)) return fallbackValue(d);

  const raw = cache.get(key);
  const value = toInt(raw);
  if (value === null) {
    warnOnce(key, `ค่า "${raw}" ไม่ใช่ตัวเลข — ใช้ค่าสำรอง ${fallbackValue(d)}`);
    return fallbackValue(d);
  }
  if (value < d.min || value > d.max) {
    const clamped = Math.min(d.max, Math.max(d.min, value));
    warnOnce(key, `ค่า ${value} อยู่นอกช่วง ${d.min}-${d.max} — ใช้ ${clamped}`);
    return clamped;
  }
  return value;
}

// ใส่ค่าลง cache (ใช้ตอนโหลดจากตาราง และในการทดสอบ)
function setCacheFromRows(rows) {
  const next = new Map();
  (rows || []).forEach((row) => {
    if (row && BY_KEY.has(row.setting_key)) next.set(row.setting_key, row.setting_value);
  });
  cache = next;
  warned.clear();
}

async function loadSettings(pool) {
  try {
    const result = await pool.request().query(`SELECT setting_key, setting_value FROM [${T}]`);
    setCacheFromRows(result.recordset);
    return true;
  } catch (err) {
    logger.warn('[settings] โหลดค่าจาก Setting ไม่สำเร็จ ใช้ค่าล่าสุดที่มีอยู่:', err.message);
    return false;
  }
}

// สร้างตาราง + ใส่เฉพาะ key ที่ยังไม่มี (ไม่ทับค่าที่ admin แก้ไว้) แล้วโหลด และตั้งให้โหลดใหม่ทุก 60 วินาที
async function initSettings(pool) {
  await pool.request().query(`
    IF OBJECT_ID('dbo.[${T}]', 'U') IS NULL AND OBJECT_ID('dbo.[${LEGACY}]', 'U') IS NOT NULL
    BEGIN
      EXEC sp_rename 'dbo.${LEGACY}', '${T}';
    END

    IF OBJECT_ID('dbo.[${T}]', 'U') IS NULL
    BEGIN
      CREATE TABLE [${T}] (
        setting_key NVARCHAR(100) NOT NULL PRIMARY KEY,
        setting_value NVARCHAR(100) NOT NULL,
        min_value INT NULL,
        max_value INT NULL,
        description NVARCHAR(200) NULL,
        updated_at DATETIME NOT NULL DEFAULT GETDATE()
      );
    END
  `);
  for (const d of DEFINITIONS) {
    await pool.request()
      .input('key', d.key)
      .input('value', String(fallbackValue(d)))
      .input('min', d.min)
      .input('max', d.max)
      .input('description', d.description)
      .query(`
        IF NOT EXISTS (SELECT 1 FROM [${T}] WHERE setting_key = @key)
          INSERT INTO [${T}] (setting_key, setting_value, min_value, max_value, description)
          VALUES (@key, @value, @min, @max, @description)
      `);
  }
  await loadSettings(pool);
  if (!timer) {
    timer = setInterval(() => { loadSettings(pool); }, REFRESH_MS);
    timer.unref();
  }
}

module.exports = { DEFINITIONS, getSetting, loadSettings, initSettings, setCacheFromRows };
