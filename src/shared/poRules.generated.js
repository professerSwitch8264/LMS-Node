// ไฟล์นี้สร้างอัตโนมัติ — ห้ามแก้ตรงนี้
// ต้นฉบับอยู่ที่หน้าเว็บ: wanthai-logistics-react/src/{domain/po.js, utils/date.js, utils/carRegistry.js}
// แก้กฎที่หน้าเว็บแล้วรัน:  cd ../wanthai-logistics-react && node scripts/sync-po-rules.mjs
/* eslint-disable */

const WORDING = new Proxy({}, { get: (_, group) => new Proxy({}, { get: (__, key) => String(key) }) });
const getRolePermissions = () => null;
// from src/domain/po.js
const PO_FIELD_ALIASES = {
  /** เวลารถเข้าโรงงาน (ISO) */
  truckArrival: ['truckArrival', 'truck_arrival', 'truckArrive', 'taskTimestamps.truckArrival'],
  /** เวลารถออกโรงงาน (ISO) — มีค่าแปลว่า PO เสร็จสิ้น */
  truckDeparture: ['truckDeparture', 'truck_departure', 'taskTimestamps.truckDeparture'],
  /** เวลาเริ่มหยิบสินค้า */
  pickStart: ['pickStart', 'pick_start_date_time', 'taskTimestamps.pickStart'],
  /** เวลาหยิบสินค้าเสร็จ */
  pickFinish: ['pickFinish', 'pickEnd', 'pick_finish_date_time', 'taskTimestamps.pickFinish'],
  /** เวลาเริ่มโหลดสินค้า */
  loadStart: ['loadStart', 'load_start_date_time', 'taskTimestamps.loadStart'],
  /** เวลาโหลดสินค้าเสร็จ */
  loadFinish: ['loadFinish', 'load_finish_date_time', 'taskTimestamps.loadFinish'],
  /** รหัสประตูโหลด เช่น D1 */
  dockDoorCode: ['dockDoorCode', 'dockDoor'],
  /** ชื่อสถานที่ส่ง */
  shipToName: ['shipToName', 'shipToCustomer', 'toLocation'],
  /** ทะเบียนรถ */
  licensePlate: ['licensePlate', 'license'],
};

// from src/domain/po.js
const readPath = (po, path) => {
  if (!po) return undefined;
  const dot = path.indexOf('.');
  if (dot < 0) return po[path];
  const parent = po[path.slice(0, dot)];
  return parent ? parent[path.slice(dot + 1)] : undefined;
};

// from src/domain/po.js
const readFirst = (po, field) => {
  const names = PO_FIELD_ALIASES[field];
  let value;
  for (const name of names) {
    value = readPath(po, name);
    if (value) return value;
  }
  return value;
};

// from src/domain/po.js
const getTruckArrival = (po) => readFirst(po, 'truckArrival');

// from src/domain/po.js
const getTruckDeparture = (po) => readFirst(po, 'truckDeparture');

// from src/domain/po.js
const getPickStart = (po) => readFirst(po, 'pickStart');

// from src/domain/po.js
const getPickFinish = (po) => readFirst(po, 'pickFinish');

// from src/domain/po.js
const getLoadStart = (po) => readFirst(po, 'loadStart');

// from src/domain/po.js
const getLoadFinish = (po) => readFirst(po, 'loadFinish');

// from src/domain/po.js
const getDockDoorCode = (po) => readFirst(po, 'dockDoorCode');

// from src/domain/po.js
const getShipToName = (po) => readFirst(po, 'shipToName');

// from src/domain/po.js
const getLicensePlate = (po) => readFirst(po, 'licensePlate');

// from src/utils/date.js
const formatDisplayTime = (timeVal) => {
  if (!timeVal) return "";
  if (typeof timeVal === 'string') {
    const trimmed = timeVal.trim();
    if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(trimmed)) {
      const [h, m] = trimmed.split(':');
      return `${h.padStart(2, '0')}:${m.padStart(2, '0')}`;
    }
    const timeMatch = trimmed.match(/[T\s](\d{1,2}):(\d{2})/);
    if (timeMatch && !trimmed.endsWith('Z')) {
      return `${timeMatch[1].padStart(2, '0')}:${timeMatch[2].padStart(2, '0')}`;
    }
    const parsed = new Date(trimmed);
    if (!isNaN(parsed.getTime())) {
      const hours = String(parsed.getHours()).padStart(2, '0');
      const minutes = String(parsed.getMinutes()).padStart(2, '0');
      return `${hours}:${minutes}`;
    }
  }
  if (timeVal instanceof Date && !isNaN(timeVal.getTime())) {
    const hours = String(timeVal.getHours()).padStart(2, '0');
    const minutes = String(timeVal.getMinutes()).padStart(2, '0');
    return `${hours}:${minutes}`;
  }
  return "";
};

// from src/utils/date.js
const getCurrentShiftDate = (base = new Date()) => {
  const d = new Date(base);
  if (d.getHours() < 7) {
    d.setDate(d.getDate() - 1);
  }
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
};

// from src/utils/date.js
const getShiftTimeRange = (targetDate) => {
  if (!targetDate) return null;

  if (typeof targetDate === 'object' && !(targetDate instanceof Date)) {
    const sDate = targetDate.startDate || targetDate.start || targetDate.from;
    const eDate = targetDate.endDate || targetDate.end || targetDate.to || sDate;
    if (sDate) {
      const startRange = getShiftTimeRange(sDate);
      const endRange = getShiftTimeRange(eDate || sDate);
      if (startRange && endRange) {
        return {
          start: startRange.start,
          end: endRange.end,
          startMs: startRange.startMs,
          endMs: endRange.endMs
        };
      }
    }
  }

  let y, m, d;
  if (targetDate instanceof Date) {
    y = targetDate.getFullYear();
    m = targetDate.getMonth();
    d = targetDate.getDate();
  } else if (typeof targetDate === 'string') {
    const cleanStr = targetDate.split('T')[0].split(' ')[0].trim();
    if (cleanStr.includes('-')) {
      const parts = cleanStr.split('-');
      if (parts.length >= 3) {
        y = parseInt(parts[0], 10);
        m = parseInt(parts[1], 10) - 1;
        d = parseInt(parts[2], 10);
      }
    } else if (cleanStr.includes('/')) {
      const parts = cleanStr.split('/');
      if (parts.length >= 3) {
        d = parseInt(parts[0], 10);
        m = parseInt(parts[1], 10) - 1;
        y = parseInt(parts[2], 10);
        if (y > 2400) y -= 543;
      }
    } else {
      const parsed = new Date(targetDate);
      if (!isNaN(parsed.getTime())) {
        y = parsed.getFullYear();
        m = parsed.getMonth();
        d = parsed.getDate();
      }
    }
  } else {
    const now = new Date();
    y = now.getFullYear();
    m = now.getMonth();
    d = now.getDate();
  }

  const start = new Date(y, m, d, 7, 0, 0, 0);
  const end = new Date(y, m, d + 1, 7, 0, 0, 0);
  return { start, end, startMs: start.getTime(), endMs: end.getTime() };
};

// from src/utils/date.js
const isPoInShift = (item, shiftDate) => {
  if (!item || !shiftDate) return false;
  const range = getShiftTimeRange(shiftDate);
  if (!range) return false;
  const { startMs, endMs } = range;


  const isCancelled = Boolean(
    item.processStage === 'CANCLE' || 
    item.processStage === 'CANCEL' || 
    item.processStage === 'CANCELLED' || 
    item.status === 'CANCLE' || 
    item.status === 'CANCEL' || 
    item.status === 'CANCELLED' || 
    item.isCancelled === true
  );

  if (isCancelled) {
    const cancelDates = [
      item.cancel_date,
      item.cancelDate,
      item.cancelledAt,
      item.cancelled_date,
      item.updateDate,
      item.update_date,
      item.updatedAt,
      item.registerDate,
      item.register_date,
      item.planDate,
      item.plan_date,
      item.shipDatePlan,
      item.ship_date_plan,
      item.createDate,
      item.create_date,
      item.createdAt
    ].filter(Boolean);

    for (const cDate of cancelDates) {
      let y, m, d;
      if (cDate instanceof Date) {
        y = cDate.getFullYear();
        m = cDate.getMonth();
        d = cDate.getDate();
      } else if (typeof cDate === 'string') {
        const cleanStr = cDate.split('T')[0].split(' ')[0].trim();
        if (cleanStr.includes('-')) {
          const parts = cleanStr.split('-');
          if (parts.length >= 3) {
            y = parseInt(parts[0], 10);
            m = parseInt(parts[1], 10) - 1;
            d = parseInt(parts[2], 10);
          }
        } else if (cleanStr.includes('/')) {
          const parts = cleanStr.split('/');
          if (parts.length >= 3) {
            const cd = parseInt(parts[0], 10);
            const cm = parseInt(parts[1], 10) - 1;
            let cy = parseInt(parts[2], 10);
            if (cy > 2400) cy -= 543;
            y = cy;
            m = cm;
            d = cd;
          }
        }
      }
      if (y !== undefined && !isNaN(y) && !isNaN(m) && !isNaN(d)) {
        const cTimestamp = new Date(y, m, d, 12, 0, 0).getTime();
        if (!isNaN(cTimestamp) && cTimestamp >= startMs && cTimestamp < endMs) {
          return true;
        }
      }
    }
    return false;
  }

  const regVal = item.registerDate || item.register_date || item.planDate || item.plan_date;
  if (!regVal) {
    return false;
  }

  let y, m, d;
  if (regVal instanceof Date) {
    y = regVal.getFullYear();
    m = regVal.getMonth();
    d = regVal.getDate();
  } else if (typeof regVal === 'string') {
    const cleanStr = regVal.split('T')[0].split(' ')[0].trim();
    if (cleanStr.includes('-')) {
      const parts = cleanStr.split('-');
      if (parts.length >= 3) {
        y = parseInt(parts[0], 10);
        m = parseInt(parts[1], 10) - 1;
        d = parseInt(parts[2], 10);
      }
    } else if (cleanStr.includes('/')) {
      const parts = cleanStr.split('/');
      if (parts.length >= 3) {
        d = parseInt(parts[0], 10);
        m = parseInt(parts[1], 10) - 1;
        y = parseInt(parts[2], 10);
        if (y > 2400) y -= 543;
      }
    }
  }

  if (y !== undefined && !isNaN(y) && !isNaN(m) && !isNaN(d)) {
    const regT = item.registerTime || item.register_time || item.planTime || item.plan_time || '07:00:00';
    let hh = 7, mm = 0, ss = 0;
    if (typeof regT === 'string' && regT.includes(':')) {
      const tParts = regT.split(':');
      hh = parseInt(tParts[0], 10) || 0;
      mm = parseInt(tParts[1], 10) || 0;
      ss = parseInt(tParts[2], 10) || 0;
    }
    const dayOffset = hh < 7 ? 1 : 0;
    const regTimestamp = new Date(y, m, d + dayOffset, hh, mm, ss).getTime();
    return !isNaN(regTimestamp) && regTimestamp >= startMs && regTimestamp < endMs;
  }

  if (typeof regVal === 'string' || regVal instanceof Date) {
    const clean = typeof regVal === 'string' ? regVal.replace(' ', 'T') : regVal;
    const t = new Date(clean).getTime();
    if (!isNaN(t) && t >= startMs && t < endMs) {
      return true;
    }
  }

  return false;
};

// from src/utils/carRegistry.js
const SHIFT_START_HOUR = 7;

// from src/utils/carRegistry.js
const cleanDisplayName = (val) => {
  if (!val) return '';
  const str = String(val).trim();
  if (str.includes(' - ')) {
    return str.split(' - ').slice(1).join(' - ').trim();
  }
  return str;
};

// from src/utils/carRegistry.js
const isCancelledPo = (item) => {
  if (!item) return false;
  return item.processStage === 'CANCLE' || 
         item.processStage === 'CANCEL' || 
         item.processStage === 'CANCELLED' || 
         item.status === 'CANCLE' || 
         item.status === 'CANCEL' || 
         item.status === 'CANCELLED' || 
         item.isCancelled === true;
};

// from src/utils/carRegistry.js
const isCompletedPo = (item) => {
  if (!item || isCancelledPo(item)) return false;
  return Boolean(
    getTruckDeparture(item) ||
    item.processStage === 'COMPLETED' ||
    item.status === 'COMPLETED'
  );
};

// from src/utils/carRegistry.js
const getPoStatus = (item) => {
  if (!item) return { key: 'WAITING_PLAN', label: 'รอลงแผนรถ', badgeClass: 'bg-amber-50 text-amber-700 border-amber-200' };
  if (isCancelledPo(item) || item.isCancelled || item.is_cancelled || item.cancelReason || item.cancel_reason || item.cancelledAt) {
    return { key: 'CANCELLED', label: 'ยกเลิก', badgeClass: 'bg-rose-50 text-rose-700 border-rose-200' };
  }
  if (isCompletedPo(item) || getTruckDeparture(item)) {
    return { key: 'COMPLETED', label: 'เสร็จสิ้น', badgeClass: 'bg-emerald-50 text-emerald-700 border-emerald-200' };
  }
  if (checkIsCarRegistered(item)) {
    return { key: 'IN_PROGRESS', label: 'กำลังดำเนินการ', badgeClass: 'bg-sky-50 text-[#084F6A] border-sky-200' };
  }
  return { key: 'WAITING_PLAN', label: 'รอลงแผนรถ', badgeClass: 'bg-amber-50 text-amber-700 border-amber-200' };
};

// from src/utils/carRegistry.js
const isPoCompletedForRole = (item, _currentRole = 'ADMIN_WAREHOUSE', _permissions = null) => {
  if (!item || isCancelledPo(item)) return false;
  return isCompletedPo(item);
};

// from src/utils/carRegistry.js
const isPoDataIncomplete = (item) => {
  if (!item) return false;
  if (item.processStage === 'CANCLE' || item.processStage === 'CANCEL' || item.processStage === 'CANCELLED' || item.status === 'CANCLE' || item.isCancelled) {
    return false;
  }

  const hasCarRegistered = Boolean(
    (item.truckType || item.truckTypeId || item.truck_type || item.truck_type_id) &&
    ((item.licensePlate && String(item.licensePlate).trim() && item.licensePlate !== '-') || 
     (item.license && String(item.license).trim() && item.license !== '-')) &&
    ((item.driverName && String(item.driverName).trim() && item.driverName !== '-') ||
     (item.driver_name && String(item.driver_name).trim() && item.driver_name !== '-')) &&
    ((item.driverTel && String(item.driverTel).trim() && item.driverTel !== '-') || 
     (item.driver_tel && String(item.driver_tel).trim() && item.driver_tel !== '-')) &&
    (item.registerDate || item.planDate || item.register_date || item.plan_date || item.shipDatePlan || item.ship_date_plan)
  );
  if (hasCarRegistered) return false;

  const hasPo = Boolean((item.poNo && String(item.poNo).trim()) || (item.PO_No && String(item.PO_No).trim()));
  const rawQty = item.quantityOrder !== undefined && item.quantityOrder !== null && item.quantityOrder !== '' 
    ? item.quantityOrder 
    : (item.quantity !== undefined ? item.quantity : item.Quantity);
  const qty = Number(rawQty);
  const hasQty = !isNaN(qty) && qty > 0;
  const hasWarehouse = Boolean(
    (item.warehouseName && String(item.warehouseName).trim()) || 
    (item.warehouse_name && String(item.warehouse_name).trim()) || 
    (item.warehouseCode && String(item.warehouseCode).trim()) || 
    item.warehouseId
  );
  const hasCustomer = Boolean(
    (item.customerName && String(item.customerName).trim()) || 
    (item.customer_Name && String(item.customer_Name).trim()) || 
    (item.customerCode && String(item.customerCode).trim()) || 
    item.customerId
  );
  const hasShipTo = Boolean(
    (item.shipToCustomer && String(item.shipToCustomer).trim()) || 
    (item.shipToName && String(item.shipToName).trim()) || 
    (item.ship_to_name && String(item.ship_to_name).trim()) || 
    (item.toLocation && String(item.toLocation).trim()) ||
    (item.shipToCode && String(item.shipToCode).trim())
  );

  const hasUom = item.quantityUom !== undefined 
    ? Boolean(String(item.quantityUom).trim()) 
    : (item.quantity_uom !== undefined 
        ? Boolean(String(item.quantity_uom).trim()) 
        : (item.uom !== undefined ? Boolean(String(item.uom).trim()) : true));

  return (!hasPo || !hasQty || !hasWarehouse || !hasCustomer || !hasShipTo || !hasUom);
};

// from src/utils/carRegistry.js
const isWaitingForDeliveryDate = (item, baseDate = getCurrentShiftDate()) => {
  if (!item || isCancelledPo(item)) return false;

  if (getTruckArrival(item)) return false;
  if (getTruckDeparture(item) || item.processStage === 'COMPLETED') return false;

  if (isPoDataIncomplete(item)) return false;
  const hasOffice = Boolean(item.officeSaved || ((item.customerName || item.customer_Name || item.customerCode || item.customer_code) && (item.quantityOrder || item.quantity)));
  if (!hasOffice) return false;

  const hasCarPlan = Boolean(
    (item.truckType || item.truckTypeId || item.truck_type || item.truck_type_id) &&
    ((item.licensePlate && String(item.licensePlate).trim() && item.licensePlate !== '-') || 
     (item.license && String(item.license).trim() && item.license !== '-')) &&
    ((item.driverName && String(item.driverName).trim() && item.driverName !== '-') ||
     (item.driver_name && String(item.driver_name).trim() && item.driver_name !== '-')) &&
    ((item.driverTel && String(item.driverTel).trim() && item.driverTel !== '-') || 
     (item.driver_tel && String(item.driver_tel).trim() && item.driver_tel !== '-')) &&
    (item.registerDate || item.planDate || item.register_date || item.plan_date || item.shipDatePlan || item.ship_date_plan)
  );
  if (!hasCarPlan) return false;

  const targetDateVal = item.registerDate || item.register_date || item.planDate || item.plan_date || item.shipDatePlan || item.ship_date_plan;
  if (!targetDateVal) return false;

  let y, m, d;
  let hh = 0;
  let mm = 0;
  if (targetDateVal instanceof Date && !isNaN(targetDateVal.getTime())) {
    y = targetDateVal.getFullYear();
    m = targetDateVal.getMonth();
    d = targetDateVal.getDate();
    hh = targetDateVal.getHours();
    mm = targetDateVal.getMinutes();
  } else if (typeof targetDateVal === 'string') {
    const s = targetDateVal.trim();
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) {
      const [day, mon, yr] = s.split('/').map(Number);
      y = yr > 2400 ? yr - 543 : yr;
      m = mon - 1;
      d = day;
    } else if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
      const clean = s.split('T')[0].split(' ')[0];
      const parts = clean.split('-');
      y = parseInt(parts[0], 10);
      if (y > 2400) y -= 543;
      m = parseInt(parts[1], 10) - 1;
      d = parseInt(parts[2], 10);
      const timeMatch = s.match(/[T\s](\d{1,2}):(\d{2})/);
      if (timeMatch) {
        hh = parseInt(timeMatch[1], 10);
        mm = parseInt(timeMatch[2], 10);
      }
    } else {
      const dt = new Date(s);
      if (!isNaN(dt.getTime())) {
        y = dt.getFullYear();
        if (y > 2400) y -= 543;
        m = dt.getMonth();
        d = dt.getDate();
        hh = dt.getHours();
        mm = dt.getMinutes();
      }
    }
  }
  if (y === undefined || isNaN(y)) return false;
  if (hh < SHIFT_START_HOUR && (hh !== 0 || mm !== 0)) {
    const shiftDay = new Date(y, m, d - 1);
    y = shiftDay.getFullYear();
    m = shiftDay.getMonth();
    d = shiftDay.getDate();
  }

  let effectiveBase = baseDate || getCurrentShiftDate();
  if (typeof effectiveBase === 'object' && !(effectiveBase instanceof Date)) {
    effectiveBase = effectiveBase.endDate || effectiveBase.startDate || getCurrentShiftDate();
  }
  if (effectiveBase instanceof Date && (effectiveBase.getHours() !== 0 || effectiveBase.getMinutes() !== 0)) {
    effectiveBase = getCurrentShiftDate(effectiveBase);
  }

  let bY, bM, bD;
  if (effectiveBase instanceof Date && !isNaN(effectiveBase.getTime())) {
    bY = effectiveBase.getFullYear();
    bM = effectiveBase.getMonth();
    bD = effectiveBase.getDate();
  } else if (typeof effectiveBase === 'string') {
    const s = effectiveBase.trim();
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) {
      const [day, mon, yr] = s.split('/').map(Number);
      bY = yr > 2400 ? yr - 543 : yr;
      bM = mon - 1;
      bD = day;
    } else if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
      const parts = s.split('T')[0].split(' ')[0].split('-');
      bY = parseInt(parts[0], 10);
      if (bY > 2400) bY -= 543;
      bM = parseInt(parts[1], 10) - 1;
      bD = parseInt(parts[2], 10);
    } else {
      const bd = new Date(effectiveBase);
      bY = bd.getFullYear();
      bM = bd.getMonth();
      bD = bd.getDate();
    }
  } else {
    const now = new Date();
    bY = now.getFullYear();
    bM = now.getMonth();
    bD = now.getDate();
  }

  const targetDay = new Date(y, m, d).getTime();
  const baseDay = new Date(bY, bM, bD).getTime();

  return targetDay > baseDay;
};

// from src/utils/carRegistry.js
const checkIsCarRegistered = (item, isLocalSaved = false) => {
  if (isLocalSaved) return true;
  if (!item) return false;
  
  const hasPlate = Boolean(
    (item.licensePlate && String(item.licensePlate).trim() && item.licensePlate !== '-') ||
    (item.license && String(item.license).trim() && item.license !== '-')
  );
  const hasDriver = Boolean(
    (item.driverName && String(item.driverName).trim() && item.driverName !== '-') ||
    (item.driver_name && String(item.driver_name).trim() && item.driver_name !== '-')
  );
  const hasTruckType = Boolean(item.truckType || item.truckTypeId || item.truck_type || item.truck_type_id);
  const hasTel = Boolean(
    (item.driverTel && String(item.driverTel).trim() && item.driverTel !== '-') ||
    (item.driver_tel && String(item.driver_tel).trim() && item.driver_tel !== '-')
  );
  const hasDate = Boolean(
    (item.registerDate && String(item.registerDate).trim() && item.registerDate !== '-') ||
    (item.planDate && String(item.planDate).trim() && item.planDate !== '-') ||
    (item.register_date && String(item.register_date).trim() && item.register_date !== '-') ||
    (item.plan_date && String(item.plan_date).trim() && item.plan_date !== '-') ||
    (item.registerDateStr && String(item.registerDateStr).trim() && item.registerDateStr !== '-')
  );
  const hasTime = Boolean(
    (item.registerTime && String(item.registerTime).trim() && item.registerTime !== '-') ||
    (item.planTime && String(item.planTime).trim() && item.planTime !== '-') ||
    (item.register_time && String(item.register_time).trim() && item.register_time !== '-') ||
    (item.register_time_str && String(item.register_time_str).trim() && item.register_time_str !== '-') ||
    (item.plan_time && String(item.plan_time).trim() && item.plan_time !== '-') ||
    (item.registerTimeStr && String(item.registerTimeStr).trim() && item.registerTimeStr !== '-') ||
    (typeof item.registerDate === 'string' && item.registerDate.includes(':')) ||
    (typeof item.planDate === 'string' && item.planDate.includes(':')) ||
    (typeof item.register_date === 'string' && item.register_date.includes(':')) ||
    (item.registerDate instanceof Date && (item.registerDate.getHours() !== 0 || item.registerDate.getMinutes() !== 0))
  );

  if (!hasPlate || !hasDriver || !hasTruckType || !hasTel || !hasDate || !hasTime) {
    return false;
  }

  if (item.carRegistered) return true;

  if (
    item.processStage &&
    ['WAIT_TICKET', 'WAIT_DOCK', 'WAIT_LOADING', 'WAIT_DEPARTURE', 'COMPLETED'].includes(item.processStage)
  ) {
    return true;
  }

  return true;
};

// from src/utils/carRegistry.js
const normalizeRole = (role) => {
  const r = String(role || '').toUpperCase();
  if (r.includes('ADMIN')) return 'ADMIN_WAREHOUSE';
  if (r.includes('YUSEN') || r.includes('CAR_REGISTER')) return 'YUSEN';
  if (r.includes('LEADER') || r.includes('OUTSIDE')) return 'LEADER_WAREHOUSE';
  return 'ADMIN_WAREHOUSE';
};

// from src/utils/carRegistry.js
const getPoProgressFlags = (item) => {
  const isDepartureDone = Boolean(
    getTruckDeparture(item) ||
    item.processStage === 'COMPLETED' ||
    item.process_stage === 'COMPLETED'
  );

  const isTicketSent = Boolean(
    (item.order_date && String(item.order_date).trim() !== '-') ||
    (item.orderDate && String(item.orderDate).trim() !== '-')
  );

  const isCarPlanDone = checkIsCarRegistered(item);

  const isArrivalDone = Boolean(
    getTruckArrival(item) ||
    getTruckDeparture(item)
  );

  const isDockDone = Boolean(getDockDoorCode(item) || item.dockDoorId);
  const isTicketIssued = Boolean(item.ticketDate || item.ticket_date || item.ticketDateStr);
  const isPickStarted = Boolean(
    getPickStart(item)
  );
  const isPickDone = Boolean(
    getPickFinish(item)
  );
  const isLoadStarted = Boolean(
    getLoadStart(item)
  );
  const isLoadDone = Boolean(
    getLoadFinish(item)
  );

  return {
    isDepartureDone,
    isTicketSent,
    isCarPlanDone,
    isArrivalDone,
    isDockDone,
    isTicketIssued,
    isPickStarted,
    isPickDone,
    isLoadStarted,
    isLoadDone,
  };
};

// from src/utils/carRegistry.js
const getPoActiveSteps = (item) => {
  if (!item || isCancelledPo(item)) return [];

  const {
    isDepartureDone,
    isTicketSent,
    isCarPlanDone,
    isArrivalDone,
    isDockDone,
    isTicketIssued,
    isPickStarted,
    isPickDone,
    isLoadStarted,
    isLoadDone,
  } = getPoProgressFlags(item);
  if (isDepartureDone) return [];

  if (!isCarPlanDone) {
    const steps = [{ id: 'carPlan', label: WORDING.STEPS.WAITING_CAR_PLAN, role: 'YUSEN' }];
    if (!isTicketSent) {
      steps.push({ id: 'ticket', label: WORDING.STEPS.WAITING_SEND_TICKET, role: 'ADMIN_WAREHOUSE' });
    }
    return steps;
  }
  if (isWaitingForDeliveryDate(item)) {
    const steps = [{ id: 'waiting_delivery_date', label: WORDING.STEPS.WAITING_DELIVERY_DATE, role: 'WAITING_DATE' }];
    if (!isTicketSent) {
      steps.push({ id: 'ticket', label: WORDING.STEPS.WAITING_SEND_TICKET, role: 'ADMIN_WAREHOUSE' });
    }
    return steps;
  }

  const steps = [];
  if (!isTicketSent) {
    steps.push({ id: 'ticket', label: WORDING.STEPS.WAITING_SEND_TICKET, role: 'ADMIN_WAREHOUSE' });
  }
  if (isCarPlanDone) {
    if (!isDockDone) {
      steps.push({ id: 'dock', label: WORDING.STEPS.WAITING_DOCK_DOOR, role: 'ADMIN_WAREHOUSE' });
    }
    if (!isArrivalDone) {
      steps.push({ id: 'arrival', label: WORDING.STEPS.WAITING_ARRIVAL, role: 'YUSEN' });
    }
    if (isArrivalDone && !isTicketIssued) {
      steps.push({ id: 'issueTicket', label: WORDING.STEPS.WAITING_ISSUE_TICKET, role: 'ADMIN_WAREHOUSE' });
    }
    if (!isPickDone) {
      steps.push({ 
        id: isPickStarted ? 'pick_in_progress' : 'pick_not_started', 
        label: isPickStarted ? WORDING.STEPS.PICKING_IN_PROGRESS : WORDING.STEPS.NOT_PICKED, 
        role: 'LEADER_WAREHOUSE' 
      });
    }
    if (isArrivalDone) {
      if (!isLoadDone && (isLoadStarted || (isPickDone && isDockDone && isTicketIssued))) {
        steps.push({ 
          id: isLoadStarted ? 'load_in_progress' : 'load_not_started', 
          label: isLoadStarted ? WORDING.STEPS.LOADING_IN_PROGRESS : WORDING.STEPS.NOT_LOADED, 
          role: 'LEADER_WAREHOUSE' 
        });
      }
      if (isLoadDone && !isDepartureDone) {
        steps.push({ id: 'departure', label: WORDING.STEPS.WAITING_DEPARTURE, role: 'LEADER_WAREHOUSE' });
      }
    }
  }
  return steps;
};

// from src/utils/carRegistry.js
const STEP_ACTION_PERMISSIONS = {
  carPlan: ['canEditCarPlan'],
  ticket: ['canActionTicketSent'],
  dock: ['canEditDockDoor'],
  arrival: ['canActionTruckArrival'],
  issueTicket: ['canActionIssueTicket'],
  pick_in_progress: ['canActionPicking'],
  pick_not_started: ['canActionPicking'],
  load_in_progress: ['canActionLoading'],
  load_not_started: ['canActionLoading'],
  departure: ['canActionTruckDeparture'],
};

// from src/utils/carRegistry.js
const canActOnStep = (step, permissions) => {
  if (!step || !permissions) return false;
  const keys = STEP_ACTION_PERMISSIONS[step.id];
  if (!keys) return false; // เช่น รอวันแผนรถเข้า — ไม่มีใครกดได้
  if (permissions.isAdminSystem) return true;
  return keys.some((key) => Boolean(permissions[key]));
};

// from src/utils/carRegistry.js
const getStageVisualData = (item, currentRole = 'ADMIN_WAREHOUSE', permissions = null) => {
  if (!item) return { label: '-', circleClass: '', badgeStyle: '', statusKey: 'UNKNOWN' };

  if (isCancelledPo(item)) {
    return {
      label: WORDING.STATUS.CANCELLED,
      circleClass: 'bg-rose-500 text-white shadow-xs',
      badgeStyle: 'bg-rose-50 text-rose-700 border border-rose-200',
      statusKey: 'CANCELLED',
    };
  }

  const isCompleted = isPoCompletedForRole(item, currentRole);
  if (isCompleted) {
    return {
      label: WORDING.STATUS.COMPLETED,
      circleClass: 'bg-emerald-600 text-white shadow-xs',
      badgeStyle: 'bg-emerald-50 text-emerald-700 border border-emerald-200',
      statusKey: 'COMPLETED',
    };
  }

  const activeSteps = getPoActiveSteps(item);
  const normalizedUserRole = normalizeRole(currentRole);
  const perms = permissions || getRolePermissions(currentRole);
  const hasOurStep = activeSteps.some((step) => step.role === normalizedUserRole || canActOnStep(step, perms));

  if (hasOurStep) {
    return {
      label: WORDING.STATUS.WAITING_OUR_ACTION,
      circleClass: 'bg-amber-500 text-white shadow-xs',
      badgeStyle: 'bg-amber-50 text-amber-800 border border-amber-300',
      statusKey: 'WAITING_OUR_ACTION',
    };
  }

  const isWaitingDate = activeSteps.some((step) => step.role === 'WAITING_DATE') || isWaitingForDeliveryDate(item);
  if (isWaitingDate) {
    return {
      label: WORDING.STATUS.WAITING_DELIVERY_DATE,
      circleClass: 'bg-teal-600 text-white shadow-xs',
      badgeStyle: 'bg-teal-50 text-teal-800 border border-teal-300',
      statusKey: 'WAITING_DELIVERY_DATE',
    };
  }

  return {
    label: WORDING.STATUS.WAITING_OTHER_ACTION,
    circleClass: 'bg-[#084F6A] text-white shadow-xs',
    badgeStyle: 'bg-sky-50 text-[#084F6A] border border-sky-200',
    statusKey: 'WAITING_OTHER_ACTION',
  };
};

module.exports = {
  PO_FIELD_ALIASES,
  readPath,
  readFirst,
  getTruckArrival,
  getTruckDeparture,
  getPickStart,
  getPickFinish,
  getLoadStart,
  getLoadFinish,
  getDockDoorCode,
  getShipToName,
  getLicensePlate,
  formatDisplayTime,
  getCurrentShiftDate,
  getShiftTimeRange,
  isPoInShift,
  SHIFT_START_HOUR,
  cleanDisplayName,
  isCancelledPo,
  isCompletedPo,
  getPoStatus,
  isPoCompletedForRole,
  isPoDataIncomplete,
  isWaitingForDeliveryDate,
  checkIsCarRegistered,
  normalizeRole,
  getPoProgressFlags,
  getPoActiveSteps,
  STEP_ACTION_PERMISSIONS,
  canActOnStep,
  getStageVisualData,
};
