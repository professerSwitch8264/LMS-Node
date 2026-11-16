// ทดสอบ level log — ไม่ต้องใช้ฐานข้อมูล
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
const { redact } = require('../src/utils/logger');

const LOGGER = path.join(__dirname, '..', 'src', 'utils', 'logger.js').replace(/\\/g, '/');

const runWithLevel = (level) => {
  const script = `const { logger } = require('${LOGGER}');
    logger.debug('d-line'); logger.info('i-line'); logger.warn('w-line'); logger.error('e-line');`;
  const out = spawnSync(process.execPath, ['-e', script], { env: { ...process.env, LOG_LEVEL: level }, encoding: 'utf8' });
  return `${out.stdout}${out.stderr}`;
};

describe('logger', () => {
  it('hides secrets but keeps normal fields', () => {
    const clean = redact({ password: 'x', token: 'y', mfaSecret: 'z', code: '123456', dockDoorCode: 'D1', nested: { refreshToken: 'q', poNo: 'PO1' } });
    assert.equal(clean.password, '[hidden]');
    assert.equal(clean.token, '[hidden]');
    assert.equal(clean.mfaSecret, '[hidden]');
    assert.equal(clean.code, '[hidden]');
    assert.equal(clean.dockDoorCode, 'D1');
    assert.equal(clean.nested.refreshToken, '[hidden]');
    assert.equal(clean.nested.poNo, 'PO1');
  });

  it('LOG_LEVEL=warn prints only warn and error', () => {
    const out = runWithLevel('warn');
    assert.equal(out.includes('d-line'), false);
    assert.equal(out.includes('i-line'), false);
    assert.match(out, /WARN\s+w-line/);
    assert.match(out, /ERROR e-line/);
  });

  it('LOG_LEVEL=debug prints everything', () => {
    const out = runWithLevel('debug');
    ['d-line', 'i-line', 'w-line', 'e-line'].forEach((line) => assert.equal(out.includes(line), true));
  });
});
