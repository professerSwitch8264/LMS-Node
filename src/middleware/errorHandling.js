const { logger } = require('../utils/logger');
const GENERIC_MESSAGE = 'เกิดข้อผิดพลาดภายในระบบ กรุณาลองใหม่อีกครั้ง';
const INTERNAL_FIELDS = ['error', 'stack', 'details', 'sqlMessage', 'originalError'];

function hideInternalErrors(req, res, next) {
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode >= 500 && body && typeof body === 'object' && !Array.isArray(body)) {
      const hidden = {};
      INTERNAL_FIELDS.forEach((field) => {
        if (body[field] !== undefined) hidden[field] = body[field];
      });
      if (Object.keys(hidden).length > 0) {
        logger.error(`❌ ${req.method} ${req.originalUrl} -> ${res.statusCode}:`, hidden.error || hidden.details || hidden.stack);
        const safe = { ...body };
        INTERNAL_FIELDS.forEach((field) => { delete safe[field]; });
        return originalJson(safe);
      }
    }
    return originalJson(body);
  };
  next();
}

// eslint-disable-next-line no-unused-vars -- Express ต้องมีพารามิเตอร์ครบ 4 ตัวถึงจะเป็น error handler
function finalErrorHandler(err, req, res, next) {
  if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
    return res.status(400).json({ success: false, code: 'BAD_JSON', message: 'ข้อมูลที่ส่งมาไม่ถูกต้อง' });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ success: false, code: 'PAYLOAD_TOO_LARGE', message: 'ข้อมูลที่ส่งมามีขนาดใหญ่เกินไป' });
  }
  logger.error(`❌ Unhandled error on ${req.method} ${req.originalUrl}:`, err && err.stack ? err.stack : err);
  if (res.headersSent) return undefined;
  return res.status(500).json({ success: false, code: 'INTERNAL_ERROR', message: GENERIC_MESSAGE });
}

function installProcessErrorLogging() {
  process.on('unhandledRejection', (reason) => {
    logger.error('❌ Unhandled promise rejection:', reason && reason.stack ? reason.stack : reason);
  });
}

module.exports = {
  hideInternalErrors,
  finalErrorHandler,
  installProcessErrorLogging,
  GENERIC_MESSAGE,
};
