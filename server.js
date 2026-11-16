require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });
// ไม่มี MFA_ENCRYPTION_KEY ที่ถูกต้อง = ไม่ start (MFA จะทำงานไม่ได้)
require('./src/config/mfa').loadEncryptionKey();
const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');

const { initializeDatabase } = require('./src/config/db');
const createApiRouter = require('./src/routes');
const { getLiveDashboardData } = require('./src/services/dashboardService');
const { loginUser, ensureUserTable } = require('./src/controllers/userController');
const { ensureTransactionLogTable } = require('./src/controllers/auditLogController');
const { loginRateLimit } = require('./src/middleware/loginRateLimit');
const { createOriginChecker } = require('./src/config/cors');
const { authenticateSocket } = require('./src/middleware/auth');
const { hideInternalErrors, finalErrorHandler, installProcessErrorLogging } = require('./src/middleware/errorHandling');
const { logger, requestLogger } = require('./src/utils/logger');

installProcessErrorLogging();

const checkOrigin = createOriginChecker();

const app = express();
// backend ส่งแค่ JSON ไม่มีหน้าเว็บ จึงตั้ง CSP ให้ห้ามโหลดทุกอย่างและห้ามฝังใน iframe
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
  },
}));
app.use(requestLogger);
app.use(cors({ origin: checkOrigin }));
app.use(hideInternalErrors);
app.use(express.json({ limit: '5mb' }));

app.post('/login', loginRateLimit, loginUser);
app.post('/api/login', loginRateLimit, loginUser);

const sslKeyFile = process.env.SSL_KEY_FILE;
const sslCertFile = process.env.SSL_CERT_FILE;
const useHttps = Boolean(sslKeyFile && sslCertFile);
const server = useHttps
  ? https.createServer({ key: fs.readFileSync(sslKeyFile), cert: fs.readFileSync(sslCertFile) }, app)
  : http.createServer(app);
if (!useHttps) {
  logger.warn('⚠️ Running over plain HTTP — passwords and tokens are not encrypted in transit. Set SSL_KEY_FILE and SSL_CERT_FILE (or put the server behind an HTTPS reverse proxy).');
}
const io = new Server(server, {
  cors: { origin: checkOrigin },
});

io.use(authenticateSocket);

app.use('/api', createApiRouter(io));

app.use(finalErrorHandler);

io.on('connection', async (socket) => {
  logger.debug('Client connected:', socket.id);
  try {
    const liveData = await getLiveDashboardData();
    socket.emit('data', liveData);
  } catch (err) {
    logger.warn('Error sending initial dashboard data:', err.message);
  }
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, async () => {
  logger.info(`🚀 Server running on port ${PORT}`);
  try {
    await initializeDatabase();
    await ensureTransactionLogTable();
    await ensureUserTable();
  } catch (err) {
    logger.warn('⚠️ Running in fallback mode. Database will reconnect once available.');
  }
});
