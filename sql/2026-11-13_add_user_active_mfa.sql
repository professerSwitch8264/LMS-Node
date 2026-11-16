-- สถานะเปิด/ปิดใช้งานบัญชี + MFA (รหัส 6 หลักจากแอป Authenticator)
-- รันซ้ำได้ (idempotent) ถ้าคอลัมน์มีอยู่แล้วจะข้ามไป
-- backend เพิ่มคอลัมน์เดียวกันให้อัตโนมัติตอนเรียกใช้ (userController -> ensureUserTable)

-- บัญชีที่มีอยู่ก่อนเพิ่มคอลัมน์ถือว่าเปิดใช้งานอยู่แล้ว (login ครั้งถัดไปจะต้องผูก MFA)
-- บัญชีที่สร้างใหม่หลังจากนี้เริ่มที่ปิดใช้งาน จนกว่า Admin จะกดเปิดและผู้ใช้ทำตามลิงก์ในอีเมล
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.[User]') AND name = 'is_active')
BEGIN
  ALTER TABLE dbo.[User] ADD is_active BIT NOT NULL CONSTRAINT DF_User_is_active DEFAULT 0;
  EXEC('UPDATE dbo.[User] SET is_active = 1');
END
GO

-- จุดประสงค์ของลิงก์ในอีเมล: PASSWORD / ACTIVATE / MFA_SETUP
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.[User]') AND name = 'reset_token_purpose')
  ALTER TABLE dbo.[User] ADD reset_token_purpose NVARCHAR(20) NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.[User]') AND name = 'mfa_secret_enc')
  ALTER TABLE dbo.[User] ADD mfa_secret_enc NVARCHAR(255) NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.[User]') AND name = 'mfa_enabled')
  ALTER TABLE dbo.[User] ADD mfa_enabled BIT NOT NULL CONSTRAINT DF_User_mfa_enabled DEFAULT 0;
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.[User]') AND name = 'mfa_last_step')
  ALTER TABLE dbo.[User] ADD mfa_last_step BIGINT NULL;
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.[User]') AND name = 'mfa_failed_count')
  ALTER TABLE dbo.[User] ADD mfa_failed_count INT NOT NULL CONSTRAINT DF_User_mfa_failed_count DEFAULT 0;
GO
IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('dbo.[User]') AND name = 'mfa_lockout_until')
  ALTER TABLE dbo.[User] ADD mfa_lockout_until DATETIME NULL;
GO

-- ตรวจสอบผล
SELECT username, is_active, mfa_enabled FROM dbo.[User] ORDER BY username;
GO

-- ย้อนกลับ (ถ้าต้องการ)
-- ALTER TABLE dbo.[User] DROP COLUMN mfa_lockout_until, mfa_last_step, mfa_secret_enc, reset_token_purpose;
-- ALTER TABLE dbo.[User] DROP CONSTRAINT DF_User_mfa_failed_count, DF_User_mfa_enabled, DF_User_is_active;
-- ALTER TABLE dbo.[User] DROP COLUMN mfa_failed_count, mfa_enabled, is_active;
