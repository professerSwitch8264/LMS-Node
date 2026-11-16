const { logger } = require('../utils/logger');
const { sql, getPool } = require('../config/db');
const { TABLES } = require('../config/constants');
const { formatSqlDateTimeStr, formatLocalIso } = require('../utils/dateHelper');
const { broadcastDashboardUpdate } = require('../services/dashboardService');

// แจ้งทุกคนว่า PO เปลี่ยน พร้อมบอกว่าใครบันทึก (หน้าเว็บใช้แสดงป้าย "อัปเดต" ให้คนอื่น)
function emitPoUpdated(io, req, payload) {
  if (!io) return;
  io.emit('po-updated', { ...payload, by: req.user?.username || null });
}

function normalizeUom(uom) {
  if (!uom) return '';
  const s = String(uom).trim().toUpperCase();
  if (s.includes('BUNDLE') || s === 'BDL') return 'BDL';
  if (s.includes('CARTON') || s === 'CTN' || s === 'CS') return 'CTN';
  if (s.includes('BOX')) return 'BOX';
  return s;
}

function safeInt(val) {
  if (val === undefined || val === null || val === '') return null;
  const n = parseInt(val, 10);
  return Number.isFinite(n) ? n : null;
}

function safeFloat(val) {
  if (val === undefined || val === null || val === '') return null;
  const n = parseFloat(String(val).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : null;
}

async function resolveTruckFromDb(pool, truckTypeId, truckType) {
  let finalId = truckTypeId !== undefined && truckTypeId !== null && truckTypeId !== '' ? parseInt(truckTypeId, 10) : null;
  let finalName = truckType !== undefined && truckType !== null && truckType !== '-' ? String(truckType).trim() : '';

  if (finalId && !finalName) {
    const trk = await pool.request()
      .input('ttid', sql.Int, finalId)
      .query(`SELECT truck_type FROM ${TABLES.TRUCK} WHERE truck_type_id = @ttid`);
    if (trk.recordset.length > 0) {
      finalName = trk.recordset[0].truck_type;
    }
  } else if (!finalId && finalName) {
    const trk = await pool.request()
      .input('ttname', sql.NVarChar(100), finalName)
      .query(`SELECT truck_type_id, truck_type FROM ${TABLES.TRUCK} WHERE truck_type = @ttname`);
    if (trk.recordset.length > 0) {
      finalId = trk.recordset[0].truck_type_id;
    }
  }

  return { truckTypeId: finalId, truckType: finalName };
}

async function getPos(req, res) {
  try {
    const pool = await getPool();
    const hasCancleCol = await pool.request().query(`
      SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('${TABLES.RECEIVED}') AND name = 'cancle_reason'
    `);
    const cancleSelect = hasCancleCol.recordset.length > 0 ? 'r.cancle_reason,' : 'NULL as cancle_reason,';

    const hasUrgentCol = await pool.request().query(`
      SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('${TABLES.RECEIVED}') AND (name = 'is_urgent' OR name = 'isUrgent')
    `);
    const urgentSelect = hasUrgentCol.recordset.length > 0 ? 'r.is_urgent,' : '0 as is_urgent,';

    const result = await pool.request().query(`
      SELECT
        r.received_id,
        r.PO_No, r.quantity, r.quantity_uom,
        c.customer_id, r.customer_code, r.customer_Name,
        r.truck_type_id, r.truck_type,
        t.truck_type_id as matched_truck_type_id,
        t.truck_type as matched_truck_type,
        r.license, r.driver_name, r.driver_tel,
        r.ticket_date,
        CONVERT(varchar(10), r.ticket_date, 120) as ticket_date_str,
        CONVERT(varchar(5), r.ticket_date, 108) as ticket_time_str,
        CONVERT(varchar(19), r.ticket_date, 120) as ticket_str,
        r.register_date,
        CONVERT(varchar(10), r.register_date, 120) as register_date_str,
        CONVERT(varchar(5), r.register_date, 108) as register_time_str,
        CONVERT(varchar(19), r.register_date, 120) as register_str,
        r.truck_arrival,
        CONVERT(varchar(10), r.truck_arrival, 120) as truck_arrival_date_str,
        CONVERT(varchar(5), r.truck_arrival, 108) as truck_arrival_time_str,
        CONVERT(varchar(19), r.truck_arrival, 120) as truck_arrival_str,
        r.order_date,
        CONVERT(varchar(10), r.order_date, 120) as order_date_str,
        CONVERT(varchar(5), r.order_date, 108) as order_time_str,
        CONVERT(varchar(19), r.order_date, 120) as order_str,
        r.ship_to_code, r.ship_to_name,
        r.warehouse_id, r.warehouse_code, r.warehouse_name,
        r.pick_start_date_time,
        CONVERT(varchar(19), r.pick_start_date_time, 120) as pick_start_str,
        r.pick_finish_date_time,
        CONVERT(varchar(19), r.pick_finish_date_time, 120) as pick_finish_str,
        r.load_start_date_time,
        CONVERT(varchar(19), r.load_start_date_time, 120) as load_start_str,
        r.load_finish_date_time,
        CONVERT(varchar(19), r.load_finish_date_time, 120) as load_finish_str,
        r.truck_departure,
        CONVERT(varchar(10), r.truck_departure, 120) as truck_departure_date_str,
        CONVERT(varchar(5), r.truck_departure, 108) as truck_departure_time_str,
        CONVERT(varchar(19), r.truck_departure, 120) as truck_departure_str,
        r.dock_door_id, r.dock_door_code, r.dock_door_name,
        r.process_stage,
        r.reschedule_date,
        CONVERT(varchar(10), r.reschedule_date, 120) as reschedule_date_str,
        CONVERT(varchar(5), r.reschedule_date, 108) as reschedule_time_str,
        r.reschedule_reason,
        ${cancleSelect}
        ${urgentSelect}
        r.create_date,
        CONVERT(varchar(19), r.create_date, 120) as create_date_str,
        r.update_date,
        CONVERT(varchar(19), r.update_date, 120) as update_date_str
      FROM ${TABLES.RECEIVED} r
      LEFT JOIN ${TABLES.CUSTOMER} c ON (
        (r.customer_code IS NOT NULL AND r.customer_code = c.customer_code)
        OR (r.customer_code IS NULL AND r.customer_Name IS NOT NULL AND r.customer_Name = c.customer_name)
      )
      LEFT JOIN ${TABLES.TRUCK} t ON (
        (r.truck_type_id IS NOT NULL AND r.truck_type_id = t.truck_type_id)
        OR (r.truck_type_id IS NULL AND r.truck_type IS NOT NULL AND r.truck_type = t.truck_type)
      )
      ORDER BY COALESCE(r.create_date, r.order_date, r.register_date) DESC, r.PO_No DESC
    `);

    const pos = result.recordset.map(row => {
      const regIso = formatLocalIso(row.register_str, row.register_date);
      const ticketIso = formatLocalIso(row.ticket_str, row.ticket_date);
      const truckArrivalIso = formatLocalIso(row.truck_arrival_str, row.truck_arrival);
      const truckDepartureIso = formatLocalIso(row.truck_departure_str, row.truck_departure);
      const orderIso = formatLocalIso(row.order_str, row.order_date);
      const shipDatePlanIso = null;
      const pickStartIso = formatLocalIso(row.pick_start_str, row.pick_start_date_time);
      const pickFinishIso = formatLocalIso(row.pick_finish_str, row.pick_finish_date_time);
      const loadStartIso = formatLocalIso(row.load_start_str, row.load_start_date_time);
      const loadFinishIso = formatLocalIso(row.load_finish_str, row.load_finish_date_time);

      const hasRealTruck = Boolean(
        row.license && String(row.license).trim() !== '' && row.license !== '-' &&
        row.driver_name && String(row.driver_name).trim() !== '' && row.driver_name !== '-' &&
        (row.register_str || row.register_date) &&
        (row.register_time_str || (regIso && regIso.length > 10))
      );

      let dynamicStage = row.process_stage || 'ADMIN_OFFICE';
      if (dynamicStage === 'CANCLE' || dynamicStage === 'CANCEL') {
        dynamicStage = 'CANCLE';
      } else if (truckDepartureIso || dynamicStage === 'COMPLETED') {
        dynamicStage = 'COMPLETED';
      } else if (loadFinishIso || dynamicStage === 'WAITING_DEPARTURE') {
        dynamicStage = 'WAITING_DEPARTURE';
      } else if (loadStartIso || pickStartIso) {
        dynamicStage = 'ADMIN_OUTSIDE';
      } else if (ticketIso) {
        dynamicStage = 'ISSUE_TICKET';
      } else if (!hasRealTruck && (!row.customer_Name || !row.quantity || (!row.ship_to_name && !row.ship_to_code))) {
        dynamicStage = 'PO_INCOMPLETE';
      } else if (!hasRealTruck) {
        dynamicStage = 'CAR_REGISTER';
      } else if (!row.dock_door_code && !row.dock_door_id) {
        dynamicStage = 'ASSIGN_DOCK';
      } else if (!row.truck_arrival && !truckArrivalIso) {
        dynamicStage = 'ASSIGN_DOCK';
      } else {
        dynamicStage = 'ISSUE_TICKET';
      }

      const qVal = row.quantity ? parseFloat(row.quantity) : null;
      const finalTruckTypeId = row.truck_type_id !== null && row.truck_type_id !== undefined
        ? Number(row.truck_type_id)
        : (row.matched_truck_type_id !== null && row.matched_truck_type_id !== undefined ? Number(row.matched_truck_type_id) : null);
      const finalTruckType = row.truck_type || row.matched_truck_type || '';

      return {
        id: row.received_id,
        receivedId: row.received_id,
        poNo: row.PO_No,
        quantity: qVal,
        quantityOrder: qVal !== null ? String(qVal) : '',
        quantityUom: normalizeUom(row.quantity_uom),
        customerId: row.customer_id !== null && row.customer_id !== undefined ? Number(row.customer_id) : null,
        customerCode: row.customer_code || '',
        customerName: row.customer_Name || '',
        truckTypeId: finalTruckTypeId,
        truckType: finalTruckType,
        licensePlate: row.license || '',
        license: row.license || '',
        driverName: row.driver_name || '',
        driverTel: row.driver_tel || '',
        shipToCode: row.ship_to_code || '',
        shipToName: row.ship_to_name || '',
        shipToCustomer: row.ship_to_name || '',
        toLocation: row.ship_to_name || '',
        warehouseId: row.warehouse_id !== null && row.warehouse_id !== undefined ? Number(row.warehouse_id) : null,
        warehouseCode: row.warehouse_code || '',
        warehouseName: row.warehouse_name || '',
        orderDate: orderIso,
        orderDateStr: row.order_date_str || '',
        orderTimeStr: row.order_time_str || '',
        ticketDate: ticketIso,
        ticketDateStr: row.ticket_date_str || '',
        ticketTimeStr: row.ticket_time_str || '',
        registerDate: regIso,
        registerDateStr: row.register_date_str || '',
        registerTimeStr: row.register_time_str || '',
        registerTime: row.register_time_str || '',
        planDate: regIso,
        planTime: row.register_time_str || '',
        shipDatePlan: null,
        shipDatePlanStr: '',
        truckArrival: truckArrivalIso,
        truckArrivalDate: row.truck_arrival_date_str || '',
        truckArrivalTime: row.truck_arrival_time_str || '',
        truckDeparture: truckDepartureIso,
        truckDepartureDate: row.truck_departure_date_str || '',
        truckDepartureTime: row.truck_departure_time_str || '',
        dockDoorId: row.dock_door_id !== null && row.dock_door_id !== undefined ? Number(row.dock_door_id) : null,
        dockDoorCode: row.dock_door_code || '',
        dockDoorName: row.dock_door_name || '',
        dockDoor: row.dock_door_code || '',
        processStage: dynamicStage,
        is_urgent: Boolean(row.is_urgent),
        isUrgent: Boolean(row.is_urgent),
        rescheduleDate: row.reschedule_date_str || null,
        rescheduleTime: row.reschedule_time_str || null,
        rescheduleReason: row.reschedule_reason || null,
        cancelReason: row.cancle_reason || row.reschedule_reason || null,
        cancleReason: row.cancle_reason || null,
        createDate: formatLocalIso(row.create_date_str, row.create_date),
        updateDate: formatLocalIso(row.update_date_str, row.update_date),
        pickStart: pickStartIso,
        pickFinish: pickFinishIso,
        loadStart: loadStartIso,
        loadFinish: loadFinishIso,
        taskTimestamps: {
          pickStart: pickStartIso,
          pickFinish: pickFinishIso,
          loadStart: loadStartIso,
          loadFinish: loadFinishIso,
          truckArrival: truckArrivalIso,
          truckDeparture: truckDepartureIso,
        },
      };
    });

    res.json({ success: true, data: pos });
  } catch (err) {
    logger.error('Error in /api/pos:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
}

function createRegisterCarHandler(io) {
  return async function registerCar(req, res) {
    const { receivedId, id, poNo, truckTypeId, truckType, licensePlate, driverName, driverTel, registerDate, registerTime } = req.body;

    if (!poNo || !String(poNo).trim()) {
      return res.status(400).json({ success: false, error: 'ไม่พบหมายเลข PO' });
    }
    if (!truckType && !truckTypeId) {
      return res.status(400).json({ success: false, error: 'กรุณาเลือกประเภทรถ' });
    }
    if (!licensePlate || !String(licensePlate).trim() || String(licensePlate).trim() === '-') {
      return res.status(400).json({ success: false, error: 'กรุณากรอกทะเบียนรถ' });
    }
    if (!driverName || !String(driverName).trim() || String(driverName).trim() === '-') {
      return res.status(400).json({ success: false, error: 'กรุณากรอกชื่อคนขับ' });
    }
    if (!driverTel || !String(driverTel).trim() || String(driverTel).trim() === '-') {
      return res.status(400).json({ success: false, error: 'กรุณากรอกเบอร์โทรศัพท์คนขับ' });
    }
    if (!registerDate) {
      return res.status(400).json({ success: false, error: 'กรุณาเลือก Plan date' });
    }
    if (!registerTime) {
      return res.status(400).json({ success: false, error: 'กรุณาเลือก Plan time' });
    }

    try {
      const pool = await getPool();
      const regDateTimeStr = formatSqlDateTimeStr(registerDate, registerTime);

      const resolvedTruck = await resolveTruckFromDb(pool, truckTypeId, truckType);
      const finalTruckTypeId = resolvedTruck.truckTypeId;
      const finalTruckType = resolvedTruck.truckType;

      const licenseStr = licensePlate !== undefined && licensePlate !== null ? String(licensePlate) : '';
      const driverNameStr = driverName !== undefined && driverName !== null ? String(driverName) : '';
      const driverTelStr = driverTel !== undefined && driverTel !== null ? String(driverTel).trim() : '';

      await pool.request()
        .input('receivedId', sql.Int, safeInt(receivedId || id))
        .input('poNo', sql.NVarChar(50), String(poNo))
        .input('truckTypeId', sql.Int, safeInt(finalTruckTypeId))
        .input('truckType', sql.NVarChar(100), finalTruckType)
        .input('license', sql.NVarChar(50), licenseStr)
        .input('driverName', sql.NVarChar(100), driverNameStr)
        .input('driverTel', sql.NVarChar(20), driverTelStr)
        .input('regDateStr', sql.VarChar(30), regDateTimeStr)
        .query(`
          IF @receivedId IS NOT NULL AND EXISTS (SELECT 1 FROM ${TABLES.RECEIVED} WHERE received_id = @receivedId)
            UPDATE ${TABLES.RECEIVED}
            SET
              truck_type_id = @truckTypeId,
              truck_type = @truckType,
              license = @license,
              driver_name = @driverName,
              driver_tel = @driverTel,
              register_date = CASE WHEN @regDateStr IS NOT NULL THEN CONVERT(datetime, @regDateStr, 120) ELSE register_date END,
              process_stage = 'ISSUE_TICKET',
              update_date = GETDATE()
            WHERE received_id = @receivedId
          ELSE IF EXISTS (SELECT 1 FROM ${TABLES.RECEIVED} WHERE PO_No = @poNo AND ISNULL(process_stage, '') NOT IN ('CANCLE', 'CANCEL'))
            UPDATE ${TABLES.RECEIVED}
            SET
              truck_type_id = @truckTypeId,
              truck_type = @truckType,
              license = @license,
              driver_name = @driverName,
              driver_tel = @driverTel,
              register_date = CASE WHEN @regDateStr IS NOT NULL THEN CONVERT(datetime, @regDateStr, 120) ELSE register_date END,
              process_stage = 'ISSUE_TICKET',
              update_date = GETDATE()
            WHERE PO_No = @poNo AND ISNULL(process_stage, '') NOT IN ('CANCLE', 'CANCEL')
          ELSE
            INSERT INTO ${TABLES.RECEIVED} (PO_No, truck_type_id, truck_type, license, driver_name, driver_tel, register_date, process_stage, create_date, update_date)
            VALUES (@poNo, @truckTypeId, @truckType, @license, @driverName, @driverTel, CASE WHEN @regDateStr IS NOT NULL THEN CONVERT(datetime, @regDateStr, 120) ELSE NULL END, 'ISSUE_TICKET', GETDATE(), GETDATE())
        `);

      logger.debug(`[API POST /api/register-car] บันทึกสำเร็จ PO: ${poNo}, truck_type_id: ${finalTruckTypeId}, truck_type: ${finalTruckType}, date: ${regDateTimeStr}`);

      if (io) {
        emitPoUpdated(io, req, { poNo, type: 'register-car' });
        broadcastDashboardUpdate(io);
      }
      res.json({ success: true, message: 'ลงทะเบียนรถเรียบร้อย' });
    } catch (err) {
      logger.error('Error in /api/register-car:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  };
}

const lastAffected = (result) => {
  const r = result && result.rowsAffected;
  return Array.isArray(r) && r.length ? Number(r[r.length - 1]) || 0 : 0;
};
const poNotFound = (res, error, extra = {}) => res.status(404).json({ success: false, code: 'PO_NOT_FOUND', error, ...extra });
const NOT_FOUND_OR_CANCELLED = (poNo) => `ไม่พบ PO ${poNo} หรือรายการถูกยกเลิกแล้ว`;

function createTruckArrivalHandler(io) {
  return async function recordTruckArrival(req, res) {
    const { poNo } = req.body;
    try {
      const pool = await getPool();
      const arrivalResult = await pool.request()
        .input('poNo', sql.NVarChar(50), String(poNo))
        .query(`
          UPDATE ${TABLES.RECEIVED}
          SET
            truck_arrival = GETDATE(),
            update_date = GETDATE()
          WHERE PO_No = @poNo AND ISNULL(process_stage, '') NOT IN ('CANCLE', 'CANCEL')
        `);

      if (lastAffected(arrivalResult) === 0) return poNotFound(res, NOT_FOUND_OR_CANCELLED(poNo));

      logger.debug(`[API POST /api/truck-arrival] บันทึกสำเร็จ PO: ${poNo}`);

      if (io) {
        emitPoUpdated(io, req, { poNo, type: 'truck-arrival' });
        broadcastDashboardUpdate(io);
      }
      res.json({ success: true, message: 'บันทึกเวลารถเข้าเรียบร้อย' });
    } catch (err) {
      logger.error('Error in /api/truck-arrival:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  };
}

function createTruckDepartureHandler(io) {
  return async function recordTruckDeparture(req, res) {
    const { poNo, username } = req.body;
    try {
      const pool = await getPool();
      const departureResult = await pool.request()
        .input('poNo', sql.NVarChar(50), String(poNo))
        .query(`
          UPDATE ${TABLES.RECEIVED}
          SET
            truck_departure = GETDATE(),
            process_stage = 'COMPLETED',
            update_date = GETDATE()
          WHERE (PO_No = @poNo OR LTRIM(RTRIM(REPLACE(PO_No, 'PO', ''))) = LTRIM(RTRIM(REPLACE(@poNo, 'PO', ''))))
            AND ISNULL(process_stage, '') NOT IN ('CANCLE', 'CANCEL')
        `);

      if (lastAffected(departureResult) === 0) return poNotFound(res, NOT_FOUND_OR_CANCELLED(poNo));

      await pool.request()
        .input('poNoForDoor', sql.NVarChar(50), String(poNo))
        .query(`
          UPDATE d
          SET d.is_active = 0, d.update_date = GETDATE()
          FROM ${TABLES.DOCK_DOOR} d
          INNER JOIN ${TABLES.RECEIVED} r ON (d.dock_door_id = r.dock_door_id OR d.dock_door_code = r.dock_door_code)
          WHERE (r.PO_No = @poNoForDoor OR LTRIM(RTRIM(REPLACE(r.PO_No, 'PO', ''))) = LTRIM(RTRIM(REPLACE(@poNoForDoor, 'PO', ''))))
        `);

      const effectiveUser = req.user?.username
        || ((username && String(username).trim()) ? String(username).trim().toUpperCase() : 'SYSTEM');
      try {
        const hasLogTable = await pool.request().query(`
          SELECT 1 FROM sys.tables WHERE name = '${TABLES.TRANSACTION_LOG}'
        `);
        if (hasLogTable.recordset.length > 0) {
          await pool.request()
            .input('username', sql.NVarChar(100), effectiveUser)
            .input('actionType', sql.NVarChar(50), 'TRUCK_DEPARTURE')
            .input('actionTitle', sql.NVarChar(255), 'บันทึกเวลารถออก')
            .input('poNo', sql.NVarChar(50), String(poNo))
            .input('details', sql.NVarChar(sql.MAX), 'รถออกจากโรงงานเรียบร้อย')
            .query(`
              INSERT INTO [${TABLES.TRANSACTION_LOG}] (username, action_type, action_title, po_no, details)
              VALUES (@username, @actionType, @actionTitle, @poNo, @details)
            `);
        }
      } catch (auditErr) {
        logger.warn('[Transaction log insertion warning in truck departure]:', auditErr.message);
      }

      logger.debug(`[API POST /api/truck-departure] บันทึกเวลารถออกและปลดล็อคประตูโหลดสำหรับ PO: ${poNo} โดย ${effectiveUser}`);

      if (io) {
        io.emit('dock-doors-updated', { poNo, is_active: 0 });
        emitPoUpdated(io, req, { poNo, type: 'truck-departure' });
        io.emit('wanthai_audit_log_created', {
          username: effectiveUser,
          action_type: 'TRUCK_DEPARTURE',
          action_title: 'บันทึกเวลารถออก',
          po_no: poNo,
          details: 'รถออกจากโรงงานเรียบร้อย',
          created_at: new Date().toISOString()
        });
        broadcastDashboardUpdate(io);
      }
      res.json({ success: true, message: 'บันทึกเวลารถออกและปลดล็อคประตูเรียบร้อย' });
    } catch (err) {
      logger.error('Error in /api/truck-departure:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  };
}

function createCancelPoHandler(io) {
  return async function cancelPo(req, res) {
    const { poNos, poNo, cancelReason, reason, receivedIds, receivedId } = req.body;
    const finalReason = cancelReason || reason || 'ยกเลิกรายการ';
    const list = Array.isArray(poNos) && poNos.length > 0 ? poNos : (poNo ? [poNo] : []);
    const idList = Array.isArray(receivedIds) && receivedIds.length > 0 ? receivedIds : (receivedId ? [receivedId] : []);

    if (list.length === 0 && idList.length === 0) {
      return res.status(400).json({ success: false, error: 'ไม่พบหมายเลข PO หรือ ID สำหรับยกเลิก' });
    }

    try {
      const pool = await getPool();

      const hasCancleCol = await pool.request().query(`
        SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('${TABLES.RECEIVED}') AND name = 'cancle_reason'
      `);
      const updateCancleCol = hasCancleCol.recordset.length > 0
        ? 'cancle_reason = @reason, reschedule_reason = COALESCE(reschedule_reason, @reason),'
        : 'reschedule_reason = @reason,';

      let cancelledCount = 0;
      const notFound = [];
      if (idList.length > 0) {
        for (const id of idList) {
          const r = await pool.request()
            .input('recId', sql.Int, Number(id))
            .input('reason', sql.NVarChar(255), String(finalReason))
            .query(`
              UPDATE d
              SET d.is_active = 0, d.update_date = GETDATE()
              FROM ${TABLES.DOCK_DOOR} d
              INNER JOIN ${TABLES.RECEIVED} r ON (d.dock_door_id = r.dock_door_id OR d.dock_door_code = r.dock_door_code)
              WHERE r.received_id = @recId;

              UPDATE ${TABLES.RECEIVED}
              SET
                process_stage = 'CANCLE',
                ${updateCancleCol}
                dock_door_id = NULL,
                dock_door_code = NULL,
                dock_door_name = NULL,
                update_date = GETDATE()
              WHERE received_id = @recId;
            `);
          if (lastAffected(r) > 0) cancelledCount += lastAffected(r); else notFound.push(id);
        }
      }

      if (list.length > 0 && idList.length === 0) {
        for (const p of list) {
          const r = await pool.request()
            .input('poNo', sql.NVarChar(50), String(p))
            .input('reason', sql.NVarChar(255), String(finalReason))
            .query(`
              UPDATE d
              SET d.is_active = 0, d.update_date = GETDATE()
              FROM ${TABLES.DOCK_DOOR} d
              INNER JOIN ${TABLES.RECEIVED} r ON (d.dock_door_id = r.dock_door_id OR d.dock_door_code = r.dock_door_code)
              WHERE (r.PO_No = @poNo OR LTRIM(RTRIM(REPLACE(r.PO_No, 'PO', ''))) = LTRIM(RTRIM(REPLACE(@poNo, 'PO', ''))));

              UPDATE ${TABLES.RECEIVED}
              SET
                process_stage = 'CANCLE',
                ${updateCancleCol}
                dock_door_id = NULL,
                dock_door_code = NULL,
                dock_door_name = NULL,
                update_date = GETDATE()
              WHERE (PO_No = @poNo OR LTRIM(RTRIM(REPLACE(PO_No, 'PO', ''))) = LTRIM(RTRIM(REPLACE(@poNo, 'PO', ''))));
            `);
          if (lastAffected(r) > 0) cancelledCount += lastAffected(r); else notFound.push(p);
        }
      }

      if (cancelledCount === 0) {
        return poNotFound(res, 'ไม่พบรายการ PO ที่จะยกเลิก', { notFound });
      }

      logger.debug(`[API POST /api/cancel-po] ยกเลิก PO สำเร็จ: ${list.join(', ') || idList.join(', ')} เหตุผล: ${finalReason}`);

      if (io) {
        io.emit('dock-doors-updated', { poNos: list, is_active: 0 });
        emitPoUpdated(io, req, { poNos: list, type: 'cancel-po' });
        broadcastDashboardUpdate(io);
      }
      res.json({ success: true, message: `ยกเลิกรายการและปลดล็อคประตูเรียบร้อยแล้ว ${cancelledCount} รายการ`, updated: cancelledCount, notFound });
    } catch (err) {
      logger.error('Error in /api/cancel-po:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  };
}

function createReschedulePoHandler(io) {
  return async function reschedulePo(req, res) {
    const { poNos, poNo, rescheduleDate, rescheduleTime, rescheduleReason } = req.body;
    const list = Array.isArray(poNos) && poNos.length > 0 ? poNos : (poNo ? [poNo] : []);

    if (list.length === 0) {
      return res.status(400).json({ success: false, error: 'ไม่พบหมายเลข PO สำหรับเลื่อนนัดหมาย' });
    }

    try {
      const pool = await getPool();
      if (rescheduleDate) {
        const parsed = await pool.request()
          .input('rDate', sql.NVarChar(50), String(rescheduleDate).trim())
          .input('rTime', sql.NVarChar(10), rescheduleTime ? String(rescheduleTime).trim() : null)
          .query(`SELECT COALESCE(
              TRY_CONVERT(DATETIME, @rDate + ' ' + ISNULL(@rTime, '00:00'), 120),
              TRY_CONVERT(DATETIME, @rDate + ' ' + ISNULL(@rTime, '00:00'), 103),
              TRY_CONVERT(DATETIME, @rDate + ' ' + ISNULL(@rTime, '00:00')),
              TRY_CONVERT(DATETIME, @rDate, 120),
              TRY_CONVERT(DATETIME, @rDate)) AS d`);
        if (!parsed.recordset?.[0]?.d) {
          return res.status(400).json({ success: false, code: 'BAD_DATE', error: 'รูปแบบวันที่เลื่อนไม่ถูกต้อง' });
        }
      }
      let rescheduledCount = 0;
      const notFound = [];
      for (const p of list) {
        const r = await pool.request()
          .input('poNo', sql.NVarChar(50), String(p))
          .input('rDate', sql.NVarChar(50), rescheduleDate ? String(rescheduleDate).trim() : null)
          .input('rTime', sql.NVarChar(10), rescheduleTime ? String(rescheduleTime).trim() : null)
          .input('rReason', sql.NVarChar(255), rescheduleReason ? String(rescheduleReason).trim() : null)
          .query(`
            UPDATE ${TABLES.RECEIVED}
            SET
              reschedule_date = CASE WHEN @rDate IS NOT NULL THEN COALESCE(
                TRY_CONVERT(DATETIME, @rDate + ' ' + ISNULL(@rTime, '00:00'), 120),
                TRY_CONVERT(DATETIME, @rDate + ' ' + ISNULL(@rTime, '00:00'), 103),
                TRY_CONVERT(DATETIME, @rDate + ' ' + ISNULL(@rTime, '00:00')),
                TRY_CONVERT(DATETIME, @rDate, 120),
                TRY_CONVERT(DATETIME, @rDate)
              ) ELSE reschedule_date END,
              reschedule_reason = COALESCE(@rReason, reschedule_reason),
              update_date = GETDATE()
            WHERE PO_No = @poNo AND ISNULL(process_stage, '') NOT IN ('CANCLE', 'CANCEL')
          `);
        if (lastAffected(r) > 0) rescheduledCount += 1; else notFound.push(p);
      }

      if (rescheduledCount === 0) {
        return poNotFound(res, 'ไม่พบรายการ PO ที่จะเลื่อนแผน หรือรายการถูกยกเลิกแล้ว', { notFound });
      }

      logger.debug(`[API POST /api/reschedule-po] เลื่อนนัดหมายสำเร็จ: ${list.join(', ')} วันที่: ${rescheduleDate} ${rescheduleTime || ''}`);

      if (io) {
        emitPoUpdated(io, req, { poNos: list, type: 'reschedule-po' });
        broadcastDashboardUpdate(io);
      }
      res.json({ success: true, message: `เลื่อนนัดหมายเรียบร้อยแล้ว ${rescheduledCount} รายการ`, updated: rescheduledCount, notFound });
    } catch (err) {
      logger.error('Error in /api/reschedule-po:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  };
}

async function upsertOfficePo(newRequest, body) {
  const {
    receivedId,
    id,
    poNo,
    customerId,
    customerCode,
    customerName,
    quantityOrder,
    quantityUom,
    shipToCode,
    shipToName,
    toLocation,
    warehouseId,
    warehouseCode,
    warehouseName,
    shipDatePlan,
    dockDoorId,
    dockDoorCode,
    dockDoorName,
    dockDoor,
    rescheduleDate,
    rescheduleTime,
    rescheduleReason
  } = body;

  let finalCustId = safeInt(customerId);
  let finalCustCode = customerCode ? String(customerCode).trim() : '';
  let finalCustName = customerName ? String(customerName).trim() : '';

  if (finalCustId && (!finalCustCode || !finalCustName)) {
    const custLookup = await newRequest()
      .input('cid', sql.Int, finalCustId)
      .query(`SELECT customer_code, customer_name FROM ${TABLES.CUSTOMER} WHERE customer_id = @cid`);
    if (custLookup.recordset.length > 0) {
      finalCustCode = finalCustCode || custLookup.recordset[0].customer_code || '';
      finalCustName = finalCustName || custLookup.recordset[0].customer_name || custLookup.recordset[0].customer_Name || '';
    }
  }

  let finalShipToCode = shipToCode ? String(shipToCode).trim() : '';
  let finalShipToName = shipToName || toLocation || '';

  let finalWhId = safeInt(warehouseId);
  let finalWhCode = warehouseCode ? String(warehouseCode).trim() : '';
  let finalWhName = warehouseName ? String(warehouseName).trim() : '';

  if (finalWhId && (!finalWhCode || !finalWhName)) {
    const whLookup = await newRequest()
      .input('whid', sql.Int, finalWhId)
      .query(`SELECT warehouse_code, warehouse_name FROM ${TABLES.WAREHOUSE} WHERE warehouse_id = @whid`);
    if (whLookup.recordset.length > 0) {
      finalWhCode = finalWhCode || whLookup.recordset[0].warehouse_code || '';
      finalWhName = finalWhName || whLookup.recordset[0].warehouse_name || '';
    }
  } else if (finalWhCode && (!finalWhId || !finalWhName)) {
    const whLookup = await newRequest()
      .input('whcode', sql.NVarChar(50), finalWhCode)
      .query(`SELECT warehouse_id, warehouse_name FROM ${TABLES.WAREHOUSE} WHERE warehouse_code = @whcode`);
    if (whLookup.recordset.length > 0) {
      finalWhId = finalWhId || whLookup.recordset[0].warehouse_id;
      finalWhName = finalWhName || whLookup.recordset[0].warehouse_name;
    }
  }

  let finalDoorId = safeInt(dockDoorId);
  let finalDoorCode = dockDoorCode || dockDoor ? String(dockDoorCode || dockDoor).trim() : '';
  let finalDoorName = dockDoorName ? String(dockDoorName).trim() : '';

  if (finalDoorId && (!finalDoorCode || !finalDoorName)) {
    const doorLookup = await newRequest()
      .input('ddid', sql.Int, finalDoorId)
      .query(`SELECT dock_door_code, dock_door_name FROM ${TABLES.DOCK_DOOR} WHERE dock_door_id = @ddid`);
    if (doorLookup.recordset.length > 0) {
      finalDoorCode = finalDoorCode || doorLookup.recordset[0].dock_door_code || '';
      finalDoorName = finalDoorName || doorLookup.recordset[0].dock_door_name || '';
    }
  } else if (finalDoorCode && (!finalDoorId || !finalDoorName)) {
    const doorLookup = await newRequest()
      .input('ddcode', sql.NVarChar(50), finalDoorCode)
      .query(`SELECT dock_door_id, dock_door_name FROM ${TABLES.DOCK_DOOR} WHERE dock_door_code = @ddcode`);
    if (doorLookup.recordset.length > 0) {
      finalDoorId = finalDoorId || doorLookup.recordset[0].dock_door_id;
      finalDoorName = finalDoorName || doorLookup.recordset[0].dock_door_name;
    }
  }

  const qtyVal = safeFloat(quantityOrder);
  const uomStr = normalizeUom(quantityUom);

  let finalRDate = null;
  if (rescheduleDate) {
    const d = new Date(rescheduleDate);
    if (!isNaN(d.getTime())) finalRDate = d;
  }
  const finalRTime = rescheduleTime ? String(rescheduleTime).trim() : null;
  const finalRReason = rescheduleReason ? String(rescheduleReason).trim() : null;
  const targetReceivedId = safeInt(receivedId || id);

  const saveResult = await newRequest()
    .input('poNo', sql.NVarChar(50), String(poNo).trim())
    .input('customerCode', sql.NVarChar(50), finalCustCode || null)
    .input('customerName', sql.NVarChar(255), finalCustName || null)
    .input('quantity', sql.Decimal(18, 2), qtyVal)
    .input('quantityUom', sql.NVarChar(20), uomStr || null)
    .input('shipToCode', sql.NVarChar(50), finalShipToCode || null)
    .input('shipToName', sql.NVarChar(255), finalShipToName || null)
    .input('warehouseId', sql.Int, finalWhId)
    .input('warehouseCode', sql.NVarChar(50), finalWhCode || null)
    .input('warehouseName', sql.NVarChar(255), finalWhName || null)
    .input('dockDoorId', sql.Int, finalDoorId)
    .input('dockDoorCode', sql.NVarChar(50), finalDoorCode || null)
    .input('dockDoorName', sql.NVarChar(100), finalDoorName || null)
    .input('receivedId', sql.Int, targetReceivedId)
    .input('rDate', sql.DateTime, finalRDate)
    .input('rTime', sql.NVarChar(50), finalRTime)
    .input('rReason', sql.NVarChar(255), finalRReason)
    .query(`
      IF @receivedId IS NOT NULL AND EXISTS (SELECT 1 FROM ${TABLES.RECEIVED} WHERE received_id = @receivedId)
      BEGIN
        UPDATE ${TABLES.RECEIVED}
        SET
          customer_code = @customerCode,
          customer_Name = @customerName,
          quantity = COALESCE(@quantity, quantity),
          quantity_uom = @quantityUom,
          ship_to_code = COALESCE(@shipToCode, ship_to_code),
          ship_to_name = @shipToName,
          warehouse_id = @warehouseId,
          warehouse_code = @warehouseCode,
          warehouse_name = @warehouseName,
          dock_door_id = @dockDoorId,
          dock_door_code = @dockDoorCode,
          dock_door_name = @dockDoorName,
          reschedule_date = COALESCE(@rDate, reschedule_date),
          reschedule_time = COALESCE(@rTime, reschedule_time),
          reschedule_reason = COALESCE(@rReason, reschedule_reason),
          process_stage = CASE
            WHEN (@customerName IS NULL OR LTRIM(RTRIM(@customerName)) = '')
              OR (@quantity IS NULL OR @quantity <= 0)
              OR (@warehouseName IS NULL OR LTRIM(RTRIM(@warehouseName)) = '')
              OR (@shipToName IS NULL OR LTRIM(RTRIM(@shipToName)) = '') THEN 'PO_INCOMPLETE'
            ELSE 'CAR_REGISTER'
          END,
          update_date = GETDATE()
        WHERE received_id = @receivedId;

        SELECT @receivedId AS final_received_id, 0 AS is_created;
      END
      ELSE
      BEGIN
        -- ตรวจสอบว่ามี PO_No นี้อยู่ในระบบแล้วหรือไม่ (ไม่รวมรายการที่ถูกยกเลิก)
        IF EXISTS (SELECT 1 FROM ${TABLES.RECEIVED} WHERE PO_No = @poNo AND ISNULL(process_stage, '') NOT IN ('CANCLE', 'CANCEL'))
        BEGIN
          SELECT -1 AS final_received_id;
        END
        ELSE
        BEGIN
          DECLARE @isIdentity INT = ISNULL(COLUMNPROPERTY(OBJECT_ID('${TABLES.RECEIVED}'), 'received_id', 'IsIdentity'), 0);
          IF @isIdentity = 0
          BEGIN
            -- ล็อคตารางด้วย Exclusive Lock (TABLOCKX, HOLDLOCK) ป้องกัน Race Condition กรณีไม่มี IDENTITY
            DECLARE @nextId INT;
            SELECT @nextId = ISNULL(MAX(received_id), 0) + 1
            FROM ${TABLES.RECEIVED} WITH (TABLOCKX, HOLDLOCK);

            INSERT INTO ${TABLES.RECEIVED} (
              received_id, PO_No, customer_code, customer_Name,
              quantity, quantity_uom, ship_to_code, ship_to_name,
              warehouse_id, warehouse_code, warehouse_name,
              dock_door_id, dock_door_code, dock_door_name,
              process_stage, create_date, update_date
            )
            VALUES (
              @nextId, @poNo, @customerCode, @customerName,
              @quantity, @quantityUom, @shipToCode, @shipToName,
              @warehouseId, @warehouseCode, @warehouseName,
              @dockDoorId, @dockDoorCode, @dockDoorName,
              CASE
                WHEN (@customerName IS NULL OR LTRIM(RTRIM(@customerName)) = '')
                  OR (@quantity IS NULL OR @quantity <= 0)
                  OR (@warehouseName IS NULL OR LTRIM(RTRIM(@warehouseName)) = '') THEN 'PO_INCOMPLETE'
                ELSE 'CAR_REGISTER'
              END,
              GETDATE(), GETDATE()
            );

            SELECT @nextId AS final_received_id, 1 AS is_created;
          END
          ELSE
          BEGIN
            INSERT INTO ${TABLES.RECEIVED} (
              PO_No, customer_code, customer_Name,
              quantity, quantity_uom, ship_to_code, ship_to_name,
              warehouse_id, warehouse_code, warehouse_name,
              dock_door_id, dock_door_code, dock_door_name,
              process_stage, create_date, update_date
            )
            OUTPUT INSERTED.received_id AS final_received_id, 1 AS is_created
            VALUES (
              @poNo, @customerCode, @customerName,
              @quantity, @quantityUom, @shipToCode, @shipToName,
              @warehouseId, @warehouseCode, @warehouseName,
              @dockDoorId, @dockDoorCode, @dockDoorName,
              CASE
                WHEN (@customerName IS NULL OR LTRIM(RTRIM(@customerName)) = '')
                  OR (@quantity IS NULL OR @quantity <= 0)
                  OR (@warehouseName IS NULL OR LTRIM(RTRIM(@warehouseName)) = '') THEN 'PO_INCOMPLETE'
                ELSE 'CAR_REGISTER'
              END,
              GETDATE(), GETDATE()
            );
          END
        END
      END
    `);

  if (saveResult && saveResult.recordset && saveResult.recordset.length > 0 && Number(saveResult.recordset[0].final_received_id) === -1) {
    return { duplicate: true };
  }

  let confirmedReceivedId = targetReceivedId;
  if (saveResult && saveResult.recordset && saveResult.recordset.length > 0 && saveResult.recordset[0].final_received_id) {
    confirmedReceivedId = saveResult.recordset[0].final_received_id;
  }
  const created = Boolean(Number(saveResult?.recordset?.[0]?.is_created));
  return { receivedId: confirmedReceivedId, created, customerCode: finalCustCode, customerName: finalCustName, warehouseCode: finalWhCode, warehouseName: finalWhName };
}

function createSaveOfficePoHandler(io) {
  return async function saveOfficePo(req, res) {
    const { poNo } = req.body;

    if (!poNo || !String(poNo).trim()) {
      return res.status(400).json({ success: false, error: 'ไม่พบหมายเลข PO' });
    }

    try {
      const pool = await getPool();
      const saved = await upsertOfficePo(() => pool.request(), req.body);
      if (saved.duplicate) {
        return res.status(400).json({ success: false, error: `หมายเลข PO ${poNo} มีอยู่ในระบบแล้ว (รายการซ้ำ)` });
      }
      const confirmedReceivedId = saved.receivedId;
      const finalCustCode = saved.customerCode;
      const finalCustName = saved.customerName;
      const finalWhCode = saved.warehouseCode;
      const finalWhName = saved.warehouseName;

      if (req.body.is_urgent !== undefined || req.body.isUrgent !== undefined) {
        try {
          const hasUrgentCol = await pool.request().query(`
            SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('${TABLES.RECEIVED}') AND (name = 'is_urgent' OR name = 'isUrgent')
          `);
          if (hasUrgentCol.recordset.length > 0) {
            const urgentBit = (req.body.is_urgent || req.body.isUrgent) ? 1 : 0;
            await pool.request()
              .input('recId', sql.Int, confirmedReceivedId)
              .input('po', sql.NVarChar(50), String(poNo).trim())
              .input('urg', sql.Bit, urgentBit)
              .query(`UPDATE ${TABLES.RECEIVED} SET is_urgent = @urg WHERE received_id = @recId OR PO_No = @po`);
          }
        } catch (urgErr) {
          logger.warn('[Urgent update warning]:', urgErr.message);
        }
      }

      logger.debug(`[API POST /api/office-save] บันทึกสำเร็จ PO: ${poNo}, ID: ${confirmedReceivedId}, customer: [${finalCustCode}] ${finalCustName}, warehouse: [${finalWhCode}] ${finalWhName}`);

      if (io) {
        try {
          emitPoUpdated(io, req, { poNo, type: 'office-save', isNew: saved.created });
          broadcastDashboardUpdate(io);
        } catch (sockErr) {
          logger.warn('[Socket emit warning]:', sockErr.message);
        }
      }
      res.json({ success: true, message: 'บันทึกข้อมูลออฟฟิศเรียบร้อย', receivedId: confirmedReceivedId });
    } catch (err) {
      logger.error('Error in /api/office-save:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  };
}

const IMPORT_MAX_ITEMS = 2000;
const IMPORT_REQUIRED = [
  ['customer', (it) => Boolean(String(it.customerName || it.customerCode || '').trim()), 'ชื่อลูกค้า'],
  ['quantity', (it) => Number(it.quantityOrder) > 0, 'จำนวน (มากกว่า 0)'],
  ['uom', (it) => Boolean(String(it.quantityUom || '').trim()), 'หน่วย (UOM)'],
  ['shipDate', (it) => /^\d{4}-\d{2}-\d{2}$/.test(String(it.shipDatePlan || '').trim()), 'วันที่ส่ง'],
  ['warehouse', (it) => Boolean(String(it.warehouseName || it.warehouseCode || '').trim()), 'คลังสินค้า'],
  ['shipTo', (it) => Boolean(String(it.shipToName || it.toLocation || '').trim()), 'สถานที่ส่ง'],
];

function validateImportItems(items) {
  const errors = [];
  const seen = new Map();
  items.forEach((it, index) => {
    const item = it && typeof it === 'object' ? it : {};
    const poNo = String(item.poNo || '').trim();
    const rows = Array.isArray(item.rows) ? item.rows.filter((n) => Number.isInteger(n)) : [];
    const problems = [];
    if (!poNo) problems.push('ไม่ได้กรอกหมายเลข PO');
    const missing = IMPORT_REQUIRED.filter(([, ok]) => !ok(item)).map(([, , label]) => label);
    if (missing.length) problems.push(`ไม่ได้กรอก ${missing.join(', ')}`);
    if (poNo) {
      const key = poNo.toLowerCase();
      if (seen.has(key)) problems.push(`หมายเลข PO ซ้ำกับรายการที่ ${seen.get(key) + 1} ในไฟล์`);
      else seen.set(key, index);
    }
    if (problems.length) errors.push({ index, poNo, rows, problems });
  });
  return errors;
}

function createImportOfficePoHandler(io) {
  return async function importOfficePo(req, res) {
    const items = req.body && req.body.items;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, code: 'NO_ITEMS', error: 'ไม่พบรายการ PO ที่จะนำเข้า' });
    }
    if (items.length > IMPORT_MAX_ITEMS) {
      return res.status(400).json({ success: false, code: 'TOO_MANY_ITEMS', error: `นำเข้าได้ครั้งละไม่เกิน ${IMPORT_MAX_ITEMS} รายการ` });
    }

    const invalid = validateImportItems(items);
    if (invalid.length) {
      return res.status(400).json({ success: false, code: 'IMPORT_INVALID', error: 'ข้อมูลในไฟล์ไม่ครบหรือไม่ถูกต้อง ไม่ได้บันทึกรายการใดเลย', errors: invalid });
    }

    let pool;
    let tx;
    let current = null;
    try {
      pool = await getPool();
      tx = new sql.Transaction(pool);
      await tx.begin();
      const duplicates = [];
      const saved = [];
      for (let index = 0; index < items.length; index++) {
        const item = items[index];
        current = { index, poNo: String(item.poNo).trim(), rows: Array.isArray(item.rows) ? item.rows : [] };
        const result = await upsertOfficePo(() => new sql.Request(tx), {
          ...item,
          receivedId: null,
          id: null,
          dockDoorId: null,
          dockDoorCode: null,
          dockDoorName: null,
          dockDoor: null,
          rescheduleDate: null,
          rescheduleTime: null,
          rescheduleReason: null,
        });
        if (result.duplicate) {
          duplicates.push({ ...current, problems: ['หมายเลข PO มีอยู่ในระบบแล้ว (รายการซ้ำ)'] });
        } else {
          saved.push({ poNo: current.poNo, receivedId: result.receivedId });
        }
      }
      current = null;

      if (duplicates.length) {
        await tx.rollback();
        return res.status(409).json({ success: false, code: 'IMPORT_DUPLICATE', error: 'มีหมายเลข PO ที่อยู่ในระบบแล้ว ไม่ได้บันทึกรายการใดเลย', errors: duplicates });
      }

      await tx.commit();
      logger.debug(`[API POST /api/office-import] นำเข้าสำเร็จ ${saved.length} รายการ`);
      if (io) {
        try {
          emitPoUpdated(io, req, { poNos: saved.map((x) => x.poNo), type: 'office-import', isNew: true });
          broadcastDashboardUpdate(io);
        } catch (sockErr) {
          logger.warn('[Socket emit warning]:', sockErr.message);
        }
      }
      return res.json({ success: true, message: `นำเข้าข้อมูลเรียบร้อย ${saved.length} รายการ`, imported: saved.length, items: saved });
    } catch (err) {
      logger.error('Error in /api/office-import:', err);
      if (tx) {
        try { await tx.rollback(); } catch (_rollbackErr) {}
      }
      const errors = current ? [{ ...current, problems: ['บันทึกลงฐานข้อมูลไม่สำเร็จ'] }] : [];
      return res.status(500).json({ success: false, code: 'IMPORT_FAILED', error: 'บันทึกลงฐานข้อมูลไม่สำเร็จ ไม่ได้บันทึกรายการใดเลย', errors });
    }
  };
}

function createAssignDockHandler(io) {
  return async function assignDockDoor(req, res) {
    const { poNo, dockDoorId, dockDoorCode, dockDoorName } = req.body;
    try {
      const pool = await getPool();

      let finalDoorId = safeInt(dockDoorId);
      let finalDoorCode = dockDoorCode || '';
      let finalDoorName = dockDoorName || '';

      if (finalDoorCode && (!finalDoorId || !finalDoorName)) {
        const dLookup = await pool.request()
          .input('ddcode', sql.NVarChar(50), finalDoorCode)
          .query(`SELECT dock_door_id, dock_door_name FROM ${TABLES.DOCK_DOOR} WHERE dock_door_code = @ddcode`);
        if (dLookup.recordset.length > 0) {
          finalDoorId = finalDoorId || dLookup.recordset[0].dock_door_id;
          finalDoorName = finalDoorName || dLookup.recordset[0].dock_door_name;
        }
      }

      const assignResult = await pool.request()
        .input('poNo', sql.NVarChar(50), String(poNo))
        .input('dockDoorId', sql.Int, finalDoorId)
        .input('dockDoorCode', sql.NVarChar(50), finalDoorCode)
        .input('dockDoorName', sql.NVarChar(100), finalDoorName)
        .query(`
          UPDATE ${TABLES.RECEIVED}
          SET
            dock_door_id = @dockDoorId,
            dock_door_code = @dockDoorCode,
            dock_door_name = @dockDoorName,
            process_stage = 'ISSUE_TICKET',
            update_date = GETDATE()
          WHERE PO_No = @poNo AND ISNULL(process_stage, '') NOT IN ('CANCLE', 'CANCEL')
        `);

      if (lastAffected(assignResult) === 0) return poNotFound(res, NOT_FOUND_OR_CANCELLED(poNo));

      logger.debug(`[API POST /api/assign-dock] บันทึกประตูสำเร็จ PO: ${poNo}, Door: ${finalDoorCode} (id: ${finalDoorId})`);

      if (io) {
        io.emit('dock-doors-updated', { poNo, dockDoorCode: finalDoorCode });
        emitPoUpdated(io, req, { poNo, type: 'assign-dock' });
        broadcastDashboardUpdate(io);
      }
      res.json({ success: true, message: 'จองประตูโหลดสินค้าเรียบร้อย' });
    } catch (err) {
      logger.error('Error in /api/assign-dock:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  };
}

function createIssueTicketHandler(io) {
  return async function issueTicket(req, res) {
    const { poNo } = req.body;
    try {
      const pool = await getPool();
      const ticketResult = await pool.request()
        .input('poNo', sql.NVarChar(50), String(poNo))
        .query(`
          UPDATE ${TABLES.RECEIVED}
          SET
            ticket_date = GETDATE(),
            process_stage = 'ADMIN_OUTSIDE',
            update_date = GETDATE()
          WHERE PO_No = @poNo AND ISNULL(process_stage, '') NOT IN ('CANCLE', 'CANCEL')
        `);

      if (lastAffected(ticketResult) === 0) return poNotFound(res, NOT_FOUND_OR_CANCELLED(poNo));

      logger.debug(`[API POST /api/issue-ticket] ออกตั๋วสำเร็จ PO: ${poNo}`);

      if (io) {
        emitPoUpdated(io, req, { poNo, type: 'issue-ticket' });
        broadcastDashboardUpdate(io);
      }
      res.json({ success: true, message: 'ออกตั๋วโหลดสินค้าเรียบร้อย' });
    } catch (err) {
      logger.error('Error in /api/issue-ticket:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  };
}

function createSendLcTicketHandler(io) {
  return async function sendLcTicket(req, res) {
    const { poNos, poNo } = req.body;
    const list = Array.isArray(poNos) && poNos.length > 0 ? poNos : (poNo ? [poNo] : []);

    if (list.length === 0) {
      return res.status(400).json({ success: false, error: 'ไม่พบหมายเลข PO สำหรับLC ส่งตั๋ว' });
    }

    try {
      const pool = await getPool();
      let sentCount = 0;
      const notFound = [];
      for (const p of list) {
        const r = await pool.request()
          .input('poNo', sql.NVarChar(50), String(p))
          .query(`
            UPDATE ${TABLES.RECEIVED}
            SET
              order_date = COALESCE(order_date, GETDATE()),
              update_date = GETDATE()
            WHERE PO_No = @poNo AND ISNULL(process_stage, '') NOT IN ('CANCLE', 'CANCEL')
          `);
        if (lastAffected(r) > 0) sentCount += 1; else notFound.push(p);
      }

      if (sentCount === 0) {
        return poNotFound(res, 'ไม่พบรายการ PO ที่จะบันทึกเวลาLC ส่งตั๋ว หรือรายการถูกยกเลิกแล้ว', { notFound });
      }

      logger.debug(`[API POST /api/send-lc-ticket] LC ส่งตั๋ว สำเร็จ: ${list.join(', ')}`);

      if (io) {
        emitPoUpdated(io, req, { poNos: list, type: 'send-lc-ticket' });
        broadcastDashboardUpdate(io);
      }
      res.json({ success: true, message: `LC ส่งตั๋ว เรียบร้อยแล้ว ${sentCount} รายการ`, updated: sentCount, notFound });
    } catch (err) {
      logger.error('Error in /api/send-lc-ticket:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  };
}

function createOutsideTaskHandler(io) {
  return async function saveOutsideTask(req, res) {
    const {
      receivedId,
      id,
      poNo,
      customerCode,
      customerName,
      quantityOrder,
      quantityUom,
      shipToName,
      toLocation,
      truckTypeId,
      truckType,
      licensePlate,
      driverName,
      driverTel,
      registerDate,
      registerTime,
      taskTimestamps,
      dockDoor,
      dockDoorId,
      dockDoorCode,
      dockDoorName,
      warehouseId,
      warehouseCode,
      warehouseName,
      truckDeparture
    } = req.body;

    try {
      const pool = await getPool();
      const reqUpdate = pool.request()
        .input('receivedId', sql.Int, safeInt(receivedId || id))
        .input('poNo', sql.NVarChar(50), String(poNo));

      let setClauses = ['update_date = GETDATE()'];

      if (customerCode && customerCode !== '-') {
        reqUpdate.input('customerCode', sql.NVarChar(50), String(customerCode));
        setClauses.push('customer_code = @customerCode');
      }

      if (customerName && customerName !== '-') {
        reqUpdate.input('customerName', sql.NVarChar(255), String(customerName));
        setClauses.push('customer_Name = @customerName');
      }

      const safeWhId = safeInt(warehouseId);
      if (safeWhId) {
        reqUpdate.input('warehouseId', sql.Int, safeWhId);
        setClauses.push('warehouse_id = @warehouseId');
      }

      if (warehouseCode && warehouseCode !== '-') {
        reqUpdate.input('warehouseCode', sql.NVarChar(50), String(warehouseCode));
        setClauses.push('warehouse_code = @warehouseCode');
      }

      if (warehouseName && warehouseName !== '-') {
        reqUpdate.input('warehouseName', sql.NVarChar(255), String(warehouseName));
        setClauses.push('warehouse_name = @warehouseName');
      }

      const effectiveShipToName = shipToName || toLocation;
      if (effectiveShipToName && effectiveShipToName !== '-') {
        reqUpdate.input('shipToName', sql.NVarChar(255), String(effectiveShipToName));
        setClauses.push('ship_to_name = @shipToName');
      }

      if (quantityOrder && quantityOrder !== '-') {
        const cleanQtyStr = String(quantityOrder).replace(/[^0-9.]/g, '');
        const qtyVal = cleanQtyStr ? parseFloat(cleanQtyStr) : null;
        if (qtyVal !== null) {
          reqUpdate.input('quantity', sql.Decimal(18, 2), qtyVal);
          setClauses.push('quantity = @quantity');
        }
      }

      if (quantityUom && quantityUom !== '-') {
        reqUpdate.input('quantityUom', sql.NVarChar(20), normalizeUom(quantityUom));
        setClauses.push('quantity_uom = @quantityUom');
      }

      const resolvedTruck = await resolveTruckFromDb(pool, truckTypeId, truckType);
      const finalTruckTypeId = resolvedTruck.truckTypeId;
      const finalTruckType = resolvedTruck.truckType;

      if (finalTruckTypeId !== null) {
        reqUpdate.input('truckTypeId', sql.Int, safeInt(finalTruckTypeId));
        setClauses.push('truck_type_id = @truckTypeId');
      }

      if (finalTruckType) {
        reqUpdate.input('truckType', sql.NVarChar(100), finalTruckType);
        setClauses.push('truck_type = @truckType');
      }

      if (licensePlate && licensePlate !== '-') {
        reqUpdate.input('license', sql.NVarChar(50), String(licensePlate));
        setClauses.push('license = @license');
      }

      if (driverName && driverName !== '-') {
        reqUpdate.input('driverName', sql.NVarChar(100), String(driverName));
        setClauses.push('driver_name = @driverName');
      }

      if (driverTel && driverTel !== '-') {
        reqUpdate.input('driverTel', sql.NVarChar(20), String(driverTel).trim());
        setClauses.push('driver_tel = @driverTel');
      }

      if (registerDate && registerDate !== '-') {
        const regDateTimeStr = formatSqlDateTimeStr(registerDate, registerTime);
        if (regDateTimeStr) {
          reqUpdate.input('regDateStr', sql.VarChar(30), regDateTimeStr);
          setClauses.push('register_date = CONVERT(datetime, @regDateStr, 120)');
        }
      }

      const effectiveDockDoor = dockDoorCode || dockDoor;
      const safeDoorId = safeInt(dockDoorId);
      if (safeDoorId) {
        reqUpdate.input('dockDoorId', sql.Int, safeDoorId);
        setClauses.push('dock_door_id = @dockDoorId');
      }
      if (effectiveDockDoor && effectiveDockDoor !== '-') {
        reqUpdate.input('dockDoorCode', sql.NVarChar(50), String(effectiveDockDoor));
        setClauses.push('dock_door_code = @dockDoorCode');
      }
      if (dockDoorName && dockDoorName !== '-') {
        reqUpdate.input('dockDoorName', sql.NVarChar(100), String(dockDoorName));
        setClauses.push('dock_door_name = @dockDoorName');
      }

      const ts = taskTimestamps || {};
      const pStart = ts.pickStart || req.body.pickStart;
      const pFinish = ts.pickFinish || req.body.pickFinish || req.body.pickEnd;
      const lStart = ts.loadStart || req.body.loadStart;
      const lFinish = ts.loadFinish || req.body.loadFinish;
      const effectiveTruckDeparture = (typeof truckDeparture !== 'undefined' ? truckDeparture : null) ||
        (ts.truckDeparture ? ts.truckDeparture : req.body.truckDeparture || null);

      if (pStart) {
        const dStr = formatSqlDateTimeStr(pStart);
        if (dStr) {
          setClauses.push('pick_start_date_time = COALESCE(pick_start_date_time, GETDATE())');
        }
      }
      if (pFinish) {
        const dStr = formatSqlDateTimeStr(pFinish);
        if (dStr) {
          setClauses.push('pick_finish_date_time = COALESCE(pick_finish_date_time, GETDATE())');
        }
      }
      if (lStart) {
        const dStr = formatSqlDateTimeStr(lStart);
        if (dStr) {
          setClauses.push('load_start_date_time = COALESCE(load_start_date_time, GETDATE())');
        }
      }
      if (lFinish) {
        const dStr = formatSqlDateTimeStr(lFinish);
        if (dStr) {
          setClauses.push('load_finish_date_time = COALESCE(load_finish_date_time, GETDATE())');
          if (!effectiveTruckDeparture) {
            setClauses.push("process_stage = 'WAITING_DEPARTURE'");
          }
        }
      }
      if (effectiveTruckDeparture) {
        const dStr = formatSqlDateTimeStr(effectiveTruckDeparture);
        if (dStr) {
          setClauses.push('truck_departure = COALESCE(truck_departure, GETDATE())');
          setClauses.push("process_stage = 'COMPLETED'");
        }
      }

      const taskResult = await reqUpdate.query(`
        UPDATE ${TABLES.RECEIVED}
        SET ${setClauses.join(', ')} 
        WHERE (@receivedId IS NOT NULL AND received_id = @receivedId)
           OR (PO_No = @poNo AND ISNULL(process_stage, '') NOT IN ('CANCLE', 'CANCEL'))
           OR (LTRIM(RTRIM(REPLACE(PO_No, 'PO', ''))) = LTRIM(RTRIM(REPLACE(@poNo, 'PO', ''))) AND ISNULL(process_stage, '') NOT IN ('CANCLE', 'CANCEL'))
      `);

      if (lastAffected(taskResult) === 0) return poNotFound(res, NOT_FOUND_OR_CANCELLED(poNo));

      if (effectiveTruckDeparture) {
        await pool.request()
          .input('poNoForDoor', sql.NVarChar(50), String(poNo))
          .query(`
            UPDATE d
            SET d.is_active = 0, d.update_date = GETDATE()
            FROM ${TABLES.DOCK_DOOR} d
            INNER JOIN ${TABLES.RECEIVED} r ON (d.dock_door_id = r.dock_door_id OR d.dock_door_code = r.dock_door_code)
            WHERE r.PO_No = @poNoForDoor OR LTRIM(RTRIM(REPLACE(r.PO_No, 'PO', ''))) = LTRIM(RTRIM(REPLACE(@poNoForDoor, 'PO', '')))
          `);
        logger.debug(`[API POST /api/outside-task] ปลดล็อคประตูโหลดสำหรับ PO ${poNo} กลับเป็น 0 (ว่าง) เรียบร้อย`);
        if (io) {
          io.emit('dock-doors-updated', { poNo });
        }
      }

      if (io) {
        io.emit('dock-doors-updated', { poNo });
        emitPoUpdated(io, req, { poNo, type: 'outside-task' });
        broadcastDashboardUpdate(io);
      }
      res.json({ success: true, message: 'บันทึกสถานะการโหลดเรียบร้อย' });
    } catch (err) {
      logger.error('Error in /api/outside-task:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  };
}

function createSetUrgentPoHandler(io) {
  return async function setUrgent(req, res) {
    const { receivedIds, poNos, isUrgent } = req.body;
    const idList = Array.isArray(receivedIds) ? receivedIds.filter(Boolean) : (receivedIds ? [receivedIds] : []);
    const poList = Array.isArray(poNos) ? poNos.filter(Boolean) : (poNos ? [poNos] : []);

    if (idList.length === 0 && poList.length === 0) {
      return res.status(400).json({ success: false, error: 'ไม่พบรายการ received_id หรือหมายเลข PO' });
    }

    try {
      const pool = await getPool();
      const hasUrgentCol = await pool.request().query(`
        SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID('${TABLES.RECEIVED}') AND (name = 'is_urgent' OR name = 'isUrgent')
      `);

      if (hasUrgentCol.recordset.length === 0) {
        return res.status(503).json({ success: false, code: 'URGENT_NOT_SUPPORTED', error: 'ฐานข้อมูลยังไม่มีคอลัมน์ is_urgent จึงบันทึกส่งด่วนไม่ได้' });
      }
      let urgentCount = 0;
      {
        const urgentBit = Boolean(isUrgent) ? 1 : 0;
        if (idList.length > 0) {
          for (const recId of idList) {
            await pool.request()
              .input('recId', sql.Int, Number(recId))
              .input('urg', sql.Bit, urgentBit)
              .query(`UPDATE ${TABLES.RECEIVED} SET is_urgent = @urg WHERE received_id = @recId`)
              .then((r) => { urgentCount += lastAffected(r); });
          }
        } else {
          for (const po of poList) {
            await pool.request()
              .input('po', sql.NVarChar(50), String(po).trim())
              .input('urg', sql.Bit, urgentBit)
              .query(`UPDATE ${TABLES.RECEIVED} SET is_urgent = @urg WHERE PO_No = @po OR LTRIM(RTRIM(REPLACE(PO_No, 'PO', ''))) = LTRIM(RTRIM(REPLACE(@po, 'PO', '')))`)
              .then((r) => { urgentCount += lastAffected(r); });
          }
        }
      }

      if (urgentCount === 0) return poNotFound(res, 'ไม่พบรายการ PO ที่จะตั้งค่าส่งด่วน');

      if (io) {
        emitPoUpdated(io, req, { receivedIds: idList, poNos: poList, type: 'urgent-updated' });
        broadcastDashboardUpdate(io);
      }
      res.json({ success: true, updated: urgentCount });
    } catch (err) {
      logger.error('Error in /api/set-urgent:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  };
}

module.exports = {
  getPos,
  createRegisterCarHandler,
  createTruckArrivalHandler,
  createTruckDepartureHandler,
  createCancelPoHandler,
  createReschedulePoHandler,
  createSaveOfficePoHandler,
  createImportOfficePoHandler,
  validateImportItems,
  createAssignDockHandler,
  createIssueTicketHandler,
  createSendLcTicketHandler,
  createOutsideTaskHandler,
  createSetUrgentPoHandler,
};
