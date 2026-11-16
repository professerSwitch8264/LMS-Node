/* =====================================================================
   เพิ่มคอลัมน์ Role_permission.dashboard_type
   ใช้เลือกชุดการ์ด KPI บนแดชบอร์ดของแต่ละ Role
     TRUCK     = รถตามแผน / รถยังไม่เข้า / รถเข้าแล้ว / รถออกแล้ว
     WAREHOUSE = หยิบรอทำ / หยิบเสร็จ / โหลดรอทำ / โหลดเสร็จ
     OVERVIEW  = PO ทั้งหมด / กำลังดำเนินการ / เสร็จสิ้น / ยกเลิก

   - รันซ้ำได้ (idempotent) ทุกขั้นเช็คก่อนทำ
   - backend (src/config/db.js -> ensureDashboardTypeColumn) ทำขั้นตอนเดียวกันนี้อัตโนมัติตอน start
     ไฟล์นี้มีไว้สำหรับรันเองล่วงหน้า / บน production ที่ไม่ให้ app แก้ schema
   - ต้องแยก batch ด้วย GO เพราะ SQL Server compile ทั้ง batch ก่อนรัน
     (ADD COLUMN แล้ว UPDATE ใน batch เดียวกันจะ error "Invalid column name 'dashboard_type'")
   ===================================================================== */

-- 1) เพิ่มคอลัมน์ (อนุญาต NULL ก่อน เพื่อเติมค่าให้ข้อมูลเดิม)
IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('dbo.Role_permission') AND name = 'dashboard_type'
)
BEGIN
    ALTER TABLE dbo.Role_permission ADD dashboard_type VARCHAR(20) NULL;
END
GO

-- 2) เติมค่าให้ Role เดิม ให้ตรงกับพฤติกรรมเดิมของระบบ (เดิมเลือกการ์ดจากชื่อ Role)
UPDATE dbo.Role_permission
SET dashboard_type = CASE
        WHEN UPPER(role_id) LIKE '%YUSEN%'
          OR UPPER(role_id) LIKE '%CAR_REGISTER%'
          OR UPPER(role_id) LIKE '%TRUCKER%'          THEN 'TRUCK'
        WHEN UPPER(role_id) LIKE '%LEADER%'
          OR UPPER(role_id) LIKE '%PICK%'
          OR UPPER(role_id) LIKE '%LOAD%'
          OR UPPER(role_id) = 'ADMIN_OUTSIDE'         THEN 'WAREHOUSE'
        ELSE 'OVERVIEW'
    END
WHERE dashboard_type IS NULL
   OR dashboard_type NOT IN ('TRUCK', 'WAREHOUSE', 'OVERVIEW');
GO

-- 3) บังคับ NOT NULL + ค่า default + จำกัดค่าที่รับได้
IF EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('dbo.Role_permission') AND name = 'dashboard_type' AND is_nullable = 1
)
BEGIN
    ALTER TABLE dbo.Role_permission ALTER COLUMN dashboard_type VARCHAR(20) NOT NULL;
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.default_constraints WHERE name = 'DF_Role_permission_dashboard_type')
BEGIN
    ALTER TABLE dbo.Role_permission
        ADD CONSTRAINT DF_Role_permission_dashboard_type DEFAULT 'OVERVIEW' FOR dashboard_type;
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_Role_permission_dashboard_type')
BEGIN
    ALTER TABLE dbo.Role_permission
        ADD CONSTRAINT CK_Role_permission_dashboard_type
        CHECK (dashboard_type IN ('TRUCK', 'WAREHOUSE', 'OVERVIEW'));
END
GO

-- 4) ตรวจผลลัพธ์
SELECT role_id, role_name, action_name, view_mode, dashboard_type
FROM dbo.Role_permission
ORDER BY role_id;
GO

/* ---------------------------------------------------------------------
   ตัวอย่าง: เปลี่ยนชุดการ์ดของ Role ด้วยมือ (ปกติแก้จากหน้า "กำหนดสิทธิ์" ได้เลย)
   UPDATE dbo.Role_permission SET dashboard_type = 'WAREHOUSE', updated_at = GETDATE()
   WHERE role_id = 'SUPERVISOR';

   ย้อนกลับ (rollback) ถ้าต้องการลบคอลัมน์ออก — ต้องลบ constraint ก่อน
   ALTER TABLE dbo.Role_permission DROP CONSTRAINT CK_Role_permission_dashboard_type;
   ALTER TABLE dbo.Role_permission DROP CONSTRAINT DF_Role_permission_dashboard_type;
   ALTER TABLE dbo.Role_permission DROP COLUMN dashboard_type;
   --------------------------------------------------------------------- */
