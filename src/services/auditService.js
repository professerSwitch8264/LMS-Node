// บันทึก Audit log (ตาราง Transaction_log) จากฝั่ง backend
// - เขียนหลังคำสั่งหลักสำเร็จเท่านั้น ผู้ทำรายการมาจาก token (req.user) ไม่ใช่จากหน้าเว็บ
// - เขียนไม่สำเร็จจะไม่ทำให้คำสั่งหลักล้ม แค่ log error ไว้
// - ห้ามใส่รหัสผ่าน / token / MFA secret / ลิงก์รีเซ็ต ลงใน details
const { getPool } = require('../config/db');
const { TABLES } = require('../config/constants');
const { ensureTransactionLogTable } = require('../controllers/auditLogController');
const { logger } = require('../utils/logger');

const clip = (value, max) => {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, max) : null;
};

async function writeAudit({ username, actionType, actionTitle, poNo, details }, io = null) {
  const entry = {
    username: clip(username, 50)?.toUpperCase() || 'SYSTEM',
    action_type: clip(actionType, 50)?.toUpperCase() || 'GENERAL',
    action_title: clip(actionTitle || actionType, 100) || '-',
    po_no: clip(poNo, 50)?.toUpperCase() || null,
    details: clip(details, 500),
  };
  try {
    await ensureTransactionLogTable();
    const pool = await getPool();
    const result = await pool.request()
      .input('username', entry.username)
      .input('action_type', entry.action_type)
      .input('action_title', entry.action_title)
      .input('po_no', entry.po_no)
      .input('details', entry.details)
      .query(`
        INSERT INTO [${TABLES.TRANSACTION_LOG}] (username, action_type, action_title, po_no, details)
        OUTPUT INSERTED.id, INSERTED.created_at
        VALUES (@username, @action_type, @action_title, @po_no, @details)
      `);
    const inserted = result.recordset?.[0] || {};
    const item = { id: inserted.id, created_at: inserted.created_at || new Date().toISOString(), ...entry };
    if (io) io.emit('wanthai_audit_log_created', item);
    return item;
  } catch (err) {
    logger.error(`[audit] write failed (${entry.action_type} ${entry.po_no || ''}):`, err.message);
    return null;
  }
}

// middleware: หลัง handler ตอบสำเร็จ (status < 400 และ success !== false) ให้สร้างรายการจาก build(req, body)
// build คืน entry เดียว, array ของ entry, หรือ null (ไม่บันทึก)
function auditRoute(io, build) {
  return (req, res, next) => {
    let responseBody;
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      responseBody = body;
      return originalJson(body);
    };
    res.on('finish', () => {
      if (res.statusCode >= 400 || responseBody?.success === false) return;
      let entries;
      try {
        entries = build(req, responseBody || {});
      } catch (err) {
        logger.error(`[audit] build failed on ${req.method} ${req.originalUrl}:`, err.message);
        return;
      }
      const list = (Array.isArray(entries) ? entries : [entries]).filter(Boolean);
      list.forEach((entry) => {
        writeAudit({ ...entry, username: req.user?.username }, io);
      });
    });
    next();
  };
}

module.exports = { writeAudit, auditRoute };
