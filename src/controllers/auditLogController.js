const { logger } = require('../utils/logger');
const { getPool } = require('../config/db');
const { TABLES } = require('../config/constants');
const { hasAnyPermission } = require('../services/permissionService');

const T = TABLES.TRANSACTION_LOG;
const LEGACY = TABLES.LEGACY_AUDIT_LOG;

// เปลี่ยนชื่อตารางเดิม (Audit_log) เป็น Transaction_log โดยข้อมูลไม่หาย ถ้ายังไม่มีตารางเลยให้สร้างใหม่
async function ensureTransactionLogTable() {
  try {
    const pool = await getPool();
    await pool.request().query(`
      IF OBJECT_ID('dbo.[${T}]', 'U') IS NULL AND OBJECT_ID('dbo.[${LEGACY}]', 'U') IS NOT NULL
      BEGIN
        EXEC sp_rename 'dbo.${LEGACY}', '${T}';
      END

      IF OBJECT_ID('dbo.[${T}]', 'U') IS NULL
      BEGIN
        CREATE TABLE [${T}] (
          id INT IDENTITY(1,1) PRIMARY KEY,
          created_at DATETIME NOT NULL DEFAULT GETDATE(),
          username NVARCHAR(50) NOT NULL,
          action_type NVARCHAR(50) NOT NULL,
          action_title NVARCHAR(100) NOT NULL,
          po_no NVARCHAR(50) NULL,
          details NVARCHAR(500) NULL
        );
      END
    `);
  } catch (err) {
    logger.error('⚠️ ensureTransactionLogTable error:', err.message);
  }
}

// รายการฝั่ง Yusen (แผนรถ / รถเข้า) — กฎเดียวกับหน้า Audit Log
function isYusenLog(l) {
  const type = String(l.action_type || '').toUpperCase();
  const user = String(l.username || '').toUpperCase();
  const details = String(l.details || '');
  return type.includes('TRUCK_ARRIVAL') || type.includes('CAR_PLAN') || type.includes('CAR_REGISTER')
    || type.includes('RESCHEDULE_PLAN') || user.includes('YUSEN')
    || details.includes('แผนรถ') || details.includes('รถเข้า');
}

// สิทธิ์อ่าน:
//  - ระบุ po_no → ทุกคนที่ login อ่านประวัติของ PO นั้นได้ (หน้า PO ใช้แสดงผู้บันทึกแต่ละขั้น) ตรงเลข PO เท่านั้น
//  - ไม่ระบุ po_no (หน้า Audit Log) → ต้องมี canViewAuditLog และกรองฝั่ง Wanthai / Yusen ตามสิทธิ์
async function getAuditLogs(req, res) {
  const { po_no, username, start_date, end_date, limit } = req.query;
  const effective = req.user?.effective;
  const can = (key) => hasAnyPermission(effective, [key]);
  const cleanPoNo = po_no ? String(po_no).trim().toUpperCase() : '';
  if (!cleanPoNo && !can('canViewAuditLog')) {
    return res.status(403).json({ success: false, code: 'FORBIDDEN', message: 'ไม่มีสิทธิ์ดูประวัติการบันทึก' });
  }
  const hasDateRange = Boolean(start_date || end_date);
  const parsedLimit = Math.min(Math.max(parseInt(limit, 10) || (hasDateRange ? 1000 : 100), 1), 5000);

  try {
    await ensureTransactionLogTable();
    const pool = await getPool();

    let query = `SELECT TOP (@limit) id, created_at, username, action_type, action_title, po_no, details FROM [${T}] WHERE 1=1`;
    const request = pool.request().input('limit', parsedLimit);

    if (cleanPoNo) {
      query += ` AND UPPER(po_no) = @po_no`;
      request.input('po_no', cleanPoNo);
    }

    if (username) {
      query += ` AND UPPER(username) LIKE '%' + @username + '%'`;
      request.input('username', String(username).trim().toUpperCase());
    }

    if (start_date && /^\d{4}-\d{2}-\d{2}$/.test(String(start_date).trim())) {
      query += ` AND created_at >= CONVERT(DATETIME, @start_date, 23)`;
      request.input('start_date', String(start_date).trim());
    }

    if (end_date && /^\d{4}-\d{2}-\d{2}$/.test(String(end_date).trim())) {
      query += ` AND created_at < DATEADD(day, 1, CONVERT(DATETIME, @end_date, 23))`;
      request.input('end_date', String(end_date).trim());
    }

    query += ` ORDER BY id DESC`;

    const result = await request.query(query);
    let rows = result.recordset || [];
    if (!cleanPoNo) {
      // เหมือนหน้าเว็บ (perms.x ?? true): ไม่ได้ตั้งค่าไว้ = เห็น
      const sees = (key) => Boolean(effective?.isAdminSystem) || effective?.perms?.[key] !== false;
      const canWanthai = sees('canViewAuditLogWanthai');
      const canYusen = sees('canViewAuditLogYusen');
      if (!canWanthai && !canYusen) rows = [];
      else if (!canYusen) rows = rows.filter((l) => !isYusenLog(l));
      else if (!canWanthai) rows = rows.filter(isYusenLog);
    }
    return res.json({ success: true, data: rows });
  } catch (err) {
    logger.error('Database error fetching transaction logs:', err.message);
    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการดึงข้อมูล Transaction Log จากฐานข้อมูล', error: err.message });
  }
}

module.exports = {
  ensureTransactionLogTable,
  getAuditLogs,
  isYusenLog,
};
