const express = require('express');
const createMasterRoutes = require('./masterRoutes');
const createPoRoutes = require('./poRoutes');
const { authenticate, clearAuthCache } = require('../middleware/auth');

const PUBLIC_ROUTES = new Set([
  'POST /login',
  'POST /users/login',
  'POST /login/mfa/setup',
  'POST /login/mfa/verify',
  'POST /password-reset/confirm',
  'POST /password-reset/verify',
  'POST /password-reset/mfa/setup',
  'POST /password-reset/mfa/verify',
]);

function createApiRouter(io) {
  const router = express.Router();

  router.use((req, res, next) => {
    if (PUBLIC_ROUTES.has(`${req.method} ${req.path}`)) return next();
    return authenticate(req, res, next);
  });

  router.use((req, res, next) => {
    if (req.method !== 'GET' && /^\/(users|permissions|save-permission)/.test(req.path)) {
      res.on('finish', () => { if (res.statusCode < 400) clearAuthCache(); });
    }
    next();
  });

  router.use(createMasterRoutes(io));

  router.use(createPoRoutes(io));

  return router;
}

module.exports = createApiRouter;
