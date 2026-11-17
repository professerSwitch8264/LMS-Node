// TRUST_PROXY: IP ที่ express เห็น (req.ip) ใช้กับการแบนตาม IP ตอน login
process.env.LOG_LEVEL = 'error';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');
const { parseTrustProxy } = require('../src/config/proxy');

// เปิด server ชั่วคราว ส่ง X-Forwarded-For แล้วดูว่า req.ip เป็นอะไร
async function ipSeenBy(trustProxy, forwardedFor) {
  const app = express();
  if (trustProxy !== false) app.set('trust proxy', trustProxy);
  app.get('/', (req, res) => res.send(req.ip));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  try {
    return await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: server.address().port, path: '/', headers: { 'X-Forwarded-For': forwardedFor } }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve(body));
      }).on('error', reject);
    });
  } finally {
    server.close();
  }
}

describe('parseTrustProxy', () => {
  it('not set / 0 / false = no proxy', () => {
    assert.equal(parseTrustProxy(undefined), false);
    assert.equal(parseTrustProxy(''), false);
    assert.equal(parseTrustProxy('0'), false);
    assert.equal(parseTrustProxy('false'), false);
  });
  it('a number = hops; a list = trusted proxy addresses', () => {
    assert.equal(parseTrustProxy('1'), 1);
    assert.deepEqual(parseTrustProxy('loopback, 10.0.0.5'), ['loopback', '10.0.0.5']);
  });
  it('"true" (trust everyone) is turned into 1', () => {
    assert.equal(parseTrustProxy('true'), 1);
  });
});

describe('IP seen by the login rate limit', () => {
  it('without TRUST_PROXY a forged X-Forwarded-For is ignored', async () => {
    assert.match(await ipSeenBy(false, '203.0.113.9'), /127\.0\.0\.1$/);
  });
  it('behind one proxy the real client IP is used', async () => {
    assert.equal(await ipSeenBy(parseTrustProxy('1'), '203.0.113.9'), '203.0.113.9');
  });
  it('with one proxy, an extra forged entry from the client does not win', async () => {
    // ผู้ใช้ส่ง X-Forwarded-For ปลอมมาเอง proxy ต่อ IP จริงไว้ท้ายสุด → ใช้ตัวท้าย
    assert.equal(await ipSeenBy(parseTrustProxy('1'), '1.1.1.1, 203.0.113.9'), '203.0.113.9');
  });
});
