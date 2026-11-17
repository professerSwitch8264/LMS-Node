-- ตารางรายการตัวเลือก (ไม่มี id — ใช้ชื่อ / รหัสเป็น key)
--   Uom: uom_code + uom_name | Cancel_reason: reason_name | Reschedule_reason: reason_name
-- backend สร้างตาราง + ใส่ค่าเริ่มต้นให้อัตโนมัติตอนเริ่มระบบ (config/lookupSchema.js) — ใส่ค่าเริ่มต้นเฉพาะตารางที่ยังว่าง
-- เพิ่ม/แก้รายการได้ที่ตารางโดยตรง หน้าเว็บโหลดใหม่หลัง login ครั้งถัดไป

IF OBJECT_ID('Uom', 'U') IS NULL
  CREATE TABLE Uom (
    uom_code NVARCHAR(20) NOT NULL CONSTRAINT PK_Uom PRIMARY KEY,
    uom_name NVARCHAR(100) NOT NULL
  );
IF OBJECT_ID('Cancel_reason', 'U') IS NULL
  CREATE TABLE Cancel_reason (
    reason_name NVARCHAR(255) NOT NULL CONSTRAINT PK_Cancel_reason PRIMARY KEY
  );
IF OBJECT_ID('Reschedule_reason', 'U') IS NULL
  CREATE TABLE Reschedule_reason (
    reason_name NVARCHAR(255) NOT NULL CONSTRAINT PK_Reschedule_reason PRIMARY KEY
  );
GO

IF NOT EXISTS (SELECT 1 FROM Uom)
  INSERT INTO Uom (uom_code, uom_name) VALUES (N'BOX', N'BOX'), (N'CTN', N'CTN'), (N'BDL', N'BDL');
IF NOT EXISTS (SELECT 1 FROM Cancel_reason)
  INSERT INTO Cancel_reason (reason_name) VALUES (N'ลูกค้ายกเลิกคำสั่งซื้อ'), (N'เอกสารผิดพลาด');
IF NOT EXISTS (SELECT 1 FROM Reschedule_reason)
  INSERT INTO Reschedule_reason (reason_name) VALUES (N'โหลดไม่ทัน'), (N'รถไม่เข้า'), (N'รถเข้าช้า'), (N'คนเรียงมีไม่เพียงพอ');
GO

-- ตัวอย่างเพิ่มรายการ:
-- INSERT INTO Uom (uom_code, uom_name) VALUES (N'PCS', N'ชิ้น');
-- INSERT INTO Reschedule_reason (reason_name) VALUES (N'ลูกค้าขอเลื่อน');
