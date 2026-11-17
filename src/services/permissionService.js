function normalizeRole(role) {
  if (!role) return '';
  const r = String(role).trim().toUpperCase().replace(/\s+/g, '_');
  if (r === 'ADMIN_SYSTEM' || r === 'DX') return 'ADMIN_SYSTEM';
  if (r === 'ADMIN_WAREHOUSE' || r === 'ADMIN_OFFICE') return 'ADMIN_WAREHOUSE';
  if (['LEADER_WAREHOUSE_PICKER', 'LEADER_PICKER', 'LEADER_PICK', 'PICKER', 'PICK'].includes(r)) return 'LEADER_WAREHOUSE_PICKER';
  if (['LEADER_WAREHOUSE_LOADER', 'LEADER_LOADER', 'LEADER_LOAD', 'LOADER', 'LOAD'].includes(r)) return 'LEADER_WAREHOUSE_LOADER';
  if (r === 'YUSEN_OFFICE' || r === 'YUSEN_ADMIN' || r === 'CAR_REGISTER') return 'YUSEN_OFFICE';
  if (['YUSEN_TRUCKER', 'YUSEN_TRUCK', 'TRUCKER', 'TRUCK'].includes(r)) return 'YUSEN_TRUCKER';
  if (r === 'YUSEN') return 'YUSEN_OFFICE';
  if (r === 'LEADER_WAREHOUSE' || r === 'ADMIN_OUTSIDE') return 'LEADER_WAREHOUSE_PICKER';
  return r;
}

const parsePermissionsJson = (value) => {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
};

// สิทธิ์ย่อยของ "จัดการข้อมูล PO" — ไม่มีให้ติ๊กแยกในหน้ากำหนดสิทธิ์ จึงเท่ากับ canEditPoData เสมอ
const PO_DATA_SUB_PERMISSIONS = ['canAddPo', 'canImportPo', 'canSetUrgentPo', 'canCancelPo', 'canReschedulePo'];

function derivePoDataPermissions(perms) {
  const allowed = Boolean(perms && perms.canEditPoData);
  return Object.fromEntries(PO_DATA_SUB_PERMISSIONS.map((k) => [k, allowed]));
}

function getEffectivePermissions(roleId, rawPermissions, defaults = {}) {
  const normRole = normalizeRole(roleId);
  if (normRole === 'ADMIN_SYSTEM') {
    return { isAdminSystem: true, perms: {} };
  }

  const base = rawPermissions
    || defaults[normRole]?.permissions
    || defaults[String(roleId || '').trim().toUpperCase()]?.permissions
    || {};

  const normalized = {};
  Object.keys(base).forEach((k) => { normalized[k] = Boolean(base[k]); });

  normalized.canViewTabActionRequired = Boolean(
    base.canEditPoData || base.canEditCarPlan || base.canActionTicketSent || base.canViewTabActionRequired
  );
  normalized.canViewTabTracking = Boolean(
    base.canActionTruckArrival || base.canEditDockDoor || base.canActionIssueTicket
    || base.canActionPicking || base.canActionLoading || base.canActionTruckDeparture || base.canViewTabTracking
  );

  // หน้ากำหนดสิทธิ์มีแค่ "จัดการข้อมูล PO" (canEditPoData) — เพิ่ม/นำเข้า/ส่งด่วน/ยกเลิก/เลื่อนแผน ตามสิทธิ์นี้เสมอ
  const poDataPerms = derivePoDataPermissions(base);

  if (base.canToggleDoorLock || base.canAddDoor || base.canDeleteDoor) {
    normalized.canManageDoorLock = true;
    normalized.canViewDoorLock = true;
  } else if (base.canManageDoorLock) {
    normalized.canViewDoorLock = true;
  }

  if (base.canViewPoTable) normalized.canExportExcel = true;

  if (base.canEditUser || base.canAddUser || base.canDeleteUser) {
    normalized.canManageUsers = true;
    normalized.canViewUsers = true;
  } else if (base.canManageUsers) {
    normalized.canViewUsers = true;
  }

  if (base.canEditRole || base.canAddRole || base.canDeleteRole) {
    normalized.canManageRoles = true;
    normalized.canViewRoles = true;
  } else if (base.canManageRoles) {
    normalized.canViewRoles = true;
  }

  if (base.canViewAuditLogDx || base.canViewAuditLogWanthai || base.canViewAuditLogYusen) normalized.canViewAuditLog = true;

  return { isAdminSystem: false, perms: { ...normalized, ...base, ...poDataPerms } };
}

function hasAnyPermission(effective, keys) {
  if (!effective) return false;
  if (effective.isAdminSystem) return true;
  return keys.some((k) => Boolean(effective.perms[k]));
}

module.exports = {
  PO_DATA_SUB_PERMISSIONS,
  derivePoDataPermissions,
  normalizeRole,
  parsePermissionsJson,
  getEffectivePermissions,
  hasAnyPermission,
};
