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


// ฝ่ายของผู้บันทึก (DX / WANTHAI / YUSEN) = ฝ่ายของผู้ใช้ในตาราง User ณ ตอนที่อ่าน
// ผู้ใช้ที่ถูกลบไปแล้ว / SYSTEM: เดาจากคำในรายการแบบเดิม (แผนรถ / รถเข้า = YUSEN, นอกนั้น WANTHAI)
const YUSEN_LOG_SQL = `(
  UPPER(t.action_type) LIKE '%TRUCK_ARRIVAL%' OR UPPER(t.action_type) LIKE '%CAR_PLAN%' OR UPPER(t.action_type) LIKE '%CAR_REGISTER%'
  OR UPPER(t.action_type) LIKE '%RESCHEDULE_PLAN%' OR UPPER(t.username) LIKE '%YUSEN%'
  OR t.details LIKE N'%แผนรถ%' OR t.details LIKE N'%รถเข้า%'
)`;
const ACTOR_GROUP_SQL = `COALESCE(u.user_group, CASE WHEN ${YUSEN_LOG_SQL} THEN 'YUSEN' ELSE 'WANTHAI' END)`;
const FROM_LOGS_SQL = `[${T}] t LEFT JOIN [${TABLES.USER}] u ON UPPER(u.username) = UPPER(t.username)`;
const AUDIT_SIDES = ['DX', 'WANTHAI', 'YUSEN'];
const SIDE_PERMISSION = { DX: 'canViewAuditLogDx', WANTHAI: 'canViewAuditLogWanthai', YUSEN: 'canViewAuditLogYusen' };

// สิทธิ์ที่ต้องเปิดไว้ชัดเจน (true) ถึงจะเห็น — canViewAuditLogDx เป็นสิทธิ์ใหม่ role เดิมในฐานข้อมูลยังไม่มี key นี้
// ถ้าใช้กฎ "ไม่ได้ตั้ง = เห็น" ทุก role ที่ดูประวัติได้จะเห็นรายการของฝ่าย DX ทันที
const EXPLICIT_SIDE_PERMISSIONS = new Set(['canViewAuditLogDx']);

/**
 * ฝ่ายที่ผู้ใช้คนนี้ดูประวัติได้ แล้วตัดตามตัวกรอง side ถ้ามี
 * - Wanthai / Yusen: ไม่ได้ตั้งค่าไว้ = เห็น (กฎเดิมของหน้าเว็บ)
 * - DX: ต้องเปิดไว้ (true) — ADMIN_SYSTEM เห็นทุกฝ่ายเสมอ
 * คืนรายชื่อฝ่าย เช่น ['WANTHAI', 'YUSEN'] — ว่าง = ไม่เห็นอะไรเลย
 */
function visibleSides(effective, sideFilter) {
  const sees = (key) => {
    if (effective?.isAdminSystem) return true;
    const value = effective?.perms?.[key];
    return EXPLICIT_SIDE_PERMISSIONS.has(key) ? value === true : value !== false;
  };
  const allowed = AUDIT_SIDES.filter((side) => sees(SIDE_PERMISSION[side]));
  let wanted = String(sideFilter || '').trim().toUpperCase();
  if (wanted === 'WAREHOUSE') wanted = 'WANTHAI';
  return AUDIT_SIDES.includes(wanted) ? allowed.filter((s) => s === wanted) : allowed;
}

const sidesWhereSql = (sides) => (sides.length === 0 ? '1=0' : `${ACTOR_GROUP_SQL} IN (${sides.map((s) => `'${s}'`).join(', ')})`);

// หมวดในหน้าต่างตัวกรองของหน้า Audit Log (เหมือนกฎเดิมของหน้าเว็บ: ดูจากคำใน action_type)
const CATEGORY_KEYWORDS = {
  PO: ['PO', 'IMPORT', 'URGENT'],
  TRUCK: ['CAR', 'TRUCK', 'ARRIVAL', 'DEPARTURE'],
  DOCK: ['DOCK', 'DOOR'],
  OPERATION: ['TICKET', 'PICK', 'LOAD'],
  SYSTEM: ['USER', 'ROLE', 'PERMISSION'],
};

const AUDIT_SORT_COLUMNS = {
  created: 't.created_at',
  username: 't.username',
  action: "COALESCE(NULLIF(t.action_title, ''), t.action_type)",
  po: 't.po_no',
  details: 't.details',
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// หน้า Audit Log: ค้นหา / กรอง / เรียง / แบ่งหน้าใน SQL — คืน { data, total, page, pageSize, totalPages }
async function getAuditLogsPage(req, res, effective) {
  const qp = req.query;
  const page = Math.max(1, parseInt(qp.page, 10) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(qp.pageSize, 10) || 50));
  const exportAll = qp.all === '1' || qp.all === 'true';

  const where = ['1=1'];
  const inputs = [];
  const like = (name, value) => { inputs.push([name, `%${String(value).trim()}%`]); return `@${name}`; };

  // ฝ่ายของผู้บันทึกที่ผู้ใช้มีสิทธิ์ดู (และตัวกรองฝ่ายถ้าเลือก)
  where.push(sidesWhereSql(visibleSides(effective, qp.side)));

  const keywords = CATEGORY_KEYWORDS[String(qp.category || '').toUpperCase()];
  if (keywords) where.push(`(${keywords.map((k) => `UPPER(t.action_type) LIKE '%${k}%'`).join(' OR ')})`);

  if (String(qp.user || '').trim()) where.push(`t.username LIKE ${like('user', qp.user)}`);
  if (String(qp.po || '').trim()) where.push(`t.po_no LIKE ${like('po', qp.po)}`);
  if (String(qp.detail || '').trim()) {
    const p = like('detail', qp.detail);
    where.push(`(t.details LIKE ${p} OR t.action_title LIKE ${p})`);
  }
  if (String(qp.q || '').trim()) {
    const p = like('q', qp.q);
    where.push(`(t.username LIKE ${p} OR t.po_no LIKE ${p} OR t.action_title LIKE ${p} OR t.details LIKE ${p})`);
  }
  if (DATE_RE.test(String(qp.start_date || '').trim())) {
    where.push('t.created_at >= CONVERT(DATETIME, @start_date, 23)');
    inputs.push(['start_date', String(qp.start_date).trim()]);
  }
  if (DATE_RE.test(String(qp.end_date || '').trim())) {
    where.push('t.created_at < DATEADD(day, 1, CONVERT(DATETIME, @end_date, 23))');
    inputs.push(['end_date', String(qp.end_date).trim()]);
  }

  const sortCol = AUDIT_SORT_COLUMNS[qp.sortField] || AUDIT_SORT_COLUMNS.created;
  const sortDir = String(qp.sortDir || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const whereSql = where.join(' AND ');

  await ensureTransactionLogTable();
  const pool = await getPool();
  const withInputs = () => {
    const r = pool.request();
    inputs.forEach(([name, value]) => r.input(name, value));
    return r;
  };

  const total = (await withInputs().query(`SELECT COUNT(*) AS total FROM ${FROM_LOGS_SQL} WHERE ${whereSql}`)).recordset[0].total;
  const totalPages = exportAll ? 1 : Math.max(1, Math.ceil(total / pageSize));
  const safePage = exportAll ? 1 : Math.min(page, totalPages);
  const take = exportAll ? Math.min(total, 20000) : pageSize;
  const rows = take === 0 ? [] : (await withInputs()
    .input('offset', (safePage - 1) * pageSize)
    .input('take', take)
    .query(`SELECT t.id, t.created_at, t.username, t.action_type, t.action_title, t.po_no, t.details, ${ACTOR_GROUP_SQL} AS actor_group
            FROM ${FROM_LOGS_SQL}
            WHERE ${whereSql}
            ORDER BY ${sortCol} ${sortDir}, t.id ${sortDir}
            OFFSET ${exportAll ? 0 : '@offset'} ROWS FETCH NEXT @take ROWS ONLY`)).recordset;

  return res.json({ success: true, data: rows, total, page: safePage, pageSize: exportAll ? total : pageSize, totalPages });
}

// สิทธิ์อ่าน:
//  - ระบุ po_no → ทุกคนที่ login อ่านประวัติของ PO นั้นได้ (หน้า PO ใช้แสดงผู้บันทึกแต่ละขั้น) ตรงเลข PO เท่านั้น
//  - ไม่ระบุ po_no (หน้า Audit Log) → ต้องมี canViewAuditLog และกรองฝั่ง Wanthai / Yusen ตามสิทธิ์
//  - ส่ง page มา → โหมดแบ่งหน้า (getAuditLogsPage) ใช้กับหน้า Audit Log
async function getAuditLogs(req, res) {
  const { po_no, username, start_date, end_date, limit } = req.query;
  const effective = req.user?.effective;
  const can = (key) => hasAnyPermission(effective, [key]);
  const cleanPoNo = po_no ? String(po_no).trim().toUpperCase() : '';
  if (!cleanPoNo && !can('canViewAuditLog')) {
    return res.status(403).json({ success: false, code: 'FORBIDDEN', message: 'ไม่มีสิทธิ์ดูประวัติการบันทึก' });
  }
  if (!cleanPoNo && (req.query.page || req.query.all)) {
    try {
      return await getAuditLogsPage(req, res, effective);
    } catch (err) {
      logger.error('Database error fetching transaction log page:', err.message);
      return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการดึงข้อมูล Transaction Log จากฐานข้อมูล', error: err.message });
    }
  }
  const hasDateRange = Boolean(start_date || end_date);
  const parsedLimit = Math.min(Math.max(parseInt(limit, 10) || (hasDateRange ? 1000 : 100), 1), 5000);

  try {
    await ensureTransactionLogTable();
    const pool = await getPool();

    let query = `SELECT TOP (@limit) t.id, t.created_at, t.username, t.action_type, t.action_title, t.po_no, t.details, ${ACTOR_GROUP_SQL} AS actor_group FROM ${FROM_LOGS_SQL} WHERE 1=1`;
    const request = pool.request().input('limit', parsedLimit);

    if (cleanPoNo) {
      query += ` AND UPPER(t.po_no) = @po_no`;
      request.input('po_no', cleanPoNo);
    }

    if (username) {
      query += ` AND UPPER(t.username) LIKE '%' + @username + '%'`;
      request.input('username', String(username).trim().toUpperCase());
    }

    if (start_date && /^\d{4}-\d{2}-\d{2}$/.test(String(start_date).trim())) {
      query += ` AND t.created_at >= CONVERT(DATETIME, @start_date, 23)`;
      request.input('start_date', String(start_date).trim());
    }

    if (end_date && /^\d{4}-\d{2}-\d{2}$/.test(String(end_date).trim())) {
      query += ` AND t.created_at < DATEADD(day, 1, CONVERT(DATETIME, @end_date, 23))`;
      request.input('end_date', String(end_date).trim());
    }

    // หน้า Audit Log (ไม่ระบุ PO): เห็นเฉพาะฝ่ายของผู้บันทึกที่มีสิทธิ์ดู — หน้ารายละเอียด PO ไม่กรองตามฝ่าย
    if (!cleanPoNo) query += ` AND ${sidesWhereSql(visibleSides(effective, req.query.side))}`;

    query += ` ORDER BY t.id DESC`;

    const result = await request.query(query);
    return res.json({ success: true, data: result.recordset || [] });
  } catch (err) {
    logger.error('Database error fetching transaction logs:', err.message);
    return res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการดึงข้อมูล Transaction Log จากฐานข้อมูล', error: err.message });
  }
}

module.exports = {
  ensureTransactionLogTable,
  getAuditLogs,
  visibleSides,
  sidesWhereSql,
};
