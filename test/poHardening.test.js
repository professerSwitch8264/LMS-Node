// ความถูกต้อง / ความเป็นส่วนตัวของข้อมูล PO
// - ส่วนแรก: ไม่ต้องใช้ฐานข้อมูล
// - ส่วนที่สอง: integration test รันกับฐานข้อมูลทดสอบเท่านั้น
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
process.env.DB_USER = process.env.DB_USER || 'test';
process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'test';
process.env.LOG_LEVEL = 'error';

const po = require('../src/controllers/poController');

describe('driver phone masking (no database)', () => {
  it('keeps the format and the last 2 digits only', () => {
    assert.equal(po.__test.maskTel('082-441-3550'), '•••-•••-••50');
    assert.equal(po.__test.maskTel('0812345678'), '••••••••78');
    assert.equal(po.__test.maskTel(''), '');
  });
});

function fakeRes() {
  return {
    statusCode: 200, body: null, headers: {}, locals: {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    set(k, v) { this.headers[k] = v; return this; },
  };
}

const ADMIN = { username: 'TESTER', effective: { isAdminSystem: true, perms: {} } };
const PICKER = { username: 'PICKER', effective: { isAdminSystem: false, perms: { canActionPicking: true, canActionLoading: true } } };

describe('PO integrity (database)', { skip: skipReason || false }, () => {
  let pool;
  const PO_NO = '4599999911';
  const call = async (factory, body, user = ADMIN) => {
    const res = fakeRes();
    await factory(null)({ body, user, query: {} }, res);
    return res;
  };
  const getOne = async (user = ADMIN) => {
    const res = fakeRes();
    await po.getPos({ user }, res);
    return res.body.data.find((p) => p.poNo === PO_NO);
  };
  const clean = () => pool.request().input('po', PO_NO).query(`
    DELETE t FROM PO_Transaction t JOIN PO p ON p.po_id = t.po_id WHERE p.PO_No IN (@po, '4599999912');
    DELETE FROM PO WHERE PO_No IN (@po, '4599999912')`);
  const car = { poNo: PO_NO, truckType: 'รถ 6 ล้อ', licensePlate: '1กข1234', driverName: 'สมชาย', driverTel: '082-441-3550', registerDate: '2030-01-01', registerTime: '08:00' };

  before(async () => {
    const db = require('../src/config/db');
    await db.initializeDatabase();
    pool = await db.getPool();
    await clean();
    const r = await call(po.createSaveOfficePoHandler, { poNo: PO_NO, customerName: 'ลูกค้า A', quantityOrder: '10', quantityUom: 'BOX', warehouseName: 'WH', shipToName: 'S' });
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  });

  after(async () => {
    if (!pool) return;
    await clean();
    await pool.close();
  });

  it('register-car does not create a PO that does not exist', async () => {
    const r = await call(po.createRegisterCarHandler, { ...car, poNo: '4599999912' });
    assert.equal(r.statusCode, 404);
    const n = (await pool.request().query("SELECT COUNT(*) n FROM PO WHERE PO_No = '4599999912'")).recordset[0].n;
    assert.equal(n, 0);
  });

  it('steps must follow the order on the server', async () => {
    assert.equal((await call(po.createTruckArrivalHandler, { poNo: PO_NO })).body.code, 'NOT_REGISTERED');
    assert.equal((await call(po.createAssignDockHandler, { poNo: PO_NO, dockDoorCode: 'D1' })).body.code, 'NOT_REGISTERED');
    assert.equal((await call(po.createRegisterCarHandler, car)).statusCode, 200);
    assert.equal((await call(po.createIssueTicketHandler, { poNo: PO_NO })).body.code, 'NOT_ARRIVED');
    assert.equal((await call(po.createTruckDepartureHandler, { poNo: PO_NO })).body.code, 'NOT_ARRIVED');
    assert.equal((await call(po.createOutsideTaskHandler, { poNo: PO_NO, taskTimestamps: { pickStart: '2030-01-01T09:00:00' } }, PICKER)).body.code, 'NOT_ARRIVED');

    assert.equal((await call(po.createTruckArrivalHandler, { poNo: PO_NO })).statusCode, 200);
    assert.equal((await call(po.createTruckArrivalHandler, { poNo: PO_NO })).body.code, 'ALREADY_ARRIVED');
    assert.equal((await call(po.createRegisterCarHandler, car)).body.code, 'ALREADY_ARRIVED', 'เปลี่ยนรถหลังรถเข้าไม่ได้');
  });

  it('a picker cannot overwrite office data, the car or the phone through outside-task', async () => {
    const r = await call(po.createOutsideTaskHandler, {
      poNo: PO_NO, customerName: 'แก้ชื่อ', quantityOrder: '999', licensePlate: 'XX-0000', driverTel: '•••-•••-••50',
      taskTimestamps: { pickStart: '2030-01-01T09:00:00' },
    }, PICKER);
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    const p = await getOne();
    assert.equal(p.customerName, 'ลูกค้า A');
    assert.equal(p.quantity, 10);
    assert.equal(p.licensePlate, '1กข1234');
    assert.equal(p.driverTel, '082-441-3550');
    assert.ok(p.pickStart, 'เวลาหยิบบันทึกได้');
  });

  it('driver phone is masked for users who cannot view the car plan', async () => {
    assert.equal((await getOne(ADMIN)).driverTel, '082-441-3550');
    assert.equal((await getOne(PICKER)).driverTel, '•••-•••-••50');
    const viewer = { username: 'V', effective: { isAdminSystem: false, perms: { canViewCarPlan: true } } };
    assert.equal((await getOne(viewer)).driverTel, '082-441-3550');
  });

  it('office save keeps the dock door and the stage of a planned round', async () => {
    await pool.request().input('po', PO_NO).query(`
      UPDATE t SET dock_door_code = 'D9', process_stage = 'WAIT_LOADING'
      FROM PO_Transaction t JOIN PO p ON p.po_id = t.po_id WHERE p.PO_No = @po AND t.is_current = 1`);
    const before = await getOne();
    const r = await call(po.createSaveOfficePoHandler, { receivedId: before.receivedId, poNo: PO_NO, customerName: 'ลูกค้า A', quantityOrder: '12', quantityUom: 'BOX', warehouseName: 'WH', shipToName: 'S' });
    assert.equal(r.statusCode, 200);
    const row = (await pool.request().input('po', PO_NO).query(`
      SELECT t.dock_door_code, t.process_stage FROM PO_Transaction t JOIN PO p ON p.po_id = t.po_id
      WHERE p.PO_No = @po AND t.is_current = 1`)).recordset[0];
    assert.equal(row.dock_door_code, 'D9');
    assert.equal(row.process_stage, 'WAIT_LOADING');
  });

  it('a write prepared for a round that was rescheduled meanwhile does not touch the old round', async () => {
    const newRequest = () => pool.request();
    const current = await po.__test.findPo(newRequest, { poNo: PO_NO });
    // จำลอง: ระหว่างนั้นมีคนเลื่อนแผน (รอบนี้ไม่ใช่รอบปัจจุบันแล้ว)
    await pool.request().input('tx', current.po_transaction_id).query("UPDATE PO_Transaction SET is_current = 0, tx_status = 'RESCHEDULED' WHERE po_transaction_id = @tx");
    assert.equal(await po.__test.completeCurrentTx(pool, current), false, 'ไม่ปิดรอบที่ถูกเลื่อนไปแล้ว');
    const r = (await pool.request().input('tx', current.po_transaction_id).query('SELECT truck_departure, tx_status FROM PO_Transaction WHERE po_transaction_id = @tx')).recordset[0];
    assert.equal(r.truck_departure, null);
    assert.equal(r.tx_status, 'RESCHEDULED');
  });
});
