const { logger } = require('../utils/logger');
const { getSetting } = require('../services/settingsService');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getPool } = require('../config/db');
const { TABLES } = require('../config/constants');
const { signUserToken, signMfaPendingToken, getTokenExpiry } = require('../config/auth');
const { resolveMfaPendingToken, clearAuthCache } = require('../middleware/auth');
const mfaService = require('../services/mfaService');
const MFA_CONFIG = require('../config/mfa');
const { ensureTransactionLogTable } = require('./auditLogController');
const { sendMail, isMailConfigured } = require('../services/mailService');
const LOCKOUT = require('../config/lockout');

function hashPassword(password) {
  if (!password || typeof password !== 'string') return null;
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

const pbkdf2Async = (password, salt) => new Promise((resolve, reject) => {
  crypto.pbkdf2(password, salt, 100000, 64, 'sha512', (err, key) => (err ? reject(err) : resolve(key)));
});

async function hashPasswordAsync(password) {
  if (!password || typeof password !== 'string') return null;
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = (await pbkdf2Async(password, salt)).toString('hex');
  return `${salt}:${hash}`;
}

async function verifyPasswordAsync(password, storedHash) {
  if (!password || !storedHash || typeof storedHash !== 'string' || !storedHash.includes(':')) {
    return false;
  }
  try {
    const [salt, originalHash] = storedHash.split(':');
    const hash = await pbkdf2Async(password, salt);
    const original = Buffer.from(originalHash, 'hex');
    return original.length === hash.length && crypto.timingSafeEqual(hash, original);
  } catch {
    return false;
  }
}

const DUMMY_HASH = `${'0'.repeat(32)}:${'0'.repeat(128)}`;

const PASSWORD_MIN_LENGTH = Math.max(8, Number(process.env.PASSWORD_MIN_LENGTH) || 8);

function validateNewPassword(password, { isNew = true } = {}) {
  const prefix = isNew ? 'รหัสผ่าน' : 'รหัสผ่านใหม่';
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `${prefix}ต้องมีความยาวอย่างน้อย ${PASSWORD_MIN_LENGTH} ตัวอักษร`;
  }
  if (password !== password.trim()) {
    return `${prefix}ต้องไม่ขึ้นต้นหรือลงท้ายด้วยช่องว่าง`;
  }
  if (!/[A-Z]/.test(password)) {
    return `${prefix}ต้องมีตัวพิมพ์ใหญ่ (A-Z) อย่างน้อย 1 ตัว`;
  }
  if (!/[a-z]/.test(password)) {
    return `${prefix}ต้องมีตัวพิมพ์เล็ก (a-z) อย่างน้อย 1 ตัว`;
  }
  if (!/[!-/:-@[-`{-~]/.test(password)) {
    return `${prefix}ต้องมีอักขระพิเศษ เช่น ! @ # $ % อย่างน้อย 1 ตัว`;
  }
  return null;
}

const INVALID_LOGIN_MESSAGE = 'รหัสพนักงานหรือรหัสผ่านไม่ถูกต้อง';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const normalizeEmail = (value) => String(value || '').trim().toLowerCase();
const isValidEmail = (email) => email.length <= 255 && EMAIL_PATTERN.test(email);

async function isEmailTaken(pool, email, exceptUsername = '') {
  const r = await pool.request()
    .input('email', email)
    .input('except', exceptUsername)
    .query(`SELECT 1 FROM [${TABLES.USER}] WHERE LOWER(email) = @email AND UPPER(username) <> @except`);
  return Boolean(r.recordset && r.recordset.length > 0);
}

function verifyPassword(password, storedHash) {
  if (!password || !storedHash || typeof storedHash !== 'string' || !storedHash.includes(':')) {
    return false;
  }
  try {
    const [salt, originalHash] = storedHash.split(':');
    const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(originalHash, 'hex'));
  } catch (err) {
    return false;
  }
}

// ฝ่ายของผู้ใช้: DX (ผู้ดูแลระบบ) / WANTHAI / YUSEN — ไม่ระบุฝ่าย ให้เดาจาก role
const USER_GROUPS = ['DX', 'WANTHAI', 'YUSEN'];
const DX_ROLE_SQL_LIST = "('ADMIN_SYSTEM', 'DX')";

function normalizeUserGroup(group, roleId = '') {
  let g = String(group || '').trim().toUpperCase();
  if (g === 'WAREHOUSE') g = 'WANTHAI';
  if (USER_GROUPS.includes(g)) return g;
  const r = String(roleId || '').trim().toUpperCase();
  if (r === 'ADMIN_SYSTEM' || r === 'DX') return 'DX';
  if (r.includes('YUSEN') || r === 'CAR_REGISTER' || r === 'TRUCKER' || r === 'TRUCK') {
    return 'YUSEN';
  }
  return 'WANTHAI';
}

async function hasUserGroupColumn(pool) {
  try {
    const r = await pool.request().query(`
      SELECT COUNT(*) AS total FROM sys.columns
      WHERE object_id = OBJECT_ID('${TABLES.USER}') AND name = 'user_group'
    `);
    return Number(r.recordset?.[0]?.total) > 0;
  } catch {
    return false;
  }
}

function getUserGroupSelectSql(hasGroupCol) {
  const fallbackSql = `CASE WHEN UPPER(u.role_id) IN ${DX_ROLE_SQL_LIST} THEN 'DX' WHEN UPPER(u.role_id) LIKE '%YUSEN%' OR UPPER(u.role_id) IN ('CAR_REGISTER', 'TRUCKER', 'TRUCK') THEN 'YUSEN' ELSE 'WANTHAI' END`;
  return hasGroupCol
    ? `COALESCE(u.user_group, ${fallbackSql}) AS user_group,`
    : `${fallbackSql} AS user_group,`;
}

async function ensureUserGroupColumn(pool) {
  const T = TABLES.USER;

  await pool.request().query(`
    IF OBJECT_ID('${T}') IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('${T}') AND name = 'user_group'
    )
    BEGIN
      ALTER TABLE [${T}] ADD user_group VARCHAR(20) NULL;
    END
  `);

  await pool.request().query(`
    UPDATE [${T}]
    SET user_group = CASE
      WHEN UPPER(role_id) IN ${DX_ROLE_SQL_LIST} THEN 'DX'
      WHEN UPPER(role_id) LIKE '%YUSEN%' OR UPPER(role_id) IN ('CAR_REGISTER', 'TRUCKER', 'TRUCK') THEN 'YUSEN'
      ELSE 'WANTHAI'
    END
    WHERE user_group IS NULL
       OR user_group NOT IN ('DX', 'WANTHAI', 'YUSEN');
  `);

  await pool.request().query(`
    IF EXISTS (
      SELECT 1 FROM sys.columns
      WHERE object_id = OBJECT_ID('${T}') AND name = 'user_group' AND is_nullable = 1
    )
    BEGIN
      ALTER TABLE [${T}] ALTER COLUMN user_group VARCHAR(20) NOT NULL;
    END

    IF NOT EXISTS (SELECT 1 FROM sys.default_constraints WHERE name = 'DF_User_user_group')
    BEGIN
      ALTER TABLE [${T}] ADD CONSTRAINT DF_User_user_group DEFAULT 'WANTHAI' FOR user_group;
    END

    -- ฝ่าย DX: สร้าง constraint ใหม่ที่รู้จัก DX (ครั้งเดียว) และย้ายผู้ดูแลระบบเดิมที่อยู่ฝ่าย WANTHAI ไปเป็น DX
    -- รันเฉพาะตอนที่ constraint ยังไม่รู้จัก DX — ภายหลังถ้าแอดมินตั้งฝ่ายเองจะไม่ถูกเขียนทับ
    IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_User_user_group' AND definition LIKE '%DX%')
    BEGIN
      IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_User_user_group')
        ALTER TABLE [${T}] DROP CONSTRAINT CK_User_user_group;
      UPDATE [${T}] SET user_group = 'DX' WHERE UPPER(role_id) IN ${DX_ROLE_SQL_LIST} AND user_group = 'WANTHAI';
      ALTER TABLE [${T}] ADD CONSTRAINT CK_User_user_group
        CHECK (user_group IN ('DX', 'WANTHAI', 'YUSEN'));
    END
  `);
}

async function ensureUserTable() {
  try {
    const pool = await getPool();
    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = '${TABLES.USER}')
      BEGIN
        CREATE TABLE [${TABLES.USER}] (
          username NVARCHAR(50) NOT NULL PRIMARY KEY,
          role_id VARCHAR(50) NOT NULL,
          user_group VARCHAR(20) NOT NULL DEFAULT 'WANTHAI',
          name_th NVARCHAR(150) NULL,
          name_en NVARCHAR(150) NULL,
          email NVARCHAR(255) NULL,
          password_hash NVARCHAR(255) NULL,
          reset_token_hash NVARCHAR(64) NULL,
          reset_token_expires DATETIME NULL,
          failed_login_count INT NOT NULL CONSTRAINT DF_User_failed_login_count DEFAULT 0,
          lockout_until DATETIME NULL,
          is_active BIT NOT NULL CONSTRAINT DF_User_is_active DEFAULT 0,
          reset_token_purpose NVARCHAR(20) NULL,
          mfa_secret_enc NVARCHAR(255) NULL,
          mfa_enabled BIT NOT NULL CONSTRAINT DF_User_mfa_enabled DEFAULT 0,
          mfa_last_step BIGINT NULL,
          mfa_failed_count INT NOT NULL CONSTRAINT DF_User_mfa_failed_count DEFAULT 0,
          mfa_lockout_until DATETIME NULL,
          created_at DATETIME DEFAULT GETDATE(),
          updated_at DATETIME DEFAULT GETDATE(),
          CONSTRAINT FK_User_RolePermission
          FOREIGN KEY (role_id) REFERENCES ${TABLES.ROLE_PERMISSION}(role_id)
          ON UPDATE CASCADE
        );
      END
      ELSE
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_NAME = '${TABLES.USER}' AND COLUMN_NAME = 'name_th'
        )
        BEGIN
          ALTER TABLE [${TABLES.USER}] ADD name_th NVARCHAR(150) NULL;
        END

        IF NOT EXISTS (
          SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_NAME = '${TABLES.USER}' AND COLUMN_NAME = 'name_en'
        )
        BEGIN
          ALTER TABLE [${TABLES.USER}] ADD name_en NVARCHAR(150) NULL;
        END

        IF NOT EXISTS (
          SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_NAME = '${TABLES.USER}' AND COLUMN_NAME = 'password_hash'
        )
        BEGIN
          ALTER TABLE [${TABLES.USER}] ADD password_hash NVARCHAR(255) NULL;
        END

        IF NOT EXISTS (
          SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_NAME = '${TABLES.USER}' AND COLUMN_NAME = 'created_at'
        )
        BEGIN
          ALTER TABLE [${TABLES.USER}] ADD created_at DATETIME DEFAULT GETDATE();
        END

        IF NOT EXISTS (
          SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_NAME = '${TABLES.USER}' AND COLUMN_NAME = 'updated_at'
        )
        BEGIN
          ALTER TABLE [${TABLES.USER}] ADD updated_at DATETIME DEFAULT GETDATE();
        END

        IF NOT EXISTS (
          SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_NAME = '${TABLES.USER}' AND COLUMN_NAME = 'email'
        )
        BEGIN
          ALTER TABLE [${TABLES.USER}] ADD email NVARCHAR(255) NULL;
        END
        ELSE IF EXISTS (
          SELECT 1 FROM sys.columns
          WHERE object_id = OBJECT_ID('${TABLES.USER}') AND name = 'email'
            AND (TYPE_NAME(user_type_id) <> 'nvarchar' OR (max_length <> -1 AND max_length < 510))
        )
        BEGIN
          ALTER TABLE [${TABLES.USER}] ALTER COLUMN email NVARCHAR(255) NULL;
        END

        IF NOT EXISTS (
          SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_NAME = '${TABLES.USER}' AND COLUMN_NAME = 'reset_token_hash'
        )
        BEGIN
          ALTER TABLE [${TABLES.USER}] ADD reset_token_hash NVARCHAR(64) NULL;
        END

        IF NOT EXISTS (
          SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_NAME = '${TABLES.USER}' AND COLUMN_NAME = 'reset_token_expires'
        )
        BEGIN
          ALTER TABLE [${TABLES.USER}] ADD reset_token_expires DATETIME NULL;
        END

        IF NOT EXISTS (
          SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_NAME = '${TABLES.USER}' AND COLUMN_NAME = 'failed_login_count'
        )
        BEGIN
          ALTER TABLE [${TABLES.USER}] ADD failed_login_count INT NOT NULL
            CONSTRAINT DF_User_failed_login_count DEFAULT 0;
        END

        IF NOT EXISTS (
          SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_NAME = '${TABLES.USER}' AND COLUMN_NAME = 'lockout_until'
        )
        BEGIN
          ALTER TABLE [${TABLES.USER}] ADD lockout_until DATETIME NULL;
        END

        -- บัญชีที่มีอยู่ก่อนเพิ่มคอลัมน์นี้ถือว่าเปิดใช้งานอยู่แล้ว ส่วนบัญชีใหม่เริ่มที่ปิดใช้งาน
        IF NOT EXISTS (
          SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_NAME = '${TABLES.USER}' AND COLUMN_NAME = 'is_active'
        )
        BEGIN
          ALTER TABLE [${TABLES.USER}] ADD is_active BIT NOT NULL CONSTRAINT DF_User_is_active DEFAULT 0;
          EXEC('UPDATE [${TABLES.USER}] SET is_active = 1');
        END

        IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = '${TABLES.USER}' AND COLUMN_NAME = 'reset_token_purpose')
          ALTER TABLE [${TABLES.USER}] ADD reset_token_purpose NVARCHAR(20) NULL;
        IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = '${TABLES.USER}' AND COLUMN_NAME = 'mfa_secret_enc')
          ALTER TABLE [${TABLES.USER}] ADD mfa_secret_enc NVARCHAR(255) NULL;
        IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = '${TABLES.USER}' AND COLUMN_NAME = 'mfa_enabled')
          ALTER TABLE [${TABLES.USER}] ADD mfa_enabled BIT NOT NULL CONSTRAINT DF_User_mfa_enabled DEFAULT 0;
        IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = '${TABLES.USER}' AND COLUMN_NAME = 'mfa_last_step')
          ALTER TABLE [${TABLES.USER}] ADD mfa_last_step BIGINT NULL;
        IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = '${TABLES.USER}' AND COLUMN_NAME = 'mfa_failed_count')
          ALTER TABLE [${TABLES.USER}] ADD mfa_failed_count INT NOT NULL CONSTRAINT DF_User_mfa_failed_count DEFAULT 0;
        IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = '${TABLES.USER}' AND COLUMN_NAME = 'mfa_lockout_until')
          ALTER TABLE [${TABLES.USER}] ADD mfa_lockout_until DATETIME NULL;
      END
    `);

    try {
      await ensureUserGroupColumn(pool);
    } catch (colErr) {
      logger.warn('⚠️ Cannot add User.user_group (will derive from role_id):', colErr.message);
    }
  } catch (err) {
    logger.error('⚠️ ensureUserTable error:', err.message);
  }
}

async function getUsers(req, res) {
  try {
    await ensureUserTable();
    const pool = await getPool();
    const hasGroupCol = await hasUserGroupColumn(pool);
    const groupSelect = getUserGroupSelectSql(hasGroupCol);
    const result = await pool.request().query(`
      SELECT
        u.username,
        u.role_id,
        ${groupSelect}
        u.name_th,
        u.name_en,
        u.email,
        CAST(ISNULL(u.is_active, 0) AS BIT) AS is_active,
        CAST(ISNULL(u.mfa_enabled, 0) AS BIT) AS mfa_enabled,
        CAST(CASE WHEN u.reset_token_purpose IN ('ACTIVATE', 'ACTIVATE_MFA', 'MFA_SETUP')
                   AND u.reset_token_expires > GETDATE() THEN 1 ELSE 0 END AS BIT) AS setup_link_pending,
        COALESCE(r.role_name, u.role_id) AS role_name,
        COALESCE(r.action_name, N'Truck Plan') AS action_name,
        COALESCE(r.view_mode, 'PC') AS view_mode,
        u.created_at,
        u.updated_at
      FROM [${TABLES.USER}] u
      LEFT JOIN ${TABLES.ROLE_PERMISSION} r ON u.role_id = r.role_id
      ORDER BY u.username ASC
    `);

    return res.json({ success: true, data: result.recordset || [] });
  } catch (err) {
    logger.error('Database error fetching users:', err.message);
    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการดึงข้อมูลผู้ใช้งานจากฐานข้อมูล', error: err.message });
  }
}

// GET /api/users/directory — รายชื่อสำหรับแสดง "อัปเดตโดย" (ทุกคนที่ login ใช้ได้)
// ส่งเฉพาะรหัสพนักงาน ชื่อ และชื่อตำแหน่ง — ไม่ส่งอีเมล / สถานะบัญชี / ข้อมูลอื่น
async function getUserDirectory(req, res) {
  try {
    const pool = await getPool();
    const result = await pool.request().query(`
      SELECT u.username, u.name_th, u.name_en, COALESCE(r.role_name, u.role_id) AS role_name
      FROM [${TABLES.USER}] u
      LEFT JOIN ${TABLES.ROLE_PERMISSION} r ON u.role_id = r.role_id
    `);
    const data = (result.recordset || []).map((row) => ({
      username: row.username,
      name: row.name_th || row.name_en || '',
      roleName: row.role_name || '',
    }));
    return res.json({ success: true, data });
  } catch (err) {
    logger.error('Database error fetching user directory:', err.message);
    return res.status(500).json({ success: false, message: 'ดึงรายชื่อผู้ใช้งานไม่สำเร็จ' });
  }
}

async function getUserByUsername(req, res) {
  const cleanUsername = String(req.params.username || '').trim().toUpperCase();
  if (!cleanUsername) {
    return res.status(400).json({ success: false, message: 'กรุณากรอกรหัสพนักงาน' });
  }

  try {
    await ensureUserTable();
    const pool = await getPool();
    const hasGroupCol = await hasUserGroupColumn(pool);
    const groupSelect = getUserGroupSelectSql(hasGroupCol);
    const result = await pool.request()
      .input('username', cleanUsername)
      .query(`
        SELECT
          u.username,
          u.role_id,
          ${groupSelect}
          u.name_th,
          u.name_en,
          u.email,
          COALESCE(r.role_name, u.role_id) AS role_name,
          COALESCE(r.action_name, N'Truck Plan') AS action_name,
          COALESCE(r.view_mode, 'PC') AS view_mode,
          r.permissions_json,
          CASE WHEN u.password_hash IS NOT NULL AND LEN(u.password_hash) > 0 THEN 1 ELSE 0 END AS has_password
        FROM [${TABLES.USER}] u
        LEFT JOIN ${TABLES.ROLE_PERMISSION} r ON u.role_id = r.role_id
        WHERE UPPER(u.username) = @username
      `);

    if (result.recordset && result.recordset.length > 0) {
      return res.json({ success: true, data: result.recordset[0] });
    }

    return res.status(404).json({ success: false, message: `ไม่พบรหัสพนักงาน ${cleanUsername} ในระบบ` });
  } catch (err) {
    logger.error('Database error fetching user by username:', err.message);
    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการตรวจสอบรหัสพนักงาน', error: err.message });
  }
}

async function createUser(req, res) {
  const { username, role_id, user_group, name_th, name_en, email, password, confirm_password } = req.body;
  const cleanUsername = String(username || '').trim().toUpperCase();
  const cleanRoleId = String(role_id || '').trim().toUpperCase();
  const cleanUserGroup = normalizeUserGroup(user_group, cleanRoleId);
  const cleanNameTh = String(name_th || '').trim();
  const cleanNameEn = String(name_en || '').trim();
  const cleanEmail = normalizeEmail(email);
  const rawPassword = String(password || '');
  const rawConfirmPassword = confirm_password !== undefined ? String(confirm_password) : rawPassword;

  if (!cleanUsername || !cleanRoleId) {
    return res.status(400).json({ success: false, message: 'กรุณากรอกรหัสพนักงานและเลือกกลุ่มผู้ใช้งาน' });
  }

  if (!cleanNameTh || !cleanNameEn) {
    return res.status(400).json({ success: false, message: 'กรุณากรอกชื่อ-นามสกุลทั้งภาษาไทยและภาษาอังกฤษ' });
  }

  if (!cleanEmail) {
    return res.status(400).json({ success: false, message: 'กรุณากรอกอีเมล' });
  }
  if (!isValidEmail(cleanEmail)) {
    return res.status(400).json({ success: false, message: 'รูปแบบอีเมลไม่ถูกต้อง' });
  }

  if (!rawPassword) {
    return res.status(400).json({ success: false, message: 'กรุณากำหนดรหัสผ่าน' });
  }

  const createPasswordError = validateNewPassword(rawPassword, { isNew: true });
  if (createPasswordError) {
    return res.status(400).json({ success: false, message: createPasswordError });
  }

  if (rawPassword !== rawConfirmPassword) {
    return res.status(400).json({ success: false, message: 'รหัสผ่านและยืนยันรหัสผ่านไม่ตรงกัน' });
  }

  try {
    await ensureUserTable();
    const pool = await getPool();

    const checkDup = await pool.request()
      .input('username', cleanUsername)
      .query(`SELECT 1 FROM [${TABLES.USER}] WHERE UPPER(username) = @username`);

    if (checkDup.recordset && checkDup.recordset.length > 0) {
      return res.status(400).json({ success: false, message: `รหัสพนักงาน ${cleanUsername} มีอยู่ในระบบแล้ว` });
    }

    if (await isEmailTaken(pool, cleanEmail)) {
      return res.status(400).json({ success: false, code: 'EMAIL_TAKEN', message: `อีเมล ${cleanEmail} ถูกใช้กับผู้ใช้งานอื่นแล้ว` });
    }

    const passwordHash = await hashPasswordAsync(rawPassword);
    const hasGroupCol = await hasUserGroupColumn(pool);

    const insertReq = pool.request()
      .input('username', cleanUsername)
      .input('role_id', cleanRoleId)
      .input('name_th', cleanNameTh)
      .input('name_en', cleanNameEn)
      .input('email', cleanEmail)
      .input('password_hash', passwordHash);

    if (hasGroupCol) {
      insertReq.input('user_group', cleanUserGroup);
    }

    await insertReq.query(hasGroupCol ? `
      INSERT INTO [${TABLES.USER}] (username, role_id, user_group, name_th, name_en, email, password_hash, created_at, updated_at)
      VALUES (@username, @role_id, @user_group, @name_th, @name_en, @email, @password_hash, GETDATE(), GETDATE())
    ` : `
      INSERT INTO [${TABLES.USER}] (username, role_id, name_th, name_en, email, password_hash, created_at, updated_at)
      VALUES (@username, @role_id, @name_th, @name_en, @email, @password_hash, GETDATE(), GETDATE())
    `);

    const newUser = {
      username: cleanUsername,
      role_id: cleanRoleId,
      user_group: cleanUserGroup,
      name_th: cleanNameTh,
      name_en: cleanNameEn,
      email: cleanEmail,
    };
    return res.json({ success: true, message: 'เพิ่มผู้ใช้งานเรียบร้อยแล้ว', data: newUser });
  } catch (err) {
    logger.error('Database error creating user:', err.message);
    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการบันทึกผู้ใช้งานลงฐานข้อมูล', error: err.message });
  }
}

async function updateUser(req, res) {
  const targetUsername = String(req.params.username || req.body.username || '').trim().toUpperCase();
  const cleanRoleId = String(req.body.role_id || '').trim().toUpperCase();
  const cleanNameTh = req.body.name_th !== undefined ? String(req.body.name_th).trim() : undefined;
  const cleanNameEn = req.body.name_en !== undefined ? String(req.body.name_en).trim() : undefined;
  const cleanEmail = req.body.email !== undefined ? normalizeEmail(req.body.email) : undefined;
  const rawPassword = req.body.password ? String(req.body.password) : null;
  const rawConfirmPassword = req.body.confirm_password ? String(req.body.confirm_password) : rawPassword;

  if (!targetUsername) {
    return res.status(400).json({ success: false, message: 'กรุณาระบุรหัสพนักงาน' });
  }

  if (cleanEmail !== undefined) {
    if (!cleanEmail) {
      return res.status(400).json({ success: false, message: 'กรุณากรอกอีเมล' });
    }
    if (!isValidEmail(cleanEmail)) {
      return res.status(400).json({ success: false, message: 'รูปแบบอีเมลไม่ถูกต้อง' });
    }
  }

  if (rawPassword) {
    const updatePasswordError = validateNewPassword(rawPassword, { isNew: false });
    if (updatePasswordError) {
      return res.status(400).json({ success: false, message: updatePasswordError });
    }
    if (rawPassword !== rawConfirmPassword) {
      return res.status(400).json({ success: false, message: 'รหัสผ่านและยืนยันรหัสผ่านไม่ตรงกัน' });
    }
  }

  try {
    await ensureUserTable();
    const pool = await getPool();
    const hasGroupCol = await hasUserGroupColumn(pool);

    const existing = await pool.request()
      .input('username', targetUsername)
      .query(`SELECT username, role_id, ${hasGroupCol ? 'user_group, ' : ''}name_th, name_en, email FROM [${TABLES.USER}] WHERE UPPER(username) = @username`);

    if (!existing.recordset || existing.recordset.length === 0) {
      return res.status(404).json({ success: false, message: `ไม่พบรหัสพนักงาน ${targetUsername}` });
    }

    if (cleanEmail && await isEmailTaken(pool, cleanEmail, targetUsername)) {
      return res.status(400).json({ success: false, code: 'EMAIL_TAKEN', message: `อีเมล ${cleanEmail} ถูกใช้กับผู้ใช้งานอื่นแล้ว` });
    }

    const current = existing.recordset[0];
    const emailToSave = cleanEmail !== undefined ? cleanEmail : (current.email || null);
    const roleToSave = cleanRoleId || current.role_id;
    const userGroupToSave = req.body.user_group !== undefined
      ? normalizeUserGroup(req.body.user_group, roleToSave)
      : (cleanRoleId && cleanRoleId !== current.role_id
        ? normalizeUserGroup(null, roleToSave)
        : normalizeUserGroup(current.user_group, roleToSave));
    const nameThToSave = cleanNameTh !== undefined ? (cleanNameTh || null) : current.name_th;
    const nameEnToSave = cleanNameEn !== undefined ? (cleanNameEn || null) : current.name_en;
    const passwordHash = rawPassword ? await hashPasswordAsync(rawPassword) : null;

    let query = `
      UPDATE [${TABLES.USER}]
      SET role_id = @role_id,
          ${hasGroupCol ? 'user_group = @user_group,' : ''}
          name_th = @name_th,
          name_en = @name_en,
          email = @email,
          updated_at = GETDATE()
    `;
    if (passwordHash) {
      query += `, password_hash = @password_hash`;
    }
    query += ` WHERE UPPER(username) = @username`;

    const request = pool.request()
      .input('username', targetUsername)
      .input('role_id', roleToSave)
      .input('name_th', nameThToSave)
      .input('name_en', nameEnToSave)
      .input('email', emailToSave);

    if (hasGroupCol) {
      request.input('user_group', userGroupToSave);
    }

    if (passwordHash) {
      request.input('password_hash', passwordHash);
    }

    await request.query(query);

    return res.json({
      success: true,
      message: 'แก้ไขข้อมูลผู้ใช้งานเรียบร้อยแล้ว',
      data: {
        username: targetUsername,
        role_id: roleToSave,
        user_group: userGroupToSave,
        name_th: nameThToSave,
        name_en: nameEnToSave,
        email: emailToSave,
      }
    });
  } catch (err) {
    logger.error('Database error updating user:', err.message);
    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการอัปเดตผู้ใช้งานในฐานข้อมูล', error: err.message });
  }
}

async function deleteUser(req, res) {
  const cleanUsername = String(req.params.username || '').trim().toUpperCase();
  if (!cleanUsername) {
    return res.status(400).json({ success: false, message: 'กรุณาระบุรหัสพนักงานที่ต้องการลบ' });
  }

  try {
    await ensureUserTable();
    const pool = await getPool();

    const deleteResult = await pool.request()
      .input('username', cleanUsername)
      .query(`DELETE FROM [${TABLES.USER}] WHERE UPPER(username) = @username`);

    const deleted = (deleteResult.rowsAffected || []).reduce((a, b) => a + b, 0);
    if (deleted === 0) {
      return res.status(404).json({ success: false, code: 'USER_NOT_FOUND', message: `ไม่พบรหัสพนักงาน ${cleanUsername}` });
    }

    return res.json({ success: true, message: 'ลบผู้ใช้งานเรียบร้อยแล้ว' });
  } catch (err) {
    logger.error('Database error deleting user:', err.message);
    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการลบผู้ใช้งานจากฐานข้อมูล', error: err.message });
  }
}

// ข้อมูลสถานะล็อค คำนวณจากเวลา DB (GETDATE()) เท่านั้น
// จัดรูปแบบเวลาใน SQL เพราะ mssql อ่าน DATETIME เป็น UTC ถ้าแปลงใน JS เวลาจะเพี้ยน
const lockInfoSql = (col) => `
  CASE WHEN ${col} > GETDATE() THEN 1 ELSE 0 END AS is_locked,
  DATEDIFF(SECOND, GETDATE(), ${col}) AS lock_seconds_left,
  CONVERT(varchar(10), ${col}, 103) + ' ' + CONVERT(varchar(5), ${col}, 108) AS lockout_until_text`;

const NOT_LOCKED_SQL = '(lockout_until IS NULL OR lockout_until <= GETDATE())';

function sendAccountLocked(res, row) {
  const secondsLeft = Math.max(1, Number(row.lock_seconds_left) || 0);
  const minutesLeft = Math.max(1, Math.ceil(secondsLeft / 60));
  res.set('Retry-After', String(secondsLeft));
  return res.status(423).json({
    success: false,
    code: 'ACCOUNT_LOCKED',
    message: `บัญชีถูกล็อคชั่วคราวเนื่องจากกรอกรหัสผ่านผิดครบ ${LOCKOUT.MAX_FAILS} ครั้ง จะปลดล็อคเวลา ${row.lockout_until_text} น. (อีกประมาณ ${minutesLeft} นาที)`,
    lockedUntil: row.lockout_until_text,
    retryAfterSeconds: secondsLeft,
  });
}

async function getLockInfo(pool, username) {
  const r = await pool.request()
    .input('username', username)
    .query(`SELECT ${lockInfoSql('lockout_until')} FROM [${TABLES.USER}] WHERE UPPER(username) = @username`);
  return r.recordset?.[0] || null;
}

// บวกตัวนับใน UPDATE เดียว (atomic) — ถ้าล็อคหมดอายุแล้วให้เริ่มนับ 1 ใหม่
// ไม่อัปเดตถ้ายังล็อคอยู่ (คืน null = ถูก request อื่นล็อคไปก่อนแล้ว)
async function registerFailedLogin(pool, username) {
  const nextCount = `CASE WHEN lockout_until IS NOT NULL AND lockout_until <= GETDATE()
                          THEN 1 ELSE failed_login_count + 1 END`;
  const r = await pool.request()
    .input('username', username)
    .input('max', LOCKOUT.MAX_FAILS)
    .input('mins', LOCKOUT.LOCK_MINUTES)
    .query(`
      UPDATE [${TABLES.USER}]
      SET failed_login_count = ${nextCount},
          lockout_until = CASE WHEN ${nextCount} >= @max
                               THEN DATEADD(MINUTE, @mins, GETDATE()) ELSE NULL END
      OUTPUT inserted.failed_login_count, ${lockInfoSql('inserted.lockout_until')}
      WHERE UPPER(username) = @username AND ${NOT_LOCKED_SQL}
    `);
  return r.recordset?.[0] || null;
}

// รีเซ็ตตัวนับเมื่อกรอกถูก — คืน false ถ้าบัญชีถูกล็อคระหว่างตรวจรหัสผ่าน
async function clearFailedLogins(pool, username) {
  const r = await pool.request()
    .input('username', username)
    .query(`
      UPDATE [${TABLES.USER}]
      SET failed_login_count = 0, lockout_until = NULL
      WHERE UPPER(username) = @username AND ${NOT_LOCKED_SQL}
    `);
  return (r.rowsAffected || []).reduce((a, b) => a + b, 0) > 0;
}

// ข้อมูลผู้ใช้สำหรับ login (ใช้ทั้งขั้นรหัสผ่านและขั้นยืนยัน MFA)
async function selectLoginUser(pool, username) {
  const hasGroupCol = await hasUserGroupColumn(pool);
  const groupSelect = getUserGroupSelectSql(hasGroupCol);
  const result = await pool.request()
    .input('username', username)
    .query(`
      SELECT
        u.username,
        u.role_id,
        ${groupSelect}
        u.name_th,
        u.name_en,
        u.password_hash,
        u.mfa_secret_enc,
        u.mfa_enabled,
        ISNULL(u.is_active, 0) AS is_active,
        CASE WHEN u.reset_token_purpose IN ('ACTIVATE', 'ACTIVATE_MFA', 'MFA_SETUP')
              AND u.reset_token_expires > GETDATE() THEN 1 ELSE 0 END AS setup_link_pending,
        COALESCE(r.role_name, u.role_id) AS role_name,
        COALESCE(r.action_name, N'Truck Plan') AS action_name,
        COALESCE(r.view_mode, 'PC') AS view_mode,
        r.permissions_json,
        ${lockInfoSql('u.lockout_until')}
      FROM [${TABLES.USER}] u
      LEFT JOIN ${TABLES.ROLE_PERMISSION} r ON u.role_id = r.role_id
      WHERE UPPER(u.username) = @username
    `);
  return result.recordset?.[0] || null;
}

const SENSITIVE_LOGIN_FIELDS = ['password_hash', 'mfa_secret_enc', 'is_locked', 'lock_seconds_left', 'lockout_until_text', 'setup_link_pending'];

// ออก token ใช้งานจริง — เรียกหลังผ่าน MFA แล้วเท่านั้น
function sendLoginSuccess(res, user) {
  const token = signUserToken({
    username: user.username,
    roleId: user.role_id,
    passwordHash: user.password_hash,
    mfaSecretEnc: user.mfa_secret_enc,
  });
  const data = { ...user, mfa_enabled: Boolean(user.mfa_enabled), is_active: Boolean(user.is_active) };
  SENSITIVE_LOGIN_FIELDS.forEach((k) => delete data[k]);
  return res.json({ success: true, message: 'เข้าสู่ระบบสำเร็จ', data, token, expiresAt: getTokenExpiry(token) });
}

const ACCOUNT_STATUS_MESSAGES = {
  SETUP_VIA_EMAIL: 'กรุณาตั้งค่าบัญชีจากลิงก์ในอีเมลก่อนเข้าสู่ระบบ',
};

async function loginUser(req, res) {
  const cleanUsername = String(req.body.username || req.body.empCode || '').trim().toUpperCase();
  const password = String(req.body.password || '');

  if (!cleanUsername) {
    return res.status(400).json({ success: false, message: 'กรุณากรอกผู้ใช้งาน' });
  }

  if (!password) {
    return res.status(400).json({ success: false, message: 'กรุณากรอกรหัสผ่าน' });
  }

  try {
    await ensureUserTable();
    const pool = await getPool();
    const user = await selectLoginUser(pool, cleanUsername);

    // ไม่มีบัญชี / บัญชีถูกปิด / ยังไม่มีรหัสผ่าน → ตอบเหมือนรหัสผิด และไม่บวก failed_login_count
    // (ยังตอบ 401 จึงนับเข้า limit ต่อ IP ใน loginRateLimit ตามปกติ)
    if (!user || !user.is_active || !user.password_hash) {
      await verifyPasswordAsync(password, DUMMY_HASH);
      return res.status(401).json({ success: false, code: 'INVALID_CREDENTIALS', message: INVALID_LOGIN_MESSAGE });
    }

    // ระหว่างล็อค ไม่ตรวจรหัสผ่านและไม่บวกตัวนับ
    if (user.is_locked) {
      return sendAccountLocked(res, user);
    }

    const isValid = await verifyPasswordAsync(password, user.password_hash);
    if (!isValid) {
      const failed = await registerFailedLogin(pool, cleanUsername);
      if (failed?.is_locked) return sendAccountLocked(res, failed);
      if (!failed) {
        // request อื่นล็อคบัญชีไปก่อนระหว่างตรวจรหัสผ่าน
        const info = await getLockInfo(pool, cleanUsername);
        if (info?.is_locked) return sendAccountLocked(res, info);
      }
      return res.status(401).json({ success: false, code: 'INVALID_CREDENTIALS', message: INVALID_LOGIN_MESSAGE });
    }

    if (!(await clearFailedLogins(pool, cleanUsername))) {
      const info = await getLockInfo(pool, cleanUsername);
      if (info?.is_locked) return sendAccountLocked(res, info);
      return res.status(401).json({ success: false, code: 'INVALID_CREDENTIALS', message: INVALID_LOGIN_MESSAGE });
    }

    if (user.setup_link_pending) {
      return res.status(403).json({ success: false, code: 'SETUP_VIA_EMAIL', message: ACCOUNT_STATUS_MESSAGES.SETUP_VIA_EMAIL });
    }

    // รหัสผ่านถูก — ยังไม่ออก token จริง ต้องผ่าน MFA ก่อน
    const mfaToken = signMfaPendingToken({ username: user.username, passwordHash: user.password_hash });
    return res.json({ success: true, mfa: user.mfa_enabled ? 'VERIFY' : 'SETUP', mfaToken });
  } catch (err) {
    logger.error('Database error logging in:', err.message);
    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการเข้าสู่ระบบ' });
  }
}

// ---------- MFA ตอน login (ใช้ mfaToken จากขั้นรหัสผ่าน ไม่ใช่ token จริง) ----------
const MFA_MESSAGES = {
  SESSION_EXPIRED: 'หมดเวลายืนยันตัวตน กรุณาเข้าสู่ระบบใหม่',
  REQUIRED_CODE: 'กรุณากรอกรหัส 6 หลักจากแอป Authenticator',
  INVALID_CODE: 'รหัส MFA ไม่ถูกต้อง กรุณาลองใหม่',
  NOT_SET: 'บัญชียังไม่ได้ตั้งค่า MFA',
  ALREADY_SET: 'บัญชีนี้ตั้งค่า MFA ไว้แล้ว',
};

function sendMfaLocked(res, lock) {
  const secondsLeft = Math.max(1, Number(lock?.lock_seconds_left) || 0);
  const minutesLeft = Math.max(1, Math.ceil(secondsLeft / 60));
  res.set('Retry-After', String(secondsLeft));
  return res.status(423).json({
    success: false,
    code: 'MFA_LOCKED',
    message: `กรอกรหัส MFA ผิดหลายครั้ง ระบบล็อคชั่วคราว จะปลดล็อคเวลา ${lock?.lockout_until_text || '-'} น. (อีกประมาณ ${minutesLeft} นาที)`,
    lockedUntil: lock?.lockout_until_text || null,
    retryAfterSeconds: secondsLeft,
  });
}

const readMfaToken = (req) => String(req.body?.mfaToken || '').trim();
const EXPECTED_TOKEN_ERRORS = ['AUTH_REQUIRED', 'TOKEN_INVALID', 'TOKEN_EXPIRED', 'TOKEN_REVOKED', 'USER_NOT_FOUND', 'ACCOUNT_DISABLED'];

// ตรวจ mfaToken แล้วคืนผู้ใช้ — ไม่ผ่านจะตอบ 401 ให้แล้ว
async function requireMfaPendingUser(req, res) {
  try {
    return await resolveMfaPendingToken(readMfaToken(req));
  } catch (err) {
    // บัญชีถูกปิดระหว่างทำ MFA ก็ตอบหมดเวลาเหมือนกัน ไม่บอกสถานะบัญชี
    if (!EXPECTED_TOKEN_ERRORS.includes(err.code)) logger.error('MFA token check failed:', err.message);
    res.status(401).json({ success: false, code: 'MFA_SESSION_EXPIRED', message: MFA_MESSAGES.SESSION_EXPIRED });
    return null;
  }
}

async function createSetupResponse(pool, username) {
  const secret = await mfaService.getOrCreatePendingSecret(pool, username);
  clearAuthCache(username);
  const qrDataUrl = await mfaService.buildQrDataUrl(username, secret);
  return { success: true, data: { qrDataUrl, secret, issuer: MFA_CONFIG.MFA_ISSUER, account: username } };
}

async function loginMfaSetup(req, res) {
  const authUser = await requireMfaPendingUser(req, res);
  if (!authUser) return;
  try {
    const pool = await getPool();
    const user = await selectLoginUser(pool, authUser.username);
    if (!user) return res.status(401).json({ success: false, code: 'MFA_SESSION_EXPIRED', message: MFA_MESSAGES.SESSION_EXPIRED });
    if (user.mfa_enabled) return res.status(409).json({ success: false, code: 'MFA_ALREADY_SET', message: MFA_MESSAGES.ALREADY_SET });
    if (user.setup_link_pending) {
      return res.status(403).json({ success: false, code: 'SETUP_VIA_EMAIL', message: ACCOUNT_STATUS_MESSAGES.SETUP_VIA_EMAIL });
    }
    return res.json(await createSetupResponse(pool, user.username));
  } catch (err) {
    logger.error('MFA setup error:', err.message);
    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการตั้งค่า MFA' });
  }
}

async function loginMfaVerify(req, res) {
  const authUser = await requireMfaPendingUser(req, res);
  if (!authUser) return;
  const code = String(req.body?.code || '').trim();
  if (!mfaService.CODE_PATTERN.test(code)) {
    return res.status(400).json({ success: false, code: 'MFA_CODE_REQUIRED', message: MFA_MESSAGES.REQUIRED_CODE });
  }
  try {
    const pool = await getPool();
    const before = await selectLoginUser(pool, authUser.username);
    if (!before) return res.status(401).json({ success: false, code: 'MFA_SESSION_EXPIRED', message: MFA_MESSAGES.SESSION_EXPIRED });
    if (before.setup_link_pending) {
      return res.status(403).json({ success: false, code: 'SETUP_VIA_EMAIL', message: ACCOUNT_STATUS_MESSAGES.SETUP_VIA_EMAIL });
    }

    const result = await mfaService.checkUserCode(pool, authUser.username, code);
    if (result.status === 'NO_SECRET') return res.status(400).json({ success: false, code: 'MFA_NOT_SET', message: MFA_MESSAGES.NOT_SET });
    if (result.status === 'LOCKED') return sendMfaLocked(res, result.lock);
    if (result.status !== 'OK') return res.status(401).json({ success: false, code: 'MFA_INVALID', message: MFA_MESSAGES.INVALID_CODE });

    clearAuthCache(authUser.username);
    const user = await selectLoginUser(pool, authUser.username);
    return sendLoginSuccess(res, user);
  } catch (err) {
    logger.error('MFA verify error:', err.message);
    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการยืนยัน MFA' });
  }
}

// อ่านจาก Setting ทุกครั้งที่ใช้ (แก้ในตารางแล้วมีผลกับลิงก์ที่ออกใหม่)
const resetExpiresMinutes = () => getSetting('PASSWORD_RESET_EXPIRES_MINUTES');
const hashResetToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[ch]));

function getAppPublicUrl() {
  const configured = String(process.env.APP_PUBLIC_URL || '').trim();
  if (configured) return configured.replace(/\/+$/, '');
  const firstOrigin = String(process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).find(Boolean);
  return (firstOrigin || 'http://localhost:5173').replace(/\/+$/, '');
}

const EMAIL_LOGO_PATH = path.join(__dirname, '..', '..', 'assets', 'email-logo.png');
const EMAIL_LOGO_CID = 'lms-logo@wanthai-lms';

const EMAIL_PURPOSE_TEXT = {
  PASSWORD: { title: 'ตั้งรหัสผ่านใหม่', intro: 'ได้ส่งคำขอตั้งรหัสผ่านใหม่สำหรับผู้ใช้งาน', action: 'ตั้งรหัสผ่านใหม่', notice: 'หากคุณไม่ได้ขอตั้งรหัสผ่านใหม่ โปรดแจ้งผู้ดูแลระบบฝ่าย DX' },
  ACTIVATE: { title: 'เปิดใช้งานบัญชี', intro: 'ได้เปิดใช้งานบัญชีสำหรับผู้ใช้งาน', action: 'ตั้งรหัสผ่านและผูก MFA', notice: 'เตรียมโทรศัพท์ที่ติดตั้งแอป Google Authenticator หรือ Microsoft Authenticator ไว้สำหรับสแกน QR' },
  MFA_SETUP: { title: 'ผูก MFA กับโทรศัพท์เครื่องใหม่', intro: 'ได้รีเซ็ต MFA สำหรับผู้ใช้งาน', action: 'ผูก MFA', notice: 'หากคุณไม่ได้ขอรีเซ็ต MFA โปรดแจ้งผู้ดูแลระบบฝ่าย DX ทันที' },
};

function buildResetEmail({ username, displayName, link, purpose = 'PASSWORD' }) {
  const purposeText = EMAIL_PURPOSE_TEXT[purpose] || EMAIL_PURPOSE_TEXT.PASSWORD;
  const expiryText = purpose === 'PASSWORD' ? `${resetExpiresMinutes()} นาที` : `${MFA_CONFIG.ACCOUNT_SETUP_LINK_HOURS} ชั่วโมง`;
  const hasLogo = fs.existsSync(EMAIL_LOGO_PATH);
  const name = escapeHtml(displayName || username);
  const safeLink = escapeHtml(link);
  const subject = `Logistic Management System - ${purposeText.title}`;
  const text = [
    `เรียน ${displayName || username}`,
    '',
    `ผู้ดูแลระบบฝ่าย DX ${purposeText.intro} ${username}`,
    `กรุณาเปิดลิงก์นี้ภายใน ${expiryText} เพื่อ${purposeText.action}:`,
    link,
    '',
    `ลิงก์นี้ใช้ได้ครั้งเดียว ${purposeText.notice}`,
  ].join('\n');
  const FONT = 'CordiaUPC,Arial,sans-serif';
  const base = `font-family:${FONT};mso-line-height-rule:exactly;`;
  const linkText = safeLink.replace(/(.{40})/g, '$1&#8203;');
  const html = `<!DOCTYPE html>
<html lang="th" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${subject}</title>
<!--[if mso]>
<style>
  body, table, td, p, a, span { font-family: ${FONT} !important; }
</style>
<xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml>
<![endif]-->
</head>
<body style="margin:0;padding:0;background-color:#f1f5f9;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f1f5f9" style="background-color:#f1f5f9;">
  <tr>
    <td align="center" style="padding:24px 12px;">
      <table role="presentation" width="520" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff"
        style="width:520px;max-width:520px;background-color:#ffffff;border:1px solid #e2e8f0;border-collapse:separate;">
        ${hasLogo ? `<tr>
          <td align="center" bgcolor="#ffffff" style="background-color:#ffffff;padding:20px 28px 12px 28px;">
            <img src="cid:${EMAIL_LOGO_CID}" width="140" height="93" alt="LMS - Logistic Management System"
              style="display:block;width:140px;height:93px;border:0;outline:none;text-decoration:none;">
          </td>
        </tr>` : ''}
        <tr>
          <td bgcolor="#084F6A" style="${base}background-color:#084F6A;padding:16px 28px;color:#ffffff;font-size:20px;line-height:24px;font-weight:bold;">
            Logistic Management System - ${purposeText.title}
          </td>
        </tr>
        <tr>
          <td style="${base}padding:24px 28px 8px 28px;color:#1e293b;font-size:18px;line-height:22px;">
            <p style="${base}margin:0 0 12px 0;font-size:18px;line-height:22px;">เรียน ${name}</p>
            <p style="${base}margin:0 0 12px 0;font-size:18px;line-height:22px;">ผู้ดูแลระบบฝ่าย DX ${purposeText.intro} <b>${escapeHtml(username)}</b></p>
            <p style="${base}margin:0 0 20px 0;font-size:18px;line-height:22px;">กดปุ่มด้านล่างเพื่อ${purposeText.action} ลิงก์นี้ใช้ได้ภายใน <b>${expiryText}</b> และใช้ได้ครั้งเดียว</p>
          </td>
        </tr>
        <tr>
          <td align="center" style="padding:0 28px 24px 28px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td align="center" bgcolor="#084F6A" style="background-color:#084F6A;padding:12px 32px;">
                  <a href="${safeLink}" target="_blank"
                    style="${base}display:block;color:#ffffff;text-decoration:none;font-size:18px;line-height:20px;font-weight:bold;">${purposeText.action}</a>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="${base}padding:0 28px 24px 28px;color:#64748b;font-size:16px;line-height:18px;">
            <p style="${base}margin:0 0 6px 0;font-size:16px;line-height:18px;">หากปุ่มไม่ทำงาน ให้คัดลอกลิงก์นี้ไปเปิดในเบราว์เซอร์:</p>
            <p style="${base}margin:0 0 14px 0;font-size:16px;line-height:18px;"><a href="${safeLink}" target="_blank" style="color:#0B76A0;text-decoration:underline;">${linkText}</a></p>
            <p style="${base}margin:0;font-size:16px;line-height:18px;">${escapeHtml(purposeText.notice)}</p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
  const attachments = hasLogo
    ? [{ filename: 'lms-logo.png', path: EMAIL_LOGO_PATH, cid: EMAIL_LOGO_CID, contentDisposition: 'inline' }]
    : [];
  return { subject, text, html, attachments };
}

function describeMailError(err) {
  const detail = String(err?.response || err?.message || '');
  if (/testing emails to your own email|verify a domain|domain is not verified|not verified/i.test(detail)) {
    return 'ส่งอีเมลไม่สำเร็จ: ผู้ส่ง (MAIL_FROM) ยังไม่ได้ยืนยันโดเมนใน Resend จึงส่งได้เฉพาะอีเมลเจ้าของบัญชี Resend กรุณายืนยันโดเมนบริษัทใน Resend แล้วตั้ง MAIL_FROM เป็นอีเมลของโดเมนนั้น';
  }
  if (err?.code === 'EAUTH' || /invalid api key|authentication/i.test(detail)) {
    return 'ส่งอีเมลไม่สำเร็จ: เข้าสู่ระบบ SMTP ไม่ผ่าน กรุณาตรวจสอบ SMTP_USER / SMTP_PASS (API key)';
  }
  if (['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS'].includes(err?.code)) {
    return 'ส่งอีเมลไม่สำเร็จ: เชื่อมต่อ SMTP server ไม่ได้ กรุณาตรวจสอบ SMTP_HOST / SMTP_PORT และการเชื่อมต่ออินเทอร์เน็ตของเซิร์ฟเวอร์';
  }
  const short = detail.replace(/\s+/g, ' ').trim().slice(0, 200);
  return `ส่งอีเมลไม่สำเร็จ${short ? `: ${short}` : ''}`;
}

// ---------- ลิงก์ในอีเมล: ตั้งรหัสผ่านใหม่ / เปิดใช้งานบัญชี / ผูก MFA ใหม่ ----------
// reset_token_purpose:
//   PASSWORD      ตั้งรหัสผ่านใหม่อย่างเดียว (ปุ่มรีเซ็ตรหัสผ่านเดิม)
//   ACTIVATE      เปิดใช้งานบัญชี: ตั้งรหัสผ่าน → ผูก MFA (ตั้งรหัสผ่านแล้วเปลี่ยนเป็น ACTIVATE_MFA)
//   ACTIVATE_MFA  เปิดใช้งานบัญชี ตั้งรหัสผ่านแล้ว เหลือผูก MFA
//   MFA_SETUP     ผูก MFA กับโทรศัพท์เครื่องใหม่ (หลัง Admin รีเซ็ต MFA)
const LINK_PURPOSE = { PASSWORD: 'PASSWORD', ACTIVATE: 'ACTIVATE', ACTIVATE_MFA: 'ACTIVATE_MFA', MFA_SETUP: 'MFA_SETUP' };
const MFA_LINK_PURPOSES = [LINK_PURPOSE.ACTIVATE_MFA, LINK_PURPOSE.MFA_SETUP];

const linkExpiryMinutes = (purpose) => (purpose === LINK_PURPOSE.PASSWORD ? resetExpiresMinutes() : MFA_CONFIG.ACCOUNT_SETUP_LINK_HOURS * 60);

// สร้างลิงก์ใหม่ (ทับลิงก์เดิม) แล้วส่งอีเมล — ส่งไม่สำเร็จจะลบลิงก์และโยน error ที่มี mailError
async function issueEmailLink(pool, user, purpose) {
  const email = normalizeEmail(user.email);
  if (!email || !isValidEmail(email)) {
    const e = new Error('NO_EMAIL'); e.code = 'NO_EMAIL'; throw e;
  }
  const token = crypto.randomBytes(32).toString('hex');
  await pool.request()
    .input('username', user.username)
    .input('hash', hashResetToken(token))
    .input('mins', linkExpiryMinutes(purpose))
    .input('purpose', purpose)
    .query(`UPDATE [${TABLES.USER}]
            SET reset_token_hash = @hash, reset_token_expires = DATEADD(MINUTE, @mins, GETDATE()), reset_token_purpose = @purpose
            WHERE UPPER(username) = UPPER(@username)`);

  const link = `${getAppPublicUrl()}/?reset_token=${token}`;
  const mail = buildResetEmail({ username: user.username, displayName: user.name_th || user.name_en, link, purpose });
  try {
    await sendMail({ to: email, ...mail });
  } catch (mailErr) {
    logger.error('Account email failed:', mailErr.responseCode || '', mailErr.response || mailErr.message);
    await clearEmailLink(pool.request(), user.username);
    const e = new Error('MAIL_FAILED'); e.code = 'MAIL_FAILED'; e.mailError = mailErr; throw e;
  }
  return email;
}

const clearEmailLink = (request, username) => request
  .input('link_u', username)
  .query(`UPDATE [${TABLES.USER}] SET reset_token_hash = NULL, reset_token_expires = NULL, reset_token_purpose = NULL
          WHERE UPPER(username) = UPPER(@link_u)`);

function sendEmailLinkError(res, err) {
  if (err.code === 'NO_EMAIL') {
    return res.status(400).json({ success: false, code: 'NO_EMAIL', message: 'ผู้ใช้งานนี้ยังไม่มีอีเมลที่ถูกต้อง กรุณาแก้ไขข้อมูลผู้ใช้งานก่อน' });
  }
  if (err.code === 'MAIL_FAILED') {
    return res.status(502).json({ success: false, code: 'MAIL_FAILED', message: describeMailError(err.mailError) });
  }
  return null;
}

const MAIL_NOT_CONFIGURED = { success: false, code: 'MAIL_NOT_CONFIGURED', message: 'ยังไม่ได้ตั้งค่าระบบส่งอีเมล (SMTP) กรุณาติดต่อผู้ดูแลระบบฝ่าย DX' };

async function findUserForAdmin(pool, username) {
  const found = await pool.request()
    .input('username', username)
    .query(`SELECT username, name_th, name_en, email, ISNULL(is_active, 0) AS is_active,
                   mfa_secret_enc, mfa_enabled, mfa_last_step
            FROM [${TABLES.USER}] WHERE UPPER(username) = @username`);
  return found.recordset?.[0] || null;
}

// บันทึกประวัติจาก backend เอง (หน้าเว็บปลอมหรือข้ามไม่ได้)
async function writeTransactionLog(pool, { username, actionType, actionTitle, details }) {
  try {
    await ensureTransactionLogTable();
    await pool.request()
      .input('username', String(username || 'SYSTEM').toUpperCase())
      .input('action_type', actionType)
      .input('action_title', actionTitle)
      .input('details', details || null)
      .query(`INSERT INTO [${TABLES.TRANSACTION_LOG}] (username, action_type, action_title, details)
              VALUES (@username, @action_type, @action_title, @details)`);
  } catch (err) {
    logger.warn('Transaction log write failed:', err.message);
  }
}

async function requestPasswordReset(req, res) {
  const cleanUsername = String(req.params.username || '').trim().toUpperCase();
  if (!cleanUsername) {
    return res.status(400).json({ success: false, message: 'กรุณาระบุรหัสพนักงาน' });
  }
  if (!isMailConfigured()) return res.status(503).json(MAIL_NOT_CONFIGURED);

  try {
    await ensureUserTable();
    const pool = await getPool();
    const user = await findUserForAdmin(pool, cleanUsername);
    if (!user) {
      return res.status(404).json({ success: false, code: 'USER_NOT_FOUND', message: `ไม่พบรหัสพนักงาน ${cleanUsername}` });
    }
    const email = await issueEmailLink(pool, user, LINK_PURPOSE.PASSWORD);
    return res.json({
      success: true,
      message: `ส่งลิงก์ตั้งรหัสผ่านใหม่ไปที่ ${email} แล้ว`,
      data: { username: user.username, email, expiresInMinutes: resetExpiresMinutes() },
    });
  } catch (err) {
    if (sendEmailLinkError(res, err)) return;
    logger.error('Database error requesting password reset:', err.message);
    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการสร้างคำขอตั้งรหัสผ่านใหม่' });
  }
}

// ---------- Admin: เปิด/ปิดใช้งานบัญชี ----------
async function setUserActive(req, res) {
  const target = String(req.params.username || '').trim().toUpperCase();
  const active = req.body?.active === true;
  if (!target || typeof req.body?.active !== 'boolean') {
    return res.status(400).json({ success: false, message: 'ข้อมูลไม่ครบถ้วน' });
  }
  if (target === req.user?.username) {
    return res.status(400).json({ success: false, code: 'CANNOT_CHANGE_SELF', message: 'ไม่สามารถเปิดหรือปิดใช้งานบัญชีของตัวเองได้' });
  }
  if (active && !isMailConfigured()) return res.status(503).json(MAIL_NOT_CONFIGURED);

  try {
    await ensureUserTable();
    const pool = await getPool();
    const user = await findUserForAdmin(pool, target);
    if (!user) return res.status(404).json({ success: false, code: 'USER_NOT_FOUND', message: `ไม่พบรหัสพนักงาน ${target}` });

    if (!active) {
      const request = pool.request().input('u', target);
      await request.query(`UPDATE [${TABLES.USER}]
        SET is_active = 0, reset_token_hash = NULL, reset_token_expires = NULL, reset_token_purpose = NULL, updated_at = GETDATE()
        WHERE UPPER(username) = @u`);
      clearAuthCache(target);
      await writeTransactionLog(pool, { username: req.user?.username, actionType: 'DEACTIVATE_USER', actionTitle: 'ปิดใช้งานบัญชี', details: `ปิดใช้งานบัญชี ${target}` });
      return res.json({ success: true, message: `ปิดใช้งานบัญชี ${target} แล้ว`, data: { username: target, is_active: false } });
    }

    if (user.is_active) {
      return res.status(409).json({ success: false, code: 'ALREADY_ACTIVE', message: 'บัญชีนี้เปิดใช้งานอยู่แล้ว' });
    }

    // เปิดใช้งาน: ล้าง MFA เดิม แล้วส่งลิงก์ให้ตั้งรหัสผ่านและผูก MFA — ส่งอีเมลไม่สำเร็จจะย้อนกลับเป็นปิดใช้งาน
    await mfaService.clearMfa(pool.request(), target);
    await pool.request().input('u', target).query(`UPDATE [${TABLES.USER}] SET is_active = 1, updated_at = GETDATE() WHERE UPPER(username) = @u`);
    let email;
    try {
      email = await issueEmailLink(pool, user, LINK_PURPOSE.ACTIVATE);
    } catch (err) {
      await pool.request().input('u', target).query(`UPDATE [${TABLES.USER}] SET is_active = 0 WHERE UPPER(username) = @u`);
      clearAuthCache(target);
      if (sendEmailLinkError(res, err)) return;
      throw err;
    }
    clearAuthCache(target);
    await writeTransactionLog(pool, { username: req.user?.username, actionType: 'ACTIVATE_USER', actionTitle: 'เปิดใช้งานบัญชี', details: `เปิดใช้งานบัญชี ${target} และส่งลิงก์ตั้งค่าไปที่ ${email}` });
    return res.json({ success: true, message: `เปิดใช้งานบัญชีแล้ว ส่งลิงก์ตั้งรหัสผ่านและผูก MFA ไปที่ ${email}`, data: { username: target, is_active: true, email } });
  } catch (err) {
    logger.error('Set user active error:', err.message);
    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการเปลี่ยนสถานะบัญชี' });
  }
}

// ---------- Admin: รีเซ็ต MFA (โทรศัพท์หาย/เปลี่ยนเครื่อง) ----------
async function resetUserMfa(req, res) {
  const target = String(req.params.username || '').trim().toUpperCase();
  if (!target) return res.status(400).json({ success: false, message: 'กรุณาระบุรหัสพนักงาน' });
  // รีเซ็ต MFA ของตัวเองจะทำให้เข้าระบบไม่ได้จนกว่าจะเปิดลิงก์ในอีเมล — ให้ Admin คนอื่นทำแทน
  if (target === req.user?.username) {
    return res.status(400).json({ success: false, code: 'CANNOT_CHANGE_SELF', message: 'ไม่สามารถรีเซ็ต MFA ของตัวเองได้ กรุณาให้ผู้ดูแลระบบคนอื่นรีเซ็ตให้' });
  }
  if (!isMailConfigured()) return res.status(503).json(MAIL_NOT_CONFIGURED);

  try {
    await ensureUserTable();
    const pool = await getPool();
    const user = await findUserForAdmin(pool, target);
    if (!user) return res.status(404).json({ success: false, code: 'USER_NOT_FOUND', message: `ไม่พบรหัสพนักงาน ${target}` });
    if (!user.is_active) {
      return res.status(409).json({ success: false, code: 'ACCOUNT_DISABLED', message: 'บัญชีนี้ปิดใช้งานอยู่ ให้เปิดใช้งานบัญชีแทน' });
    }

    // ล้าง MFA ก่อน แล้วส่งลิงก์ — ส่งอีเมลไม่สำเร็จจะคืนค่า MFA เดิม
    await mfaService.clearMfa(pool.request(), target);
    let email;
    try {
      email = await issueEmailLink(pool, user, LINK_PURPOSE.MFA_SETUP);
    } catch (err) {
      await pool.request()
        .input('u', target)
        .input('enc', user.mfa_secret_enc)
        .input('enabled', user.mfa_enabled ? 1 : 0)
        .input('step', user.mfa_last_step)
        .query(`UPDATE [${TABLES.USER}] SET mfa_secret_enc = @enc, mfa_enabled = @enabled, mfa_last_step = @step WHERE UPPER(username) = @u`);
      clearAuthCache(target);
      if (sendEmailLinkError(res, err)) return;
      throw err;
    }
    clearAuthCache(target);
    await writeTransactionLog(pool, { username: req.user?.username, actionType: 'RESET_USER_MFA', actionTitle: 'รีเซ็ต MFA', details: `รีเซ็ต MFA ของ ${target} และส่งลิงก์ผูก MFA ไปที่ ${email}` });
    return res.json({ success: true, message: `รีเซ็ต MFA แล้ว ส่งลิงก์ผูก MFA ไปที่ ${email}`, data: { username: target, email } });
  } catch (err) {
    logger.error('Reset MFA error:', err.message);
    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการรีเซ็ต MFA' });
  }
}

const RESET_TOKEN_PATTERN = /^[a-f0-9]{64}$/i;
const RESET_INVALID_MESSAGES = {
  expired: 'ลิงก์หมดเวลาแล้ว กรุณาติดต่อผู้ดูแลระบบฝ่าย DX เพื่อขอลิงก์ใหม่',
  used: 'ลิงก์นี้ถูกใช้ไปแล้ว หรือมีการขอลิงก์ใหม่แทน กรุณาติดต่อผู้ดูแลระบบฝ่าย DX หากต้องการลิงก์ใหม่',
};

function sendResetTokenInvalid(res, reason) {
  const key = reason === 'expired' ? 'expired' : 'used';
  return res.status(400).json({ success: false, code: 'RESET_TOKEN_INVALID', reason: key, message: RESET_INVALID_MESSAGES[key] });
}

async function getResetTokenState(pool, token) {
  const result = await pool.request()
    .input('hash', hashResetToken(token))
    .query(`
      SELECT TOP 1 username, ISNULL(reset_token_purpose, 'PASSWORD') AS purpose, ISNULL(is_active, 0) AS is_active,
             DATEDIFF(SECOND, GETDATE(), reset_token_expires) AS seconds_left
      FROM [${TABLES.USER}]
      WHERE reset_token_hash = @hash
    `);
  const row = result.recordset?.[0];
  if (!row) return { state: 'used' };
  const secondsLeft = Number(row.seconds_left);
  if (!(secondsLeft > 0)) return { state: 'expired' };
  // ลิงก์เปิดใช้งาน/ผูก MFA ใช้ไม่ได้ถ้าบัญชีถูกปิดใช้งานไปแล้ว
  if (row.purpose !== LINK_PURPOSE.PASSWORD && !row.is_active) return { state: 'used' };
  return { state: 'valid', username: row.username, purpose: row.purpose, secondsLeft };
}

async function verifyPasswordResetToken(req, res) {
  const token = String(req.body.token || '').trim();
  if (!RESET_TOKEN_PATTERN.test(token)) return sendResetTokenInvalid(res, 'used');
  try {
    await ensureUserTable();
    const pool = await getPool();
    const info = await getResetTokenState(pool, token);
    if (info.state !== 'valid') return sendResetTokenInvalid(res, info.state);
    return res.json({ success: true, data: { username: info.username, purpose: info.purpose, secondsLeft: info.secondsLeft } });
  } catch (err) {
    logger.error('Database error verifying password reset token:', err.message);
    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการตรวจสอบลิงก์' });
  }
}

async function confirmPasswordReset(req, res) {
  const token = String(req.body.token || '').trim();
  const rawPassword = String(req.body.password || '');
  const rawConfirmPassword = req.body.confirm_password !== undefined ? String(req.body.confirm_password) : rawPassword;

  if (!RESET_TOKEN_PATTERN.test(token)) return sendResetTokenInvalid(res, 'used');
  if (!rawPassword) {
    return res.status(400).json({ success: false, message: 'กรุณากำหนดรหัสผ่านใหม่' });
  }
  const passwordError = validateNewPassword(rawPassword, { isNew: false });
  if (passwordError) {
    return res.status(400).json({ success: false, message: passwordError });
  }
  if (rawPassword !== rawConfirmPassword) {
    return res.status(400).json({ success: false, message: 'รหัสผ่านและยืนยันรหัสผ่านไม่ตรงกัน' });
  }

  try {
    await ensureUserTable();
    const pool = await getPool();
    const info = await getResetTokenState(pool, token);
    if (info.state !== 'valid') return sendResetTokenInvalid(res, info.state);
    if (info.purpose !== LINK_PURPOSE.PASSWORD && info.purpose !== LINK_PURPOSE.ACTIVATE) {
      return res.status(400).json({ success: false, code: 'RESET_PURPOSE_MISMATCH', message: 'ลิงก์นี้ใช้สำหรับผูก MFA เท่านั้น' });
    }

    // PASSWORD: ตั้งรหัสแล้วลิงก์หมดอายุ / ACTIVATE: ตั้งรหัสแล้วไปขั้นผูก MFA ต่อ (ลิงก์ยังใช้ต่อได้)
    const isActivation = info.purpose === LINK_PURPOSE.ACTIVATE;
    const passwordHash = await hashPasswordAsync(rawPassword);
    const result = await pool.request()
      .input('hash', hashResetToken(token))
      .input('password_hash', passwordHash)
      .input('purpose', info.purpose)
      .query(`
        UPDATE [${TABLES.USER}]
        SET password_hash = @password_hash,
            ${isActivation
              ? `reset_token_purpose = '${LINK_PURPOSE.ACTIVATE_MFA}',`
              : 'reset_token_hash = NULL, reset_token_expires = NULL, reset_token_purpose = NULL,'}
            failed_login_count = 0,
            lockout_until = NULL,
            updated_at = GETDATE()
        OUTPUT inserted.username
        WHERE reset_token_hash = @hash AND reset_token_expires > GETDATE()
          AND ISNULL(reset_token_purpose, 'PASSWORD') = @purpose
      `);
    const username = result.recordset?.[0]?.username;
    if (!username) {
      const latest = await getResetTokenState(pool, token);
      return sendResetTokenInvalid(res, latest.state === 'expired' ? 'expired' : 'used');
    }
    clearAuthCache(username);

    if (isActivation) {
      return res.json({ success: true, next: 'MFA', message: 'ตั้งรหัสผ่านเรียบร้อย ขั้นต่อไปผูก MFA กับโทรศัพท์', data: { username } });
    }
    return res.json({ success: true, message: 'ตั้งรหัสผ่านใหม่เรียบร้อยแล้ว กรุณาเข้าสู่ระบบด้วยรหัสผ่านใหม่', data: { username } });
  } catch (err) {
    logger.error('Database error confirming password reset:', err.message);
    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการตั้งรหัสผ่านใหม่' });
  }
}

// ลิงก์ผูก MFA (หลังตั้งรหัสผ่านของการเปิดใช้งาน หรือหลัง Admin รีเซ็ต MFA) — username มาจากลิงก์เท่านั้น
async function getMfaLinkUser(pool, token) {
  if (!RESET_TOKEN_PATTERN.test(token)) return { state: 'used' };
  const info = await getResetTokenState(pool, token);
  if (info.state !== 'valid') return info;
  if (!MFA_LINK_PURPOSES.includes(info.purpose)) return { state: 'wrong_purpose' };
  return info;
}

function sendMfaLinkInvalid(res, info) {
  if (info.state === 'wrong_purpose') {
    return res.status(400).json({ success: false, code: 'RESET_PURPOSE_MISMATCH', message: 'กรุณาตั้งรหัสผ่านก่อนผูก MFA' });
  }
  return sendResetTokenInvalid(res, info.state);
}

async function resetLinkMfaSetup(req, res) {
  try {
    await ensureUserTable();
    const pool = await getPool();
    const info = await getMfaLinkUser(pool, String(req.body?.token || '').trim());
    if (info.state !== 'valid') return sendMfaLinkInvalid(res, info);
    return res.json(await createSetupResponse(pool, info.username));
  } catch (err) {
    logger.error('MFA link setup error:', err.message);
    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการตั้งค่า MFA' });
  }
}

async function resetLinkMfaVerify(req, res) {
  const code = String(req.body?.code || '').trim();
  if (!mfaService.CODE_PATTERN.test(code)) {
    return res.status(400).json({ success: false, code: 'MFA_CODE_REQUIRED', message: MFA_MESSAGES.REQUIRED_CODE });
  }
  try {
    await ensureUserTable();
    const pool = await getPool();
    const token = String(req.body?.token || '').trim();
    const info = await getMfaLinkUser(pool, token);
    if (info.state !== 'valid') return sendMfaLinkInvalid(res, info);

    const result = await mfaService.checkUserCode(pool, info.username, code);
    if (result.status === 'NO_SECRET') return res.status(400).json({ success: false, code: 'MFA_NOT_SET', message: MFA_MESSAGES.NOT_SET });
    if (result.status === 'LOCKED') return sendMfaLocked(res, result.lock);
    if (result.status !== 'OK') return res.status(401).json({ success: false, code: 'MFA_INVALID', message: MFA_MESSAGES.INVALID_CODE });

    // ผูกสำเร็จ: ลิงก์ใช้ได้ครั้งเดียว
    await pool.request()
      .input('hash', hashResetToken(token))
      .query(`UPDATE [${TABLES.USER}] SET reset_token_hash = NULL, reset_token_expires = NULL, reset_token_purpose = NULL
              WHERE reset_token_hash = @hash`);
    clearAuthCache(info.username);
    const message = info.purpose === LINK_PURPOSE.ACTIVATE_MFA
      ? 'เปิดใช้งานบัญชีเรียบร้อย กรุณาเข้าสู่ระบบ'
      : 'ผูก MFA กับโทรศัพท์เครื่องใหม่เรียบร้อย กรุณาเข้าสู่ระบบ';
    return res.json({ success: true, message, data: { username: info.username } });
  } catch (err) {
    logger.error('MFA link verify error:', err.message);
    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการยืนยัน MFA' });
  }
}

// ---------- ผู้ใช้เปลี่ยนรหัสผ่านเอง (หน้าโปรไฟล์) ----------
// อีเมลแจ้งว่ารหัสผ่านถูกเปลี่ยน — ไม่มีลิงก์และไม่มีรหัสผ่าน
function buildPasswordChangedEmail({ username, displayName, changedAt = new Date() }) {
  const when = changedAt.toLocaleString('th-TH', {
    timeZone: 'Asia/Bangkok', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  const hasLogo = fs.existsSync(EMAIL_LOGO_PATH);
  const name = escapeHtml(displayName || username);
  const title = 'รหัสผ่านถูกเปลี่ยน';
  const subject = `Logistic Management System - ${title}`;
  const notice = 'หากคุณไม่ได้เปลี่ยนรหัสผ่านเอง กรุณาแจ้งผู้ดูแลระบบฝ่าย DX ทันที';
  const text = [
    `เรียน ${displayName || username}`,
    '',
    `รหัสผ่านของผู้ใช้งาน ${username} ถูกเปลี่ยนเมื่อ ${when} น.`,
    'เครื่องอื่นที่เข้าสู่ระบบค้างไว้ถูกออกจากระบบแล้ว',
    '',
    notice,
  ].join('\n');
  const FONT = 'CordiaUPC,Arial,sans-serif';
  const base = `font-family:${FONT};mso-line-height-rule:exactly;`;
  const html = `<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${subject}</title>
</head>
<body style="margin:0;padding:0;background-color:#f1f5f9;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f1f5f9" style="background-color:#f1f5f9;">
  <tr>
    <td align="center" style="padding:24px 12px;">
      <table role="presentation" width="520" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff"
        style="width:520px;max-width:520px;background-color:#ffffff;border:1px solid #e2e8f0;border-collapse:separate;">
        ${hasLogo ? `<tr>
          <td align="center" bgcolor="#ffffff" style="background-color:#ffffff;padding:20px 28px 12px 28px;">
            <img src="cid:${EMAIL_LOGO_CID}" width="140" height="93" alt="LMS - Logistic Management System"
              style="display:block;width:140px;height:93px;border:0;outline:none;text-decoration:none;">
          </td>
        </tr>` : ''}
        <tr>
          <td bgcolor="#084F6A" style="${base}background-color:#084F6A;padding:16px 28px;color:#ffffff;font-size:20px;line-height:24px;font-weight:bold;">
            Logistic Management System - ${title}
          </td>
        </tr>
        <tr>
          <td style="${base}padding:24px 28px 24px 28px;color:#1e293b;font-size:18px;line-height:22px;">
            <p style="${base}margin:0 0 12px 0;font-size:18px;line-height:22px;">เรียน ${name}</p>
            <p style="${base}margin:0 0 12px 0;font-size:18px;line-height:22px;">รหัสผ่านของผู้ใช้งาน <b>${escapeHtml(username)}</b> ถูกเปลี่ยนเมื่อ <b>${escapeHtml(when)} น.</b></p>
            <p style="${base}margin:0 0 16px 0;font-size:18px;line-height:22px;">เครื่องอื่นที่เข้าสู่ระบบค้างไว้ถูกออกจากระบบแล้ว</p>
            <p style="${base}margin:0;color:#b91c1c;font-size:16px;line-height:18px;">${escapeHtml(notice)}</p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
  const attachments = hasLogo
    ? [{ filename: 'lms-logo.png', path: EMAIL_LOGO_PATH, cid: EMAIL_LOGO_CID, contentDisposition: 'inline' }]
    : [];
  return { subject, text, html, attachments };
}

const CHANGE_PASSWORD_MESSAGES = {
  REQUIRED: 'กรุณากรอกรหัสผ่านปัจจุบัน รหัสผ่านใหม่ และยืนยันรหัสผ่านใหม่ให้ครบ',
  MISMATCH: 'รหัสผ่านใหม่และยืนยันรหัสผ่านไม่ตรงกัน',
  SAME_AS_OLD: 'รหัสผ่านใหม่ต้องไม่ซ้ำกับรหัสผ่านปัจจุบัน',
  WRONG_PASSWORD: 'รหัสผ่านปัจจุบันไม่ถูกต้อง',
  SUCCESS: 'เปลี่ยนรหัสผ่านเรียบร้อยแล้ว',
};

// POST /api/users/me/password { current_password, new_password, confirm_password, code }
// ขั้นตอน: ตรวจรหัสผ่านปัจจุบัน → ยืนยัน MFA → บันทึกรหัสผ่านใหม่ → ส่ง token ใหม่ (เครื่องนี้อยู่ต่อได้) → แจ้งอีเมล
// เครื่องอื่นหลุดเอง เพราะ token ผูกกับ password_hash (config/auth.js -> passwordVersion)
async function changeOwnPassword(req, res) {
  const username = String(req.user?.username || '').trim().toUpperCase();
  const currentPassword = String(req.body?.current_password || '');
  const newPassword = String(req.body?.new_password || '');
  const confirmPassword = String(req.body?.confirm_password ?? '');
  const code = String(req.body?.code || '').trim();

  if (!username) return res.status(401).json({ success: false, code: 'AUTH_REQUIRED', message: 'กรุณาเข้าสู่ระบบ' });
  if (!currentPassword || !newPassword || !confirmPassword) {
    return res.status(400).json({ success: false, code: 'REQUIRED', message: CHANGE_PASSWORD_MESSAGES.REQUIRED });
  }
  const ruleError = validateNewPassword(newPassword, { isNew: false });
  if (ruleError) return res.status(400).json({ success: false, code: 'PASSWORD_RULE', message: ruleError });
  if (newPassword !== confirmPassword) {
    return res.status(400).json({ success: false, code: 'PASSWORD_MISMATCH', message: CHANGE_PASSWORD_MESSAGES.MISMATCH });
  }
  if (newPassword === currentPassword) {
    return res.status(400).json({ success: false, code: 'SAME_AS_OLD', message: CHANGE_PASSWORD_MESSAGES.SAME_AS_OLD });
  }
  if (!mfaService.CODE_PATTERN.test(code)) {
    return res.status(400).json({ success: false, code: 'MFA_CODE_REQUIRED', message: MFA_MESSAGES.REQUIRED_CODE });
  }

  try {
    await ensureUserTable();
    const pool = await getPool();
    const user = await selectLoginUser(pool, username);
    if (!user || !user.is_active || !user.password_hash) {
      return res.status(401).json({ success: false, code: 'USER_NOT_FOUND', message: 'ไม่พบบัญชีผู้ใช้งาน กรุณาเข้าสู่ระบบใหม่' });
    }
    if (user.is_locked) return sendAccountLocked(res, user);

    // รหัสผ่านปัจจุบัน — ใช้ตัวนับเดียวกับตอน login (ผิดครบกำหนด = ล็อคบัญชี)
    if (!(await verifyPasswordAsync(currentPassword, user.password_hash))) {
      const failed = await registerFailedLogin(pool, username);
      if (failed?.is_locked) return sendAccountLocked(res, failed);
      return res.status(401).json({ success: false, code: 'WRONG_PASSWORD', message: CHANGE_PASSWORD_MESSAGES.WRONG_PASSWORD });
    }
    await clearFailedLogins(pool, username);

    const mfa = await mfaService.checkUserCode(pool, username, code);
    if (mfa.status === 'NO_SECRET') return res.status(400).json({ success: false, code: 'MFA_NOT_SET', message: MFA_MESSAGES.NOT_SET });
    if (mfa.status === 'LOCKED') return sendMfaLocked(res, mfa.lock);
    if (mfa.status !== 'OK') return res.status(401).json({ success: false, code: 'MFA_INVALID', message: MFA_MESSAGES.INVALID_CODE });

    // บันทึก: เปลี่ยนรหัส + ปลดตัวนับ + ยกเลิกลิงก์ตั้งรหัสผ่านที่ค้างอยู่ (ถ้ามี)
    // ไม่แตะลิงก์ตั้งค่าบัญชี / MFA (ACTIVATE*, MFA_SETUP) — บัญชีที่ยังตั้งค่าไม่เสร็จ login ไม่ได้อยู่แล้ว
    const passwordHash = await hashPasswordAsync(newPassword);
    const updated = await pool.request()
      .input('username', username)
      .input('old_hash', user.password_hash)
      .input('password_hash', passwordHash)
      .query(`
        UPDATE [${TABLES.USER}]
        SET password_hash = @password_hash,
            failed_login_count = 0,
            lockout_until = NULL,
            reset_token_hash = CASE WHEN ISNULL(reset_token_purpose, 'PASSWORD') = 'PASSWORD' THEN NULL ELSE reset_token_hash END,
            reset_token_expires = CASE WHEN ISNULL(reset_token_purpose, 'PASSWORD') = 'PASSWORD' THEN NULL ELSE reset_token_expires END,
            reset_token_purpose = CASE WHEN ISNULL(reset_token_purpose, 'PASSWORD') = 'PASSWORD' THEN NULL ELSE reset_token_purpose END,
            updated_at = GETDATE()
        WHERE UPPER(username) = @username AND password_hash = @old_hash
      `);
    // รหัสผ่านถูกเปลี่ยนจากที่อื่นระหว่างนี้ (เช่นตั้งผ่านลิงก์) — ไม่เขียนทับ
    if (!(updated.rowsAffected || []).some((n) => n > 0)) {
      return res.status(409).json({ success: false, code: 'PASSWORD_CHANGED_ELSEWHERE', message: 'รหัสผ่านถูกเปลี่ยนจากที่อื่นแล้ว กรุณาเข้าสู่ระบบใหม่' });
    }
    clearAuthCache(username);

    const fresh = await selectLoginUser(pool, username);
    const email = await pool.request().input('username', username)
      .query(`SELECT email FROM [${TABLES.USER}] WHERE UPPER(username) = @username`)
      .then((r) => normalizeEmail(r.recordset?.[0]?.email))
      .catch(() => '');
    if (email && isMailConfigured()) {
      const mail = buildPasswordChangedEmail({ username: fresh.username, displayName: fresh.name_th || fresh.name_en });
      // ไม่รอผลอีเมล — ส่งไม่สำเร็จ รหัสผ่านก็เปลี่ยนแล้ว แค่บันทึก log
      sendMail({ to: email, ...mail }).catch((mailErr) => {
        logger.error('Password changed email failed:', mailErr.responseCode || '', mailErr.response || mailErr.message);
      });
    }

    const token = signUserToken({
      username: fresh.username,
      roleId: fresh.role_id,
      passwordHash: fresh.password_hash,
      mfaSecretEnc: fresh.mfa_secret_enc,
    });
    return res.json({ success: true, message: CHANGE_PASSWORD_MESSAGES.SUCCESS, token, expiresAt: getTokenExpiry(token), emailSent: Boolean(email && isMailConfigured()) });
  } catch (err) {
    logger.error('Change own password error:', err.message);
    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการเปลี่ยนรหัสผ่าน' });
  }
}

module.exports = {
  normalizeUserGroup,
  getUsers,
  getUserDirectory,
  getUserByUsername,
  createUser,
  updateUser,
  deleteUser,
  loginUser,
  loginMfaSetup,
  loginMfaVerify,
  requestPasswordReset,
  confirmPasswordReset,
  verifyPasswordResetToken,
  resetLinkMfaSetup,
  resetLinkMfaVerify,
  setUserActive,
  resetUserMfa,
  buildResetEmail,
  buildPasswordChangedEmail,
  changeOwnPassword,
  hashPassword,
  hashPasswordAsync,
  verifyPasswordAsync,
  PASSWORD_MIN_LENGTH,
  verifyPassword,
  ensureUserTable,
};
