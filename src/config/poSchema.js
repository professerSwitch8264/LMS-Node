// ตาราง PO (หัวเอกสาร) + PO_Transaction (รอบรถ ตั้งแต่แผนรถเข้า → รถออก)
// PO หนึ่งใบมีได้หลายรอบ — เลื่อนแผน 1 ครั้ง = รอบใหม่ 1 แถว รอบล่าสุดคือแถว is_current = 1 (มีได้แถวเดียวต่อ PO)
// V_PO_Current = PO + รอบปัจจุบัน ใช้ชื่อคอลัมน์เดียวกับตาราง Received เดิม (received_id = po_id) เพื่อให้ query อ่านเดิมใช้ต่อได้
const { TABLES } = require('./constants');
const { logger } = require('../utils/logger');

const P = TABLES.PO;
const T = TABLES.PO_TRANSACTION;
const V = TABLES.PO_CURRENT_VIEW;
const R = TABLES.RECEIVED;
const RECEIVED_BACKUP = 'Received_backup_20261117';

// ชื่อขั้นงาน (process_stage): ชุดเดิม → ชุดใหม่ (WAIT_* = กำลังรออะไร) และ CANCLE (สะกดผิด) → CANCELLED
const STAGE_RENAMES = {
  PO_INCOMPLETE: 'WAIT_PO_DATA',
  ADMIN_OFFICE: 'WAIT_PO_DATA',
  CAR_REGISTER: 'WAIT_CAR_PLAN',
  ASSIGN_DOCK: 'WAIT_DOCK',
  ISSUE_TICKET: 'WAIT_TICKET',
  ADMIN_OUTSIDE: 'WAIT_LOADING',
  WAITING_DEPARTURE: 'WAIT_DEPARTURE',
  CANCLE: 'CANCELLED',
  CANCEL: 'CANCELLED',
};
const stageRename = (expr) =>
  `CASE ${expr} ${Object.entries(STAGE_RENAMES).map(([from, to]) => `WHEN '${from}' THEN '${to}'`).join(' ')} ELSE ${expr} END`;

// เปลี่ยนค่าเดิมที่บันทึกไว้แล้วให้เป็นชื่อชุดใหม่ (รันซ้ำได้ ไม่มีค่าเดิมเหลือก็ไม่ทำอะไร)
const RENAME_VALUES_SQL = `
UPDATE ${P} SET po_status = 'CANCELLED' WHERE po_status IN ('CANCLE', 'CANCEL');
UPDATE ${T} SET tx_status = 'CANCELLED' WHERE tx_status IN ('CANCLE', 'CANCEL');
UPDATE ${T} SET process_stage = ${stageRename('process_stage')}
  WHERE process_stage IN (${Object.keys(STAGE_RENAMES).map((s) => `'${s}'`).join(', ')});
`;

const CREATE_TABLES_SQL = `
IF OBJECT_ID('${P}', 'U') IS NULL
BEGIN
  CREATE TABLE ${P} (
    po_id INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_${P} PRIMARY KEY,
    PO_No NVARCHAR(50) NOT NULL,
    customer_code NVARCHAR(50) NULL,
    customer_Name NVARCHAR(255) NULL,
    quantity DECIMAL(18,2) NULL,
    quantity_uom NVARCHAR(20) NULL,
    ship_to_name NVARCHAR(255) NULL,
    warehouse_code NVARCHAR(50) NULL,
    warehouse_name NVARCHAR(255) NULL,
    is_urgent BIT NOT NULL CONSTRAINT DF_${P}_is_urgent DEFAULT 0,
    po_status NVARCHAR(20) NOT NULL CONSTRAINT DF_${P}_po_status DEFAULT 'ACTIVE',
    cancle_reason NVARCHAR(255) NULL,
    create_by NVARCHAR(100) NULL,
    create_date DATETIME NOT NULL CONSTRAINT DF_${P}_create_date DEFAULT GETDATE(),
    update_by NVARCHAR(100) NULL,
    update_date DATETIME NOT NULL CONSTRAINT DF_${P}_update_date DEFAULT GETDATE()
  );
  CREATE INDEX IX_${P}_PO_No ON ${P} (PO_No);
END;

IF OBJECT_ID('${T}', 'U') IS NULL
BEGIN
  CREATE TABLE ${T} (
    po_transaction_id INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_${T} PRIMARY KEY,
    po_id INT NOT NULL CONSTRAINT FK_${T}_${P} REFERENCES ${P}(po_id),
    round_no INT NOT NULL CONSTRAINT DF_${T}_round_no DEFAULT 1,
    is_current BIT NOT NULL CONSTRAINT DF_${T}_is_current DEFAULT 1,
    tx_status NVARCHAR(20) NOT NULL CONSTRAINT DF_${T}_tx_status DEFAULT 'ACTIVE',
    truck_type_id INT NULL,
    truck_type NVARCHAR(100) NULL,
    license NVARCHAR(50) NULL,
    driver_name NVARCHAR(100) NULL,
    driver_tel NVARCHAR(20) NULL,
    register_date DATETIME NULL,
    dock_door_id INT NULL,
    dock_door_code NVARCHAR(50) NULL,
    dock_door_name NVARCHAR(100) NULL,
    truck_arrival DATETIME NULL,
    ticket_date DATETIME NULL,
    order_date DATETIME NULL,
    pick_start_date_time DATETIME NULL,
    pick_finish_date_time DATETIME NULL,
    load_start_date_time DATETIME NULL,
    load_finish_date_time DATETIME NULL,
    truck_departure DATETIME NULL,
    process_stage NVARCHAR(50) NULL,
    rescheduled_from_id INT NULL,
    reschedule_reason NVARCHAR(255) NULL,
    rescheduled_by NVARCHAR(100) NULL,
    rescheduled_at DATETIME NULL,
    create_date DATETIME NOT NULL CONSTRAINT DF_${T}_create_date DEFAULT GETDATE(),
    update_date DATETIME NOT NULL CONSTRAINT DF_${T}_update_date DEFAULT GETDATE()
  );
  CREATE INDEX IX_${T}_po_round ON ${T} (po_id, round_no);
  CREATE UNIQUE INDEX UX_${T}_current ON ${T} (po_id) WHERE is_current = 1;
END;
`;

// สถานะของ PO ทั้งใบ (ยกเลิก) ชนะสถานะของรอบ — ที่เหลือใช้ process_stage ของรอบ
// currentOnly = true → V_PO_Current (รอบปัจจุบัน), false → V_PO_Round (ทุกรอบ ใช้ทำประวัติ / Excel)
const viewSelect = (currentOnly) => `
SELECT
  p.po_id AS received_id,
  p.po_id,
  p.PO_No,
  p.customer_code, p.customer_Name,
  p.quantity, p.quantity_uom,
  p.ship_to_name,
  p.warehouse_code, p.warehouse_name,
  p.is_urgent, p.po_status, p.cancle_reason,
  p.create_date,
  CASE WHEN t.update_date IS NOT NULL AND t.update_date > p.update_date THEN t.update_date ELSE p.update_date END AS update_date,
  t.po_transaction_id, t.round_no, t.is_current, t.tx_status, t.create_date AS tx_create_date,
  t.truck_type_id, t.truck_type, t.license, t.driver_name, t.driver_tel,
  t.register_date,
  t.dock_door_id, t.dock_door_code, t.dock_door_name,
  t.truck_arrival, t.ticket_date, t.order_date,
  t.pick_start_date_time, t.pick_finish_date_time,
  t.load_start_date_time, t.load_finish_date_time,
  t.truck_departure,
  CASE WHEN p.po_status = 'CANCELLED' AND ISNULL(t.is_current, 1) = 1 THEN 'CANCELLED' ELSE t.process_stage END AS process_stage,
  t.rescheduled_from_id, t.reschedule_reason, t.rescheduled_by, t.rescheduled_at
FROM ${P} p
${currentOnly ? 'LEFT' : 'INNER'} JOIN ${T} t ON t.po_id = p.po_id${currentOnly ? ' AND t.is_current = 1' : ''}
`;

const CREATE_VIEW_SQL = [
  `CREATE OR ALTER VIEW ${V} AS ${viewSelect(true)}`,
  `CREATE OR ALTER VIEW ${TABLES.PO_ROUND_VIEW} AS ${viewSelect(false)}`,
];

async function columnSet(pool, table) {
  const r = await pool.request().query(`SELECT name FROM sys.columns WHERE object_id = OBJECT_ID('${table}')`);
  return new Set(r.recordset.map((x) => String(x.name).toLowerCase()));
}

// ย้ายข้อมูลจาก Received เดิม → PO + PO_Transaction (รอบที่ 1) แล้วเปลี่ยนชื่อ Received เป็นตารางสำรอง
// ทำครั้งเดียว: ถ้า PO มีข้อมูลแล้ว หรือไม่มี Received จะข้าม
async function migrateReceived(pool) {
  const exists = await pool.request().query(`SELECT OBJECT_ID('${R}', 'U') AS rid, (SELECT COUNT(*) FROM ${P}) AS poCount`);
  const row = exists.recordset[0] || {};
  if (!row.rid) return;
  if (Number(row.poCount) > 0) {
    logger.warn(`⚠️ พบทั้งตาราง ${R} และ ${P} ที่มีข้อมูลแล้ว — ข้ามการย้ายข้อมูล (ตรวจสอบด้วยมือ)`);
    return;
  }

  const cols = await columnSet(pool, R);
  const c = (name, fallback = 'NULL') => (cols.has(name.toLowerCase()) ? `r.${name}` : fallback);
  const stage = c('process_stage', "''");
  const isCancelled = `ISNULL(${stage}, '') IN ('CANCLE', 'CANCEL')`;
  const isCompleted = `(ISNULL(${stage}, '') = 'COMPLETED' OR ${c('truck_departure')} IS NOT NULL)`;
  // แผนที่ถูกเลื่อนไว้ในระบบเดิม = แผนรถเข้าปัจจุบัน
  const planDate = cols.has('reschedule_date') ? `COALESCE(r.reschedule_date, ${c('register_date')})` : c('register_date');

  const sql = require('mssql');
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    const q = (text) => new sql.Request(tx).query(text);
    await q(`
      SET IDENTITY_INSERT ${P} ON;
      INSERT INTO ${P} (po_id, PO_No, customer_code, customer_Name, quantity, quantity_uom, ship_to_name,
        warehouse_code, warehouse_name, is_urgent, po_status, cancle_reason, create_by, create_date, update_by, update_date)
      SELECT r.received_id, r.PO_No, ${c('customer_code')}, ${c('customer_Name')}, ${c('quantity')}, ${c('quantity_uom')},
        ${c('ship_to_name')}, ${c('warehouse_code')}, ${c('warehouse_name')},
        ISNULL(${c('is_urgent', '0')}, 0),
        CASE WHEN ${isCancelled} THEN 'CANCELLED' WHEN ${isCompleted} THEN 'COMPLETED' ELSE 'ACTIVE' END,
        ${c('cancle_reason')}, ${c('create_by')}, ISNULL(${c('create_date')}, GETDATE()), ${c('update_by')}, ISNULL(${c('update_date')}, GETDATE())
      FROM ${R} r;
      SET IDENTITY_INSERT ${P} OFF;

      INSERT INTO ${T} (po_id, round_no, is_current, tx_status, truck_type_id, truck_type, license, driver_name, driver_tel,
        register_date, dock_door_id, dock_door_code, dock_door_name, truck_arrival, ticket_date, order_date,
        pick_start_date_time, pick_finish_date_time, load_start_date_time, load_finish_date_time, truck_departure,
        process_stage, reschedule_reason, create_date, update_date)
      SELECT r.received_id, 1, 1,
        CASE WHEN ${isCancelled} THEN 'CANCELLED' WHEN ${isCompleted} THEN 'COMPLETED' ELSE 'ACTIVE' END,
        ${c('truck_type_id')}, ${c('truck_type')}, ${c('license')}, ${c('driver_name')}, ${c('driver_tel')},
        ${planDate}, ${c('dock_door_id')}, ${c('dock_door_code')}, ${c('dock_door_name')},
        ${c('truck_arrival')}, ${c('ticket_date')}, ${c('order_date')},
        ${c('pick_start_date_time')}, ${c('pick_finish_date_time')}, ${c('load_start_date_time')}, ${c('load_finish_date_time')},
        ${c('truck_departure')},
        CASE WHEN ${isCancelled} THEN 'CANCELLED' ELSE ${stageRename(c('process_stage'))} END,
        ${c('reschedule_reason')}, ISNULL(${c('create_date')}, GETDATE()), ISNULL(${c('update_date')}, GETDATE())
      FROM ${R} r;
    `);
    await q(`EXEC sp_rename '${R}', '${RECEIVED_BACKUP}'`);
    await tx.commit();
    logger.info(`✅ ย้ายข้อมูล ${R} → ${P} / ${T} เรียบร้อย (ตารางเดิมเก็บไว้ที่ ${RECEIVED_BACKUP})`);
  } catch (err) {
    try { await tx.rollback(); } catch (_e) { /* ignore */ }
    throw err;
  }
}

// index ที่ใช้เรียง (วันที่สร้าง) และกรอง (สถานะ) บ่อย — เพิ่มให้ตารางที่สร้างไว้แล้วด้วย
const INDEX_SQL = `
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_${P}_create_date' AND object_id = OBJECT_ID('${P}'))
  CREATE INDEX IX_${P}_create_date ON ${P} (create_date);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_${P}_po_status' AND object_id = OBJECT_ID('${P}'))
  CREATE INDEX IX_${P}_po_status ON ${P} (po_status) INCLUDE (PO_No);
`;

async function ensurePoTables(pool) {
  await pool.request().query(CREATE_TABLES_SQL);
  await pool.request().query(INDEX_SQL);
  // ระบบเก่าตั้งชื่อตาราง Received_Master — เปลี่ยนชื่อก่อนย้าย
  await pool.request().query(`
    IF OBJECT_ID('${R}', 'U') IS NULL AND OBJECT_ID('Received_Master', 'U') IS NOT NULL
      EXEC sp_rename 'Received_Master', '${R}';
  `);
  await migrateReceived(pool);
  // สร้าง view ก่อน (ไม่อ้างคอลัมน์ที่เลิกใช้แล้ว) แล้วค่อยลบคอลัมน์ออกจากตาราง PO เดิม
  for (const view of CREATE_VIEW_SQL) await pool.request().query(view);
  await pool.request().query(DROP_UNUSED_COLUMNS_SQL);
  await pool.request().query(RENAME_VALUES_SQL);
}

// PO ไม่เก็บ ship_to_code / warehouse_id แล้ว (ใช้ชื่อสถานที่ส่ง + รหัส/ชื่อคลัง) — ข้อมูลเดิมยังอยู่ใน Received_backup
const DROP_UNUSED_COLUMNS_SQL = `
IF COL_LENGTH('${P}', 'ship_to_code') IS NOT NULL ALTER TABLE ${P} DROP COLUMN ship_to_code;
IF COL_LENGTH('${P}', 'warehouse_id') IS NOT NULL ALTER TABLE ${P} DROP COLUMN warehouse_id;
`;

module.exports = { ensurePoTables, CREATE_TABLES_SQL, CREATE_VIEW_SQL, DROP_UNUSED_COLUMNS_SQL, RENAME_VALUES_SQL, STAGE_RENAMES, RECEIVED_BACKUP };
