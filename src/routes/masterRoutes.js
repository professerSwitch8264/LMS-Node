const express = require('express');
const {
  getCustomers,
  getShipTo,
  getDockDoors,
  createToggleDockDoorLockHandler,
  createBatchLockDockDoorsHandler,
  createDockDoorHandler,
  createDeleteDockDoorHandler,
  createRestoreDockDoorHandler,
  getWarehouses,
  getTruckTypes,
} = require('../controllers/masterController');
const {
  getPermissions,
  updatePermission,
  createRole,
  deleteRole,
  resetPermissions,
} = require('../controllers/permissionController');
const {
  getUsers,
  getUserByUsername,
  createUser,
  updateUser,
  deleteUser,
  loginUser,
  loginMfaSetup,
  loginMfaVerify,
  requestPasswordReset,
  confirmPasswordReset,
  verifyPasswordResetToken,
  resetLinkMfaSetup,
  resetLinkMfaVerify,
  setUserActive,
  resetUserMfa,
} = require('../controllers/userController');
const { getAuditLogs } = require('../controllers/auditLogController');
const { auditRoute } = require('../services/auditService');
const { DOOR, ROLE, USER } = require('../services/auditEvents');
const {
  requirePermission: can,
  requireSelfOrPermission,
  protectAdminSystemAccounts,
} = require('../middleware/auth');
const { loginRateLimit, passwordResetRateLimit } = require('../middleware/loginRateLimit');

function createMasterRoutes(io) {
  const router = express.Router();
  const audit = (build) => auditRoute(io, build);

  router.get('/customers', getCustomers);
  router.get('/ship-to', getShipTo);
  router.get('/dock-doors', getDockDoors);
  router.get('/warehouses', getWarehouses);
  router.get('/truck-types', getTruckTypes);

  const canAddDoor = can('canAddDoor', 'canManageDoorLock');
  const canDeleteDoor = can('canDeleteDoor', 'canManageDoorLock');
  const canToggleDoor = can('canToggleDoorLock', 'canManageDoorLock');
  router.post('/dock-doors', canAddDoor, audit(DOOR.create), createDockDoorHandler(io));
  router.post('/dock-doors/create', canAddDoor, audit(DOOR.create), createDockDoorHandler(io));
  router.post('/dock-doors/toggle-lock', canToggleDoor, audit(DOOR.toggleLock), createToggleDockDoorLockHandler(io));
  router.post('/dock-doors/batch-lock', canToggleDoor, audit(DOOR.batchLock), createBatchLockDockDoorsHandler(io));
  router.delete('/dock-doors/:id', canDeleteDoor, audit(DOOR.remove), createDeleteDockDoorHandler(io));
  router.post('/dock-doors/delete', canDeleteDoor, audit(DOOR.remove), createDeleteDockDoorHandler(io));
  router.post('/dock-doors/restore', canDeleteDoor, audit(DOOR.restore), createRestoreDockDoorHandler(io));
  router.post('/dock-doors/:id/restore', canDeleteDoor, audit(DOOR.restore), createRestoreDockDoorHandler(io));

  const canEditRole = can('canEditRole', 'canManageRoles');
  const canAddRole = can('canAddRole', 'canManageRoles');
  const canDeleteRole = can('canDeleteRole', 'canManageRoles');
  router.get('/permissions', getPermissions);
  router.get('/permissions/:roleId', getPermissions);
  router.post('/permissions/reset', can('canManageRoles'), audit(ROLE.reset), resetPermissions);
  router.post('/permissions/roles', canAddRole, audit(ROLE.create), createRole);
  router.put('/permissions/:roleId', canEditRole, audit(ROLE.update), updatePermission);
  router.post('/permissions/:roleId', canEditRole, audit(ROLE.update), updatePermission);
  router.put('/permissions', canEditRole, audit(ROLE.update), updatePermission);
  router.post('/permissions', canEditRole, audit(ROLE.update), updatePermission);
  router.post('/save-permission', canEditRole, audit(ROLE.update), updatePermission);
  router.delete('/permissions/roles/:roleId', canDeleteRole, audit(ROLE.remove), deleteRole);
  router.delete('/permissions/:roleId', canDeleteRole, audit(ROLE.remove), deleteRole);

  const canViewUsers = ['canViewUsers', 'canManageUsers'];
  router.post('/login', loginRateLimit, loginUser);
  router.post('/users/login', loginRateLimit, loginUser);
  // MFA ตอน login — ใช้ mfaToken จากขั้นรหัสผ่าน (ไม่ใช่ token จริง)
  router.post('/login/mfa/setup', loginRateLimit, loginMfaSetup);
  router.post('/login/mfa/verify', loginRateLimit, loginMfaVerify);
  router.get('/users', can(...canViewUsers), getUsers);
  router.get('/users/:username', requireSelfOrPermission(...canViewUsers), getUserByUsername);
  router.post('/password-reset/verify', passwordResetRateLimit, verifyPasswordResetToken);
  router.post('/password-reset/confirm', passwordResetRateLimit, confirmPasswordReset);
  router.post('/password-reset/mfa/setup', passwordResetRateLimit, resetLinkMfaSetup);
  router.post('/password-reset/mfa/verify', passwordResetRateLimit, resetLinkMfaVerify);
  router.post('/users', can('canAddUser', 'canManageUsers'), protectAdminSystemAccounts, audit(USER.create), createUser);
  router.post('/users/:username/reset-password', can('canEditUser', 'canManageUsers'), protectAdminSystemAccounts, audit(USER.resetPassword), requestPasswordReset);
  router.patch('/users/:username/active', can('canEditUser', 'canManageUsers'), protectAdminSystemAccounts, setUserActive);
  router.post('/users/:username/reset-mfa', can('canEditUser', 'canManageUsers'), protectAdminSystemAccounts, resetUserMfa);
  router.put('/users/:username', can('canEditUser', 'canManageUsers'), protectAdminSystemAccounts, audit(USER.update), updateUser);
  router.post('/users/:username', can('canEditUser', 'canManageUsers'), protectAdminSystemAccounts, audit(USER.update), updateUser);
  router.delete('/users/:username', can('canDeleteUser', 'canManageUsers'), protectAdminSystemAccounts, audit(USER.remove), deleteUser);
  router.post('/users/:username/delete', can('canDeleteUser', 'canManageUsers'), protectAdminSystemAccounts, audit(USER.remove), deleteUser);

  // อ่านได้ทุกคนเมื่อระบุ PO (ใช้แสดงผู้บันทึกแต่ละขั้น) — ดูทั้งหมดต้องมี canViewAuditLog (ตรวจใน getAuditLogs)
  // ไม่มี POST แล้ว: audit log เขียนจาก backend เท่านั้น (services/auditService)
  router.get('/audit-logs', getAuditLogs);

  return router;
}

module.exports = createMasterRoutes;
