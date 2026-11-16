const { logger } = require('../utils/logger');
const { getPool } = require('../config/db');
const { TABLES } = require('../config/constants');
const { verifyUserToken, passwordVersion } = require('../config/auth');
const {
  normalizeRole,
  parsePermissionsJson,
  getEffectivePermissions,
  hasAnyPermission,
} = require('../services/permissionService');

const PERMISSION_MODE = String(process.env.PERMISSION_MODE || 'enforce').toLowerCase() === 'report' ? 'report' : 'enforce';
if (PERMISSION_MODE === 'report') {
  logger.warn('⚠️ PERMISSION_MODE=report — permission checks only log, they do not block requests.');
}

const CACHE_TTL_MS = 30 * 1000;
const userCache = new Map();

function clearAuthCache(username) {
  if (username) userCache.delete(String(username).toUpperCase());
  else userCache.clear();
}

let defaultPermissions = null;
const getDefaults = () => {
  if (!defaultPermissions) {
    defaultPermissions = require('../controllers/permissionController').DEFAULT_SHEET3_PERMISSIONS;
  }
  return defaultPermissions;
};

async function loadAuthUser(username) {
  const key = String(username || '').toUpperCase();
  const hit = userCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.user;

  const pool = await getPool();
  const result = await pool.request()
    .input('username', key)
    .query(`
      SELECT u.username, u.role_id, u.name_th, u.password_hash, u.mfa_secret_enc, u.mfa_enabled,
             ISNULL(u.is_active, 0) AS is_active, r.permissions_json
      FROM [${TABLES.USER}] u
      LEFT JOIN ${TABLES.ROLE_PERMISSION} r ON u.role_id = r.role_id
      WHERE UPPER(u.username) = @username
    `);
  const row = result.recordset?.[0];
  const user = row ? {
    username: String(row.username).toUpperCase(),
    roleId: row.role_id,
    nameTh: row.name_th,
    passwordHash: row.password_hash,
    mfaSecretEnc: row.mfa_secret_enc,
    mfaEnabled: Boolean(row.mfa_enabled),
    isActive: Boolean(row.is_active),
    effective: getEffectivePermissions(row.role_id, parsePermissionsJson(row.permissions_json), getDefaults()),
  } : null;
  userCache.set(key, { user, at: Date.now() });
  return user;
}

const authError = (code, message) => { const e = new Error(message); e.code = code; return e; };

// ตรวจ token ตามชนิดที่ต้องการ: 'access' (ใช้งานจริง ผ่าน MFA แล้ว) หรือ 'mfa_pending' (รอยืนยัน MFA)
async function resolveTokenOfType(token, expectedType) {
  if (!token) throw authError('AUTH_REQUIRED', 'Authentication required');
  const payload = verifyUserToken(token);
  if (payload.typ !== expectedType || (expectedType === 'access' && payload.mfa !== true)) {
    throw authError('TOKEN_INVALID', 'Wrong token type');
  }
  const user = await loadAuthUser(payload.sub);
  if (!user) throw authError('USER_NOT_FOUND', 'User no longer exists');
  // token ใช้งานจริงผูกกับทั้งรหัสผ่านและ MFA; token รอยืนยันผูกกับรหัสผ่านอย่างเดียว
  // (ตอนตั้งค่า MFA secret จะเปลี่ยนระหว่างขั้น setup กับ verify)
  const expectedPv = expectedType === 'access'
    ? passwordVersion(user.passwordHash, user.mfaSecretEnc)
    : passwordVersion(user.passwordHash);
  if (!user.passwordHash || expectedPv !== payload.pv) {
    throw authError('TOKEN_REVOKED', 'Password or MFA changed — please log in again');
  }
  if (!user.isActive) throw authError('ACCOUNT_DISABLED', 'Account is disabled');
  return user;
}

const resolveToken = (token) => resolveTokenOfType(token, 'access');
const resolveMfaPendingToken = (token) => resolveTokenOfType(token, 'mfa_pending');

const AUTH_MESSAGES = {
  AUTH_REQUIRED: 'กรุณาเข้าสู่ระบบ',
  TOKEN_EXPIRED: 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่',
  TOKEN_INVALID: 'เซสชันไม่ถูกต้อง กรุณาเข้าสู่ระบบใหม่',
  TOKEN_REVOKED: 'รหัสผ่านหรือ MFA ถูกเปลี่ยน กรุณาเข้าสู่ระบบใหม่',
  ACCOUNT_DISABLED: 'บัญชีถูกปิดใช้งาน กรุณาติดต่อผู้ดูแลระบบ',
  USER_NOT_FOUND: 'ไม่พบบัญชีผู้ใช้งานนี้แล้ว กรุณาติดต่อผู้ดูแลระบบ',
};

async function authenticate(req, res, next) {
  const match = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  try {
    const user = await resolveToken(match ? match[1].trim() : null);
    req.user = { username: user.username, roleId: user.roleId, nameTh: user.nameTh, effective: user.effective };
    return next();
  } catch (err) {
    if (AUTH_MESSAGES[err.code]) {
      return res.status(401).json({ success: false, code: err.code, message: AUTH_MESSAGES[err.code] });
    }
    logger.error('Authentication check failed:', err.message);
    return res.status(503).json({ success: false, code: 'AUTH_UNAVAILABLE', message: 'ไม่สามารถตรวจสอบการเข้าสู่ระบบได้ในขณะนี้' });
  }
}

function denyOrReport(req, res, next, detail) {
  logger.warn(`🚫 Permission ${PERMISSION_MODE === 'report' ? 'WOULD BE denied' : 'denied'}: ${req.user?.username} (${req.user?.roleId}) ${req.method} ${req.originalUrl} — ${detail}`);
  if (PERMISSION_MODE === 'report') return next();
  return res.status(403).json({ success: false, code: 'FORBIDDEN', message: 'คุณไม่มีสิทธิ์ทำรายการนี้' });
}

const requirePermission = (...keys) => (req, res, next) => {
  if (hasAnyPermission(req.user?.effective, keys)) return next();
  return denyOrReport(req, res, next, `needs any of [${keys.join(', ')}]`);
};

const requireSelfOrPermission = (...keys) => (req, res, next) => {
  const target = String(req.params.username || '').trim().toUpperCase();
  if (target && target === req.user?.username) return next();
  return requirePermission(...keys)(req, res, next);
};

async function protectAdminSystemAccounts(req, res, next) {
  if (req.user?.effective?.isAdminSystem) return next();
  try {
    if (normalizeRole(req.body?.role_id) === 'ADMIN_SYSTEM') {
      return denyOrReport(req, res, next, 'only ADMIN_SYSTEM can assign the ADMIN_SYSTEM role');
    }
    const target = String(req.params.username || '').trim().toUpperCase();
    if (target) {
      const targetUser = await loadAuthUser(target);
      if (targetUser && normalizeRole(targetUser.roleId) === 'ADMIN_SYSTEM') {
        return denyOrReport(req, res, next, 'only ADMIN_SYSTEM can change an ADMIN_SYSTEM account');
      }
    }
    return next();
  } catch (err) {
    logger.error('protectAdminSystemAccounts failed:', err.message);
    return res.status(503).json({ success: false, code: 'AUTH_UNAVAILABLE', message: 'ไม่สามารถตรวจสอบสิทธิ์ได้ในขณะนี้' });
  }
}

async function authenticateSocket(socket, next) {
  try {
    const user = await resolveToken(socket.handshake?.auth?.token);
    socket.data.user = { username: user.username, roleId: user.roleId };
    return next();
  } catch (err) {
    const e = new Error(AUTH_MESSAGES[err.code] ? err.code : 'AUTH_UNAVAILABLE');
    e.data = { code: err.code || 'AUTH_UNAVAILABLE' };
    return next(e);
  }
}

module.exports = {
  authenticate,
  authenticateSocket,
  requirePermission,
  requireSelfOrPermission,
  protectAdminSystemAccounts,
  clearAuthCache,
  loadAuthUser,
  resolveMfaPendingToken,
  AUTH_MESSAGES,
  PERMISSION_MODE,
};
