-- เพิ่มคอลัมน์สำหรับล็อคบัญชีเมื่อกรอกรหัสผ่านผิดหลายครั้ง ในตาราง [User]
-- รันซ้ำได้ (idempotent) ถ้าคอลัมน์มีอยู่แล้วจะข้ามไป
-- backend จะเพิ่มคอลัมน์เดียวกันให้อัตโนมัติตอนเรียกใช้ (userController -> ensureUserTable)
-- ไฟล์นี้ไว้สำหรับรันล่วงหน้าบนฐานข้อมูลจริง

-- จำนวนครั้งที่กรอกรหัสผ่านผิดติดกัน (แถวเดิมจะได้ค่า 0 อัตโนมัติจาก DEFAULT)
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.[User]') AND name = 'failed_login_count')
BEGIN
  ALTER TABLE dbo.[User] ADD failed_login_count INT NOT NULL
    CONSTRAINT DF_User_failed_login_count DEFAULT 0;
END
GO

-- เวลาที่ปลดล็อค (NULL = ไม่ได้ล็อค)
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.[User]') AND name = 'lockout_until')
BEGIN
  ALTER TABLE dbo.[User] ADD lockout_until DATETIME NULL;
END
GO

-- ตรวจสอบผล
SELECT name, TYPE_NAME(user_type_id) AS data_type, is_nullable,
       OBJECT_NAME(default_object_id) AS default_constraint
FROM sys.columns
WHERE object_id = OBJECT_ID('dbo.[User]') AND name IN ('failed_login_count', 'lockout_until');
GO

-- ย้อนกลับ (ถ้าต้องการ)
-- ALTER TABLE dbo.[User] DROP COLUMN lockout_until;
-- ALTER TABLE dbo.[User] DROP CONSTRAINT DF_User_failed_login_count;
-- ALTER TABLE dbo.[User] DROP COLUMN failed_login_count;
