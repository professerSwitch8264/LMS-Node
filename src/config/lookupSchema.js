// ตารางรายการตัวเลือก (ไม่มี id — ใช้ชื่อ / รหัสเป็น key)
//   Uom               : uom_code (PK) + uom_name      หน่วยนับของ PO เช่น BOX
//   Cancel_reason     : reason_name (PK)              เหตุผลการยกเลิก PO
//   Reschedule_reason : reason_name (PK)              เหตุผลการเลื่อนแผนรถเข้า
// สร้างตาราง + ใส่ค่าเริ่มต้นครั้งแรก (ตารางว่างเท่านั้น) — แก้รายการได้ที่ตารางโดยตรง
const { TABLES } = require('./constants');

const DEFAULT_UOMS = [
  ['BOX', 'BOX'],
  ['CTN', 'CTN'],
  ['BDL', 'BDL'],
];
// "อื่นๆ" ไม่อยู่ในตาราง — หน้าเว็บใส่เป็นตัวเลือกท้ายรายการให้พิมพ์เหตุผลเอง
const DEFAULT_CANCEL_REASONS = ['ลูกค้ายกเลิกคำสั่งซื้อ', 'เอกสารผิดพลาด'];
const DEFAULT_RESCHEDULE_REASONS = ['โหลดไม่ทัน', 'รถไม่เข้า', 'รถเข้าช้า', 'คนเรียงมีไม่เพียงพอ'];

const CREATE_SQL = `
IF OBJECT_ID('${TABLES.UOM}', 'U') IS NULL
  CREATE TABLE ${TABLES.UOM} (
    uom_code NVARCHAR(20) NOT NULL CONSTRAINT PK_${TABLES.UOM} PRIMARY KEY,
    uom_name NVARCHAR(100) NOT NULL
  );
IF OBJECT_ID('${TABLES.CANCEL_REASON}', 'U') IS NULL
  CREATE TABLE ${TABLES.CANCEL_REASON} (
    reason_name NVARCHAR(255) NOT NULL CONSTRAINT PK_${TABLES.CANCEL_REASON} PRIMARY KEY
  );
IF OBJECT_ID('${TABLES.RESCHEDULE_REASON}', 'U') IS NULL
  CREATE TABLE ${TABLES.RESCHEDULE_REASON} (
    reason_name NVARCHAR(255) NOT NULL CONSTRAINT PK_${TABLES.RESCHEDULE_REASON} PRIMARY KEY
  );
`;

const quote = (v) => `N'${String(v).replace(/'/g, "''")}'`;
const SEED_SQL = `
IF NOT EXISTS (SELECT 1 FROM ${TABLES.UOM})
  INSERT INTO ${TABLES.UOM} (uom_code, uom_name) VALUES ${DEFAULT_UOMS.map(([c, n]) => `(${quote(c)}, ${quote(n)})`).join(', ')};
IF NOT EXISTS (SELECT 1 FROM ${TABLES.CANCEL_REASON})
  INSERT INTO ${TABLES.CANCEL_REASON} (reason_name) VALUES ${DEFAULT_CANCEL_REASONS.map((r) => `(${quote(r)})`).join(', ')};
IF NOT EXISTS (SELECT 1 FROM ${TABLES.RESCHEDULE_REASON})
  INSERT INTO ${TABLES.RESCHEDULE_REASON} (reason_name) VALUES ${DEFAULT_RESCHEDULE_REASONS.map((r) => `(${quote(r)})`).join(', ')};
`;

async function ensureLookupTables(pool) {
  await pool.request().query(CREATE_SQL);
  await pool.request().query(SEED_SQL);
}

const loadUoms = async (pool) => (await pool.request()
  .query(`SELECT uom_code, uom_name FROM ${TABLES.UOM} ORDER BY uom_code`)).recordset
  .map((r) => ({ code: r.uom_code, name: r.uom_name }));

const loadReasons = async (pool, table) => (await pool.request()
  .query(`SELECT reason_name FROM ${table} ORDER BY reason_name`)).recordset
  .map((r) => r.reason_name);

// ตรวจว่าค่ามีอยู่ในตาราง (เทียบแบบไม่สนช่องว่างหัวท้าย)
async function existsIn(pool, table, column, value) {
  const v = String(value ?? '').trim();
  if (!v) return false;
  const r = await pool.request().input('v', v).query(`SELECT 1 AS ok FROM ${table} WHERE ${column} = @v`);
  return r.recordset.length > 0;
}
const isCancelReason = (pool, v) => existsIn(pool, TABLES.CANCEL_REASON, 'reason_name', v);
const isRescheduleReason = (pool, v) => existsIn(pool, TABLES.RESCHEDULE_REASON, 'reason_name', v);

module.exports = {
  ensureLookupTables,
  loadUoms,
  loadReasons,
  isCancelReason,
  isRescheduleReason,
  CREATE_SQL,
  SEED_SQL,
  DEFAULT_UOMS,
};
