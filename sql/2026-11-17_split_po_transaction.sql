-- แยกตาราง Received เดิม เป็น PO (หัวเอกสาร) + PO_Transaction (รอบรถ แผนรถเข้า → รถออก)
-- PO หนึ่งใบมีได้หลายรอบ: เลื่อนแผน 1 ครั้ง = ปิดรอบเดิม (tx_status = RESCHEDULED, is_current = 0) + เปิดรอบใหม่
-- รอบปัจจุบัน = is_current = 1 (unique index บังคับให้มีได้แถวเดียวต่อ PO)
-- backend สร้างตาราง/ view และย้ายข้อมูลจาก Received ให้อัตโนมัติตอนเริ่มระบบ (config/poSchema.js -> ensurePoTables)
-- การย้ายข้อมูล: po_id = received_id เดิม, 1 แถวเดิม = รอบที่ 1, reschedule_date เดิม (ถ้ามี) กลายเป็น register_date
-- แล้วเปลี่ยนชื่อ Received เป็น Received_backup_20261117 (ไม่ลบ) — ไฟล์นี้ไว้รันสร้างตารางล่วงหน้า / ตรวจสอบ

IF OBJECT_ID('PO', 'U') IS NULL
BEGIN
  CREATE TABLE PO (
    po_id INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_PO PRIMARY KEY,
    PO_No NVARCHAR(50) NOT NULL,
    customer_code NVARCHAR(50) NULL,
    customer_Name NVARCHAR(255) NULL,
    quantity DECIMAL(18,2) NULL,
    quantity_uom NVARCHAR(20) NULL,
    ship_to_name NVARCHAR(255) NULL,
    warehouse_code NVARCHAR(50) NULL,
    warehouse_name NVARCHAR(255) NULL,
    is_urgent BIT NOT NULL CONSTRAINT DF_PO_is_urgent DEFAULT 0,
    po_status NVARCHAR(20) NOT NULL CONSTRAINT DF_PO_po_status DEFAULT 'ACTIVE',
    cancle_reason NVARCHAR(255) NULL,
    create_by NVARCHAR(100) NULL,
    create_date DATETIME NOT NULL CONSTRAINT DF_PO_create_date DEFAULT GETDATE(),
    update_by NVARCHAR(100) NULL,
    update_date DATETIME NOT NULL CONSTRAINT DF_PO_update_date DEFAULT GETDATE()
  );
  CREATE INDEX IX_PO_PO_No ON PO (PO_No);
END;

IF OBJECT_ID('PO_Transaction', 'U') IS NULL
BEGIN
  CREATE TABLE PO_Transaction (
    po_transaction_id INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_PO_Transaction PRIMARY KEY,
    po_id INT NOT NULL CONSTRAINT FK_PO_Transaction_PO REFERENCES PO(po_id),
    round_no INT NOT NULL CONSTRAINT DF_PO_Transaction_round_no DEFAULT 1,
    is_current BIT NOT NULL CONSTRAINT DF_PO_Transaction_is_current DEFAULT 1,
    tx_status NVARCHAR(20) NOT NULL CONSTRAINT DF_PO_Transaction_tx_status DEFAULT 'ACTIVE',
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
    create_date DATETIME NOT NULL CONSTRAINT DF_PO_Transaction_create_date DEFAULT GETDATE(),
    update_date DATETIME NOT NULL CONSTRAINT DF_PO_Transaction_update_date DEFAULT GETDATE()
  );
  CREATE INDEX IX_PO_Transaction_po_round ON PO_Transaction (po_id, round_no);
  CREATE UNIQUE INDEX UX_PO_Transaction_current ON PO_Transaction (po_id) WHERE is_current = 1;
END;
GO

CREATE OR ALTER VIEW V_PO_Current AS 
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
FROM PO p
LEFT JOIN PO_Transaction t ON t.po_id = p.po_id AND t.is_current = 1
GO

CREATE OR ALTER VIEW V_PO_Round AS 
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
FROM PO p
INNER JOIN PO_Transaction t ON t.po_id = p.po_id
GO

-- PO ไม่เก็บ ship_to_code / warehouse_id (ข้อมูลเดิมยังอยู่ใน Received_backup_20261117)
IF COL_LENGTH('PO', 'ship_to_code') IS NOT NULL ALTER TABLE PO DROP COLUMN ship_to_code;
IF COL_LENGTH('PO', 'warehouse_id') IS NOT NULL ALTER TABLE PO DROP COLUMN warehouse_id;
GO

-- ชื่อขั้นงาน/สถานะชุดใหม่: WAIT_PO_DATA, WAIT_CAR_PLAN, WAIT_DOCK, WAIT_TICKET, WAIT_LOADING, WAIT_DEPARTURE, COMPLETED, CANCELLED
UPDATE PO SET po_status = 'CANCELLED' WHERE po_status IN ('CANCLE', 'CANCEL');
UPDATE PO_Transaction SET tx_status = 'CANCELLED' WHERE tx_status IN ('CANCLE', 'CANCEL');
UPDATE PO_Transaction SET process_stage = CASE process_stage WHEN 'PO_INCOMPLETE' THEN 'WAIT_PO_DATA' WHEN 'ADMIN_OFFICE' THEN 'WAIT_PO_DATA' WHEN 'CAR_REGISTER' THEN 'WAIT_CAR_PLAN' WHEN 'ASSIGN_DOCK' THEN 'WAIT_DOCK' WHEN 'ISSUE_TICKET' THEN 'WAIT_TICKET' WHEN 'ADMIN_OUTSIDE' THEN 'WAIT_LOADING' WHEN 'WAITING_DEPARTURE' THEN 'WAIT_DEPARTURE' WHEN 'CANCLE' THEN 'CANCELLED' WHEN 'CANCEL' THEN 'CANCELLED' ELSE process_stage END
  WHERE process_stage IN ('PO_INCOMPLETE', 'ADMIN_OFFICE', 'CAR_REGISTER', 'ASSIGN_DOCK', 'ISSUE_TICKET', 'ADMIN_OUTSIDE', 'WAITING_DEPARTURE', 'CANCLE', 'CANCEL');
GO

-- ตรวจสอบหลังย้ายข้อมูล: จำนวน PO ต้องเท่ากับจำนวนแถวใน Received_backup_20261117 และทุก PO มีรอบปัจจุบัน 1 รอบ
-- SELECT (SELECT COUNT(*) FROM PO) AS po_count, (SELECT COUNT(*) FROM Received_backup_20261117) AS received_count,
--        (SELECT COUNT(*) FROM PO_Transaction WHERE is_current = 1) AS current_rounds;

-- ย้อนกลับ (ถ้าต้องการ):
-- DROP VIEW V_PO_Round; DROP VIEW V_PO_Current; DROP TABLE PO_Transaction; DROP TABLE PO;
-- EXEC sp_rename 'Received_backup_20261117', 'Received';
