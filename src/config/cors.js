const { logger } = require('../utils/logger');
const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\.\d+\.\d+\.\d+$/,
  /^\[?::1\]?$/,
  /^10\.\d+\.\d+\.\d+$/,
  /^192\.168\.\d+\.\d+$/,
  /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/,
];

const parseAllowedOrigins = (value) =>
  String(value || '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);

const isPrivateNetworkOrigin = (origin) => {
  try {
    const { protocol, hostname } = new URL(origin);
    if (protocol !== 'http:' && protocol !== 'https:') return false;
    return PRIVATE_HOST_PATTERNS.some((re) => re.test(hostname));
  } catch {
    return false;
  }
};

function createOriginChecker(env = process.env) {
  const allowList = parseAllowedOrigins(env.CORS_ORIGINS);
  const useAllowList = allowList.length > 0;
  const warned = new Set();

  if (!useAllowList) {
    logger.warn('⚠️ CORS_ORIGINS is not set — allowing only localhost and private-network origins. Set CORS_ORIGINS in .env for production.');
  }

  const isAllowed = (origin) => {
    if (!origin) return true;
    const clean = origin.replace(/\/+$/, '');
    return useAllowList ? allowList.includes(clean) : isPrivateNetworkOrigin(clean);
  };

  return (origin, callback) => {
    if (isAllowed(origin)) return callback(null, true);
    if (!warned.has(origin)) {
      warned.add(origin);
      logger.warn(`🚫 Blocked CORS request from origin: ${origin}`);
    }
    return callback(null, false);
  };
}

module.exports = {
  createOriginChecker,
  isPrivateNetworkOrigin,
  parseAllowedOrigins,
};
