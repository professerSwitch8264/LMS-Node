// ทดสอบส่วนคำนวณของ MFA — ไม่ต้องใช้ฐานข้อมูล
process.env.DB_USER = process.env.DB_USER || 'test';
process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'test';
process.env.MFA_ENCRYPTION_KEY = require('crypto').randomBytes(32).toString('base64');

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { authenticator } = require('otplib');
const mfa = require('../src/services/mfaService');

const codeAt = (secret, ms) => authenticator.clone({ epoch: ms }).generate(secret);

describe('mfaService', () => {
  it('encrypts and decrypts the secret, with a fresh IV every time', () => {
    const secret = mfa.generateSecret();
    const a = mfa.encryptSecret(secret);
    const b = mfa.encryptSecret(secret);
    assert.notEqual(a, b);
    assert.equal(mfa.decryptSecret(a), secret);
    assert.equal(mfa.decryptSecret(b), secret);
  });

  it('rejects a tampered ciphertext (GCM auth tag)', () => {
    const enc = mfa.encryptSecret(mfa.generateSecret());
    const [iv, tag, data] = enc.split(':');
    const flipped = Buffer.from(data, 'base64');
    flipped[0] ^= 1;
    assert.throws(() => mfa.decryptSecret([iv, tag, flipped.toString('base64')].join(':')));
  });

  it('accepts the current code and ±1 time step, rejects ±2', () => {
    const secret = mfa.generateSecret();
    const now = Date.now();
    assert.equal(mfa.verifyCode(secret, codeAt(secret, now), null, now).ok, true);
    assert.equal(mfa.verifyCode(secret, codeAt(secret, now - 30000), null, now).ok, true);
    assert.equal(mfa.verifyCode(secret, codeAt(secret, now + 30000), null, now).ok, true);
    assert.equal(mfa.verifyCode(secret, codeAt(secret, now - 60000), null, now).ok, false);
  });

  it('rejects a code from a time step that was already used (replay)', () => {
    const secret = mfa.generateSecret();
    const now = Date.now();
    const first = mfa.verifyCode(secret, codeAt(secret, now), null, now);
    assert.equal(first.ok, true);
    assert.equal(mfa.verifyCode(secret, codeAt(secret, now), first.step, now).ok, false);
    assert.equal(mfa.verifyCode(secret, codeAt(secret, now - 30000), first.step, now).ok, false);
  });

  it('rejects malformed codes', () => {
    const secret = mfa.generateSecret();
    for (const bad of ['', '12345', '1234567', 'abcdef', null, undefined]) {
      assert.equal(mfa.verifyCode(secret, bad).ok, false, String(bad));
    }
  });

  it('builds a QR code data URL', async () => {
    const url = await mfa.buildQrDataUrl('USER1', mfa.generateSecret());
    assert.match(url, /^data:image\/png;base64,/);
  });
});
