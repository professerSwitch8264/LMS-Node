-- เปลี่ยนชื่อตาราง dbo.Audit_log เป็น dbo.Transaction_log (ข้อมูลเดิมอยู่ครบ)
-- รันซ้ำได้ (idempotent) ถ้าเปลี่ยนชื่อไปแล้วจะข้ามไป
-- backend จะเปลี่ยนชื่อให้อัตโนมัติตอน start (auditLogController -> ensureTransactionLogTable)
-- ไฟล์นี้ไว้สำหรับรันล่วงหน้าบนฐานข้อมูลจริง

IF OBJECT_ID('dbo.Transaction_log', 'U') IS NULL AND OBJECT_ID('dbo.Audit_log', 'U') IS NOT NULL
BEGIN
  EXEC sp_rename 'dbo.Audit_log', 'Transaction_log';
END
GO

-- แก้ข้อความเลื่อนเวลารถเข้าเดิมที่วันที่อ่านไม่ออก
-- เช่น "เลื่อนเวลารถเข้าเป็น Sat Nov 14 2026 00:00:00 GMT+0700 (Indochina Time) 07:00 น."
--   -> "เลื่อนเวลารถเข้าเป็น 14/11/2569 07:00 น."
-- (หน้าเว็บแปลงให้ตอนแสดงผลอยู่แล้ว ส่วนนี้ทำให้ข้อมูลใน DB อ่านง่ายด้วย จะรันหรือไม่ก็ได้)
;WITH src AS (
  SELECT id, details,
         CHARINDEX(N' GMT', details) AS gmt_pos,
         CHARINDEX(N'เป็น ', details) + 5 AS date_pos
  FROM dbo.Transaction_log
  WHERE action_type = 'RESCHEDULE_PO' AND details LIKE N'%GMT[+-]____%'
), parsed AS (
  SELECT id, details, gmt_pos, date_pos,
         -- "Sat Nov 14 2026 00:00:00" -> ตัดชื่อวัน แล้วแปลง "Nov 14 2026"
         TRY_CONVERT(date, SUBSTRING(details, date_pos + 4, 11), 107) AS d
  FROM src
)
UPDATE t
SET details = LEFT(p.details, p.date_pos - 1)
            + FORMAT(p.d, 'dd/MM/') + CAST(YEAR(p.d) + 543 AS nvarchar(4))
            + SUBSTRING(p.details,
                        -- ข้ามช่วง " GMT+0700 (Indochina Time)" ถ้ามีวงเล็บ
                        CASE WHEN SUBSTRING(p.details, p.gmt_pos + 9, 2) = N' ('
                             THEN CHARINDEX(N')', p.details, p.gmt_pos) + 1
                             ELSE p.gmt_pos + 9 END,
                        500)
FROM dbo.Transaction_log t
JOIN parsed p ON p.id = t.id
WHERE p.d IS NOT NULL;
GO

-- ตรวจสอบผล
SELECT TOP 20 id, created_at, action_type, details
FROM dbo.Transaction_log
WHERE action_type = 'RESCHEDULE_PO'
ORDER BY id DESC;
GO

-- ย้อนกลับ (ถ้าต้องการ)
-- EXEC sp_rename 'dbo.Transaction_log', 'Audit_log';
