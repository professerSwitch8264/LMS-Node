const { logger } = require('../utils/logger');
const { getPool, ensureDashboardTypeColumn, hasDashboardTypeColumn } = require('../config/db');
const { TABLES, getDefaultDashboardType, normalizeDashboardType } = require('../config/constants');
const { derivePoDataPermissions } = require('../services/permissionService');

let dashboardTypeColumnReady = false;
const DT = () => dashboardTypeColumnReady;

const DEFAULT_SHEET3_PERMISSIONS = {
  ADMIN_WAREHOUSE: {
    role_id: 'ADMIN_WAREHOUSE',
    role_name: 'Admin Warehouse',
    view_mode: 'PC',
    permissions: {
      canAddPo: true,
      canImportPo: true,
      canExportExcel: true,
      canSetUrgentPo: true,
      canViewTabActionRequired: true,
      canViewTabTracking: true,
      canViewPoTable: true,
      canManageDoorLock: true,
      canViewDoorLock: true,
      canToggleDoorLock: true,
      canAddDoor: true,
      canDeleteDoor: true,
      canEditPoData: true,
      canEditCarPlan: false,
      canActionTicketSent: true,
      canActionTruckArrival: false,
      canEditDockDoor: true,
      canActionIssueTicket: true,
      canActionPicking: false,
      canActionLoading: false,
      canActionTruckDeparture: false,
      canViewDeliveryInfo: true,
      canViewCarPlan: true,
      canViewTicketSent: true,
      canViewTruckArrival: true,
      canViewDockDoor: true,
      canViewIssueTicket: true,
      canViewPicking: true,
      canViewLoading: true,
      canViewTruckDeparture: true,
      canCancelPo: true,
      canReschedulePo: true,
      canManageRoles: false,
      canViewRoles: false,
      canEditRole: false,
      canAddRole: false,
      canDeleteRole: false,
      canManageUsers: false,
      canViewUsers: false,
      canEditUser: false,
      canAddUser: false,
      canDeleteUser: false,
      canViewAuditLog: true,
      canViewAuditLogWanthai: true,
      canViewAuditLogYusen: false,
    },
  },
  LEADER_WAREHOUSE_PICKER: {
    role_id: 'LEADER_WAREHOUSE_PICKER',
    role_name: 'Leader Warehouse Pick',
    view_mode: 'MOBILE',
    permissions: {
      canAddPo: false,
      canImportPo: false,
      canViewTabActionRequired: false,
      canViewTabTracking: true,
      canManageDoorLock: false,
      canViewDoorLock: false,
      canEditPoData: false,
      canEditCarPlan: false,
      canActionTicketSent: false,
      canActionTruckArrival: false,
      canEditDockDoor: false,
      canActionIssueTicket: false,
      canActionPicking: true,
      canActionLoading: false,
      canActionTruckDeparture: false,
      canViewDeliveryInfo: true,
      canViewCarPlan: false,
      canViewTicketSent: false,
      canViewTruckArrival: false,
      canViewDockDoor: true,
      canViewIssueTicket: false,
      canViewPicking: true,
      canViewLoading: false,
      canViewTruckDeparture: false,
      canCancelPo: false,
      canReschedulePo: false,
      canManageRoles: false,
      canManageUsers: false,
    },
  },
  LEADER_WAREHOUSE_LOADER: {
    role_id: 'LEADER_WAREHOUSE_LOADER',
    role_name: 'Leader Warehouse Load',
    view_mode: 'MOBILE',
    permissions: {
      canAddPo: false,
      canImportPo: false,
      canViewTabActionRequired: false,
      canViewTabTracking: true,
      canManageDoorLock: false,
      canViewDoorLock: false,
      canEditPoData: false,
      canEditCarPlan: false,
      canActionTicketSent: false,
      canActionTruckArrival: false,
      canEditDockDoor: false,
      canActionIssueTicket: false,
      canActionPicking: false,
      canActionLoading: true,
      canActionTruckDeparture: true,
      canViewDeliveryInfo: true,
      canViewCarPlan: false,
      canViewTicketSent: false,
      canViewTruckArrival: false,
      canViewDockDoor: true,
      canViewIssueTicket: false,
      canViewPicking: true,
      canViewLoading: true,
      canViewTruckDeparture: true,
      canCancelPo: false,
      canReschedulePo: false,
      canManageRoles: false,
      canManageUsers: false,
    },
  },
  YUSEN_OFFICE: {
    role_id: 'YUSEN_OFFICE',
    role_name: 'Yusen Office',
    view_mode: 'PC',
    permissions: {
      canAddPo: false,
      canImportPo: false,
      canViewTabActionRequired: true,
      canViewTabTracking: true,
      canManageDoorLock: false,
      canViewDoorLock: false,
      canEditPoData: false,
      canEditCarPlan: true,
      canActionTicketSent: false,
      canActionTruckArrival: true,
      canEditDockDoor: false,
      canActionIssueTicket: false,
      canActionPicking: false,
      canActionLoading: false,
      canActionTruckDeparture: false,
      canViewDeliveryInfo: true,
      canViewCarPlan: true,
      canViewTicketSent: false,
      canViewTruckArrival: true,
      canViewDockDoor: true,
      canViewIssueTicket: false,
      canViewPicking: false,
      canViewLoading: false,
      canViewTruckDeparture: true,
      canCancelPo: false,
      canReschedulePo: false,
      canManageRoles: false,
      canManageUsers: false,
    },
  },
  YUSEN_TRUCKER: {
    role_id: 'YUSEN_TRUCKER',
    role_name: 'Yusen Truck',
    view_mode: 'MOBILE',
    permissions: {
      canAddPo: false,
      canImportPo: false,
      canViewTabActionRequired: false,
      canViewTabTracking: false,
      canManageDoorLock: false,
      canViewDoorLock: false,
      canEditPoData: false,
      canEditCarPlan: false,
      canActionTicketSent: false,
      canActionTruckArrival: true,
      canEditDockDoor: false,
      canActionIssueTicket: false,
      canActionPicking: false,
      canActionLoading: false,
      canActionTruckDeparture: false,
      canViewDeliveryInfo: true,
      canViewCarPlan: true,
      canViewTicketSent: false,
      canViewTruckArrival: true,
      canViewDockDoor: true,
      canViewIssueTicket: false,
      canViewPicking: false,
      canViewLoading: false,
      canViewTruckDeparture: true,
      canCancelPo: false,
      canReschedulePo: false,
      canManageRoles: false,
      canManageUsers: false,
    },
  },
  ADMIN_SYSTEM: {
    role_id: 'ADMIN_SYSTEM',
    role_name: 'Admin System',
    view_mode: 'PC',
    permissions: {
      canAddPo: true,
      canImportPo: true,
      canExportExcel: true,
      canSetUrgentPo: true,
      canViewTabActionRequired: true,
      canViewTabTracking: true,
      canViewPoTable: true,
      canManageDoorLock: true,
      canViewDoorLock: true,
      canToggleDoorLock: true,
      canAddDoor: true,
      canDeleteDoor: true,
      canEditPoData: true,
      canEditCarPlan: true,
      canActionTicketSent: true,
      canActionTruckArrival: true,
      canEditDockDoor: true,
      canActionIssueTicket: true,
      canActionPicking: true,
      canActionLoading: true,
      canActionTruckDeparture: true,
      canViewDeliveryInfo: true,
      canViewCarPlan: true,
      canViewTicketSent: true,
      canViewTruckArrival: true,
      canViewDockDoor: true,
      canViewIssueTicket: true,
      canViewPicking: true,
      canViewLoading: true,
      canViewTruckDeparture: true,
      canCancelPo: true,
      canReschedulePo: true,
      canManageRoles: true,
      canViewRoles: true,
      canEditRole: true,
      canAddRole: true,
      canDeleteRole: true,
      canManageUsers: true,
      canViewUsers: true,
      canEditUser: true,
      canAddUser: true,
      canDeleteUser: true,
      canViewAuditLog: true,
      canViewAuditLogWanthai: true,
      canViewAuditLogYusen: true,
    },
  },
};

// รายการสิทธิ์ทั้งหมดของระบบ (45 key) — ใช้กรองก่อนบันทึก ทุก role จะมี key ครบเท่ากัน
// คำนวณครั้งเดียวตอนโหลด เพราะ DEFAULT_SHEET3_PERMISSIONS ถูกแก้ระหว่างรันได้
const PERMISSION_KEYS = Object.freeze(Object.keys(DEFAULT_SHEET3_PERMISSIONS.ADMIN_SYSTEM.permissions));

// เก็บเฉพาะ key ที่รู้จัก ค่าต้องเป็น true จริงเท่านั้น key ที่ขาดเป็น false และ key แปลก (เช่น role_id) ถูกตัดทิ้ง
function sanitizePermissions(input) {
  const source = input && typeof input === 'object' ? input : {};
  const clean = {};
  PERMISSION_KEYS.forEach((key) => { clean[key] = source[key] === true; });
  // สิทธิ์ย่อยของ "จัดการข้อมูล PO" เก็บให้ตรงกับ canEditPoData เสมอ
  return { ...clean, ...derivePoDataPermissions(clean) };
}

const getDefaultActionName = (roleId) => {
  const r = String(roleId || '').toUpperCase();
  if (r.includes('YUSEN')) return 'Truck Plan';
  if (r.includes('LEADER') || r.includes('PICK') || r.includes('LOAD')) return 'Picking and Loading';
  return 'ADMIN WAREHOUSE';
};

async function ensurePermissionsTable() {
  try {
    const pool = await getPool();
    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = '${TABLES.ROLE_PERMISSION}')
      BEGIN
        CREATE TABLE ${TABLES.ROLE_PERMISSION} (
          role_id VARCHAR(50) PRIMARY KEY,
          role_name NVARCHAR(100) NOT NULL,
          action_name NVARCHAR(100) NULL,
          view_mode VARCHAR(20) NOT NULL DEFAULT 'PC',
          dashboard_type VARCHAR(20) NULL,
          permissions_json NVARCHAR(MAX) NOT NULL,
          updated_at DATETIME DEFAULT GETDATE()
        );
      END
      ELSE
      BEGIN
        IF NOT EXISTS (
          SELECT * FROM sys.columns
          WHERE object_id = OBJECT_ID('${TABLES.ROLE_PERMISSION}') AND name = 'action_name'
        )
        BEGIN
          ALTER TABLE ${TABLES.ROLE_PERMISSION} ADD action_name NVARCHAR(100) NULL;
        END
      END
    `);

    if (!dashboardTypeColumnReady) {
      try {
        await ensureDashboardTypeColumn(pool);
      } catch (err) {
        logger.warn('⚠️ Cannot add Role_permission.dashboard_type (KPI cards will use role defaults):', err.message);
      }
      dashboardTypeColumnReady = await hasDashboardTypeColumn(pool);
    }

    const checkCount = await pool.request().query(`SELECT COUNT(*) AS total FROM ${TABLES.ROLE_PERMISSION}`);
    if (checkCount.recordset[0].total === 0) {
      for (const item of Object.values(DEFAULT_SHEET3_PERMISSIONS)) {
        await pool.request()
          .input('role_id', item.role_id)
          .input('role_name', item.role_name)
          .input('action_name', item.action_name || getDefaultActionName(item.role_id))
          .input('view_mode', item.view_mode)
          .input('dashboard_type', normalizeDashboardType(item.dashboard_type) || getDefaultDashboardType(item.role_id))
          .input('permissions_json', JSON.stringify(item.permissions))
          .query(DT() ? `
            INSERT INTO ${TABLES.ROLE_PERMISSION} (role_id, role_name, action_name, view_mode, dashboard_type, permissions_json)
            VALUES (@role_id, @role_name, @action_name, @view_mode, @dashboard_type, @permissions_json)
          ` : `
            INSERT INTO ${TABLES.ROLE_PERMISSION} (role_id, role_name, action_name, view_mode, permissions_json)
            VALUES (@role_id, @role_name, @action_name, @view_mode, @permissions_json)
          `);
      }
      logger.info('✅ Seeded default Sheet 3 permissions to database.');
    }
  } catch (err) {
    logger.warn('⚠️ ensurePermissionsTable error (using fallback):', err.message);
  }
}

async function getPermissions(req, res) {
  try {
    await ensurePermissionsTable();
    const pool = await getPool();
    const result = await pool.request().query(`SELECT role_id, role_name, action_name, view_mode, ${DT() ? 'dashboard_type' : 'NULL AS dashboard_type'}, permissions_json, updated_at FROM ${TABLES.ROLE_PERMISSION}`);

    if (result.recordset && result.recordset.length > 0) {
      const data = {};
      result.recordset.forEach((row) => {
        let perms = {};
        try {
          perms = JSON.parse(row.permissions_json);
        } catch {
          perms = {};
        }
        data[row.role_id] = {
          role_id: row.role_id,
          role_name: row.role_name,
          action_name: row.action_name || getDefaultActionName(row.role_id),
          view_mode: row.view_mode,
          dashboard_type: normalizeDashboardType(row.dashboard_type) || getDefaultDashboardType(row.role_id),
          permissions: perms,
          updated_at: row.updated_at,
        };
      });
      return res.json({ success: true, data });
    }
  } catch (err) {
    logger.error('Database error fetching permissions:', err.message);
    return res.status(503).json({ success: false, code: 'DB_UNAVAILABLE', message: 'ไม่สามารถอ่านสิทธิ์จากฐานข้อมูลได้ในขณะนี้' });
  }

  return res.json({ success: true, data: DEFAULT_SHEET3_PERMISSIONS });
}

async function updatePermission(req, res) {
  const targetRoleId = req.params.roleId || req.body.roleId || req.body.role_id;
  const { permissions, view_mode, role_name, action_name, actionName, dashboard_type, dashboardType } = req.body;

  if (!targetRoleId || !permissions) {
    return res.status(400).json({ success: false, message: 'Missing roleId or permissions object' });
  }

  const cleanRoleId = String(targetRoleId).trim().toUpperCase();
  const cleanPermissions = sanitizePermissions(permissions);
  const finalActionName = action_name || actionName || getDefaultActionName(cleanRoleId);
  const rawDashboardType = dashboard_type ?? dashboardType;
  const finalDashboardType = normalizeDashboardType(rawDashboardType);
  if (rawDashboardType !== undefined && rawDashboardType !== null && rawDashboardType !== '' && !finalDashboardType) {
    return res.status(400).json({ success: false, message: 'dashboard_type must be TRUCK, WAREHOUSE or OVERVIEW' });
  }

  try {
    await ensurePermissionsTable();
    const pool = await getPool();

    await pool.request()
      .input('role_id', cleanRoleId)
      .input('role_name', role_name || DEFAULT_SHEET3_PERMISSIONS[cleanRoleId]?.role_name || cleanRoleId)
      .input('action_name', finalActionName)
      .input('view_mode', view_mode || DEFAULT_SHEET3_PERMISSIONS[cleanRoleId]?.view_mode || 'PC')
      .input('dashboard_type', finalDashboardType)
      .input('default_dashboard_type', getDefaultDashboardType(cleanRoleId))
      .input('permissions_json', JSON.stringify(cleanPermissions))
      .query(`
        IF EXISTS (SELECT 1 FROM ${TABLES.ROLE_PERMISSION} WHERE role_id = @role_id)
        BEGIN
          UPDATE ${TABLES.ROLE_PERMISSION}
          SET permissions_json = @permissions_json,
              view_mode = @view_mode,
              role_name = @role_name,
              action_name = @action_name,
              ${DT() ? 'dashboard_type = COALESCE(@dashboard_type, dashboard_type, @default_dashboard_type),' : ''}
              updated_at = GETDATE()
          WHERE role_id = @role_id;
        END
        ELSE
        BEGIN
          INSERT INTO ${TABLES.ROLE_PERMISSION} (role_id, role_name, action_name, view_mode, ${DT() ? 'dashboard_type, ' : ''}permissions_json)
          VALUES (@role_id, @role_name, @action_name, @view_mode, ${DT() ? 'COALESCE(@dashboard_type, @default_dashboard_type), ' : ''}@permissions_json);
        END
      `);

    if (DEFAULT_SHEET3_PERMISSIONS[cleanRoleId]) {
      DEFAULT_SHEET3_PERMISSIONS[cleanRoleId].permissions = cleanPermissions;
      DEFAULT_SHEET3_PERMISSIONS[cleanRoleId].role_name = role_name || DEFAULT_SHEET3_PERMISSIONS[cleanRoleId].role_name;
      DEFAULT_SHEET3_PERMISSIONS[cleanRoleId].action_name = finalActionName;
      if (finalDashboardType) DEFAULT_SHEET3_PERMISSIONS[cleanRoleId].dashboard_type = finalDashboardType;
    }

    return res.json({
      success: true,
      message: `Updated permissions for ${cleanRoleId} in database successfully`
    });
  } catch (err) {
    logger.error('Error updating permissions in database:', err.message);
    return res.status(500).json({ success: false, code: 'DB_WRITE_FAILED', message: 'บันทึกสิทธิ์ลงฐานข้อมูลไม่สำเร็จ กรุณาลองใหม่อีกครั้ง' });
  }
}

async function createRole(req, res) {
  const { role_id, role_name, action_name, actionName, view_mode = 'PC', dashboard_type, dashboardType, permissions = {} } = req.body;

  if (!role_id || !role_name) {
    return res.status(400).json({ success: false, message: 'role_id and role_name are required' });
  }

  const cleanRoleId = String(role_id).trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  const finalActionName = action_name || actionName || getDefaultActionName(cleanRoleId);
  const rawDashboardType = dashboard_type ?? dashboardType;
  if (rawDashboardType !== undefined && rawDashboardType !== null && rawDashboardType !== '' && !normalizeDashboardType(rawDashboardType)) {
    return res.status(400).json({ success: false, message: 'dashboard_type must be TRUCK, WAREHOUSE or OVERVIEW' });
  }
  const finalDashboardType = normalizeDashboardType(rawDashboardType) || getDefaultDashboardType(cleanRoleId);

  try {
    await ensurePermissionsTable();
    const pool = await getPool();

    const check = await pool.request()
      .input('role_id', cleanRoleId)
      .query(`SELECT 1 FROM ${TABLES.ROLE_PERMISSION} WHERE role_id = @role_id`);

    if (check.recordset && check.recordset.length > 0) {
      return res.status(409).json({ success: false, message: `Role ${cleanRoleId} already exists` });
    }

    await pool.request()
      .input('role_id', cleanRoleId)
      .input('role_name', role_name.trim())
      .input('action_name', finalActionName)
      .input('view_mode', view_mode === 'MOBILE' ? 'MOBILE' : 'PC')
      .input('dashboard_type', finalDashboardType)
      .input('permissions_json', JSON.stringify(sanitizePermissions(permissions)))
      .query(`
        INSERT INTO ${TABLES.ROLE_PERMISSION} (role_id, role_name, action_name, view_mode, ${DT() ? 'dashboard_type, ' : ''}permissions_json)
        VALUES (@role_id, @role_name, @action_name, @view_mode, ${DT() ? '@dashboard_type, ' : ''}@permissions_json)
      `);

    DEFAULT_SHEET3_PERMISSIONS[cleanRoleId] = {
      role_id: cleanRoleId,
      role_name: role_name.trim(),
      action_name: finalActionName,
      view_mode: view_mode === 'MOBILE' ? 'MOBILE' : 'PC',
      dashboard_type: finalDashboardType,
      permissions,
    };

    return res.status(201).json({
      success: true,
      message: `Created role ${cleanRoleId} successfully`,
      data: {
        role_id: cleanRoleId,
        role_name: role_name.trim(),
        action_name: finalActionName,
        view_mode: view_mode === 'MOBILE' ? 'MOBILE' : 'PC',
        dashboard_type: finalDashboardType,
        permissions,
      },
    });
  } catch (err) {
    logger.error('Error creating role:', err.message);
    if (err && (err.number === 2627 || err.number === 2601)) {
      return res.status(409).json({ success: false, code: 'ROLE_EXISTS', message: `Role ${cleanRoleId} already exists` });
    }
    return res.status(500).json({ success: false, code: 'DB_WRITE_FAILED', message: 'สร้าง Role ลงฐานข้อมูลไม่สำเร็จ กรุณาลองใหม่อีกครั้ง' });
  }
}

async function deleteRole(req, res) {
  const { roleId } = req.params;

  if (!roleId) {
    return res.status(400).json({ success: false, message: 'Missing roleId' });
  }

  const cleanRoleId = String(roleId).trim().toUpperCase();

  if (cleanRoleId === 'ADMIN_SYSTEM') {
    return res.status(403).json({ success: false, message: 'Cannot delete ADMIN_SYSTEM role' });
  }

  try {
    await ensurePermissionsTable();
    const pool = await getPool();

    const deleteResult = await pool.request()
      .input('role_id', cleanRoleId)
      .query(`DELETE FROM ${TABLES.ROLE_PERMISSION} WHERE role_id = @role_id`);

    const deleted = (deleteResult.rowsAffected || []).reduce((a, b) => a + b, 0);
    if (deleted === 0) {
      return res.status(404).json({ success: false, code: 'ROLE_NOT_FOUND', message: `ไม่พบ Role ${cleanRoleId}` });
    }

    delete DEFAULT_SHEET3_PERMISSIONS[cleanRoleId];

    return res.json({
      success: true,
      message: `Deleted role ${cleanRoleId} successfully`,
    });
  } catch (err) {
    logger.error('Error deleting role:', err.message);
    if (err && err.number === 547) {
      return res.status(409).json({ success: false, code: 'ROLE_IN_USE', message: 'ยังมีผู้ใช้งานอยู่ใน Role นี้ กรุณาย้ายผู้ใช้ไป Role อื่นก่อนลบ' });
    }
    return res.status(500).json({ success: false, code: 'DB_WRITE_FAILED', message: 'ลบ Role ในฐานข้อมูลไม่สำเร็จ กรุณาลองใหม่อีกครั้ง' });
  }
}

async function resetPermissions(req, res) {
  try {
    await ensurePermissionsTable();
    const pool = await getPool();
    await pool.request().query(`DELETE FROM ${TABLES.ROLE_PERMISSION}`);
    for (const item of Object.values(DEFAULT_SHEET3_PERMISSIONS)) {
      await pool.request()
        .input('role_id', item.role_id)
        .input('role_name', item.role_name)
        .input('view_mode', item.view_mode)
        .input('dashboard_type', normalizeDashboardType(item.dashboard_type) || getDefaultDashboardType(item.role_id))
        .input('permissions_json', JSON.stringify(item.permissions))
        .query(`
          INSERT INTO ${TABLES.ROLE_PERMISSION} (role_id, role_name, view_mode, ${DT() ? 'dashboard_type, ' : ''}permissions_json)
          VALUES (@role_id, @role_name, @view_mode, ${DT() ? '@dashboard_type, ' : ''}@permissions_json)
        `);
    }
    return res.json({ success: true, message: 'Reset all role permissions to Sheet 3 defaults in database' });
  } catch (err) {
    logger.error('Error resetting permissions:', err.message);
    return res.status(500).json({ success: false, message: 'ไม่สามารถคืนค่าสิทธิ์เริ่มต้นได้' });
  }
}

module.exports = {
  getPermissions,
  updatePermission,
  createRole,
  deleteRole,
  resetPermissions,
  DEFAULT_SHEET3_PERMISSIONS,
  PERMISSION_KEYS,
  sanitizePermissions,
};
