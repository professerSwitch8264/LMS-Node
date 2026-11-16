-- เพิ่มคอลัมน์อีเมลและ token ตั้งรหัสผ่านใหม่ในตาราง [User]
-- รันซ้ำได้ (idempotent) ถ้าคอลัมน์มีอยู่แล้วจะข้ามไป
-- backend จะเพิ่มคอลัมน์เดียวกันให้อัตโนมัติตอนเรียกใช้ (userController -> ensureUserTable)
-- ไฟล์นี้ไว้สำหรับรันล่วงหน้าบนฐานข้อมูลจริง

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.[User]') AND name = 'email')
BEGIN
  ALTER TABLE dbo.[User] ADD email NVARCHAR(255) NULL;
END
GO

-- ถ้าเคยสร้าง email เป็น VARCHAR(50) ไว้ ให้ขยายเป็น NVARCHAR(255) (ข้อมูลเดิมไม่หาย)
IF EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.[User]') AND name = 'email'
    AND (TYPE_NAME(user_type_id) <> 'nvarchar' OR (max_length <> -1 AND max_length < 510))
)
BEGIN
  ALTER TABLE dbo.[User] ALTER COLUMN email NVARCHAR(255) NULL;
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.[User]') AND name = 'reset_token_hash')
BEGIN
  ALTER TABLE dbo.[User] ADD reset_token_hash NVARCHAR(64) NULL;
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.[User]') AND name = 'reset_token_expires')
BEGIN
  ALTER TABLE dbo.[User] ADD reset_token_expires DATETIME NULL;
END
GO

-- ตรวจสอบผล
SELECT name, TYPE_NAME(user_type_id) AS data_type, max_length, is_nullable
FROM sys.columns
WHERE object_id = OBJECT_ID('dbo.[User]') AND name IN ('email', 'reset_token_hash', 'reset_token_expires');
GO

-- ย้อนกลับ (ถ้าต้องการ)
-- ALTER TABLE dbo.[User] DROP COLUMN reset_token_expires;
-- ALTER TABLE dbo.[User] DROP COLUMN reset_token_hash;
-- ALTER TABLE dbo.[User] DROP COLUMN email;  -- ระวัง: ลบข้อมูลอีเมลทั้งหมด
