// Level log ของ backend (ไม่ใช่ Audit log) — สำหรับ Dev/IT ไว้ดูว่าระบบทำอะไรและพังตรงไหน
// ระดับ: debug < info < warn < error   ตั้งด้วย LOG_LEVEL (ค่าเริ่มต้น: production = info, อื่นๆ = debug)
// เขียนออก stdout/stderr บรรทัดละรายการ: <เวลา> <LEVEL> [<request id>] <ข้อความ> <meta JSON>
// ห้ามใส่รหัสผ่าน / token / MFA secret / ลิงก์รีเซ็ต ลงใน meta
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const defaultLevel = process.env.NODE_ENV === 'production' ? 'info' : 'debug';
const configured = String(process.env.LOG_LEVEL || defaultLevel).trim().toLowerCase();
const threshold = LEVELS[configured] || LEVELS[defaultLevel];

const requestContext = new AsyncLocalStorage();

const SECRET_KEYS = /pass(word)?|token|secret|authorization|cookie|^otp$|^code$|^mfaCode$/i;

function redact(value, depth = 0) {
  if (value instanceof Error) return { message: value.message, ...(value.code ? { code: value.code } : {}) };
  if (!value || typeof value !== 'object' || depth > 3) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEYS.test(k) ? '[hidden]' : redact(v, depth + 1);
  return out;
}

function pad(n) { return String(n).padStart(2, '0'); }
function timestamp() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function write(level, message, meta) {
  if (LEVELS[level] < threshold) return;
  const reqId = requestContext.getStore()?.requestId;
  let line = `${timestamp()} ${level.toUpperCase().padEnd(5)}${reqId ? ` [${reqId}]` : ''} ${message}`;
  if (meta !== undefined) {
    try {
      line += ` ${JSON.stringify(redact(meta))}`;
    } catch {
      line += ' [meta not serializable]';
    }
  }
  if (level === 'error' || level === 'warn') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

const logger = {
  debug: (message, meta) => write('debug', message, meta),
  info: (message, meta) => write('info', message, meta),
  warn: (message, meta) => write('warn', message, meta),
  error: (message, meta) => write('error', message, meta),
  level: Object.keys(LEVELS).find((k) => LEVELS[k] === threshold),
};

// middleware: ให้ทุก log ใน request เดียวกันมี request id เดียวกัน และสรุป 1 บรรทัดเมื่อตอบเสร็จ
// GET ที่สำเร็จ = debug (หน้าเว็บดึงข้อมูลบ่อย), คำสั่งที่สำเร็จ = info, 4xx = warn, 5xx = error
function requestLogger(req, res, next) {
  const requestId = crypto.randomBytes(4).toString('hex');
  const started = process.hrtime.bigint();
  res.setHeader('X-Request-Id', requestId);
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : req.method === 'GET' ? 'debug' : 'info';
    requestContext.run({ requestId }, () => {
      write(level, `${req.method} ${req.originalUrl.split('?')[0]} ${res.statusCode} ${ms.toFixed(0)}ms`, req.user?.username ? { user: req.user.username } : undefined);
    });
  });
  requestContext.run({ requestId }, next);
}

module.exports = { logger, requestLogger, redact };
