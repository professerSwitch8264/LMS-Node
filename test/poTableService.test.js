// ทดสอบตาราง PO ฝั่ง server (ค้นหา / กรอง / เรียง / แบ่งหน้า) — ไม่ต้องใช้ฐานข้อมูล
process.env.DB_USER = process.env.DB_USER || 'test';
process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'test';
process.env.LOG_LEVEL = 'error';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseTableQuery, queryPoTable } = require('../src/services/poTableService');

const plan = { quantityOrder: '10', quantityUom: 'CTN', shipToCode: 'S1', licensePlate: '1กข 1234', driverName: 'สมชาย', driverTel: '0812345678', truckType: '6 ล้อ', truckTypeId: 1, registerDate: '2020-01-15', registerTime: '08:00' };
const pos = [
  { poNo: 'PO003', customerName: 'ลูกค้า B', warehouseName: 'WH1', shipToName: 'คลังบางนา', ...plan, dockDoorCode: 'D2' },
  { poNo: 'PO001', customerName: 'ลูกค้า A', warehouseName: 'WH2', shipToName: 'คลังรังสิต', ...plan, truckArrival: '2020-01-15 08:10:00' },
  { poNo: 'PO002', customerName: 'ลูกค้า A', warehouseName: 'WH1', shipToName: 'คลังบางนา', ...plan, truckDeparture: '2020-01-15 10:00:00', processStage: 'COMPLETED' },
  { poNo: 'PO004', customerName: 'ลูกค้า C', warehouseName: 'WH1', shipToName: 'คลังบางนา', ...plan, processStage: 'CANCELLED' },
  { poNo: 'PO005', customerName: 'ลูกค้า C', warehouseName: 'WH3', shipToName: 'คลังลำลูกกา', ...plan, registerDate: '2020-01-20' },
];
const admin = { role: 'ADMIN_SYSTEM', permissions: { isAdminSystem: true } };
const picker = { role: 'LEADER_WAREHOUSE_PICKER', permissions: { canActionPicking: true } };
const run = (query, viewer = admin) => queryPoTable(pos, parseTableQuery(query), viewer);
const names = (r) => r.rows.map((p) => p.poNo);

describe('poTableService', () => {
  it('pages the sorted result and reports totals', () => {
    const r = run({ page: '1', pageSize: '2' });
    assert.deepEqual(names(r), ['PO001', 'PO002']);
    assert.equal(r.total, 5);
    assert.equal(r.totalPages, 3);
    assert.deepEqual(names(run({ page: '3', pageSize: '2' })), ['PO005']);
  });

  it('a page past the end shows the last page', () => {
    const r = run({ page: '99', pageSize: '2' });
    assert.equal(r.page, 3);
    assert.deepEqual(names(r), ['PO005']);
  });

  it('search covers PO, customer, ship-to, plate, driver, warehouse and door (same as the old table)', () => {
    assert.deepEqual(names(run({ q: 'PO00' })).length, 5);
    assert.deepEqual(names(run({ q: 'ลูกค้า a' })), ['PO001', 'PO002']);
    assert.deepEqual(names(run({ q: 'รังสิต' })), ['PO001']);
    assert.deepEqual(names(run({ q: 'wh3' })), ['PO005']);
    assert.deepEqual(names(run({ q: 'd2' })), ['PO003']);
  });

  it('status filter', () => {
    assert.deepEqual(names(run({ status: 'COMPLETED' })), ['PO002']);
    assert.deepEqual(names(run({ status: 'CANCELLED' })), ['PO004']);
    assert.deepEqual(names(run({ status: 'IN_PROGRESS' })), ['PO001', 'PO003', 'PO005']);
  });

  it('customer / warehouse / ship-to filters', () => {
    assert.deepEqual(names(run({ customerName: 'ลูกค้า C' })), ['PO004', 'PO005']);
    assert.deepEqual(names(run({ warehouseName: 'wh1' })), ['PO002', 'PO003', 'PO004']);
    assert.deepEqual(names(run({ shipToName: 'บางนา' })), ['PO002', 'PO003', 'PO004']);
  });

  it('shift date filter (single day and range)', () => {
    assert.deepEqual(names(run({ dateStart: '2020-01-20', dateEnd: '2020-01-20' })), ['PO005']);
    assert.deepEqual(names(run({ dateStart: '2020-01-14', dateEnd: '2020-01-21' })).length, 5);
  });

  it('icon status filter follows the viewer permissions', () => {
    // ADMIN ทำได้ทุกขั้น จึงเป็น "รอเรา"; Picker ทำแค่หยิบ
    const adminOurs = names(run({ stageIconStatus: 'WAITING_OUR_ACTION' }, admin));
    const pickerOurs = names(run({ stageIconStatus: 'WAITING_OUR_ACTION' }, picker));
    assert.ok(adminOurs.length >= pickerOurs.length);
    assert.ok(adminOurs.includes('PO003'), 'PO waiting for a dock door is ADMIN\'s action');
  });

  it('sorting by column, both directions, empty values last', () => {
    assert.deepEqual(names(run({ sortField: 'poNo', sortDir: 'desc' })), ['PO005', 'PO004', 'PO003', 'PO002', 'PO001']);
    const byArrival = names(run({ sortField: 'truckArrival', sortDir: 'desc' }));
    assert.equal(byArrival[0], 'PO001', 'the only PO with an arrival time comes first');
  });

  it('export returns every matching row in one go', () => {
    const r = run({ all: '1', pageSize: '2' });
    assert.equal(r.rows.length, 5);
    assert.equal(r.totalPages, 1);
  });

  it('filter dropdown options come from all POs', () => {
    const r = run({ q: 'PO001' });
    assert.deepEqual(r.options.customers, ['ลูกค้า A', 'ลูกค้า B', 'ลูกค้า C']);
    assert.ok(r.options.locations.includes('คลังลำลูกกา'));
  });

  it('bad paging input falls back to safe defaults', () => {
    const f = parseTableQuery({ page: '-5', pageSize: '99999' });
    assert.equal(f.page, 1);
    assert.equal(f.pageSize, 200);
  });
});
