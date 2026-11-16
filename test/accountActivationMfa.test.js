// Integration test: เปิด/ปิดใช้งานบัญชี + MFA — รันกับฐานข้อมูลทดสอบเท่านั้น
// วิธีรัน (PowerShell):  $env:TEST_DB_NAME='LMS_TEST'; npm test
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
process.env.JWT_SECRET = crypto.randomBytes(48).toString('hex');
process.env.MFA_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
process.env.MFA_MAX_FAILS = '5';

// ไม่ส่งอีเมลจริง: เก็บอีเมลไว้ตรวจลิงก์แทน (ต้องแทนก่อนโหลด controller)
const sentMails = [];
const mailService = require('../src/services/mailService');
mailService.sendMail = async (mail) => { sentMails.push(mail); };
mailService.isMailConfigured = () => true;

const PREFIX = 'ZZ_MFA_';
const LEGACY = `${PREFIX}LEGACY`;
const NEWBIE = `${PREFIX}NEW`;
const ADMIN = `${PREFIX}ADMIN`;
const PASSWORD = 'Start!Pass1';
const NEW_PASSWORD = 'Fresh!Pass2';

function fakeRes() {
  return {
    statusCode: 200, headers: {}, body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    set(key, value) { this.headers[key] = value; return this; },
  };
}

describe('account activation + MFA', { skip: skipReason || false }, () => {
  let pool;
  let ctrl;
  let authMw;
  let authCfg;
  let authenticator;

  const call = async (handler, req) => { const res = fakeRes(); await handler({ params: {}, body: {}, ...req }, res); return res; };
  const login = (username, password) => call(ctrl.loginUser, { body: { username, password } });
  const codeFor = (secret, offsetSteps = 0) => authenticator.clone({ epoch: Date.now() + offsetSteps * 30000 }).generate(secret);
  const lastLink = () => {
    const m = String(sentMails[sentMails.length - 1]?.text || '').match(/reset_token=([a-f0-9]{64})/);
    return m ? m[1] : null;
  };
  // เรียก middleware authenticate จริง: คืน { status, code }
  const tryApi = async (token) => {
    const res = fakeRes();
    let passed = false;
    await authMw.authenticate({ headers: { authorization: `Bearer ${token}` } }, res, () => { passed = true; });
    return passed ? { status: 200 } : { status: res.statusCode, code: res.body?.code };
  };
  const setUser = (username, sqlSet) => pool.request().input('u', username).query(`UPDATE [User] SET ${sqlSet} WHERE username = @u`);
  const row = async (username) => (await pool.request().input('u', username)
    .query('SELECT is_active, mfa_enabled, mfa_secret_enc, reset_token_purpose FROM [User] WHERE username = @u')).recordset[0];

  // login ให้สำเร็จทั้ง 2 ขั้น (ผูก MFA ถ้ายังไม่ผูก) แล้วคืน { token, secret }
  async function fullLogin(username, password, existingSecret = null) {
    const step1 = await login(username, password);
    assert.equal(step1.statusCode, 200, JSON.stringify(step1.body));
    let secret = existingSecret;
    if (step1.body.mfa === 'SETUP') {
      const setup = await call(ctrl.loginMfaSetup, { body: { mfaToken: step1.body.mfaToken } });
      assert.equal(setup.statusCode, 200);
      secret = setup.body.data.secret;
    }
    await setUser(username, 'mfa_last_step = NULL');
    const verify = await call(ctrl.loginMfaVerify, { body: { mfaToken: step1.body.mfaToken, code: codeFor(secret) } });
    assert.equal(verify.statusCode, 200, JSON.stringify(verify.body));
    return { token: verify.body.token, secret };
  }

  before(async () => {
    ({ authenticator } = require('otplib'));
    const db = require('../src/config/db');
    ctrl = require('../src/controllers/userController');
    authMw = require('../src/middleware/auth');
    authCfg = require('../src/config/auth');
    await db.initializeDatabase();
    await ctrl.ensureUserTable();
    pool = await db.getPool();
  });

  beforeEach(async () => {
    sentMails.length = 0;
    const role = (await pool.request().query('SELECT TOP 1 role_id FROM Role_permission ORDER BY role_id')).recordset[0].role_id;
    const hash = await ctrl.hashPasswordAsync(PASSWORD);
    await pool.request().query(`DELETE FROM [User] WHERE username LIKE '${PREFIX}%'`);
    for (const [username, active] of [[LEGACY, 1], [NEWBIE, 0]]) {
      await pool.request()
        .input('u', username).input('role', role).input('hash', hash).input('active', active)
        .query(`INSERT INTO [User] (username, role_id, name_th, name_en, email, password_hash, is_active)
                VALUES (@u, @role, N'ทดสอบ', 'Test', '${username.toLowerCase()}@example.invalid', @hash, @active)`);
    }
    authMw.clearAuthCache();
  });

  after(async () => {
    if (!pool) return;
    await pool.request().query(`DELETE FROM [User] WHERE username LIKE '${PREFIX}%'`);
    await pool.close();
  });

  it('existing active account links MFA at login; the pending token cannot call APIs', async () => {
    const step1 = await login(LEGACY, PASSWORD);
    assert.equal(step1.statusCode, 200);
    assert.equal(step1.body.mfa, 'SETUP');
    assert.equal(step1.body.token, undefined);
    assert.equal((await tryApi(step1.body.mfaToken)).status, 401);

    const setup = await call(ctrl.loginMfaSetup, { body: { mfaToken: step1.body.mfaToken } });
    assert.match(setup.body.data.qrDataUrl, /^data:image\/png;base64,/);

    const wrong = await call(ctrl.loginMfaVerify, { body: { mfaToken: step1.body.mfaToken, code: '000000' } });
    assert.equal(wrong.statusCode, 401);

    const ok = await call(ctrl.loginMfaVerify, { body: { mfaToken: step1.body.mfaToken, code: codeFor(setup.body.data.secret) } });
    assert.equal(ok.statusCode, 200);
    assert.equal((await tryApi(ok.body.token)).status, 200);
    assert.equal(ok.body.data.mfa_secret_enc, undefined);
    assert.equal(ok.body.data.password_hash, undefined);

    const again = await login(LEGACY, PASSWORD);
    assert.equal(again.body.mfa, 'VERIFY');
    const setupAgain = await call(ctrl.loginMfaSetup, { body: { mfaToken: again.body.mfaToken } });
    assert.equal(setupAgain.statusCode, 409);
  });

  it('a code cannot be used twice', async () => {
    const { secret } = await fullLogin(LEGACY, PASSWORD);
    const code = codeFor(secret, 1);
    const first = await login(LEGACY, PASSWORD);
    assert.equal((await call(ctrl.loginMfaVerify, { body: { mfaToken: first.body.mfaToken, code } })).statusCode, 200);
    const second = await login(LEGACY, PASSWORD);
    assert.equal((await call(ctrl.loginMfaVerify, { body: { mfaToken: second.body.mfaToken, code } })).statusCode, 401);
  });

  it('disabled account looks like wrong credentials and does not count failed logins', async () => {
    for (const pw of ['Wrong!Pass9', PASSWORD]) {
      const res = await login(NEWBIE, pw);
      assert.equal(res.statusCode, 401);
      assert.equal(res.body.code, 'INVALID_CREDENTIALS');
      assert.equal(res.body.mfaToken, undefined);
    }
    const count = (await pool.request().input('u', NEWBIE)
      .query('SELECT ISNULL(failed_login_count, 0) AS failed_login_count FROM [User] WHERE username = @u')).recordset[0].failed_login_count;
    assert.equal(count, 0);
  });

  it('admin activates → email link: set password → link MFA → log in', async () => {
    const act = await call(ctrl.setUserActive, { params: { username: NEWBIE }, body: { active: true }, user: { username: ADMIN } });
    assert.equal(act.statusCode, 200, JSON.stringify(act.body));
    const link = lastLink();
    assert.ok(link);
    assert.match(sentMails[0].subject, /เปิดใช้งานบัญชี/);

    // ระหว่างรอทำตามอีเมล login ไม่ได้
    assert.equal((await login(NEWBIE, PASSWORD)).body.code, 'SETUP_VIA_EMAIL');

    const info = await call(ctrl.verifyPasswordResetToken, { body: { token: link } });
    assert.equal(info.body.data.purpose, 'ACTIVATE');
    assert.equal((await call(ctrl.resetLinkMfaSetup, { body: { token: link } })).statusCode, 400);

    const pw = await call(ctrl.confirmPasswordReset, { body: { token: link, password: NEW_PASSWORD, confirm_password: NEW_PASSWORD } });
    assert.equal(pw.body.next, 'MFA');
    const setup = await call(ctrl.resetLinkMfaSetup, { body: { token: link } });
    assert.equal(setup.statusCode, 200);
    const done = await call(ctrl.resetLinkMfaVerify, { body: { token: link, code: codeFor(setup.body.data.secret) } });
    assert.equal(done.statusCode, 200, JSON.stringify(done.body));

    // ลิงก์ใช้ซ้ำไม่ได้
    assert.equal((await call(ctrl.verifyPasswordResetToken, { body: { token: link } })).statusCode, 400);

    assert.equal((await login(NEWBIE, PASSWORD)).statusCode, 401);
    const step1 = await login(NEWBIE, NEW_PASSWORD);
    assert.equal(step1.body.mfa, 'VERIFY');
    const ok = await call(ctrl.loginMfaVerify, { body: { mfaToken: step1.body.mfaToken, code: codeFor(setup.body.data.secret, 1) } });
    assert.equal(ok.statusCode, 200);
  });

  it('admin deactivates → the user is kicked out immediately', async () => {
    const { token } = await fullLogin(LEGACY, PASSWORD);
    assert.equal((await tryApi(token)).status, 200);
    const off = await call(ctrl.setUserActive, { params: { username: LEGACY }, body: { active: false }, user: { username: ADMIN } });
    assert.equal(off.statusCode, 200);
    assert.deepEqual(await tryApi(token), { status: 401, code: 'ACCOUNT_DISABLED' });
    assert.equal((await login(LEGACY, PASSWORD)).body.code, 'INVALID_CREDENTIALS');
  });

  it('admin cannot reset their own MFA', async () => {
    const self = await call(ctrl.resetUserMfa, { params: { username: LEGACY }, user: { username: LEGACY } });
    assert.equal(self.statusCode, 400);
    assert.equal(self.body.code, 'CANNOT_CHANGE_SELF');
    assert.equal(sentMails.length, 0);
  });

  it('admin cannot deactivate their own account', async () => {
    const self = await call(ctrl.setUserActive, { params: { username: LEGACY }, body: { active: false }, user: { username: LEGACY } });
    assert.equal(self.statusCode, 400);
    assert.equal((await row(LEGACY)).is_active, true);
  });

  it('admin resets MFA → old token revoked, email link links a new phone, password unchanged', async () => {
    const { token } = await fullLogin(LEGACY, PASSWORD);
    const reset = await call(ctrl.resetUserMfa, { params: { username: LEGACY }, user: { username: ADMIN } });
    assert.equal(reset.statusCode, 200);
    assert.equal((await tryApi(token)).status, 401);
    assert.equal((await login(LEGACY, PASSWORD)).body.code, 'SETUP_VIA_EMAIL');

    const link = lastLink();
    assert.equal((await call(ctrl.confirmPasswordReset, { body: { token: link, password: NEW_PASSWORD, confirm_password: NEW_PASSWORD } })).statusCode, 400);
    const setup = await call(ctrl.resetLinkMfaSetup, { body: { token: link } });
    const done = await call(ctrl.resetLinkMfaVerify, { body: { token: link, code: codeFor(setup.body.data.secret) } });
    assert.equal(done.statusCode, 200);
    assert.equal((await login(LEGACY, PASSWORD)).body.mfa, 'VERIFY');
  });

  it('5 wrong MFA codes lock it; while locked even the right code fails', async () => {
    const { secret } = await fullLogin(LEGACY, PASSWORD);
    const step1 = await login(LEGACY, PASSWORD);
    const codes = [];
    for (let i = 0; i < 5; i += 1) {
      codes.push((await call(ctrl.loginMfaVerify, { body: { mfaToken: step1.body.mfaToken, code: '000000' } })).statusCode);
    }
    assert.deepEqual(codes, [401, 401, 401, 401, 423]);
    await setUser(LEGACY, 'mfa_last_step = NULL');
    const locked = await call(ctrl.loginMfaVerify, { body: { mfaToken: step1.body.mfaToken, code: codeFor(secret) } });
    assert.equal(locked.statusCode, 423);
    assert.equal(locked.body.code, 'MFA_LOCKED');
  });

  it('a token without MFA (old format) is rejected', async () => {
    const jwt = require('jsonwebtoken');
    const r = (await pool.request().input('u', LEGACY).query('SELECT password_hash FROM [User] WHERE username = @u')).recordset[0];
    const oldToken = jwt.sign(
      { sub: LEGACY, role: 'X', pv: authCfg.passwordVersion(r.password_hash) },
      process.env.JWT_SECRET,
      { algorithm: 'HS256', expiresIn: '1h', issuer: 'wanthai-lms' },
    );
    assert.equal((await tryApi(oldToken)).status, 401);
  });
});
