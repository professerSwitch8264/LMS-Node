const { logger } = require('../utils/logger');
const { parseTableQuery, queryPoTable } = require('../services/poTableService');
const { sql, getPool } = require('../config/db');
const { TABLES } = require('../config/constants');
const { formatSqlDateTimeStr, formatLocalIso } = require('../utils/dateHelper');
const { broadcastDashboardUpdate } = require('../services/dashboardService');
const lookups = require('../config/lookupSchema');

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

// ---------------------------------------------------------------------------
// ตาราง: PO (หัวเอกสาร) + PO_Transaction (รอบรถ แผนรถเข้า → รถออก) — ดู config/poSchema.js
// รอบปัจจุบันของ PO = PO_Transaction.is_current = 1 (มีแถวเดียว) เลื่อนแผน = ปิดรอบเดิม + เปิดรอบใหม่
// ---------------------------------------------------------------------------
const PO_T = TABLES.PO;
const TX_T = TABLES.PO_TRANSACTION;

// คอลัมน์ที่ใช้แปลงเป็น object ของหน้าเว็บ — ใช้ได้ทั้ง V_PO_Current และ V_PO_Round (alias r)
const PO_SELECT_COLUMNS = `
  r.received_id, r.po_id,
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
  r.ship_to_name,
  r.warehouse_code, r.warehouse_name,
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
  r.cancle_reason,
  r.is_urgent,
  r.po_transaction_id, r.round_no, r.is_current, r.tx_status,
  CONVERT(varchar(19), r.tx_create_date, 120) as tx_create_date_str,
  r.rescheduled_from_id, r.reschedule_reason, r.rescheduled_by,
  CONVERT(varchar(19), r.rescheduled_at, 120) as rescheduled_at_str,
  r.create_date,
  CONVERT(varchar(19), r.create_date, 120) as create_date_str,
  r.update_date,
  CONVERT(varchar(19), r.update_date, 120) as update_date_str
`;

const PO_SELECT_JOINS = `
  LEFT JOIN ${TABLES.CUSTOMER} c ON (
    (r.customer_code IS NOT NULL AND r.customer_code = c.customer_code)
    OR (r.customer_code IS NULL AND r.customer_Name IS NOT NULL AND r.customer_Name = c.customer_name)
  )
  LEFT JOIN ${TABLES.TRUCK} t ON (
    (r.truck_type_id IS NOT NULL AND r.truck_type_id = t.truck_type_id)
    OR (r.truck_type_id IS NULL AND r.truck_type IS NOT NULL AND r.truck_type = t.truck_type)
  )
`;

function mapPoRow(row) {
  const regIso = formatLocalIso(row.register_str, row.register_date);
  const ticketIso = formatLocalIso(row.ticket_str, row.ticket_date);
  const truckArrivalIso = formatLocalIso(row.truck_arrival_str, row.truck_arrival);
  const truckDepartureIso = formatLocalIso(row.truck_departure_str, row.truck_departure);
  const orderIso = formatLocalIso(row.order_str, row.order_date);
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

  let dynamicStage = row.process_stage || 'WAIT_PO_DATA';
  if (dynamicStage === 'CANCELLED' || dynamicStage === 'CANCEL') {
    dynamicStage = 'CANCELLED';
  } else if (truckDepartureIso || dynamicStage === 'COMPLETED') {
    dynamicStage = 'COMPLETED';
  } else if (loadFinishIso || dynamicStage === 'WAIT_DEPARTURE') {
    dynamicStage = 'WAIT_DEPARTURE';
  } else if (loadStartIso || pickStartIso) {
    dynamicStage = 'WAIT_LOADING';
  } else if (ticketIso) {
    dynamicStage = 'WAIT_TICKET';
  } else if (!hasRealTruck && (!row.customer_Name || !row.quantity || !row.ship_to_name)) {
    dynamicStage = 'WAIT_PO_DATA';
  } else if (!hasRealTruck) {
    dynamicStage = 'WAIT_CAR_PLAN';
  } else if (!row.dock_door_code && !row.dock_door_id) {
    dynamicStage = 'WAIT_DOCK';
  } else if (!row.truck_arrival && !truckArrivalIso) {
    dynamicStage = 'WAIT_DOCK';
  } else {
    dynamicStage = 'WAIT_TICKET';
  }

  const qVal = row.quantity ? parseFloat(row.quantity) : null;
  const finalTruckTypeId = row.truck_type_id !== null && row.truck_type_id !== undefined
    ? Number(row.truck_type_id)
    : (row.matched_truck_type_id !== null && row.matched_truck_type_id !== undefined ? Number(row.matched_truck_type_id) : null);
  const finalTruckType = row.truck_type || row.matched_truck_type || '';
  const roundNo = Number(row.round_no) || 1;

  return {
    id: row.received_id,
    receivedId: row.received_id,
    poId: row.po_id,
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
    shipToName: row.ship_to_name || '',
    shipToCustomer: row.ship_to_name || '',
    toLocation: row.ship_to_name || '',
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
    // รอบรถ (PO_Transaction): รอบที่ 2 ขึ้นไป = เกิดจากการเลื่อนแผน วันเวลาใหม่อยู่ใน registerDate
    transactionId: row.po_transaction_id ?? null,
    roundNo,
    isCurrentRound: row.is_current === undefined || row.is_current === null ? true : Boolean(row.is_current),
    roundStatus: row.tx_status || null,
    roundCreateDate: formatLocalIso(row.tx_create_date_str, null),
    isRescheduled: Boolean(row.rescheduled_from_id),
    rescheduleCount: Math.max(0, roundNo - 1),
    rescheduleReason: row.reschedule_reason || null,
    rescheduledBy: row.rescheduled_by || null,
    rescheduledAt: formatLocalIso(row.rescheduled_at_str, null),
    cancelReason: row.cancle_reason || null,
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
}

// อ่าน PO ทั้งหมด (รอบปัจจุบัน) แล้วแปลงเป็นรูปแบบที่หน้าเว็บใช้ (ใช้ทั้ง GET /pos และ GET /pos/table)
async function loadAllPos(pool) {
  const result = await pool.request().query(`
    SELECT ${PO_SELECT_COLUMNS}
    FROM ${TABLES.PO_CURRENT_VIEW} r
    ${PO_SELECT_JOINS}
    ORDER BY COALESCE(r.create_date, r.order_date, r.register_date) DESC, r.PO_No DESC
  `);
  return result.recordset.map(mapPoRow);
}

const MAX_ROUND_PO_IDS = 20000;

// ทุกรอบของ PO ที่ระบุ — เรียงตามวันที่สร้าง PO แล้วตามรอบ (รอบของ PO เดียวกันอยู่ติดกัน)
async function loadPoRounds(pool, poIds) {
  const ids = [...new Set((poIds || []).map(safeInt).filter((n) => n && n > 0))].slice(0, MAX_ROUND_PO_IDS);
  if (ids.length === 0) return [];
  const result = await pool.request()
    .input('ids', sql.NVarChar(sql.MAX), ids.join(','))
    .query(`
      SELECT ${PO_SELECT_COLUMNS}
      FROM ${TABLES.PO_ROUND_VIEW} r
      ${PO_SELECT_JOINS}
      WHERE r.po_id IN (SELECT TRY_CAST(value AS INT) FROM STRING_SPLIT(@ids, ','))
      ORDER BY r.create_date ASC, r.po_id ASC, r.round_no ASC
    `);
  return result.recordset.map(mapPoRow);
}

// GET /api/pos/table — ตาราง PO: ค้นหา / กรอง / เรียง / แบ่งหน้าที่ server (ดู services/poTableService.js)
async function getPoTable(req, res) {
  try {
    const pool = await getPool();
    const pos = await loadAllPos(pool);
    const effective = req.user?.effective || {};
    const viewer = {
      role: req.user?.roleId,
      permissions: { ...(effective.perms || {}), isAdminSystem: Boolean(effective.isAdminSystem) },
    };
    const result = queryPoTable(pos, parseTableQuery(req.query), viewer);
    res.json({ success: true, data: result.rows, total: result.total, page: result.page, pageSize: result.pageSize, totalPages: result.totalPages, options: result.options });
  } catch (err) {
    logger.error('Error in /api/pos/table:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
}

async function getPos(req, res) {
  try {
    const pool = await getPool();
    const pos = await loadAllPos(pool);
    res.json({ success: true, data: pos });
  } catch (err) {
    logger.error('Error in /api/pos:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
}

// POST /api/pos/rounds { poIds: [...] } — ทุกรอบ (รวมรอบที่ถูกเลื่อน) ใช้แสดงประวัติและออก Excel
async function getPoRounds(req, res) {
  const poIds = Array.isArray(req.body?.poIds) ? req.body.poIds : [];
  if (poIds.length === 0) return res.status(400).json({ success: false, error: 'ไม่พบรายการ PO' });
  if (poIds.length > MAX_ROUND_PO_IDS) {
    return res.status(400).json({ success: false, error: `ขอข้อมูลได้ครั้งละไม่เกิน ${MAX_ROUND_PO_IDS} รายการ` });
  }
  try {
    const pool = await getPool();
    const rows = await loadPoRounds(pool, poIds);
    res.json({ success: true, data: rows });
  } catch (err) {
    logger.error('Error in /api/pos/rounds:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
}

const lastAffected = (result) => {
  const r = result && result.rowsAffected;
  return Array.isArray(r) && r.length ? Number(r[r.length - 1]) || 0 : 0;
};
const poNotFound = (res, error, extra = {}) => res.status(404).json({ success: false, code: 'PO_NOT_FOUND', error, ...extra });
const NOT_FOUND_OR_CANCELLED = (poNo) => `ไม่พบ PO ${poNo} หรือรายการถูกยกเลิกแล้ว`;

// เทียบเลข PO แบบเดิม (ไม่สนคำนำหน้า "PO")
const looseMatch = (col, param) => `LTRIM(RTRIM(REPLACE(${col}, 'PO', ''))) = LTRIM(RTRIM(REPLACE(${param}, 'PO', '')))`;

/**
 * หา PO + รอบปัจจุบัน
 * - poId มาก่อน (ถ้าส่งมา) ไม่งั้นใช้เลข PO (เอาใบที่ยังไม่ยกเลิก ล่าสุด)
 * - loose: เทียบเลข PO โดยไม่สนคำนำหน้า "PO"
 * - includeCancelled: รวม PO ที่ยกเลิกแล้ว (ค่าเริ่มต้น: ไม่รวม)
 * - lock: ล็อกแถว (ใช้ใน DB transaction)
 * ถ้า PO ยังไม่มีรอบปัจจุบัน (ข้อมูลผิดปกติ) จะสร้างรอบใหม่ให้
 */
async function findPo(newRequest, { poId = null, poNo = null, loose = false, includeCancelled = false, lock = false } = {}) {
  const hint = lock ? 'WITH (UPDLOCK, HOLDLOCK)' : '';
  const poNoCond = loose ? `(p.PO_No = @poNo OR ${looseMatch('p.PO_No', '@poNo')})` : 'p.PO_No = @poNo';
  const result = await newRequest()
    .input('poId', sql.Int, safeInt(poId))
    .input('poNo', sql.NVarChar(50), poNo !== null && poNo !== undefined ? String(poNo).trim() : null)
    .query(`
      SELECT TOP 1
        p.po_id, p.PO_No, p.po_status,
        x.po_transaction_id, x.round_no, x.tx_status, x.rescheduled_from_id,
        x.truck_type_id, x.truck_type, x.license, x.driver_name, x.driver_tel,
        x.register_date, CONVERT(varchar(19), x.register_date, 120) AS register_str,
        x.dock_door_id, x.dock_door_code, x.dock_door_name,
        x.truck_arrival, x.truck_departure, x.process_stage
      FROM ${PO_T} p ${hint}
      LEFT JOIN ${TX_T} x ${hint} ON x.po_id = p.po_id AND x.is_current = 1
      WHERE ((@poId IS NOT NULL AND p.po_id = @poId) OR (@poId IS NULL AND ${poNoCond}))
        ${includeCancelled ? '' : "AND p.po_status <> 'CANCELLED'"}
      ORDER BY CASE WHEN p.po_status = 'CANCELLED' THEN 1 ELSE 0 END, p.po_id DESC
    `);
  const row = result.recordset[0];
  if (!row) return null;
  if (!row.po_transaction_id) {
    const created = await newRequest()
      .input('poId', sql.Int, row.po_id)
      .query(`
        INSERT INTO ${TX_T} (po_id, round_no, is_current, tx_status, process_stage)
        OUTPUT INSERTED.po_transaction_id, INSERTED.round_no
        VALUES (@poId, 1, 1, 'ACTIVE', 'WAIT_CAR_PLAN')
      `);
    row.po_transaction_id = created.recordset[0].po_transaction_id;
    row.round_no = created.recordset[0].round_no;
    row.tx_status = 'ACTIVE';
  }
  return row;
}

const filled = (v) => Boolean(v !== null && v !== undefined && String(v).trim() && String(v).trim() !== '-');
// รอบนี้กรอกแผนรถเข้าครบแล้วหรือยัง (เงื่อนไขเดียวกับ checkIsCarRegistered หน้าเว็บ)
const isCarPlanFilled = (row) => Boolean(
  row && (filled(row.truck_type) || row.truck_type_id) && filled(row.license) && filled(row.driver_name) && filled(row.driver_tel) && row.register_date
);

// ปลดประตูโหลดของรอบนี้ (กลับเป็นว่าง)
const releaseDockOfTx = (newRequest, txId) => newRequest()
  .input('txId', sql.Int, txId)
  .query(`
    UPDATE d
    SET d.is_active = 0, d.update_date = GETDATE()
    FROM ${TABLES.DOCK_DOOR} d
    INNER JOIN ${TX_T} x ON (d.dock_door_id = x.dock_door_id OR (x.dock_door_code IS NOT NULL AND x.dock_door_code <> '' AND d.dock_door_code = x.dock_door_code))
    WHERE x.po_transaction_id = @txId
  `);

const touchPo = (newRequest, poId, username) => newRequest()
  .input('poId', sql.Int, poId)
  .input('by', sql.NVarChar(100), username || null)
  .query(`UPDATE ${PO_T} SET update_date = GETDATE(), update_by = COALESCE(@by, update_by) WHERE po_id = @poId`);

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

    try {
      const pool = await getPool();
      const newRequest = () => pool.request();
      const resolvedTruck = await resolveTruckFromDb(pool, truckTypeId, truckType);

      let po = await findPo(newRequest, { poId: receivedId || id, poNo, includeCancelled: Boolean(receivedId || id) });
      if (!po && (receivedId || id)) po = await findPo(newRequest, { poNo });
      if (!po) {
        // ระบบเดิม: ลงแผนรถให้ PO ที่ยังไม่มีในระบบได้ → สร้าง PO ใหม่พร้อมรอบที่ 1
        const created = await newRequest()
          .input('poNo', sql.NVarChar(50), String(poNo).trim())
          .input('by', sql.NVarChar(100), req.user?.username || null)
          .query(`INSERT INTO ${PO_T} (PO_No, create_by, update_by) OUTPUT INSERTED.po_id VALUES (@poNo, @by, @by)`);
        po = await findPo(newRequest, { poId: created.recordset[0].po_id, includeCancelled: true });
      }

      // รอบที่เกิดจากการเลื่อนแผน: วัน-เวลากำหนดไว้แล้วตอนเลื่อน ไม่รับค่าจากหน้าเว็บ
      const keepPlan = Boolean(po.rescheduled_from_id && po.register_date);
      if (!keepPlan && !registerDate) {
        return res.status(400).json({ success: false, error: 'กรุณาเลือก Plan date' });
      }
      if (!keepPlan && !registerTime) {
        return res.status(400).json({ success: false, error: 'กรุณาเลือก Plan time' });
      }
      const regDateTimeStr = keepPlan ? null : formatSqlDateTimeStr(registerDate, registerTime);

      await newRequest()
        .input('txId', sql.Int, po.po_transaction_id)
        .input('truckTypeId', sql.Int, safeInt(resolvedTruck.truckTypeId))
        .input('truckType', sql.NVarChar(100), resolvedTruck.truckType)
        .input('license', sql.NVarChar(50), String(licensePlate))
        .input('driverName', sql.NVarChar(100), String(driverName))
        .input('driverTel', sql.NVarChar(20), String(driverTel).trim())
        .input('regDateStr', sql.VarChar(30), regDateTimeStr)
        .query(`
          UPDATE ${TX_T}
          SET
            truck_type_id = @truckTypeId,
            truck_type = @truckType,
            license = @license,
            driver_name = @driverName,
            driver_tel = @driverTel,
            register_date = CASE WHEN @regDateStr IS NOT NULL THEN CONVERT(datetime, @regDateStr, 120) ELSE register_date END,
            process_stage = 'WAIT_DOCK',
            update_date = GETDATE()
          WHERE po_transaction_id = @txId
        `);
      await touchPo(newRequest, po.po_id, req.user?.username);

      logger.debug(`[API POST /api/register-car] บันทึกสำเร็จ PO: ${poNo} รอบ ${po.round_no}, truck_type: ${resolvedTruck.truckType}, date: ${regDateTimeStr || po.register_str}`);

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

// อัปเดตรอบปัจจุบันของ PO (ที่ยังไม่ยกเลิก) — คืน PO ที่เจอ หรือ null
async function updateCurrentTx(pool, { poId = null, poNo, loose = false }, setSql, bindInputs = (r) => r) {
  const newRequest = () => pool.request();
  const po = await findPo(newRequest, { poId, poNo, loose });
  if (!po) return null;
  await bindInputs(newRequest().input('txId', sql.Int, po.po_transaction_id))
    .query(`UPDATE ${TX_T} SET ${setSql}, update_date = GETDATE() WHERE po_transaction_id = @txId`);
  return po;
}

function createTruckArrivalHandler(io) {
  return async function recordTruckArrival(req, res) {
    const { poNo } = req.body;
    try {
      const pool = await getPool();
      const po = await updateCurrentTx(pool, { poNo }, "truck_arrival = GETDATE(), process_stage = 'WAIT_TICKET'");
      if (!po) return poNotFound(res, NOT_FOUND_OR_CANCELLED(poNo));

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

// รถออก: ปิดรอบ (COMPLETED) + PO เสร็จ + ปลดประตูของรอบนี้
async function completeCurrentTx(pool, po) {
  const newRequest = () => pool.request();
  await newRequest()
    .input('txId', sql.Int, po.po_transaction_id)
    .query(`
      UPDATE ${TX_T}
      SET truck_departure = COALESCE(truck_departure, GETDATE()), process_stage = 'COMPLETED', tx_status = 'COMPLETED', update_date = GETDATE()
      WHERE po_transaction_id = @txId
    `);
  await newRequest()
    .input('poId', sql.Int, po.po_id)
    .query(`UPDATE ${PO_T} SET po_status = 'COMPLETED', update_date = GETDATE() WHERE po_id = @poId AND po_status <> 'CANCELLED'`);
  await releaseDockOfTx(newRequest, po.po_transaction_id);
}

function createTruckDepartureHandler(io) {
  return async function recordTruckDeparture(req, res) {
    const { poNo, username } = req.body;
    try {
      const pool = await getPool();
      const po = await findPo(() => pool.request(), { poNo, loose: true });
      if (!po) return poNotFound(res, NOT_FOUND_OR_CANCELLED(poNo));
      await completeCurrentTx(pool, po);

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

// ทำงานใน DB transaction — ผิดพลาดตรงไหน rollback ทั้งหมด
async function inDbTransaction(pool, work) {
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    const result = await work(() => new sql.Request(tx));
    await tx.commit();
    return result;
  } catch (err) {
    try { await tx.rollback(); } catch (_rollbackErr) { /* ignore */ }
    throw err;
  }
}

function createCancelPoHandler(io) {
  return async function cancelPo(req, res) {
    const { poNos, poNo, cancelReason, reason, receivedIds, receivedId, reasonIsOther } = req.body;
    // reasonIsOther = เลือก "อื่นๆ" แล้วพิมพ์เหตุผลเอง (ไม่ต้องอยู่ในตาราง Cancel_reason)
    const finalReason = String(cancelReason || reason || '').trim().slice(0, 255);
    const isOther = reasonIsOther === true;
    const list = Array.isArray(poNos) && poNos.length > 0 ? poNos : (poNo ? [poNo] : []);
    const idList = Array.isArray(receivedIds) && receivedIds.length > 0 ? receivedIds : (receivedId ? [receivedId] : []);

    if (list.length === 0 && idList.length === 0) {
      return res.status(400).json({ success: false, error: 'ไม่พบหมายเลข PO หรือ ID สำหรับยกเลิก' });
    }

    try {
      const pool = await getPool();
      if (isOther ? !finalReason : !(await lookups.isCancelReason(pool, finalReason))) {
        return res.status(400).json({ success: false, code: 'BAD_REASON', error: isOther ? 'กรุณาระบุเหตุผลการยกเลิก' : 'กรุณาเลือกเหตุผลการยกเลิกจากรายการ' });
      }
      let cancelledCount = 0;
      const notFound = [];
      const targets = idList.length > 0
        ? idList.map((rid) => ({ key: rid, find: { poId: rid, includeCancelled: true } }))
        : list.map((p) => ({ key: p, find: { poNo: p, loose: true } }));

      for (const target of targets) {
        const done = await inDbTransaction(pool, async (newRequest) => {
          const po = await findPo(newRequest, { ...target.find, lock: true });
          if (!po) return false;
          await releaseDockOfTx(newRequest, po.po_transaction_id);
          await newRequest()
            .input('txId', sql.Int, po.po_transaction_id)
            .query(`
              UPDATE ${TX_T}
              SET tx_status = 'CANCELLED', process_stage = 'CANCELLED',
                  dock_door_id = NULL, dock_door_code = NULL, dock_door_name = NULL,
                  update_date = GETDATE()
              WHERE po_transaction_id = @txId
            `);
          await newRequest()
            .input('poId', sql.Int, po.po_id)
            .input('reason', sql.NVarChar(255), String(finalReason))
            .input('by', sql.NVarChar(100), req.user?.username || null)
            .query(`
              UPDATE ${PO_T}
              SET po_status = 'CANCELLED', cancle_reason = @reason, update_by = COALESCE(@by, update_by), update_date = GETDATE()
              WHERE po_id = @poId
            `);
          return true;
        });
        if (done) cancelledCount += 1; else notFound.push(target.key);
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

const RESCHEDULE_BLOCKED = {
  NOT_REGISTERED: 'เลื่อนแผนได้เฉพาะรายการที่กรอกแผนรถเข้าแล้ว',
  COMPLETED: 'รายการเสร็จสิ้นแล้ว ไม่สามารถเลื่อนแผนได้',
};

// เลื่อนแผนรถเข้า: ปิดรอบปัจจุบัน (RESCHEDULED เก็บข้อมูลเดิมไว้ทั้งหมด) แล้วเปิดรอบใหม่
// รอบใหม่: แผนรถเข้า = วัน-เวลาที่เลื่อน, ข้อมูลรถ/ประตูว่าง → กลับไปขั้น "แผนรถเข้า"
// เงื่อนไข: รอบปัจจุบันกรอกแผนรถเข้าครบแล้ว และ PO ยังไม่เสร็จ / ไม่ถูกยกเลิก (รถเข้าแล้วก็เลื่อนได้)
// PO ที่ยกเลิกแล้ว findPo หาไม่เจออยู่แล้ว (ตอบ notFound)
function createReschedulePoHandler(io) {
  return async function reschedulePo(req, res) {
    const { poNos, poNo, rescheduleDate, rescheduleTime, rescheduleReason } = req.body;
    const list = Array.isArray(poNos) && poNos.length > 0 ? poNos : (poNo ? [poNo] : []);

    if (list.length === 0) {
      return res.status(400).json({ success: false, error: 'ไม่พบหมายเลข PO สำหรับเลื่อนนัดหมาย' });
    }
    const newPlanStr = rescheduleDate && rescheduleTime ? formatSqlDateTimeStr(String(rescheduleDate).trim(), String(rescheduleTime).trim()) : null;
    if (!newPlanStr || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(newPlanStr)) {
      return res.status(400).json({ success: false, code: 'BAD_DATE', error: 'กรุณาระบุวันและเวลาที่เลื่อนให้ถูกต้อง' });
    }
    const reasonStr = rescheduleReason ? String(rescheduleReason).trim() : null;
    const by = req.user?.username || null;

    try {
      const pool = await getPool();
      if (!(await lookups.isRescheduleReason(pool, reasonStr))) {
        return res.status(400).json({ success: false, code: 'BAD_REASON', error: 'กรุณาเลือกเหตุผลการเลื่อนแผนจากรายการ' });
      }
      const rescheduled = [];
      const notFound = [];
      const blocked = [];
      for (const p of list) {
        const outcome = await inDbTransaction(pool, async (newRequest) => {
          const po = await findPo(newRequest, { poNo: p, lock: true });
          if (!po) return { notFound: true };
          if (po.truck_departure || po.po_status === 'COMPLETED' || po.tx_status === 'COMPLETED') return { blocked: 'COMPLETED' };
          if (!isCarPlanFilled(po)) return { blocked: 'NOT_REGISTERED' };

          await releaseDockOfTx(newRequest, po.po_transaction_id);
          // ต้องปิดรอบเดิมก่อน เพราะมี unique index ให้ is_current = 1 ได้แถวเดียวต่อ PO
          await newRequest()
            .input('txId', sql.Int, po.po_transaction_id)
            .query(`UPDATE ${TX_T} SET is_current = 0, tx_status = 'RESCHEDULED', update_date = GETDATE() WHERE po_transaction_id = @txId`);
          await newRequest()
            .input('poId', sql.Int, po.po_id)
            .input('roundNo', sql.Int, (Number(po.round_no) || 1) + 1)
            .input('plan', sql.VarChar(30), newPlanStr)
            .input('fromId', sql.Int, po.po_transaction_id)
            .input('reason', sql.NVarChar(255), reasonStr)
            .input('by', sql.NVarChar(100), by)
            .query(`
              INSERT INTO ${TX_T} (po_id, round_no, is_current, tx_status, register_date, process_stage,
                rescheduled_from_id, reschedule_reason, rescheduled_by, rescheduled_at)
              VALUES (@poId, @roundNo, 1, 'ACTIVE', CONVERT(datetime, @plan, 120), 'WAIT_CAR_PLAN',
                @fromId, @reason, @by, GETDATE())
            `);
          await touchPo(newRequest, po.po_id, by);
          return { po };
        });
        if (outcome.notFound) notFound.push(p);
        else if (outcome.blocked) blocked.push({ poNo: p, code: outcome.blocked });
        else rescheduled.push({ poNo: p, previous: outcome.po });
      }

      if (rescheduled.length === 0) {
        if (blocked.length > 0) {
          const code = blocked[0].code;
          return res.status(400).json({ success: false, code, error: RESCHEDULE_BLOCKED[code], blocked, notFound });
        }
        return poNotFound(res, 'ไม่พบรายการ PO ที่จะเลื่อนแผน หรือรายการถูกยกเลิกแล้ว', { notFound });
      }

      // ข้อมูลรอบเดิม ให้ audit log ใช้ (ไม่ส่งกลับหน้าเว็บ)
      res.locals.rescheduledPrevious = rescheduled;
      logger.debug(`[API POST /api/reschedule-po] เลื่อนแผนสำเร็จ: ${rescheduled.map((x) => x.poNo).join(', ')} แผนใหม่: ${newPlanStr}`);

      if (io) {
        io.emit('dock-doors-updated', { poNos: rescheduled.map((x) => x.poNo), is_active: 0 });
        emitPoUpdated(io, req, { poNos: rescheduled.map((x) => x.poNo), type: 'reschedule-po' });
        broadcastDashboardUpdate(io);
      }
      res.json({
        success: true,
        message: `เลื่อนแผนเรียบร้อยแล้ว ${rescheduled.length} รายการ`,
        updated: rescheduled.length,
        notFound: [...notFound, ...blocked.map((b) => b.poNo)],
        blocked,
      });
    } catch (err) {
      logger.error('Error in /api/reschedule-po:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  };
}

const isKnownUom = async (pool, code) => (await lookups.loadUoms(pool)).some((u) => String(u.code).toUpperCase() === code);

async function upsertOfficePo(newRequest, body, username = null) {
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
    dockDoorId,
    dockDoorCode,
    dockDoorName,
    dockDoor,
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

  // PO เก็บแค่ชื่อสถานที่ส่ง — ถ้าหน้าเว็บส่งมาแต่รหัส ให้หาชื่อจาก master
  let finalShipToName = shipToName || toLocation || '';
  if (!String(finalShipToName).trim() && shipToCode && String(shipToCode).trim()) {
    const shipLookup = await newRequest()
      .input('stcode', sql.NVarChar(50), String(shipToCode).trim())
      .query(`SELECT TOP 1 ship_to_name FROM ${TABLES.SHIP_TO} WHERE ship_to_code = @stcode`);
    finalShipToName = shipLookup.recordset[0]?.ship_to_name || '';
  }

  // PO เก็บรหัส + ชื่อคลัง (ไม่เก็บ warehouse_id) — id จากหน้าเว็บใช้หาชื่อ/รหัสจาก master เท่านั้น
  const finalWhId = safeInt(warehouseId);
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
  } else if (finalWhCode && !finalWhName) {
    const whLookup = await newRequest()
      .input('whcode', sql.NVarChar(50), finalWhCode)
      .query(`SELECT warehouse_name FROM ${TABLES.WAREHOUSE} WHERE warehouse_code = @whcode`);
    if (whLookup.recordset.length > 0) {
      finalWhName = whLookup.recordset[0].warehouse_name;
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
  const targetReceivedId = safeInt(receivedId || id);

  // ขั้นของรอบปัจจุบัน: ข้อมูลออฟฟิศไม่ครบ = PO_INCOMPLETE ไม่งั้นไปขั้นแผนรถเข้า
  const saveResult = await newRequest()
    .input('poNo', sql.NVarChar(50), String(poNo).trim())
    .input('customerCode', sql.NVarChar(50), finalCustCode || null)
    .input('customerName', sql.NVarChar(255), finalCustName || null)
    .input('quantity', sql.Decimal(18, 2), qtyVal)
    .input('quantityUom', sql.NVarChar(20), uomStr || null)
    .input('shipToName', sql.NVarChar(255), finalShipToName || null)
    .input('warehouseCode', sql.NVarChar(50), finalWhCode || null)
    .input('warehouseName', sql.NVarChar(255), finalWhName || null)
    .input('dockDoorId', sql.Int, finalDoorId)
    .input('dockDoorCode', sql.NVarChar(50), finalDoorCode || null)
    .input('dockDoorName', sql.NVarChar(100), finalDoorName || null)
    .input('receivedId', sql.Int, targetReceivedId)
    .input('by', sql.NVarChar(100), username || null)
    .query(`
      DECLARE @stage NVARCHAR(50) = CASE
        WHEN (@customerName IS NULL OR LTRIM(RTRIM(@customerName)) = '')
          OR (@quantity IS NULL OR @quantity <= 0)
          OR (@warehouseName IS NULL OR LTRIM(RTRIM(@warehouseName)) = '')
          OR (@receivedId IS NOT NULL AND (@shipToName IS NULL OR LTRIM(RTRIM(@shipToName)) = '')) THEN 'WAIT_PO_DATA'
        ELSE 'WAIT_CAR_PLAN'
      END;

      IF @receivedId IS NOT NULL AND EXISTS (SELECT 1 FROM ${PO_T} WHERE po_id = @receivedId)
      BEGIN
        UPDATE ${PO_T}
        SET
          customer_code = @customerCode,
          customer_Name = @customerName,
          quantity = COALESCE(@quantity, quantity),
          quantity_uom = @quantityUom,
          ship_to_name = @shipToName,
          warehouse_code = @warehouseCode,
          warehouse_name = @warehouseName,
          update_by = COALESCE(@by, update_by),
          update_date = GETDATE()
        WHERE po_id = @receivedId;

        IF NOT EXISTS (SELECT 1 FROM ${TX_T} WHERE po_id = @receivedId AND is_current = 1)
          INSERT INTO ${TX_T} (po_id, round_no, is_current, tx_status, process_stage) VALUES (@receivedId, 1, 1, 'ACTIVE', @stage);

        UPDATE ${TX_T}
        SET
          dock_door_id = @dockDoorId,
          dock_door_code = @dockDoorCode,
          dock_door_name = @dockDoorName,
          process_stage = @stage,
          update_date = GETDATE()
        WHERE po_id = @receivedId AND is_current = 1;

        SELECT @receivedId AS final_received_id, 0 AS is_created;
      END
      ELSE IF EXISTS (SELECT 1 FROM ${PO_T} WHERE PO_No = @poNo AND po_status <> 'CANCELLED')
      BEGIN
        -- มี PO_No นี้อยู่ในระบบแล้ว (ไม่รวมรายการที่ถูกยกเลิก)
        SELECT -1 AS final_received_id;
      END
      ELSE
      BEGIN
        DECLARE @newPo TABLE (po_id INT);
        INSERT INTO ${PO_T} (
          PO_No, customer_code, customer_Name,
          quantity, quantity_uom, ship_to_name,
          warehouse_code, warehouse_name,
          create_by, update_by
        )
        OUTPUT INSERTED.po_id INTO @newPo
        VALUES (
          @poNo, @customerCode, @customerName,
          @quantity, @quantityUom, @shipToName,
          @warehouseCode, @warehouseName,
          @by, @by
        );
        DECLARE @pid INT = (SELECT TOP 1 po_id FROM @newPo);
        INSERT INTO ${TX_T} (po_id, round_no, is_current, tx_status, dock_door_id, dock_door_code, dock_door_name, process_stage)
        VALUES (@pid, 1, 1, 'ACTIVE', @dockDoorId, @dockDoorCode, @dockDoorName, @stage);

        SELECT @pid AS final_received_id, 1 AS is_created;
      END
    `);

  const out = saveResult?.recordset?.[0];
  if (out && Number(out.final_received_id) === -1) {
    return { duplicate: true };
  }

  const confirmedReceivedId = out && out.final_received_id ? out.final_received_id : targetReceivedId;
  const created = Boolean(Number(out?.is_created));
  return { receivedId: confirmedReceivedId, created, customerCode: finalCustCode, customerName: finalCustName, warehouseCode: finalWhCode, warehouseName: finalWhName };
}

function createSaveOfficePoHandler(io) {
  return async function saveOfficePo(req, res) {
    const { poNo, receivedId, id } = req.body;

    if (!poNo || !String(poNo).trim()) {
      return res.status(400).json({ success: false, error: 'ไม่พบหมายเลข PO' });
    }
    if (!receivedId && !id && !isValidPoNo(poNo)) {
      return res.status(400).json({ success: false, error: INVALID_PO_MESSAGE });
    }

    try {
      const pool = await getPool();
      const uom = normalizeUom(req.body.quantityUom);
      if (uom && !(await isKnownUom(pool, uom))) {
        return res.status(400).json({ success: false, code: 'BAD_UOM', error: `ไม่พบหน่วย ${uom} ในระบบ` });
      }
      const saved = await upsertOfficePo(() => pool.request(), req.body, req.user?.username);
      if (saved.duplicate) {
        return res.status(400).json({ success: false, error: `หมายเลข PO ${poNo} มีอยู่ในระบบแล้ว (รายการซ้ำ)` });
      }
      const confirmedReceivedId = saved.receivedId;
      // ค่าที่บันทึกจริง ให้ audit log ใช้ (ไม่ส่งกลับหน้าเว็บ)
      res.locals.savedPo = saved;

      if (req.body.is_urgent !== undefined || req.body.isUrgent !== undefined) {
        const urgentBit = (req.body.is_urgent || req.body.isUrgent) ? 1 : 0;
        await pool.request()
          .input('recId', sql.Int, confirmedReceivedId)
          .input('urg', sql.Bit, urgentBit)
          .query(`UPDATE ${PO_T} SET is_urgent = @urg WHERE po_id = @recId`);
      }

      logger.debug(`[API POST /api/office-save] บันทึกสำเร็จ PO: ${poNo}, ID: ${confirmedReceivedId}, customer: [${saved.customerCode}] ${saved.customerName}, warehouse: [${saved.warehouseCode}] ${saved.warehouseName}`);

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
  ['warehouse', (it) => Boolean(String(it.warehouseName || it.warehouseCode || '').trim()), 'คลังสินค้า'],
  ['shipTo', (it) => Boolean(String(it.shipToName || it.toLocation || '').trim()), 'สถานที่ส่ง'],
];

// หมายเลข PO: ตัวเลขล้วน 10 หลัก (กฎเดียวกับหน้าเว็บ: isValidPoNo ใน src/domain/po.js)
// ใช้กับ PO ที่สร้างใหม่และการนำเข้า — PO เดิมที่มีอยู่ก่อนกฎนี้ ยังแก้ข้อมูลอื่นได้
const PO_NO_PATTERN = /^\d{10}$/;
const isValidPoNo = (value) => PO_NO_PATTERN.test(String(value ?? '').trim());
const INVALID_PO_MESSAGE = 'หมายเลข PO ต้องเป็นตัวเลข 10 หลัก';

function validateImportItems(items) {
  const errors = [];
  const seen = new Map();
  items.forEach((it, index) => {
    const item = it && typeof it === 'object' ? it : {};
    const poNo = String(item.poNo || '').trim();
    const rows = Array.isArray(item.rows) ? item.rows.filter((n) => Number.isInteger(n)) : [];
    const problems = [];
    if (!poNo) problems.push('ไม่ได้กรอกหมายเลข PO');
    else if (!isValidPoNo(poNo)) problems.push(INVALID_PO_MESSAGE);
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
      const known = new Set((await lookups.loadUoms(pool)).map((u) => String(u.code).toUpperCase()));
      const badUom = items
        .map((it, index) => ({ index, poNo: String(it.poNo || '').trim(), rows: Array.isArray(it.rows) ? it.rows : [], uom: normalizeUom(it.quantityUom) }))
        .filter((x) => x.uom && !known.has(x.uom))
        .map(({ uom, ...x }) => ({ ...x, problems: [`ไม่พบหน่วย ${uom} ในระบบ`] }));
      if (badUom.length) {
        return res.status(400).json({ success: false, code: 'IMPORT_INVALID', error: 'ข้อมูลในไฟล์ไม่ครบหรือไม่ถูกต้อง ไม่ได้บันทึกรายการใดเลย', errors: badUom });
      }
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
        }, req.user?.username);
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

      const po = await updateCurrentTx(
        pool,
        { poNo },
        `dock_door_id = @dockDoorId, dock_door_code = @dockDoorCode, dock_door_name = @dockDoorName, process_stage = 'WAIT_DOCK'`,
        (r) => r
          .input('dockDoorId', sql.Int, finalDoorId)
          .input('dockDoorCode', sql.NVarChar(50), finalDoorCode)
          .input('dockDoorName', sql.NVarChar(100), finalDoorName),
      );
      if (!po) return poNotFound(res, NOT_FOUND_OR_CANCELLED(poNo));

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
      const po = await updateCurrentTx(pool, { poNo }, `ticket_date = GETDATE(), process_stage = 'WAIT_LOADING'`);
      if (!po) return poNotFound(res, NOT_FOUND_OR_CANCELLED(poNo));

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
        const po = await updateCurrentTx(pool, { poNo: p }, 'order_date = COALESCE(order_date, GETDATE())');
        if (po) sentCount += 1; else notFound.push(p);
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
      warehouseCode,
      warehouseName,
      truckDeparture
    } = req.body;

    try {
      const pool = await getPool();
      const newRequest = () => pool.request();
      let po = receivedId || id ? await findPo(newRequest, { poId: receivedId || id }) : null;
      if (!po) po = await findPo(newRequest, { poNo, loose: true });
      if (!po) return poNotFound(res, NOT_FOUND_OR_CANCELLED(poNo));

      // ข้อมูลหัว PO → ตาราง PO, ข้อมูลรถ/ประตู/เวลา → รอบปัจจุบัน (PO_Transaction)
      const poReq = newRequest().input('poId', sql.Int, po.po_id);
      const txReq = newRequest().input('txId', sql.Int, po.po_transaction_id);
      const poSets = ['update_date = GETDATE()'];
      const txSets = ['update_date = GETDATE()'];

      if (customerCode && customerCode !== '-') {
        poReq.input('customerCode', sql.NVarChar(50), String(customerCode));
        poSets.push('customer_code = @customerCode');
      }
      if (customerName && customerName !== '-') {
        poReq.input('customerName', sql.NVarChar(255), String(customerName));
        poSets.push('customer_Name = @customerName');
      }
      if (warehouseCode && warehouseCode !== '-') {
        poReq.input('warehouseCode', sql.NVarChar(50), String(warehouseCode));
        poSets.push('warehouse_code = @warehouseCode');
      }
      if (warehouseName && warehouseName !== '-') {
        poReq.input('warehouseName', sql.NVarChar(255), String(warehouseName));
        poSets.push('warehouse_name = @warehouseName');
      }
      const effectiveShipToName = shipToName || toLocation;
      if (effectiveShipToName && effectiveShipToName !== '-') {
        poReq.input('shipToName', sql.NVarChar(255), String(effectiveShipToName));
        poSets.push('ship_to_name = @shipToName');
      }
      if (quantityOrder && quantityOrder !== '-') {
        const cleanQtyStr = String(quantityOrder).replace(/[^0-9.]/g, '');
        const qtyVal = cleanQtyStr ? parseFloat(cleanQtyStr) : null;
        if (qtyVal !== null) {
          poReq.input('quantity', sql.Decimal(18, 2), qtyVal);
          poSets.push('quantity = @quantity');
        }
      }
      if (quantityUom && quantityUom !== '-') {
        poReq.input('quantityUom', sql.NVarChar(20), normalizeUom(quantityUom));
        poSets.push('quantity_uom = @quantityUom');
      }

      const resolvedTruck = await resolveTruckFromDb(pool, truckTypeId, truckType);
      if (resolvedTruck.truckTypeId !== null) {
        txReq.input('truckTypeId', sql.Int, safeInt(resolvedTruck.truckTypeId));
        txSets.push('truck_type_id = @truckTypeId');
      }
      if (resolvedTruck.truckType) {
        txReq.input('truckType', sql.NVarChar(100), resolvedTruck.truckType);
        txSets.push('truck_type = @truckType');
      }
      if (licensePlate && licensePlate !== '-') {
        txReq.input('license', sql.NVarChar(50), String(licensePlate));
        txSets.push('license = @license');
      }
      if (driverName && driverName !== '-') {
        txReq.input('driverName', sql.NVarChar(100), String(driverName));
        txSets.push('driver_name = @driverName');
      }
      if (driverTel && driverTel !== '-') {
        txReq.input('driverTel', sql.NVarChar(20), String(driverTel).trim());
        txSets.push('driver_tel = @driverTel');
      }
      // รอบที่เกิดจากการเลื่อนแผน: แผนรถเข้ากำหนดไว้แล้ว ไม่เขียนทับ
      if (registerDate && registerDate !== '-' && !(po.rescheduled_from_id && po.register_date)) {
        const regDateTimeStr = formatSqlDateTimeStr(registerDate, registerTime);
        if (regDateTimeStr) {
          txReq.input('regDateStr', sql.VarChar(30), regDateTimeStr);
          txSets.push('register_date = CONVERT(datetime, @regDateStr, 120)');
        }
      }

      const effectiveDockDoor = dockDoorCode || dockDoor;
      const safeDoorId = safeInt(dockDoorId);
      if (safeDoorId) {
        txReq.input('dockDoorId', sql.Int, safeDoorId);
        txSets.push('dock_door_id = @dockDoorId');
      }
      if (effectiveDockDoor && effectiveDockDoor !== '-') {
        txReq.input('dockDoorCode', sql.NVarChar(50), String(effectiveDockDoor));
        txSets.push('dock_door_code = @dockDoorCode');
      }
      if (dockDoorName && dockDoorName !== '-') {
        txReq.input('dockDoorName', sql.NVarChar(100), String(dockDoorName));
        txSets.push('dock_door_name = @dockDoorName');
      }

      const ts = taskTimestamps || {};
      const pStart = ts.pickStart || req.body.pickStart;
      const pFinish = ts.pickFinish || req.body.pickFinish || req.body.pickEnd;
      const lStart = ts.loadStart || req.body.loadStart;
      const lFinish = ts.loadFinish || req.body.loadFinish;
      const effectiveTruckDeparture = (typeof truckDeparture !== 'undefined' ? truckDeparture : null) ||
        (ts.truckDeparture ? ts.truckDeparture : req.body.truckDeparture || null);
      const departing = Boolean(effectiveTruckDeparture && formatSqlDateTimeStr(effectiveTruckDeparture));

      if (pStart && formatSqlDateTimeStr(pStart)) txSets.push('pick_start_date_time = COALESCE(pick_start_date_time, GETDATE())');
      if (pFinish && formatSqlDateTimeStr(pFinish)) txSets.push('pick_finish_date_time = COALESCE(pick_finish_date_time, GETDATE())');
      if (lStart && formatSqlDateTimeStr(lStart)) txSets.push('load_start_date_time = COALESCE(load_start_date_time, GETDATE())');
      if (lFinish && formatSqlDateTimeStr(lFinish)) {
        txSets.push('load_finish_date_time = COALESCE(load_finish_date_time, GETDATE())');
        if (!effectiveTruckDeparture) txSets.push("process_stage = 'WAIT_DEPARTURE'");
      }

      if (poSets.length > 1) await poReq.query(`UPDATE ${PO_T} SET ${poSets.join(', ')} WHERE po_id = @poId`);
      if (txSets.length > 1) await txReq.query(`UPDATE ${TX_T} SET ${txSets.join(', ')} WHERE po_transaction_id = @txId`);
      if (departing) {
        await completeCurrentTx(pool, po);
        logger.debug(`[API POST /api/outside-task] ปลดล็อคประตูโหลดสำหรับ PO ${poNo} กลับเป็น 0 (ว่าง) เรียบร้อย`);
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
      let urgentCount = 0;
      const urgentBit = Boolean(isUrgent) ? 1 : 0;
      if (idList.length > 0) {
        for (const recId of idList) {
          const r = await pool.request()
            .input('recId', sql.Int, Number(recId))
            .input('urg', sql.Bit, urgentBit)
            .query(`UPDATE ${PO_T} SET is_urgent = @urg, update_date = GETDATE() WHERE po_id = @recId`);
          urgentCount += lastAffected(r);
        }
      } else {
        for (const po of poList) {
          const r = await pool.request()
            .input('po', sql.NVarChar(50), String(po).trim())
            .input('urg', sql.Bit, urgentBit)
            .query(`UPDATE ${PO_T} SET is_urgent = @urg, update_date = GETDATE() WHERE PO_No = @po OR ${looseMatch('PO_No', '@po')}`);
          urgentCount += lastAffected(r);
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
  getPoTable,
  getPoRounds,
  loadAllPos,
  loadPoRounds,
  mapPoRow,
  isCarPlanFilled,
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
