// ตาราง PO (หน้า "ตาราง PO"): ค้นหา / กรอง / เรียง / แบ่งหน้าที่ server
// กฎสถานะ, สถานะไอคอน (รอเรา / รอฝ่ายอื่น), กะ และชื่อ field มาจากโค้ดหน้าเว็บผ่าน shared/poRules.generated.js
// ส่วนตัวกรองตาม field และการเรียง คัดลอกมาจาก PoDataTable.jsx เดิม (ผลเหมือนเดิม)
const {
  isCancelledPo,
  isCompletedPo,
  getPoStatus,
  getStageVisualData,
  isPoInShift,
  cleanDisplayName,
  formatDisplayTime,
  getShipToName,
  getLicensePlate,
  getTruckArrival,
  getDockDoorCode,
} = require('../shared/poRules.generated');

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const MAX_EXPORT_ROWS = 20000;

const str = (v) => (v === null || v === undefined ? '' : String(v));
const lower = (v) => str(v).trim().toLowerCase();

// 'YYYY-MM-DD' → Date เวลาเที่ยงคืนตามเวลาเครื่อง (เหมือนวันที่ที่หน้าเว็บเลือก)
const parseDay = (value) => {
  const m = str(value).trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
};

/** แปลง query string เป็นเงื่อนไขของตาราง */
function parseTableQuery(query = {}) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(query.pageSize, 10) || DEFAULT_PAGE_SIZE));
  const start = parseDay(query.dateStart);
  const end = parseDay(query.dateEnd);
  let date = null;
  if (start && end && start.getTime() !== end.getTime()) date = { startDate: start, endDate: end };
  else if (start || end) date = start || end;
  return {
    search: str(query.q).trim(),
    customerName: str(query.customerName).trim(),
    warehouseName: str(query.warehouseName).trim(),
    shipToName: str(query.shipToName).trim(),
    status: str(query.status).trim() || 'ALL',
    stageIconStatus: str(query.stageIconStatus).trim() || 'ALL',
    date,
    sortField: str(query.sortField).trim() || 'poNo',
    sortAsc: str(query.sortDir).toLowerCase() !== 'desc',
    page,
    pageSize,
    exportAll: query.all === '1' || query.all === 'true',
  };
}

/** ตัวกรอง — เหมือน filteredList ใน PoDataTable.jsx เดิม */
function matchesTableFilters(item, filters, viewer) {
  if (filters.status && filters.status !== 'ALL') {
    const status = getPoStatus(item);
    if (filters.status === 'IN_PROGRESS' && (isCancelledPo(item) || isCompletedPo(item))) return false;
    if (filters.status === 'COMPLETED' && (!isCompletedPo(item) || isCancelledPo(item))) return false;
    if (filters.status === 'CANCELLED' && !isCancelledPo(item)) return false;
    if (!['IN_PROGRESS', 'COMPLETED', 'CANCELLED'].includes(filters.status) && status.key !== filters.status) return false;
  }
  if (filters.customerName && !lower(item.customerName || item.customerCode).includes(filters.customerName.toLowerCase())) return false;
  if (filters.warehouseName && !lower(item.warehouseName || item.warehouseCode).includes(filters.warehouseName.toLowerCase())) return false;
  if (filters.shipToName && !lower(getShipToName(item)).includes(filters.shipToName.toLowerCase())) return false;
  if (filters.date && !isPoInShift(item, filters.date)) return false;
  if (filters.stageIconStatus && filters.stageIconStatus !== 'ALL') {
    // สถานะไอคอนดูตามสิทธิ์ของผู้ที่เปิดตาราง (เหมือนรายการ PO)
    const stage = getStageVisualData(item, viewer.role, viewer.permissions);
    if (stage.statusKey !== filters.stageIconStatus) return false;
  }
  const q = filters.search.toLowerCase();
  if (q) {
    const fields = [
      item.poNo,
      item.customerName || item.customerCode,
      getShipToName(item),
      getLicensePlate(item),
      item.driverName || item.driver_name,
      item.warehouseName || item.warehouseCode,
      item.dockDoorName || getDockDoorCode(item),
    ];
    if (!fields.some((v) => lower(v).includes(q))) return false;
  }
  return true;
}

// ---------- การเรียง (เหมือน getSortValue / sortedList ใน PoDataTable.jsx เดิม) ----------
const parseDateToTimestamp = (dVal) => {
  if (!dVal) return 0;
  if (dVal instanceof Date) return isNaN(dVal.getTime()) ? 0 : dVal.getTime();
  const s = String(dVal).trim();
  if (!s) return 0;
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) {
    const [d, m, y] = s.split('/').map(Number);
    const actualY = y > 2400 ? y - 543 : y;
    return new Date(actualY, m - 1, d).getTime();
  }
  const parsed = new Date(s);
  return isNaN(parsed.getTime()) ? 0 : parsed.getTime();
};

const parseTimeToMinutes = (tVal) => {
  if (!tVal) return -1;
  const s = String(tVal).trim();
  if (!s || s === '-') return -1;
  const match = s.match(/(\d{1,2}):(\d{2})/);
  if (match) return parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
  const parsed = new Date(s);
  if (!isNaN(parsed.getTime())) return parsed.getHours() * 60 + parsed.getMinutes();
  return -1;
};

const getSortValue = (item, field) => {
  switch (field) {
    case 'poNo': return item.poNo || '';
    case 'status': return getPoStatus(item).label || '';
    case 'customer': return cleanDisplayName(item.customerName || item.customerCode || '');
    case 'shipTo': return cleanDisplayName(getShipToName(item) || '');
    case 'qty': return Number(item.quantityOrder || item.quantity || 0);
    case 'warehouse': return cleanDisplayName(item.warehouseName || item.warehouseCode || '');
    case 'shipDate': return parseDateToTimestamp(item.shipDatePlan || item.planDate || item.plan_date);
    case 'ticketSent': return parseTimeToMinutes(item.orderDate || item.ticketDate || item.order_date);
    case 'truckType': return item.truckTypeName || item.truckType || '';
    case 'licensePlate': return getLicensePlate(item) || '';
    case 'driverName': return item.driverName || item.driver_name || '';
    case 'planTime': return parseTimeToMinutes(item.planTime || item.registerTime || formatDisplayTime(item.planDate));
    case 'truckArrival': return parseTimeToMinutes(getTruckArrival(item));
    case 'dockDoor': return cleanDisplayName(item.dockDoorName || getDockDoorCode(item) || '');
    case 'ticketOut': return parseTimeToMinutes(item.ticketIssue || item.ticketDate);
    case 'pickingTime': return parseTimeToMinutes(item.pickStart);
    case 'loadingTime': return parseTimeToMinutes(item.loadStart);
    case 'truckDeparture': return parseTimeToMinutes(item.truckDeparture || item.truckDepart);
    default: return item[field] || '';
  }
};

const compareRows = (sortField, sortAsc) => (a, b) => {
  const valA = getSortValue(a, sortField);
  const valB = getSortValue(b, sortField);
  let cmp;
  if (typeof valA === 'number' && typeof valB === 'number') {
    const isEmptyA = valA <= 0;
    const isEmptyB = valB <= 0;
    if (isEmptyA && isEmptyB) cmp = 0;
    else if (isEmptyA) return 1; // ค่าว่างอยู่ท้ายเสมอ ไม่ว่าจะเรียงทางไหน
    else if (isEmptyB) return -1;
    else cmp = valA - valB;
  } else {
    const strA = String(valA || '').trim();
    const strB = String(valB || '').trim();
    if (!strA && !strB) cmp = 0;
    else if (!strA) return 1;
    else if (!strB) return -1;
    else cmp = strA.localeCompare(strB, 'th', { numeric: true, sensitivity: 'base' });
  }
  if (cmp !== 0) return sortAsc ? cmp : -cmp;
  return String(a.poNo || '').localeCompare(String(b.poNo || ''), undefined, { numeric: true });
};

// ตัวเลือกในหน้าต่างตัวกรอง (ลูกค้า / คลัง / สถานที่ส่ง) จาก PO ทั้งหมด — เหมือนเดิม
const distinctSorted = (pos, pick) => {
  const set = new Set();
  pos.forEach((p) => {
    const v = cleanDisplayName(pick(p) || '');
    if (v && v !== '-') set.add(v);
  });
  return Array.from(set).sort((a, b) => a.localeCompare(b, 'th'));
};

/**
 * pos = PO ทั้งหมด (จาก loadAllPos), filters = parseTableQuery(...), viewer = { role, permissions }
 * คืน { rows, total, page, pageSize, totalPages, options }
 */
function queryPoTable(pos, filters, viewer) {
  const matched = pos.filter((item) => matchesTableFilters(item, filters, viewer)).sort(compareRows(filters.sortField, filters.sortAsc));
  const total = matched.length;
  const options = {
    customers: distinctSorted(pos, (p) => p.customerName || p.customerCode),
    warehouses: distinctSorted(pos, (p) => p.warehouseName || p.warehouseCode),
    locations: distinctSorted(pos, (p) => getShipToName(p)),
  };
  if (filters.exportAll) {
    return { rows: matched.slice(0, MAX_EXPORT_ROWS), total, page: 1, pageSize: total, totalPages: 1, options };
  }
  const totalPages = Math.max(1, Math.ceil(total / filters.pageSize));
  const page = Math.min(filters.page, totalPages);
  const startIdx = (page - 1) * filters.pageSize;
  return { rows: matched.slice(startIdx, startIdx + filters.pageSize), total, page, pageSize: filters.pageSize, totalPages, options };
}

module.exports = { parseTableQuery, matchesTableFilters, queryPoTable, getSortValue, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE };
