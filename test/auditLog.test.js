// ทดสอบ audit log ฝั่ง backend — ไม่ต้องใช้ฐานข้อมูล
process.env.DB_USER = process.env.DB_USER || 'test';
process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'test';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { PO, DOOR, USER, dateTimeText } = require('../src/services/auditEvents');
const { getAuditLogs, visibleSides } = require('../src/controllers/auditLogController');

const fakeRes = () => {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
};

describe('audit events (built from the request, not from the browser)', () => {
  it('car plan keeps the old wording and Thai date', () => {
    const entry = PO.saveCarPlan({ body: { poNo: 'PO1', licensePlate: '1กข 1234', driverName: 'สมชาย', driverTel: '0812345678', registerDate: '2026-11-16', registerTime: '08:30' } });
    assert.equal(entry.actionType, 'SAVE_CAR_PLAN');
    assert.equal(entry.poNo, 'PO1');
    assert.equal(entry.details, 'ทะเบียน 1กข 1234 คนขับ สมชาย โทร 0812345678 เวลารถเข้า 16/11/2569 08:30 น.');
  });

  it('batch actions skip POs the handler reported as not found', () => {
    const entries = PO.cancel({ body: { poNos: ['PO1', 'PO2', 'PO3'], reason: 'ลูกค้ายกเลิก' } }, { notFound: ['po2'] });
    assert.deepEqual(entries.map((e) => e.poNo), ['PO1', 'PO3']);
    assert.equal(entries[0].details, 'ยกเลิกรายการ PO เนื่องจาก: ลูกค้ายกเลิก');
  });

  it('pick/load only logs whitelisted task ids', () => {
    assert.equal(PO.outsideTask({ body: { poNo: 'PO1', taskId: 'pickStart' } }).actionType, 'ACTION_PICKSTART');
    assert.equal(PO.outsideTask({ body: { poNo: 'PO1', taskId: 'DROP TABLE' } }), null);
    assert.equal(PO.outsideTask({ body: { poNo: 'PO1' } }), null);
  });

  it('create vs update PO depends on receivedId', () => {
    assert.equal(PO.officeSave({ body: { poNo: 'PO9', quantityOrder: 1500, quantityUom: 'KG' } }).actionType, 'CREATE_PO');
    const update = PO.officeSave({ body: { receivedId: 5, poNo: 'PO9', quantityOrder: 1500, quantityUom: 'KG', shipToName: 'คลัง A' } });
    assert.equal(update.actionType, 'UPDATE_PO');
    assert.equal(update.details, 'แก้ไข PO PO9 สถานที่จัดส่ง คลัง A จำนวน 1,500 KG');
  });

  it('never puts the password into user audit details', () => {
    const entry = USER.update({ params: { username: 'wtf001' }, body: { password: 'Secret!234', role_id: 'admin_warehouse' } });
    assert.equal(entry.details.includes('Secret'), false);
    assert.equal(entry.details, 'แก้ไขข้อมูลของ WTF001 กลุ่มผู้ใช้งาน ADMIN_WAREHOUSE');
  });

  it('door lock wording', () => {
    assert.equal(DOOR.toggleLock({ body: { dockDoorCode: 'D1', isLocked: true } }).details, 'สั่งล็อค ประตู D1');
  });

  it('dateTimeText falls back to "-"', () => {
    assert.equal(dateTimeText('', ''), '-');
    assert.equal(dateTimeText('2026-01-05', ''), '05/01/2569');
  });
});

describe('GET /audit-logs access', () => {
  it('without canViewAuditLog the full log is forbidden', async () => {
    const res = fakeRes();
    await getAuditLogs({ query: {}, user: { effective: { isAdminSystem: false, perms: { canViewAuditLog: false } } } }, res);
    assert.equal(res.statusCode, 403);
  });

  it('visibility is by the side of the person who saved the entry (see test/userSide.test.js)', () => {
    assert.deepEqual(visibleSides({ isAdminSystem: false, perms: { canViewAuditLogYusen: true, canViewAuditLogWanthai: false, canViewAuditLogDx: false } }), ['YUSEN']);
  });
});
