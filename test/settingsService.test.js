// ทดสอบค่าตั้งจากตาราง Setting — ไม่ต้องใช้ฐานข้อมูล (ใส่ค่าลง cache ตรงๆ)
process.env.DB_USER = process.env.DB_USER || 'test';
process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'test';
process.env.LOG_LEVEL = 'error';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { DEFINITIONS, getSetting, setCacheFromRows, loadSettings } = require('../src/services/settingsService');
const LOCKOUT = require('../src/config/lockout');
const MFA = require('../src/config/mfa');

const ENV_KEYS = DEFINITIONS.map((d) => d.env);
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const resetEnv = () => ENV_KEYS.forEach((k) => {
  if (savedEnv[k] === undefined) delete process.env[k];
  else process.env[k] = savedEnv[k];
});

describe('settingsService', () => {
  beforeEach(() => {
    resetEnv();
    ENV_KEYS.forEach((k) => delete process.env[k]);
    setCacheFromRows([]);
  });

  it('has the 11 login / account security settings', () => {
    assert.equal(DEFINITIONS.length, 11);
  });

  it('uses the value from the table', () => {
    setCacheFromRows([{ setting_key: 'ACCOUNT_LOCKOUT_MAX_FAILS', setting_value: '3' }]);
    assert.equal(getSetting('ACCOUNT_LOCKOUT_MAX_FAILS'), 3);
    assert.equal(LOCKOUT.MAX_FAILS, 3, 'config getters read the current value');
  });

  it('no row → .env value → built-in default', () => {
    assert.equal(getSetting('MFA_MAX_FAILS'), 5);
    process.env.MFA_MAX_FAILS = '7';
    assert.equal(getSetting('MFA_MAX_FAILS'), 7);
    assert.equal(MFA.MFA_MAX_FAILS, 7);
  });

  it('out-of-range values are clamped', () => {
    setCacheFromRows([
      { setting_key: 'MFA_MAX_FAILS', setting_value: '999' },
      { setting_key: 'PASSWORD_RESET_EXPIRES_MINUTES', setting_value: '1' },
    ]);
    assert.equal(getSetting('MFA_MAX_FAILS'), 20);
    assert.equal(getSetting('PASSWORD_RESET_EXPIRES_MINUTES'), 5);
  });

  it('a non-number in the table falls back instead of breaking login', () => {
    setCacheFromRows([{ setting_key: 'LOGIN_MAX_FAILS_PER_IP', setting_value: 'abc' }]);
    assert.equal(getSetting('LOGIN_MAX_FAILS_PER_IP'), 20);
    process.env.LOGIN_MAX_FAILS_PER_IP = '30';
    assert.equal(getSetting('LOGIN_MAX_FAILS_PER_IP'), 30);
  });

  it('SESSION_HOURS understands the old JWT_EXPIRES_IN formats', () => {
    for (const [raw, hours] of [['12h', 12], ['1d', 24], ['90m', 2], ['7200', 2], ['bad', 12]]) {
      process.env.JWT_EXPIRES_IN = raw;
      assert.equal(getSetting('SESSION_HOURS'), hours, raw);
    }
  });

  it('unknown keys throw (typo protection)', () => {
    assert.throws(() => getSetting('NOT_A_SETTING'));
  });

  it('a failed reload keeps the last good values', async () => {
    setCacheFromRows([{ setting_key: 'ACCOUNT_LOCKOUT_MINUTES', setting_value: '45' }]);
    const brokenPool = { request: () => ({ query: async () => { throw new Error('db down'); } }) };
    assert.equal(await loadSettings(brokenPool), false);
    assert.equal(getSetting('ACCOUNT_LOCKOUT_MINUTES'), 45);
  });

  it('a successful reload replaces the cache', async () => {
    const pool = { request: () => ({ query: async () => ({ recordset: [{ setting_key: 'ACCOUNT_LOCKOUT_MINUTES', setting_value: '60' }] }) }) };
    assert.equal(await loadSettings(pool), true);
    assert.equal(LOCKOUT.LOCK_MINUTES, 60);
  });
});
