const sql = require('mssql');
const { TABLES, DASHBOARD_TYPES, getDefaultDashboardType } = require('./constants');
const { logger } = require('../utils/logger');

const missingDbEnv = ['DB_USER', 'DB_PASSWORD'].filter((key) => !process.env[key]);
if (missingDbEnv.length > 0) {
  logger.error(`❌ Missing required environment variable(s): ${missingDbEnv.join(', ')} — set them in wanthai-logistic-node/.env (see .env.example)`);
}

const config = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  server: process.env.DB_SERVER || 'localhost',
  port: parseInt(process.env.DB_PORT || '1433', 10),
  database: process.env.DB_NAME || 'LMS',
  options: {
    instanceName: process.env.DB_INSTANCE === '' ? undefined : (process.env.DB_INSTANCE || 'SQLEXPRESS'),
    encrypt: String(process.env.DB_ENCRYPT || 'false').toLowerCase() === 'true',
    trustServerCertificate: String(process.env.DB_TRUST_SERVER_CERT || 'true').toLowerCase() === 'true',
  },
  pool: {
    max: 10,
    min: 0,
    idleTimeoutMillis: 30000,
  },
};

let poolPromise = null;

function getPool() {
  if (!poolPromise) {
    poolPromise = new sql.ConnectionPool(config)
      .connect()
      .then((pool) => {
        logger.info(`✅ Connected to SQL Server (Database: ${config.database})`);
        return pool;
      })
      .catch((err) => {
        logger.error('❌ SQL Server connection error:', err.message);
        poolPromise = null;
        throw err;
      });
  }
  return poolPromise;
}

async function initializeDatabase() {
  try {
    const pool = await getPool();
    logger.info('🔄 Checking and initializing database tables (New Schema: Customer, Dock_door, PO, PO_Transaction, Ship_to, Truck, Warehouse)...');

    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = '${TABLES.CUSTOMER}')
      BEGIN
        IF EXISTS (SELECT * FROM sys.tables WHERE name = 'Customer_master')
        BEGIN
          EXEC sp_rename 'Customer_master', '${TABLES.CUSTOMER}';
        END
        ELSE
        BEGIN
          CREATE TABLE ${TABLES.CUSTOMER} (
            customer_id INT IDENTITY(1,1) PRIMARY KEY,
            customer_code NVARCHAR(50) NOT NULL,
            customer_name NVARCHAR(255) NOT NULL,
            create_by NVARCHAR(100) NULL,
            create_date DATETIME DEFAULT GETDATE(),
            phone NVARCHAR(50) NULL,
            fax NVARCHAR(50) NULL,
            email NVARCHAR(100) NULL,
            contact NVARCHAR(100) NULL,
            is_active BIT DEFAULT 1
          );
        END
      END
    `);

    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = '${TABLES.TRUCK}')
      BEGIN
        IF EXISTS (SELECT * FROM sys.tables WHERE name = 'Truck_master')
        BEGIN
          EXEC sp_rename 'Truck_master', '${TABLES.TRUCK}';
        END
        ELSE
        BEGIN
          CREATE TABLE ${TABLES.TRUCK} (
            truck_type_id INT IDENTITY(1,1) PRIMARY KEY,
            truck_type NVARCHAR(100) NOT NULL,
            license_plate NVARCHAR(50) NULL,
            create_date DATETIME DEFAULT GETDATE(),
            update_by NVARCHAR(100) NULL,
            update_date DATETIME DEFAULT GETDATE(),
            is_active BIT DEFAULT 1
          );
        END
      END
    `);

    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = '${TABLES.DOCK_DOOR}')
      BEGIN
        IF EXISTS (SELECT * FROM sys.tables WHERE name = 'Dock_door_master')
        BEGIN
          EXEC sp_rename 'Dock_door_master', '${TABLES.DOCK_DOOR}';
        END
        ELSE
        BEGIN
          CREATE TABLE ${TABLES.DOCK_DOOR} (
            dock_door_id INT IDENTITY(1,1) PRIMARY KEY,
            dock_door_code NVARCHAR(50) NOT NULL,
            dock_door_name NVARCHAR(100) NOT NULL,
            create_date DATETIME DEFAULT GETDATE(),
            update_by NVARCHAR(100) NULL,
            update_date DATETIME DEFAULT GETDATE(),
            is_active INT DEFAULT 0,
            is_deleted BIT DEFAULT 0
          );

          INSERT INTO ${TABLES.DOCK_DOOR} (dock_door_code, dock_door_name, is_active) VALUES 
          (N'D1', N'ประตูโหลด 1', 0),
          (N'D2', N'ประตูโหลด 2', 0),
          (N'D3', N'ประตูโหลด 3', 0),
          (N'D4', N'ประตูโหลด 4', 0),
          (N'D5', N'ประตูโหลด 5', 0),
          (N'D6', N'ประตูโหลด 6', 0),
          (N'D7', N'ประตูโหลด 7', 0),
          (N'D8', N'ประตูโหลด 8', 0),
          (N'D9', N'ประตูโหลด 9', 0),
          (N'D10', N'ประตูโหลด 10', 0);
        END
      END
      ELSE
      BEGIN
        -- ตรวจสอบคอลัมน์ is_active ให้เป็น INT เพื่อรองรับ 0 (ว่าง), 1 (มีรถใช้), 2 (ล็อค)
        IF EXISTS (
          SELECT * FROM INFORMATION_SCHEMA.COLUMNS 
          WHERE TABLE_NAME = '${TABLES.DOCK_DOOR}' AND COLUMN_NAME = 'is_active' AND DATA_TYPE = 'bit'
        )
        BEGIN
          DECLARE @ConstraintName NVARCHAR(200);
          SELECT @ConstraintName = d.name
          FROM sys.default_constraints d
          JOIN sys.columns c ON d.parent_object_id = c.object_id AND d.parent_column_id = c.column_id
          WHERE d.parent_object_id = OBJECT_ID('${TABLES.DOCK_DOOR}') AND c.name = 'is_active';

          IF @ConstraintName IS NOT NULL
          BEGIN
            EXEC('ALTER TABLE ${TABLES.DOCK_DOOR} DROP CONSTRAINT ' + @ConstraintName);
          END

          ALTER TABLE ${TABLES.DOCK_DOOR} ALTER COLUMN is_active INT;
          ALTER TABLE ${TABLES.DOCK_DOOR} ADD CONSTRAINT DF_Dock_door_is_active DEFAULT 0 FOR is_active;
        END

        -- ตรวจสอบคอลัมน์ is_deleted สำหรับรองรับการลบแบบปิดการใช้งาน (Soft Delete)
        IF NOT EXISTS (
          SELECT * FROM INFORMATION_SCHEMA.COLUMNS 
          WHERE TABLE_NAME = '${TABLES.DOCK_DOOR}' AND COLUMN_NAME = 'is_deleted'
        )
        BEGIN
          ALTER TABLE ${TABLES.DOCK_DOOR} ADD is_deleted BIT DEFAULT 0;
          EXEC('UPDATE ${TABLES.DOCK_DOOR} SET is_deleted = 0 WHERE is_deleted IS NULL');
        END
      END
    `);

    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = '${TABLES.SHIP_TO}')
      BEGIN
        IF EXISTS (SELECT * FROM sys.tables WHERE name = 'Ship_to_master')
        BEGIN
          EXEC sp_rename 'Ship_to_master', '${TABLES.SHIP_TO}';
        END
        ELSE
        BEGIN
          CREATE TABLE ${TABLES.SHIP_TO} (
            ship_to_id INT IDENTITY(1,1) PRIMARY KEY,
            ship_to_code NVARCHAR(50) NOT NULL,
            ship_to_name NVARCHAR(255) NOT NULL,
            create_date DATETIME DEFAULT GETDATE(),
            is_active BIT DEFAULT 1
          );

          INSERT INTO ${TABLES.SHIP_TO} (ship_to_code, ship_to_name) VALUES 
          (N'ST-001', N'คลังสินค้าหลัก (Main Warehouse)'),
          (N'ST-002', N'ศูนย์กระจายสินค้า บางนา (Bangna DC)'),
          (N'ST-003', N'โรงงาน 1 - นวนคร (Factory 1)'),
          (N'ST-004', N'ศูนย์กระจายสินค้า ขอนแก่น (Khon Kaen DC)'),
          (N'ST-005', N'ท่าเรือแหลมฉบัง (Laem Chabang Port)'),
          (N'ST-006', N'คลังสินค้า สุราษฎร์ธานี (Surat Thani Hub)');
        END
      END
    `);

    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = '${TABLES.WAREHOUSE}')
      BEGIN
        IF EXISTS (SELECT * FROM sys.tables WHERE name = 'Warehouse_master')
        BEGIN
          EXEC sp_rename 'Warehouse_master', '${TABLES.WAREHOUSE}';
        END
        ELSE
        BEGIN
          CREATE TABLE ${TABLES.WAREHOUSE} (
            warehouse_id INT IDENTITY(1,1) PRIMARY KEY,
            warehouse_code NVARCHAR(50) NOT NULL,
            warehouse_name NVARCHAR(255) NOT NULL,
            create_date DATETIME DEFAULT GETDATE(),
            update_by NVARCHAR(100) NULL,
            update_date DATETIME DEFAULT GETDATE(),
            is_active BIT DEFAULT 1
          );

          INSERT INTO ${TABLES.WAREHOUSE} (warehouse_code, warehouse_name) VALUES 
          (N'WH-01', N'คลังสินค้าสำเร็จรูป 1 (FG Warehouse 1)'),
          (N'WH-02', N'คลังสินค้าสำเร็จรูป 2 (FG Warehouse 2)'),
          (N'WH-03', N'คลังวัตถุดิบและบรรจุภัณฑ์ (Raw Material & Packaging)'),
          (N'WH-04', N'คลังสินค้าควบคุมอุณหภูมิ (Temperature-Controlled WH)'),
          (N'WH-05', N'คลังกระจายสินค้าย่อย (Distribution Hub)');
        END
      END
    `);

    // PO + PO_Transaction (ย้ายข้อมูลจาก Received เดิมอัตโนมัติครั้งแรก)
    await require('./poSchema').ensurePoTables(pool);
    // หน่วยนับ / เหตุผลยกเลิก / เหตุผลเลื่อนแผน (ตารางรายการตัวเลือก)
    await require('./lookupSchema').ensureLookupTables(pool);

    const truckCheck = await pool.request().query(`SELECT COUNT(*) as count FROM ${TABLES.TRUCK}`);
    if (truckCheck.recordset[0].count === 0) {
      await pool.request().query(`
        INSERT INTO ${TABLES.TRUCK} (truck_type) VALUES 
        (N'รถ 4 ล้อ'),
        (N'รถ 6 ล้อ'),
        (N'รถ 10 ล้อ'),
        (N'รถเทรลเลอร์'),
        (N'รถหัวลาก');
      `);
    }

    await pool.request().query(`
      IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = '${TABLES.ROLE_PERMISSION}')
      BEGIN
        CREATE TABLE ${TABLES.ROLE_PERMISSION} (
          role_id VARCHAR(50) PRIMARY KEY,
          role_name NVARCHAR(100) NOT NULL,
          action_name NVARCHAR(100) NULL,
          view_mode VARCHAR(20) NOT NULL DEFAULT 'PC',
          dashboard_type VARCHAR(20) NOT NULL
            CONSTRAINT DF_Role_permission_dashboard_type DEFAULT '${DASHBOARD_TYPES.OVERVIEW}'
            CONSTRAINT CK_Role_permission_dashboard_type CHECK (dashboard_type IN ('${DASHBOARD_TYPES.TRUCK}', '${DASHBOARD_TYPES.WAREHOUSE}', '${DASHBOARD_TYPES.OVERVIEW}')),
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

    try {
      await ensureDashboardTypeColumn(pool);
    } catch (err) {
      logger.warn('⚠️ Cannot add Role_permission.dashboard_type (KPI cards will use role defaults):', err.message);
    }
    const hasDashboardType = await hasDashboardTypeColumn(pool);

    const roleCheck = await pool.request().query(`SELECT COUNT(*) as total FROM ${TABLES.ROLE_PERMISSION}`);
    if (roleCheck.recordset[0].total === 0) {
      const defaultRoles = [
        {
          role_id: 'ADMIN_WAREHOUSE',
          role_name: 'Admin Warehouse',
          view_mode: 'PC',
          permissions_json: JSON.stringify({
            canAddPo: true, canImportPo: true, canViewTabActionRequired: true, canViewTabTracking: true,
            canManageDoorLock: true, canEditPoData: true, canEditCarPlan: false, canActionTicketSent: true,
            canActionTruckArrival: false, canEditDockDoor: true, canActionIssueTicket: true, canActionPicking: false,
            canActionLoading: false, canActionTruckDeparture: false, canViewDeliveryInfo: true, canViewCarPlan: true,
            canViewTicketSent: true, canViewTruckArrival: true, canViewDockDoor: true, canViewPicking: true,
            canViewLoading: true, canViewTruckDeparture: true, canCancelPo: true, canReschedulePo: true,
            canManageRoles: false, canManageUsers: false
          })
        },
        {
          role_id: 'LEADER_WAREHOUSE_PICKER',
          role_name: 'Leader Warehouse Pick',
          view_mode: 'MOBILE',
          permissions_json: JSON.stringify({
            canAddPo: false, canImportPo: false, canViewTabActionRequired: false, canViewTabTracking: true,
            canManageDoorLock: false, canEditPoData: false, canEditCarPlan: false, canActionTicketSent: false,
            canActionTruckArrival: false, canEditDockDoor: false, canActionIssueTicket: false, canActionPicking: true,
            canActionLoading: false, canActionTruckDeparture: false, canViewDeliveryInfo: true, canViewCarPlan: false,
            canViewTicketSent: false, canViewTruckArrival: false, canViewDockDoor: false, canViewPicking: true,
            canViewLoading: false, canViewTruckDeparture: false, canCancelPo: false, canReschedulePo: false,
            canManageRoles: false, canManageUsers: false
          })
        },
        {
          role_id: 'LEADER_WAREHOUSE_LOADER',
          role_name: 'Leader Warehouse Load',
          view_mode: 'MOBILE',
          permissions_json: JSON.stringify({
            canAddPo: false, canImportPo: false, canViewTabActionRequired: false, canViewTabTracking: true,
            canManageDoorLock: false, canEditPoData: false, canEditCarPlan: false, canActionTicketSent: false,
            canActionTruckArrival: false, canEditDockDoor: false, canActionIssueTicket: false, canActionPicking: false,
            canActionLoading: true, canActionTruckDeparture: true, canViewDeliveryInfo: true, canViewCarPlan: false,
            canViewTicketSent: false, canViewTruckArrival: false, canViewDockDoor: false, canViewPicking: false,
            canViewLoading: true, canViewTruckDeparture: true, canCancelPo: false, canReschedulePo: false,
            canManageRoles: false, canManageUsers: false
          })
        },
        {
          role_id: 'YUSEN_OFFICE',
          role_name: 'Yusen Office',
          view_mode: 'PC',
          permissions_json: JSON.stringify({
            canAddPo: false, canImportPo: false, canViewTabActionRequired: true, canViewTabTracking: true,
            canManageDoorLock: false, canEditPoData: false, canEditCarPlan: true, canActionTicketSent: false,
            canActionTruckArrival: true, canEditDockDoor: false, canActionIssueTicket: false, canActionPicking: false,
            canActionLoading: false, canActionTruckDeparture: false, canViewDeliveryInfo: true, canViewCarPlan: true,
            canViewTicketSent: false, canViewTruckArrival: true, canViewDockDoor: true, canViewPicking: false,
            canViewLoading: false, canViewTruckDeparture: true, canCancelPo: false, canReschedulePo: false,
            canManageRoles: false, canManageUsers: false
          })
        },
        {
          role_id: 'YUSEN_TRUCKER',
          role_name: 'Yusen Truck',
          view_mode: 'MOBILE',
          permissions_json: JSON.stringify({
            canAddPo: false, canImportPo: false, canViewTabActionRequired: false, canViewTabTracking: false,
            canManageDoorLock: false, canEditPoData: false, canEditCarPlan: false, canActionTicketSent: false,
            canActionTruckArrival: true, canEditDockDoor: false, canActionIssueTicket: false, canActionPicking: false,
            canActionLoading: false, canActionTruckDeparture: false, canViewDeliveryInfo: true, canViewCarPlan: true,
            canViewTicketSent: false, canViewTruckArrival: true, canViewDockDoor: true, canViewPicking: false,
            canViewLoading: false, canViewTruckDeparture: true, canCancelPo: false, canReschedulePo: false,
            canManageRoles: false, canManageUsers: false
          })
        },
        {
          role_id: 'ADMIN_SYSTEM',
          role_name: 'Admin System',
          view_mode: 'PC',
          permissions_json: JSON.stringify({
            canAddPo: true, canImportPo: true, canViewTabActionRequired: true, canViewTabTracking: true,
            canManageDoorLock: true, canEditPoData: true, canEditCarPlan: true, canActionTicketSent: true,
            canActionTruckArrival: true, canEditDockDoor: true, canActionIssueTicket: true, canActionPicking: true,
            canActionLoading: true, canActionTruckDeparture: true, canViewDeliveryInfo: true, canViewCarPlan: true,
            canViewTicketSent: true, canViewTruckArrival: true, canViewDockDoor: true, canViewPicking: true,
            canViewLoading: true, canViewTruckDeparture: true, canCancelPo: true, canReschedulePo: true,
            canManageRoles: true, canManageUsers: true
          })
        }
      ];

      for (const item of defaultRoles) {
        await pool.request()
          .input('role_id', item.role_id)
          .input('role_name', item.role_name)
          .input('view_mode', item.view_mode)
          .input('dashboard_type', getDefaultDashboardType(item.role_id))
          .input('permissions_json', item.permissions_json)
          .query(hasDashboardType ? `
            INSERT INTO ${TABLES.ROLE_PERMISSION} (role_id, role_name, view_mode, dashboard_type, permissions_json)
            VALUES (@role_id, @role_name, @view_mode, @dashboard_type, @permissions_json)
          ` : `
            INSERT INTO ${TABLES.ROLE_PERMISSION} (role_id, role_name, view_mode, permissions_json)
            VALUES (@role_id, @role_name, @view_mode, @permissions_json)
          `);
      }
      logger.info('✅ Seeded default Sheet 3 permissions to SQL Server database.');
    }

    logger.info('✅ LMS Database tables initialized successfully.');
  } catch (err) {
    logger.error('❌ Failed to initialize database:', err.message);
  }

  // แยก try: ตาราง Setting พังก็ยังใช้ค่าจาก .env / ค่าเริ่มต้นได้ ไม่กระทบตารางอื่น
  try {
    const { initSettings } = require('../services/settingsService');
    await initSettings(await getPool());
    logger.info('✅ Setting loaded.');
  } catch (err) {
    logger.warn('⚠️ Setting not available — using .env / default values:', err.message);
  }
}

async function ensureDashboardTypeColumn(pool) {
  const T = TABLES.ROLE_PERMISSION;
  const { TRUCK, WAREHOUSE, OVERVIEW } = DASHBOARD_TYPES;

  await pool.request().query(`
    IF OBJECT_ID('${T}') IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('${T}') AND name = 'dashboard_type'
    )
    BEGIN
      ALTER TABLE ${T} ADD dashboard_type VARCHAR(20) NULL;
    END
  `);

  await pool.request().query(`
    UPDATE ${T}
    SET dashboard_type = CASE
      WHEN UPPER(role_id) LIKE '%YUSEN%' OR UPPER(role_id) LIKE '%CAR_REGISTER%' OR UPPER(role_id) LIKE '%TRUCKER%' THEN '${TRUCK}'
      WHEN UPPER(role_id) LIKE '%LEADER%' OR UPPER(role_id) LIKE '%PICK%' OR UPPER(role_id) LIKE '%LOAD%' OR UPPER(role_id) = 'ADMIN_OUTSIDE' THEN '${WAREHOUSE}'
      ELSE '${OVERVIEW}'
    END
    WHERE dashboard_type IS NULL
       OR dashboard_type NOT IN ('${TRUCK}', '${WAREHOUSE}', '${OVERVIEW}');
  `);

  await pool.request().query(`
    IF EXISTS (
      SELECT 1 FROM sys.columns
      WHERE object_id = OBJECT_ID('${T}') AND name = 'dashboard_type' AND is_nullable = 1
    )
    BEGIN
      ALTER TABLE ${T} ALTER COLUMN dashboard_type VARCHAR(20) NOT NULL;
    END

    IF NOT EXISTS (SELECT 1 FROM sys.default_constraints WHERE name = 'DF_Role_permission_dashboard_type')
    BEGIN
      ALTER TABLE ${T} ADD CONSTRAINT DF_Role_permission_dashboard_type DEFAULT '${OVERVIEW}' FOR dashboard_type;
    END

    IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_Role_permission_dashboard_type')
    BEGIN
      ALTER TABLE ${T} ADD CONSTRAINT CK_Role_permission_dashboard_type
        CHECK (dashboard_type IN ('${TRUCK}', '${WAREHOUSE}', '${OVERVIEW}'));
    END
  `);
}

async function hasDashboardTypeColumn(pool) {
  const r = await pool.request().query(`
    SELECT COUNT(*) AS total FROM sys.columns
    WHERE object_id = OBJECT_ID('${TABLES.ROLE_PERMISSION}') AND name = 'dashboard_type'
  `);
  return Number(r.recordset?.[0]?.total) > 0;
}

module.exports = {
  sql,
  getPool,
  initializeDatabase,
  ensureDashboardTypeColumn,
  hasDashboardTypeColumn,
};
