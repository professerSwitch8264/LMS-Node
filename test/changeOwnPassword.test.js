// ผู้ใช้เปลี่ยนรหัสผ่านเอง (POST /api/users/me/password)
// - ส่วนแรก: ตรวจ input และอีเมล ไม่ต้องใช้ฐานข้อมูล
// - ส่วนที่สอง: integration test รันกับฐานข้อมูลทดสอบเท่านั้น
//   วิธีรัน (PowerShell):  $env:TEST_DB_NAME='LMS_TEST'; npm test
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
process.env.DB_USER = process.env.DB_USER || 'test';
process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'test';
process.env.LOG_LEVEL = 'error';
process.env.JWT_SECRET = crypto.randomBytes(48).toString('hex');
process.env.MFA_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
process.env.ACCOUNT_LOCKOUT_MAX_FAILS = '5';
process.env.ACCOUNT_LOCKOUT_MINUTES = '30';

// ไม่ส่งอีเมลจริง: เก็บไว้ตรวจแทน (ต้องแทนก่อนโหลด controller)
const sentMails = [];
const mailService = require('../src/services/mailService');
mailService.sendMail = async (mail) => { sentMails.push(mail); };
mailService.isMailConfigured = () => true;

const ctrl = require('../src/controllers/userController');
const { USER } = require('../src/services/auditEvents');

function fakeRes() {
  return {
    statusCode: 200, headers: {}, body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    set(key, value) { this.headers[key] = value; return this; },
  };
}
const call = async (body, username = 'ANYONE') => {
  const res = fakeRes();
  await ctrl.changeOwnPassword({ body, user: { username } }, res);
  return res;
};

const OLD = 'Start!Pass1';
const NEW = 'Fresh!Pass2';

describe('change own password: input checks (no database)', () => {
  it('requires every field, the password rules, matching confirmation and a different password', async () => {
    assert.equal((await call({ current_password: OLD, new_password: NEW })).body.code, 'REQUIRED');
    assert.equal((await call({ current_password: OLD, new_password: 'short', confirm_password: 'short', code: '123456' })).body.code, 'PASSWORD_RULE');
    assert.equal((await call({ current_password: OLD, new_password: NEW, confirm_password: 'Other!Pass3', code: '123456' })).body.code, 'PASSWORD_MISMATCH');
    assert.equal((await call({ current_password: NEW, new_password: NEW, confirm_password: NEW, code: '123456' })).body.code, 'SAME_AS_OLD');
    assert.equal((await call({ current_password: OLD, new_password: NEW, confirm_password: NEW, code: '12' })).body.code, 'MFA_CODE_REQUIRED');
  });

  it('needs a logged-in user (username comes from the token, never from the body)', async () => {
    const res = fakeRes();
    await ctrl.changeOwnPassword({ body: { username: 'VICTIM', current_password: OLD, new_password: NEW, confirm_password: NEW, code: '123456' }, user: null }, res);
    assert.equal(res.statusCode, 401);
  });

  it('email: tells the time and what to do, contains no password and escapes the name', () => {
    const mail = ctrl.buildPasswordChangedEmail({ username: 'U1', displayName: '<b>สมชาย</b>', changedAt: new Date('2026-11-17T03:00:00Z') });
    assert.match(mail.subject, /รหัสผ่านถูกเปลี่ยน/);
    assert.match(mail.text, /17\/11\/2569 10:00/);
    assert.match(mail.text, /แจ้งผู้ดูแลระบบ/);
    assert.doesNotMatch(mail.html, /<b>สมชาย<\/b>/);
    assert.match(mail.html, /&lt;b&gt;สมชาย/);
    assert.doesNotMatch(mail.html + mail.text, /Fresh!Pass2|Start!Pass1|reset_token/);
  });

  it('audit entry has no password', () => {
    const entry = USER.changeOwnPassword({ user: { username: 'u1' }, body: { current_password: OLD, new_password: NEW } }, { emailSent: true });
    assert.equal(entry.actionType, 'CHANGE_PASSWORD');
    assert.match(entry.details, /U1 เปลี่ยนรหัสผ่านด้วยตัวเอง/);
    assert.doesNotMatch(entry.details, /Pass/);
  });
});

describe('change own password (database)', { skip: skipReason || false }, () => {
  const USERNAME = 'ZZ_CHPW_TEST';
  let pool;
  let authMw;
  let authCfg;
  let mfa;
  let authenticator;
  let secret;

  const codeFor = (offsetSteps = 0) => authenticator.clone({ epoch: Date.now() + offsetSteps * 30000 }).generate(secret);
  const row = async () => (await pool.request().input('u', USERNAME)
    .query('SELECT password_hash, failed_login_count, reset_token_hash, CASE WHEN lockout_until > GETDATE() THEN 1 ELSE 0 END AS is_locked FROM [User] WHERE username = @u')).recordset[0];
  const tokenFor = (r) => authCfg.signUserToken({ username: USERNAME, roleId: r.role_id, passwordHash: r.password_hash, mfaSecretEnc: r.mfa_secret_enc });
  const tryApi = async (token) => {
    const res = fakeRes();
    let passed = false;
    await authMw.authenticate({ headers: { authorization: `Bearer ${token}` } }, res, () => { passed = true; });
    return passed;
  };
  const login = async (password) => {
    const res = fakeRes();
    await ctrl.loginUser({ body: { username: USERNAME, password } }, res);
    return res;
  };

  before(async () => {
    const db = require('../src/config/db');
    authMw = require('../src/middleware/auth');
    authCfg = require('../src/config/auth');
    mfa = require('../src/services/mfaService');
    ({ authenticator } = require('otplib'));
    await db.initializeDatabase();
    await ctrl.ensureUserTable();
    pool = await db.getPool();
    require('../src/services/settingsService').setCacheFromRows([]);
  });

  beforeEach(async () => {
    sentMails.length = 0;
    const role = await pool.request().query('SELECT TOP 1 role_id FROM Role_permission ORDER BY role_id');
    secret = mfa.generateSecret();
    await pool.request().input('u', USERNAME).query('DELETE FROM [User] WHERE username = @u');
    await pool.request()
      .input('u', USERNAME)
      .input('role', role.recordset[0].role_id)
      .input('hash', await ctrl.hashPasswordAsync(OLD))
      .input('secret', mfa.encryptSecret(secret))
      .query(`INSERT INTO [User] (username, role_id, name_th, email, password_hash, is_active, mfa_secret_enc, mfa_enabled,
                reset_token_hash, reset_token_expires, reset_token_purpose)
              VALUES (@u, @role, N'ทดสอบ', 'zz_chpw@example.invalid', @hash, 1, @secret, 1,
                REPLICATE('a', 64), DATEADD(HOUR, 1, GETDATE()), 'PASSWORD')`);
    authMw.clearAuthCache(USERNAME);
  });

  after(async () => {
    if (!pool) return;
    await pool.request().input('u', USERNAME).query('DELETE FROM [User] WHERE username = @u');
    await pool.close();
  });

  it('success: new password works, old one and old tokens stop working, this device gets a new token, owner is emailed', async () => {
    const before = (await pool.request().input('u', USERNAME).query('SELECT * FROM [User] WHERE username = @u')).recordset[0];
    const oldToken = tokenFor(before);
    assert.equal(await tryApi(oldToken), true);

    const res = await call({ current_password: OLD, new_password: NEW, confirm_password: NEW, code: codeFor() }, USERNAME);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.ok(res.body.token);

    authMw.clearAuthCache(USERNAME);
    assert.equal(await tryApi(oldToken), false, 'token เก่า (เครื่องอื่น) ใช้ไม่ได้');
    assert.equal(await tryApi(res.body.token), true, 'token ใหม่ของเครื่องนี้ใช้ได้');
    assert.equal((await login(OLD)).statusCode, 401);
    assert.equal((await login(NEW)).statusCode, 200);
    assert.equal((await row()).reset_token_hash, null, 'ลิงก์ตั้งรหัสผ่านที่ค้างอยู่ใช้ไม่ได้แล้ว');

    await new Promise((r) => setImmediate(r));
    assert.equal(sentMails.length, 1);
    assert.equal(sentMails[0].to, 'zz_chpw@example.invalid');
    assert.match(sentMails[0].subject, /รหัสผ่านถูกเปลี่ยน/);
  });

  it('wrong current password: nothing changes, counts toward the account lock', async () => {
    const hashBefore = (await row()).password_hash;
    const res = await call({ current_password: 'Wrong!Pass9', new_password: NEW, confirm_password: NEW, code: codeFor() }, USERNAME);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.code, 'WRONG_PASSWORD');
    const r = await row();
    assert.equal(r.password_hash, hashBefore);
    assert.equal(r.failed_login_count, 1);

    for (let i = 0; i < 4; i += 1) await call({ current_password: 'Wrong!Pass9', new_password: NEW, confirm_password: NEW, code: codeFor() }, USERNAME);
    assert.equal((await row()).is_locked, 1, 'ผิดครบ 5 ครั้ง = ล็อคบัญชี เหมือนตอน login');
    assert.equal(sentMails.length, 0);
  });

  it('wrong or reused MFA code: nothing changes', async () => {
    const hashBefore = (await row()).password_hash;
    const wrong = await call({ current_password: OLD, new_password: NEW, confirm_password: NEW, code: '000000' }, USERNAME);
    assert.equal(wrong.statusCode, 401);
    assert.equal(wrong.body.code, 'MFA_INVALID');
    assert.equal((await row()).password_hash, hashBefore);

    const code = codeFor();
    assert.equal((await call({ current_password: OLD, new_password: NEW, confirm_password: NEW, code }, USERNAME)).statusCode, 200);
    const reuse = await call({ current_password: NEW, new_password: 'Third!Pass3', confirm_password: 'Third!Pass3', code }, USERNAME);
    assert.equal(reuse.body.code, 'MFA_INVALID', 'รหัส MFA ที่ใช้ไปแล้วใช้ซ้ำไม่ได้');
  });
});
