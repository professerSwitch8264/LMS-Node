const { logger } = require('../utils/logger');
const { sql, getPool } = require('../config/db');
const { TABLES } = require('../config/constants');
const { broadcastDashboardUpdate } = require('../services/dashboardService');

async function syncDockDoorStatuses() {
  try {
    const pool = await getPool();
    await pool.request().query(`
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
        ALTER TABLE ${TABLES.DOCK_DOOR} ADD CONSTRAINT DF_${TABLES.DOCK_DOOR}_is_active DEFAULT 0 FOR is_active;
      END

      -- ตรวจสอบคอลัมน์ is_deleted สำหรับรองรับการลบแบบปิดการใช้งาน (Soft Delete)
      IF NOT EXISTS (
        SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_NAME = '${TABLES.DOCK_DOOR}' AND COLUMN_NAME = 'is_deleted'
      )
      BEGIN
        ALTER TABLE ${TABLES.DOCK_DOOR} ADD is_deleted BIT DEFAULT 0;
        EXEC('UPDATE ${TABLES.DOCK_DOOR} SET is_deleted = 0 WHERE is_deleted IS NULL');
      END
    `);

    await pool.request().query(`
      UPDATE d
      SET d.is_active = 1, d.update_date = GETDATE()
      FROM ${TABLES.DOCK_DOOR} d
      WHERE (d.dock_door_id IN (
              SELECT DISTINCT dock_door_id
              FROM ${TABLES.RECEIVED}
              WHERE dock_door_id IS NOT NULL AND process_stage NOT IN ('COMPLETED', 'DEPARTED', 'CANCLE', 'CANCEL')
            )
         OR d.dock_door_code IN (
              SELECT DISTINCT dock_door_code
              FROM ${TABLES.RECEIVED}
              WHERE dock_door_code IS NOT NULL AND dock_door_code <> '' AND process_stage NOT IN ('COMPLETED', 'DEPARTED', 'CANCLE', 'CANCEL')
            ))
        AND d.is_active <> 1
    `);
  } catch (err) {
    logger.warn('Sync dock doors warning:', err.message);
  }
}

async function getCustomers(req, res) {
  try {
    const pool = await getPool();
    const result = await pool.request().query(`
      SELECT customer_id, customer_code, customer_name, is_active
      FROM ${TABLES.CUSTOMER}
      WHERE is_active = 1 OR is_active IS NULL
      ORDER BY customer_id ASC
    `);

    const customers = result.recordset.map(row => {
      const custName = row.customer_name ?? row.customer_Name ?? '';
      return {
        id: row.customer_id,
        code: row.customer_code,
        name: custName,
        displayName: `${row.customer_code} - ${custName}`.trim(),
      };
    });

    logger.debug(`[API GET /api/customers] ส่งรายการลูกค้า ${customers.length} รายการ (ตาราง: ${TABLES.CUSTOMER})`);
    res.json({ success: true, data: customers });
  } catch (err) {
    logger.error('Error in /api/customers:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
}

async function getShipTo(req, res) {
  try {
    const pool = await getPool();
    const result = await pool.request().query(`
      SELECT ship_to_id, ship_to_code, ship_to_name, is_active
      FROM ${TABLES.SHIP_TO}
      WHERE is_active = 1 OR is_active IS NULL
      ORDER BY ship_to_id ASC
    `);

    const shipToList = result.recordset.map(row => ({
      id: row.ship_to_id,
      code: row.ship_to_code,
      name: row.ship_to_name,
      displayName: `${row.ship_to_code} - ${row.ship_to_name}`,
    }));

    logger.debug(`[API GET /api/ship-to] ส่งรายการสถานที่ปลายทาง ${shipToList.length} รายการ (ตาราง: ${TABLES.SHIP_TO})`);
    res.json({ success: true, data: shipToList });
  } catch (err) {
    logger.error('Error in /api/ship-to:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
}

async function getDockDoors(req, res) {
  try {
    const pool = await getPool();
    await syncDockDoorStatuses();

    const includeDeleted = req.query.include_deleted === 'true' || req.query.all === 'true';
    const whereClause = includeDeleted ? '' : 'WHERE ISNULL(d.is_deleted, 0) = 0';

    const result = await pool.request().query(`
      SELECT
        d.dock_door_id,
        d.dock_door_code,
        d.dock_door_name,
        d.is_active,
        ISNULL(d.is_deleted, 0) as is_deleted,
        (SELECT TOP 1 r.PO_No
         FROM ${TABLES.RECEIVED} r
         WHERE (r.dock_door_id = d.dock_door_id OR r.dock_door_code = d.dock_door_code)
           AND r.process_stage NOT IN ('COMPLETED', 'CANCLE', 'CANCEL', 'DEPARTED')
         ORDER BY r.update_date DESC) as current_po_no,
        (SELECT TOP 1 r.customer_Name
         FROM ${TABLES.RECEIVED} r
         WHERE (r.dock_door_id = d.dock_door_id OR r.dock_door_code = d.dock_door_code)
           AND r.process_stage NOT IN ('COMPLETED', 'CANCLE', 'CANCEL', 'DEPARTED')
         ORDER BY r.update_date DESC) as current_customer
      FROM ${TABLES.DOCK_DOOR} d
      ${whereClause}
      ORDER BY d.dock_door_id ASC
    `);

    const doorList = result.recordset.map(row => {
      const isDeleted = Boolean(row.is_deleted);
      const statusNum = Number(row.is_active);
      const hasPo = Boolean(row.current_po_no);

      const isOccupied = hasPo || statusNum === 1;
      const isLockedByAdmin = statusNum === 2;
      const isAvailable = statusNum === 0 && !isOccupied && !isDeleted;

      const finalStatus = isDeleted ? -1 : isOccupied ? 1 : isLockedByAdmin ? 2 : 0;

      return {
        id: row.dock_door_id,
        code: row.dock_door_code,
        name: row.dock_door_name,
        dock_door_name: row.dock_door_name,
        dockDoorName: row.dock_door_name,
        displayName: `${row.dock_door_code} - ${row.dock_door_name}`,
        is_active: finalStatus,
        isActive: isAvailable,
        isLocked: isOccupied || isLockedByAdmin,
        isLockedByAdmin: isLockedByAdmin,
        isOccupied: isOccupied,
        is_deleted: isDeleted ? 1 : 0,
        isDeleted: isDeleted,
        currentPoNo: row.current_po_no || null,
        currentCustomer: row.current_customer || null,
      };
    });

    logger.debug(`[API GET /api/dock-doors] ส่งรายการประตูโหลด ${doorList.length} รายการ (ตาราง: ${TABLES.DOCK_DOOR}, รวมปิดใช้งาน: ${includeDeleted})`);
    res.json({ success: true, data: doorList });
  } catch (err) {
    logger.error('Error in /api/dock-doors:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
}

function createToggleDockDoorLockHandler(io) {
  return async function toggleDockDoorLock(req, res) {
    try {
      const { dockDoorId, dockDoorCode, isLocked } = req.body;
      const pool = await getPool();

      const targetStatus = isLocked ? 2 : 0;

      const checkOccupied = await pool.request()
        .input('doorId', sql.Int, dockDoorId ? parseInt(dockDoorId, 10) : null)
        .input('doorCode', sql.NVarChar(50), dockDoorCode || '')
        .query(`
          SELECT TOP 1 PO_No, customer_Name
          FROM ${TABLES.RECEIVED}
          WHERE ((dock_door_id = @doorId AND @doorId IS NOT NULL) OR (dock_door_code = @doorCode AND @doorCode <> ''))
            AND ISNULL(process_stage, '') NOT IN ('COMPLETED', 'CANCLE')
        `);

      if (checkOccupied.recordset.length > 0) {
        return res.status(400).json({
          success: false,
          error: `ประตูกำลังมีรถเข้าใช้งาน (PO: ${checkOccupied.recordset[0].PO_No}) ไม่สามารถเปลี่ยนสถานะได้`
        });
      }

      const updateResult = await pool.request()
        .input('doorId', sql.Int, dockDoorId ? parseInt(dockDoorId, 10) : null)
        .input('doorCode', sql.NVarChar(50), dockDoorCode || '')
        .input('status', sql.Int, targetStatus)
        .query(`
          IF EXISTS (
            SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
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

          UPDATE ${TABLES.DOCK_DOOR}
          SET is_active = @status
          WHERE ((dock_door_id = @doorId AND @doorId IS NOT NULL)
             OR (dock_door_code = @doorCode AND @doorCode <> ''));
        `);

      if (!updateResult.rowsAffected || updateResult.rowsAffected.reduce((a, b) => a + b, 0) === 0) {
        return res.status(404).json({
          success: false,
          error: `ไม่พบข้อมูลประตู ${dockDoorCode || dockDoorId} ในฐานข้อมูล`
        });
      }

      logger.debug(`[API POST /api/dock-doors/toggle-lock] ประตู ${dockDoorCode || dockDoorId} ถูกตั้ง is_active = ${targetStatus}`);

      if (io) {
        io.emit('dock-doors-updated', { dockDoorCode, is_active: targetStatus });
        broadcastDashboardUpdate(io);
      }

      res.json({ success: true, is_active: targetStatus });
    } catch (err) {
      logger.error('Error in /api/dock-doors/toggle-lock:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  };
}

function createBatchLockDockDoorsHandler(io) {
  return async function batchLockDockDoors(req, res) {
    try {
      const { isLocked } = req.body;
      const pool = await getPool();
      const targetStatus = isLocked ? 2 : 0;

      await pool.request()
        .input('status', sql.Int, targetStatus)
        .query(`
          IF EXISTS (
            SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
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

          UPDATE ${TABLES.DOCK_DOOR}
          SET is_active = @status
          WHERE dock_door_id NOT IN (
            SELECT DISTINCT dock_door_id
            FROM ${TABLES.RECEIVED}
            WHERE dock_door_id IS NOT NULL
              AND ISNULL(process_stage, '') NOT IN ('COMPLETED', 'CANCLE')
          )
          AND dock_door_code NOT IN (
            SELECT DISTINCT dock_door_code
            FROM ${TABLES.RECEIVED}
            WHERE dock_door_code IS NOT NULL AND dock_door_code <> ''
              AND ISNULL(process_stage, '') NOT IN ('COMPLETED', 'CANCLE')
          );
        `);

      logger.debug(`[API POST /api/dock-doors/batch-lock] ประตูที่ว่างทั้งหมดถูกตั้งเป็น ${isLocked ? 'ล็อค (is_active = 2)' : 'ปลดล็อค (is_active = 0)'}`);

      if (io) {
        io.emit('dock-doors-updated', { batch: true, isLocked, is_active: targetStatus });
        broadcastDashboardUpdate(io);
      }

      res.json({ success: true, isLocked, is_active: targetStatus, message: `อัปเดตสถานะประตูที่ว่างเรียบร้อยแล้ว` });
    } catch (err) {
      logger.error('Error in /api/dock-doors/batch-lock:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  };
}

function createDockDoorHandler(io) {
  return async function createDockDoor(req, res) {
    try {
      const { dockDoorCode, dockDoorName } = req.body;
      if (!dockDoorCode && !dockDoorName) {
        return res.status(400).json({ success: false, message: 'กรุณากรอกรหัสหรือชื่อประตู' });
      }

      const code = (dockDoorCode || '').trim().toUpperCase();
      const name = (dockDoorName || `ประตูโหลด ${code.replace(/[^0-9]/g, '') || code}`).trim();

      const pool = await getPool();

      const check = await pool.request()
        .input('code', sql.NVarChar(50), code)
        .query(`SELECT dock_door_id, dock_door_code, dock_door_name, ISNULL(is_deleted, 0) as is_deleted FROM ${TABLES.DOCK_DOOR} WHERE dock_door_code = @code`);

      if (check.recordset && check.recordset.length > 0) {
        const existing = check.recordset[0];
        if (existing.is_deleted) {
          await pool.request()
            .input('doorId', sql.Int, existing.dock_door_id)
            .input('name', sql.NVarChar(100), name)
            .query(`
              UPDATE ${TABLES.DOCK_DOOR}
              SET is_deleted = 0, is_active = 0, dock_door_name = @name, update_date = GETDATE()
              WHERE dock_door_id = @doorId
            `);

          const reactivatedDoor = {
            id: existing.dock_door_id,
            code: existing.dock_door_code,
            name: name,
            dock_door_name: name,
            dockDoorName: name,
            displayName: `${existing.dock_door_code} - ${name}`,
            is_active: 0,
            isActive: true,
            isLocked: false,
            isLockedByAdmin: false,
            isOccupied: false,
            is_deleted: 0,
            isDeleted: false,
            currentPoNo: null,
            currentCustomer: null,
          };

          logger.debug(`[API POST /api/dock-doors] กู้คืนประตูที่เคยปิดไว้สำเร็จ: ${code} (${name})`);

          if (io) {
            io.emit('dock-doors-updated', { newDoor: reactivatedDoor });
            broadcastDashboardUpdate(io);
          }

          return res.status(201).json({ success: true, data: reactivatedDoor, message: `เปิดใช้งานประตู ${code} สำเร็จ` });
        }
        return res.status(409).json({ success: false, message: `มีประตูรหัส ${code} อยู่แล้วในระบบ` });
      }

      const insertResult = await pool.request()
        .input('code', sql.NVarChar(50), code)
        .input('name', sql.NVarChar(100), name)
        .query(`
          INSERT INTO ${TABLES.DOCK_DOOR} (dock_door_code, dock_door_name, is_active, is_deleted, create_date)
          OUTPUT INSERTED.dock_door_id, INSERTED.dock_door_code, INSERTED.dock_door_name, INSERTED.is_active
          VALUES (@code, @name, 0, 0, GETDATE())
        `);

      const newDoor = insertResult.recordset[0];
      const formattedDoor = {
        id: newDoor.dock_door_id,
        code: newDoor.dock_door_code,
        name: newDoor.dock_door_name,
        dock_door_name: newDoor.dock_door_name,
        dockDoorName: newDoor.dock_door_name,
        displayName: `${newDoor.dock_door_code} - ${newDoor.dock_door_name}`,
        is_active: 0,
        isActive: true,
        isLocked: false,
        isLockedByAdmin: false,
        isOccupied: false,
        is_deleted: 0,
        isDeleted: false,
        currentPoNo: null,
        currentCustomer: null,
      };

      logger.debug(`[API POST /api/dock-doors] เพิ่มประตูใหม่สำเร็จ: ${code} (${name})`);

      if (io) {
        io.emit('dock-doors-updated', { newDoor: formattedDoor });
        broadcastDashboardUpdate(io);
      }

      res.status(201).json({ success: true, data: formattedDoor, message: `เพิ่มประตู ${code} สำเร็จ` });
    } catch (err) {
      logger.error('Error in /api/dock-doors (create):', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  };
}

function createDeleteDockDoorHandler(io) {
  return async function deleteDockDoor(req, res) {
    try {
      const rawParam = req.params.id || req.params.dockDoorId || '';
      const bodyId = req.body?.dockDoorId || req.body?.id;
      const bodyCode = req.body?.dockDoorCode || req.body?.code;
      const queryCode = req.query?.dockDoorCode || req.query?.code;
      const queryId = req.query?.dockDoorId || req.query?.id;

      const doorId = bodyId || queryId || (rawParam && !isNaN(rawParam) ? rawParam : null);
      const doorCode = bodyCode || queryCode || (rawParam ? String(rawParam).trim().toUpperCase() : '');

      const parsedId = doorId && !isNaN(doorId) ? parseInt(doorId, 10) : null;
      const cleanCode = String(doorCode || '').trim().toUpperCase();
      const possibleCodeWithD = cleanCode ? (cleanCode.startsWith('D') ? cleanCode : `D${cleanCode}`) : (parsedId ? `D${parsedId}` : '');
      const possibleCodeWithoutD = cleanCode.replace(/^D/, '');

      const pool = await getPool();

      await pool.request().query(`
        IF NOT EXISTS (
          SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_NAME = '${TABLES.DOCK_DOOR}' AND COLUMN_NAME = 'is_deleted'
        )
        BEGIN
          ALTER TABLE ${TABLES.DOCK_DOOR} ADD is_deleted BIT DEFAULT 0;
          EXEC('UPDATE ${TABLES.DOCK_DOOR} SET is_deleted = 0 WHERE is_deleted IS NULL');
        END
      `);

      const checkDoor = await pool.request()
        .input('doorId', sql.Int, parsedId)
        .input('cleanCode', sql.NVarChar(50), cleanCode)
        .input('codeWithD', sql.NVarChar(50), possibleCodeWithD)
        .input('codeWithoutD', sql.NVarChar(50), possibleCodeWithoutD)
        .query(`
          SELECT TOP 1 dock_door_id, dock_door_code, dock_door_name, is_active
          FROM ${TABLES.DOCK_DOOR}
          WHERE ((dock_door_id = @doorId AND @doorId IS NOT NULL)
             OR (dock_door_code = @cleanCode AND @cleanCode <> '')
             OR (dock_door_code = @codeWithD AND @codeWithD <> '')
             OR (dock_door_code = @codeWithoutD AND @codeWithoutD <> ''))
        `);

      if (!checkDoor.recordset || checkDoor.recordset.length === 0) {
        return res.status(404).json({ success: false, message: `ไม่พบข้อมูลประตู ${cleanCode || doorId || ''} ในระบบ` });
      }

      const targetDoor = checkDoor.recordset[0];

      const checkOccupied = await pool.request()
        .input('doorId', sql.Int, targetDoor.dock_door_id)
        .input('doorCode', sql.NVarChar(50), targetDoor.dock_door_code)
        .query(`
          SELECT TOP 1 PO_No, customer_Name
          FROM ${TABLES.RECEIVED}
          WHERE ((dock_door_id = @doorId AND @doorId IS NOT NULL) OR (dock_door_code = @doorCode AND @doorCode <> ''))
            AND ISNULL(process_stage, '') NOT IN ('COMPLETED', 'CANCLE', 'CANCEL', 'DEPARTED')
        `);

      if (checkOccupied.recordset.length > 0) {
        return res.status(400).json({
          success: false,
          error: `ประตูกำลังมีรถเข้าใช้งาน (PO: ${checkOccupied.recordset[0].PO_No}) ไม่สามารถลบได้`
        });
      }

      await pool.request()
        .input('doorId', sql.Int, targetDoor.dock_door_id)
        .query(`
          UPDATE ${TABLES.DOCK_DOOR}
          SET is_deleted = 1, is_active = 0, update_date = GETDATE()
          WHERE dock_door_id = @doorId
        `);

      logger.debug(`[API DELETE /api/dock-doors] ปิดการใช้งานประตู ${targetDoor.dock_door_code} (Soft Delete) เรียบร้อยแล้ว`);

      if (io) {
        io.emit('dock-doors-updated', { deletedDoor: targetDoor.dock_door_code, id: targetDoor.dock_door_id });
        broadcastDashboardUpdate(io);
      }

      return res.json({
        success: true,
        message: `ลบประตู ${targetDoor.dock_door_code} เรียบร้อยแล้ว (ปิดการใช้งาน)`,
        data: { id: targetDoor.dock_door_id, code: targetDoor.dock_door_code }
      });
    } catch (err) {
      logger.error('Error in delete dock door:', err.message);
      return res.status(500).json({ success: false, error: err.message });
    }
  };
}

function createRestoreDockDoorHandler(io) {
  return async function restoreDockDoor(req, res) {
    try {
      const rawParam = req.params.id || req.params.dockDoorId || '';
      const bodyId = req.body?.dockDoorId || req.body?.id;
      const bodyCode = req.body?.dockDoorCode || req.body?.code;
      const queryCode = req.query?.dockDoorCode || req.query?.code;
      const queryId = req.query?.dockDoorId || req.query?.id;

      const doorId = bodyId || queryId || (rawParam && !isNaN(rawParam) ? rawParam : null);
      const doorCode = bodyCode || queryCode || (rawParam ? String(rawParam).trim().toUpperCase() : '');

      const parsedId = doorId && !isNaN(doorId) ? parseInt(doorId, 10) : null;
      const cleanCode = String(doorCode || '').trim().toUpperCase();
      const possibleCodeWithD = cleanCode ? (cleanCode.startsWith('D') ? cleanCode : `D${cleanCode}`) : (parsedId ? `D${parsedId}` : '');
      const possibleCodeWithoutD = cleanCode.replace(/^D/, '');

      const pool = await getPool();

      const restoreResult = await pool.request()
        .input('doorId', sql.Int, parsedId)
        .input('cleanCode', sql.NVarChar(50), cleanCode)
        .input('codeWithD', sql.NVarChar(50), possibleCodeWithD)
        .input('codeWithoutD', sql.NVarChar(50), possibleCodeWithoutD)
        .query(`
          UPDATE ${TABLES.DOCK_DOOR}
          SET is_deleted = 0, is_active = 0, update_date = GETDATE()
          WHERE ((dock_door_id = @doorId AND @doorId IS NOT NULL)
             OR (dock_door_code = @cleanCode AND @cleanCode <> '')
             OR (dock_door_code = @codeWithD AND @codeWithD <> '')
             OR (dock_door_code = @codeWithoutD AND @codeWithoutD <> ''))
        `);

      const restored = (restoreResult.rowsAffected || []).reduce((a, b) => a + b, 0);
      if (restored === 0) {
        return res.status(404).json({ success: false, code: 'DOOR_NOT_FOUND', error: `ไม่พบข้อมูลประตู ${doorCode || doorId || ''} ในระบบ` });
      }

      logger.debug(`[API POST /api/dock-doors/restore] เปิดใช้งานประตู ${doorCode || doorId} อีกครั้งเรียบร้อยแล้ว`);

      if (io) {
        io.emit('dock-doors-updated', { restoredDoor: doorCode || doorId });
        broadcastDashboardUpdate(io);
      }

      return res.json({
        success: true,
        message: `เปิดใช้งานประตู ${doorCode || doorId} อีกครั้งเรียบร้อยแล้ว`
      });
    } catch (err) {
      logger.error('Error in restore dock door:', err.message);
      return res.status(500).json({ success: false, error: err.message });
    }
  };
}

async function getWarehouses(req, res) {
  try {
    const pool = await getPool();
    const result = await pool.request().query(`
      SELECT warehouse_id, warehouse_code, warehouse_name, is_active
      FROM ${TABLES.WAREHOUSE}
      WHERE is_active = 1 OR is_active IS NULL
      ORDER BY warehouse_id ASC
    `);

    const warehouses = result.recordset.map(row => ({
      id: row.warehouse_id,
      code: row.warehouse_code,
      name: row.warehouse_name,
      displayName: `${row.warehouse_code} - ${row.warehouse_name}`,
    }));

    logger.debug(`[API GET /api/warehouses] ส่งรายการคลังสินค้า ${warehouses.length} รายการ (ตาราง: ${TABLES.WAREHOUSE})`);
    res.json({ success: true, data: warehouses });
  } catch (err) {
    logger.error('Error in /api/warehouses:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
}

async function getTruckTypes(req, res) {
  try {
    const pool = await getPool();
    const result = await pool.request().query(`
      SELECT truck_type_id, truck_type, is_active
      FROM ${TABLES.TRUCK}
      WHERE is_active = 1 OR is_active IS NULL
      ORDER BY truck_type_id ASC
    `);

    const truckTypes = result.recordset.map(row => ({
      id: row.truck_type_id,
      truckType: row.truck_type,
      name: row.truck_type,
      displayName: row.truck_type,
    }));

    logger.debug(`[API GET /api/truck-types] ส่งรายการประเภทรถ ${truckTypes.length} รายการ (ตาราง: ${TABLES.TRUCK})`);
    res.json({ success: true, data: truckTypes });
  } catch (err) {
    logger.error('Error in /api/truck-types:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
}

module.exports = {
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
};
