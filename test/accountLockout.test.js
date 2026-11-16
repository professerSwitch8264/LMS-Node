// Integration test ของระบบล็อคบัญชี — รันกับฐานข้อมูลทดสอบเท่านั้น
// วิธีรัน (PowerShell):  $env:TEST_DB_NAME='LMS_TEST'; npm test
// ถ้าไม่ตั้ง TEST_DB_NAME จะข้ามทั้งชุด เพื่อไม่ให้แตะฐานข้อมูลจริง
const path = require('path');
const crypto = require('crypto');
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const TEST_DB = String(process.env.TEST_DB_NAME || '').trim();
const MAIN_DB = String(process.env.DB_NAME || 'LMS').trim();
const skipReason = !TEST_DB
  ? 'ตั้ง TEST_DB_NAME เพื่อรัน integration test'
  : (TEST_DB.toLowerCase() === MAIN_DB.toLowerCase() ? 'TEST_DB_NAME ต้องไม่ใช่ฐานข้อมูลเดียวกับ DB_NAME' : null);

if (!skipReason) process.env.DB_NAME = TEST_DB;
// ตรึงค่าให้ test ไม่ขึ้นกับ .env
process.env.ACCOUNT_LOCKOUT_MAX_FAILS = '5';
process.env.ACCOUNT_LOCKOUT_MINUTES = '30';
process.env.MFA_ENCRYPTION_KEY = process.env.MFA_ENCRYPTION_KEY || require('crypto').randomBytes(32).toString('base64');

const USERNAME = 'ZZ_LOCKOUT_TEST';
const CORRECT = 'Correct!Pass1';
const WRONG = 'Wrong!Pass1';

function fakeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    set(key, value) { this.headers[key] = value; return this; },
  };
}

describe('account lockout', { skip: skipReason || false }, () => {
  let pool;
  let ctrl;
  let originalHash;
  let settings;

  const login = async (password, username = USERNAME) => {
    const res = fakeRes();
    await ctrl.loginUser({ body: { username, password } }, res);
    return res;
  };

  const loginTimes = async (password, n) => {
    const results = [];
    for (let i = 0; i < n; i += 1) results.push(await login(password));
    return results;
  };

  const state = async () => {
    const r = await pool.request().input('u', USERNAME).query(`
      SELECT failed_login_count,
             CASE WHEN lockout_until IS NULL THEN 0 ELSE 1 END AS has_lockout,
             CASE WHEN lockout_until > GETDATE() THEN 1 ELSE 0 END AS is_locked
      FROM [User] WHERE username = @u`);
    return r.recordset[0];
  };

  // จำลองว่าครบเวลาล็อคแล้ว โดยใช้เวลา DB เหมือน logic จริง
  const expireLock = () => pool.request().input('u', USERNAME)
    .query('UPDATE [User] SET lockout_until = DATEADD(SECOND, -1, GETDATE()) WHERE username = @u');

  before(async () => {
    const db = require('../src/config/db');
    ctrl = require('../src/controllers/userController');
    settings = require('../src/services/settingsService');
    await db.initializeDatabase();
    await ctrl.ensureUserTable();
    pool = await db.getPool();

    const role = await pool.request().query('SELECT TOP 1 role_id FROM Role_permission ORDER BY role_id');
    assert.ok(role.recordset[0], 'ต้องมี role อย่างน้อย 1 รายการใน Role_permission');
    originalHash = await ctrl.hashPasswordAsync(CORRECT);

    await pool.request().input('u', USERNAME).query('DELETE FROM [User] WHERE username = @u');
    await pool.request()
      .input('u', USERNAME)
      .input('role', role.recordset[0].role_id)
      .input('hash', originalHash)
      .query(`INSERT INTO [User] (username, role_id, name_th, name_en, email, password_hash, is_active)
              VALUES (@u, @role, N'ทดสอบ', 'Test', 'zz_lockout_test@example.invalid', @hash, 1)`);
  });

  beforeEach(async () => {
    // ล้าง cache ของ Setting ให้ใช้ค่าที่ตรึงไว้ใน env ด้านบน (5 ครั้ง / 30 นาที) ไม่ขึ้นกับค่าในตาราง
    settings.setCacheFromRows([]);
    await pool.request().input('u', USERNAME).input('hash', originalHash).query(`
      UPDATE [User]
      SET failed_login_count = 0, lockout_until = NULL, password_hash = @hash,
          reset_token_hash = NULL, reset_token_expires = NULL
      WHERE username = @u`);
  });

  after(async () => {
    if (!pool) return;
    await pool.request().input('u', USERNAME).query('DELETE FROM [User] WHERE username = @u');
    await pool.close();
  });

  it('wrong password 5 times locks the account', async () => {
    const results = await loginTimes(WRONG, 5);
    assert.deepEqual(results.map((r) => r.statusCode), [401, 401, 401, 401, 423]);

    const locked = results[4];
    assert.equal(locked.body.code, 'ACCOUNT_LOCKED');
    assert.match(locked.body.lockedUntil, /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/);
    assert.ok(locked.body.message.includes(locked.body.lockedUntil));
    assert.ok(locked.body.retryAfterSeconds > 29 * 60 && locked.body.retryAfterSeconds <= 30 * 60);
    assert.ok(locked.headers['Retry-After']);

    assert.deepEqual(await state(), { failed_login_count: 5, has_lockout: 1, is_locked: 1 });
  });

  it('4 wrong then 1 correct resets the counter', async () => {
    await loginTimes(WRONG, 4);
    assert.equal((await state()).failed_login_count, 4);

    const ok = await login(CORRECT);
    assert.equal(ok.statusCode, 200);
    assert.ok(ok.body.mfaToken);
    assert.equal(ok.body.token, undefined);
    assert.deepEqual(await state(), { failed_login_count: 0, has_lockout: 0, is_locked: 0 });
  });

  it('correct password while locked is still rejected and the counter does not move', async () => {
    await loginTimes(WRONG, 5);

    const res = await login(CORRECT);
    assert.equal(res.statusCode, 423);
    assert.equal(res.body.code, 'ACCOUNT_LOCKED');
    assert.equal(res.body.token, undefined);
    assert.equal(res.body.mfaToken, undefined);

    const again = await login(WRONG);
    assert.equal(again.statusCode, 423);
    assert.deepEqual(await state(), { failed_login_count: 5, has_lockout: 1, is_locked: 1 });
  });

  it('after the lock time passes the correct password works and clears the lock', async () => {
    await loginTimes(WRONG, 5);
    await expireLock();

    const ok = await login(CORRECT);
    assert.equal(ok.statusCode, 200);
    assert.ok(ok.body.mfaToken);
    assert.equal(ok.body.token, undefined);
    assert.deepEqual(await state(), { failed_login_count: 0, has_lockout: 0, is_locked: 0 });
  });

  it('after an expired lock, one wrong password starts again at 1 instead of locking', async () => {
    await loginTimes(WRONG, 5);
    await expireLock();

    const res = await login(WRONG);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(await state(), { failed_login_count: 1, has_lockout: 0, is_locked: 0 });

    // ต้องผิดอีกครบ 5 ครั้งถึงจะล็อคใหม่
    const more = await loginTimes(WRONG, 4);
    assert.deepEqual(more.map((r) => r.statusCode), [401, 401, 401, 423]);
  });

  it('password reset via token clears the counter and unlocks', async () => {
    await loginTimes(WRONG, 5);

    const token = crypto.randomBytes(32).toString('hex');
    await pool.request()
      .input('u', USERNAME)
      .input('hash', crypto.createHash('sha256').update(token).digest('hex'))
      .query(`UPDATE [User] SET reset_token_hash = @hash, reset_token_expires = DATEADD(MINUTE, 10, GETDATE())
              WHERE username = @u`);

    const res = fakeRes();
    await ctrl.confirmPasswordReset({ body: { token, password: 'NewPass!234', confirm_password: 'NewPass!234' } }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(await state(), { failed_login_count: 0, has_lockout: 0, is_locked: 0 });

    const ok = await login('NewPass!234');
    assert.equal(ok.statusCode, 200);
  });

  it('parallel wrong attempts never push the counter past the limit', async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => login(WRONG)));
    const codes = results.map((r) => r.statusCode);

    assert.equal(codes.filter((c) => c === 401).length, 4);
    assert.equal(codes.filter((c) => c === 423).length, 6);
    assert.deepEqual(await state(), { failed_login_count: 5, has_lockout: 1, is_locked: 1 });
  });

  it('lockout limit changed in Setting applies without a restart', async () => {
    const key = 'ACCOUNT_LOCKOUT_MAX_FAILS';
    const before = (await pool.request().input('k', key).query('SELECT setting_value FROM [Setting] WHERE setting_key = @k')).recordset[0];
    assert.ok(before, 'initializeDatabase ต้องสร้างแถว ACCOUNT_LOCKOUT_MAX_FAILS');
    try {
      await pool.request().input('k', key).query("UPDATE [Setting] SET setting_value = '3', updated_at = GETDATE() WHERE setting_key = @k");
      assert.equal(await settings.loadSettings(pool), true);
      const results = await loginTimes(WRONG, 3);
      assert.deepEqual(results.map((r) => r.statusCode), [401, 401, 423]);
      assert.ok(results[2].body.message.includes('3 ครั้ง'));
    } finally {
      await pool.request().input('k', key).input('v', before.setting_value).query('UPDATE [Setting] SET setting_value = @v WHERE setting_key = @k');
      settings.setCacheFromRows([]);
    }
  });

  it('wrong password and unknown username return the same error', async () => {
    const wrong = await login(WRONG);
    const unknown = await login(WRONG, 'ZZ_NO_SUCH_USER_9999');
    assert.equal(wrong.statusCode, 401);
    assert.equal(unknown.statusCode, 401);
    assert.deepEqual(wrong.body, unknown.body);
  });
});
