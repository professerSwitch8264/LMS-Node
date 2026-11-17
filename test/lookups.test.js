// ตารางรายการตัวเลือก: หน่วยนับ (Uom), เหตุผลยกเลิก (Cancel_reason), เหตุผลเลื่อนแผน (Reschedule_reason)
// integration test — รันกับฐานข้อมูลทดสอบเท่านั้น
//   วิธีรัน (PowerShell):  $env:TEST_DB_NAME='LMS_TEST'; npm test
const path = require('path');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const TEST_DB = String(process.env.TEST_DB_NAME || '').trim();
const MAIN_DB = String(process.env.DB_NAME || 'LMS').trim();
const skipReason = !TEST_DB
  ? 'ตั้ง TEST_DB_NAME เพื่อรัน integration test'
  : (TEST_DB.toLowerCase() === MAIN_DB.toLowerCase() ? 'TEST_DB_NAME ต้องไม่ใช่ฐานข้อมูลเดียวกับ DB_NAME' : null);
if (!skipReason) process.env.DB_NAME = TEST_DB;
process.env.LOG_LEVEL = 'error';

function fakeRes() {
  return {
    statusCode: 200, body: null, headers: {}, locals: {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    set(k, v) { this.headers[k] = v; return this; },
  };
}

describe('lookup tables', { skip: skipReason || false }, () => {
  let pool;
  let master;
  let po;
  const PO_NO = '4599999901';
  const call = async (handler, body) => { const res = fakeRes(); await handler({ body, user: { username: 'TESTER' }, query: {} }, res); return res; };

  before(async () => {
    const db = require('../src/config/db');
    await db.initializeDatabase();
    pool = await db.getPool();
    master = require('../src/controllers/masterController');
    po = require('../src/controllers/poController');
    await pool.request().input('po', PO_NO).query('DELETE t FROM PO_Transaction t JOIN PO p ON p.po_id = t.po_id WHERE p.PO_No = @po; DELETE FROM PO WHERE PO_No = @po');
  });

  after(async () => {
    if (!pool) return;
    await pool.request().input('po', PO_NO).query('DELETE t FROM PO_Transaction t JOIN PO p ON p.po_id = t.po_id WHERE p.PO_No = @po; DELETE FROM PO WHERE PO_No = @po');
    await pool.close();
  });

  it('tables exist with default rows and no id column', async () => {
    const cols = (await pool.request().query(`
      SELECT OBJECT_NAME(object_id) AS t, name FROM sys.columns
      WHERE object_id IN (OBJECT_ID('Uom'), OBJECT_ID('Cancel_reason'), OBJECT_ID('Reschedule_reason'))`)).recordset;
    assert.deepEqual(cols.filter((c) => c.t === 'Uom').map((c) => c.name).sort(), ['uom_code', 'uom_name']);
    assert.deepEqual(cols.filter((c) => c.t === 'Cancel_reason').map((c) => c.name), ['reason_name']);
    assert.deepEqual(cols.filter((c) => c.t === 'Reschedule_reason').map((c) => c.name), ['reason_name']);

    const res = fakeRes();
    await master.getLookups({}, res);
    assert.equal(res.body.success, true);
    assert.deepEqual(res.body.data.uoms.map((u) => u.code).sort(), ['BDL', 'BOX', 'CTN']);
    assert.ok(res.body.data.cancelReasons.includes('เอกสารผิดพลาด'));
    assert.ok(res.body.data.rescheduleReasons.includes('รถเข้าช้า'));
  });

  it('seeding runs once: rows edited in the table are kept after restart', async () => {
    await pool.request().query("INSERT INTO Cancel_reason (reason_name) VALUES (N'ทดสอบเหตุผลใหม่')");
    await require('../src/config/lookupSchema').ensureLookupTables(pool);
    const r = await pool.request().query("SELECT COUNT(*) n FROM Cancel_reason WHERE reason_name = N'ทดสอบเหตุผลใหม่'");
    assert.equal(r.recordset[0].n, 1);
    await pool.request().query("DELETE FROM Cancel_reason WHERE reason_name = N'ทดสอบเหตุผลใหม่'");
  });

  it('office save rejects a unit that is not in Uom', async () => {
    const bad = await call(po.createSaveOfficePoHandler(null), { poNo: PO_NO, customerName: 'A', quantityOrder: '1', quantityUom: 'KG', warehouseName: 'W', shipToName: 'S' });
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.body.code, 'BAD_UOM');
    const ok = await call(po.createSaveOfficePoHandler(null), { poNo: PO_NO, customerName: 'A', quantityOrder: '1', quantityUom: 'box', warehouseName: 'W', shipToName: 'S' });
    assert.equal(ok.statusCode, 200, JSON.stringify(ok.body));
  });

  it('import rejects a unit that is not in Uom (nothing saved)', async () => {
    const res = await call(po.createImportOfficePoHandler(null), { items: [{ poNo: '4599999902', customerName: 'A', quantityOrder: 1, quantityUom: 'KG', warehouseName: 'W', shipToName: 'S', rows: [2] }] });
    assert.equal(res.statusCode, 400);
    assert.match(res.body.errors[0].problems[0], /KG/);
    assert.deepEqual(res.body.errors[0].rows, [2]);
  });

  it('cancel and reschedule need a reason from their table', async () => {
    const badReschedule = await call(po.createReschedulePoHandler(null), { poNo: PO_NO, rescheduleDate: '2030-01-05', rescheduleTime: '09:00', rescheduleReason: 'พิมพ์เอง' });
    assert.equal(badReschedule.body.code, 'BAD_REASON');
    const noReschedule = await call(po.createReschedulePoHandler(null), { poNo: PO_NO, rescheduleDate: '2030-01-05', rescheduleTime: '09:00' });
    assert.equal(noReschedule.body.code, 'BAD_REASON');

    const badCancel = await call(po.createCancelPoHandler(null), { poNo: PO_NO, reason: 'พิมพ์เอง' });
    assert.equal(badCancel.body.code, 'BAD_REASON');
    const noCancel = await call(po.createCancelPoHandler(null), { poNo: PO_NO });
    assert.equal(noCancel.body.code, 'BAD_REASON');

    // "อื่นๆ" ไม่อยู่ในตาราง: ต้องพิมพ์เหตุผลเอง (reasonIsOther) — ว่างไม่ได้
    const emptyOther = await call(po.createCancelPoHandler(null), { poNo: PO_NO, reason: '  ', reasonIsOther: true });
    assert.equal(emptyOther.body.code, 'BAD_REASON');
    const noOtherRow = await pool.request().query("SELECT COUNT(*) n FROM Cancel_reason WHERE reason_name LIKE N'อื่น%'");
    assert.equal(noOtherRow.recordset[0].n, 0, 'ไม่มี "อื่นๆ" ในตาราง');

    const ok = await call(po.createCancelPoHandler(null), { poNo: PO_NO, reason: 'เอกสารผิดพลาด' });
    assert.equal(ok.statusCode, 200, JSON.stringify(ok.body));
    const saved = await pool.request().input('po', PO_NO).query('SELECT cancle_reason FROM PO WHERE PO_No = @po');
    assert.equal(saved.recordset[0].cancle_reason, 'เอกสารผิดพลาด');

    // PO ใหม่ (เลขเดิมหลังยกเลิก) ยกเลิกด้วยเหตุผลที่พิมพ์เอง
    await call(po.createSaveOfficePoHandler(null), { poNo: PO_NO, customerName: 'A', quantityOrder: '1', quantityUom: 'BOX', warehouseName: 'W', shipToName: 'S' });
    const other = await call(po.createCancelPoHandler(null), { poNo: PO_NO, reason: 'ลูกค้าขอเปลี่ยนสินค้า', reasonIsOther: true });
    assert.equal(other.statusCode, 200, JSON.stringify(other.body));
    const saved2 = await pool.request().input('po', PO_NO).query("SELECT TOP 1 cancle_reason FROM PO WHERE PO_No = @po ORDER BY po_id DESC");
    assert.equal(saved2.recordset[0].cancle_reason, 'ลูกค้าขอเปลี่ยนสินค้า');
  });
});
