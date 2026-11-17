// error 500 ต้องไม่ส่งรายละเอียดภายใน (ข้อความจาก SQL / stack) กลับไปให้หน้าเว็บ — เก็บไว้ใน log ฝั่ง server เท่านั้น
process.env.LOG_LEVEL = 'silent';

const fs = require('fs');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { hideInternalErrors } = require('../src/middleware/errorHandling');

function run(status, body) {
  let sent;
  const res = { statusCode: status, json: (b) => { sent = b; return res; } };
  hideInternalErrors({ method: 'GET', originalUrl: '/api/x' }, res, () => {});
  res.json(body);
  return sent;
}

describe('hideInternalErrors', () => {
  it('removes internal fields from 5xx responses', () => {
    const sent = run(500, { success: false, error: "Invalid object name 'V_PO_Current'.", stack: 'at ...', message: 'บันทึกไม่สำเร็จ' });
    assert.deepEqual(sent, { success: false, message: 'บันทึกไม่สำเร็จ' });
  });

  it('keeps 4xx responses as they are (messages meant for the user)', () => {
    const body = { success: false, code: 'BAD_REASON', error: 'กรุณาเลือกเหตุผลการยกเลิกจากรายการ' };
    assert.deepEqual(run(400, body), body);
  });

  it('is installed before the API routes in server.js', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const hideAt = src.indexOf('app.use(hideInternalErrors)');
    const apiAt = src.indexOf("app.use('/api'");
    assert.ok(hideAt > 0 && apiAt > 0 && hideAt < apiAt, 'app.use(hideInternalErrors) ต้องอยู่ก่อน app.use(\'/api\', ...)');
  });
});
