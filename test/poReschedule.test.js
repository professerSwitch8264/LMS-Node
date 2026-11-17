// เลื่อนแผนรถเข้า (PO + PO_Transaction): การแปลงข้อมูลรอบ, เงื่อนไขเลื่อนได้, ข้อความ audit — ไม่ต้องใช้ฐานข้อมูล
// flow จริงกับฐานข้อมูล (migration / เลื่อนหลายรอบ / ปลดประตู) ทดสอบกับฐานข้อมูลทดสอบแยก
process.env.DB_USER = process.env.DB_USER || 'test';
process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'test';
process.env.LOG_LEVEL = 'error';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { mapPoRow, isCarPlanFilled } = require('../src/controllers/poController');
const { PO } = require('../src/services/auditEvents');

const baseRow = {
  received_id: 7, po_id: 7, PO_No: '1234567890', quantity: 10, customer_Name: 'ลูกค้า', ship_to_name: 'คลัง',
  process_stage: 'WAIT_CAR_PLAN', po_transaction_id: 21, is_current: true, tx_status: 'ACTIVE',
};

describe('mapPoRow: รอบรถ', () => {
  it('รอบแรก: ไม่ใช่รอบเลื่อนแผน', () => {
    const po = mapPoRow({ ...baseRow, round_no: 1 });
    assert.equal(po.roundNo, 1);
    assert.equal(po.isRescheduled, false);
    assert.equal(po.rescheduleCount, 0);
    assert.equal(po.transactionId, 21);
    assert.equal('rescheduleDate' in po, false, 'ไม่มีฟิลด์วันที่เลื่อนแยกแล้ว');
  });

  it('รอบที่เกิดจากการเลื่อน: แผนใหม่อยู่ใน registerDate และกลับไปขั้นแผนรถเข้า', () => {
    const po = mapPoRow({
      ...baseRow, round_no: 3, rescheduled_from_id: 20, reschedule_reason: 'รถเสีย', rescheduled_by: 'ADMIN',
      register_date: new Date(2030, 0, 5, 9, 30), register_str: '2030-01-05 09:30:00', register_date_str: '2030-01-05', register_time_str: '09:30',
    });
    assert.equal(po.isRescheduled, true);
    assert.equal(po.rescheduleCount, 2);
    assert.equal(po.rescheduleReason, 'รถเสีย');
    assert.equal(po.registerDateStr, '2030-01-05');
    assert.equal(po.registerTime, '09:30');
    assert.equal(po.processStage, 'WAIT_CAR_PLAN');
    assert.equal(po.licensePlate, '');
  });
});

describe('isCarPlanFilled: เลื่อนแผนได้เมื่อกรอกแผนรถเข้าครบ', () => {
  const full = { truck_type: '6 ล้อ', license: '1กข1234', driver_name: 'สมชาย', driver_tel: '0812345678', register_date: new Date() };
  it('ครบ = เลื่อนได้', () => assert.equal(isCarPlanFilled(full), true));
  it('รอบใหม่หลังเลื่อน (ยังไม่มีรถ) = เลื่อนซ้ำไม่ได้', () => {
    assert.equal(isCarPlanFilled({ register_date: new Date() }), false);
    assert.equal(isCarPlanFilled({ ...full, license: '-' }), false);
    assert.equal(isCarPlanFilled({ ...full, driver_tel: '' }), false);
  });
});

describe('audit: เลื่อนแผน', () => {
  it('บันทึกแผนเดิม แผนใหม่ และเหตุผล (ไม่ใส่ข้อมูลรถเดิม)', () => {
    const req = {
      body: { poNo: '1234567890', rescheduleDate: '2030-01-05', rescheduleTime: '09:30', rescheduleReason: 'ลูกค้าขอเลื่อน' },
      res: { locals: { rescheduledPrevious: [{ poNo: '1234567890', previous: { register_str: '2030-01-01 08:00:00', license: '1กข1234', driver_name: 'สมชาย', driver_tel: '0812345678' } }] } },
    };
    const [entry] = PO.reschedule(req, { success: true, notFound: [] });
    assert.equal(entry.actionType, 'RESCHEDULE_PO');
    assert.match(entry.details, /จาก 01\/01\/2573 08:00 น\. เป็น 05\/01\/2573 09:30 น\./);
    assert.match(entry.details, /เหตุผล: ลูกค้าขอเลื่อน$/);
    assert.doesNotMatch(entry.details, /ทะเบียน|คนขับ|โทร/);
  });

  it('PO ที่เลื่อนไม่ได้ (อยู่ใน notFound) ไม่บันทึก', () => {
    const req = { body: { poNos: ['A', 'B'], rescheduleDate: '2030-01-05', rescheduleTime: '09:30' }, res: { locals: {} } };
    const entries = PO.reschedule(req, { success: true, notFound: ['B'] });
    assert.deepEqual(entries.map((e) => e.poNo), ['A']);
  });
});
