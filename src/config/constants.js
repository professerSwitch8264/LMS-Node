const TABLES = {
  CUSTOMER: 'Customer',
  DOCK_DOOR: 'Dock_door',
  RECEIVED: 'Received', // ตารางเดิม — ย้ายไป PO / PO_Transaction แล้ว (config/poSchema.js) ใช้เฉพาะตอน migrate
  PO: 'PO',
  PO_TRANSACTION: 'PO_Transaction',
  PO_CURRENT_VIEW: 'V_PO_Current', // PO + รอบปัจจุบัน ชื่อคอลัมน์เดียวกับ Received เดิม (ใช้อ่านเท่านั้น)
  UOM: 'Uom', // หน่วยนับ (uom_code + uom_name)
  CANCEL_REASON: 'Cancel_reason', // เหตุผลยกเลิก PO (reason_name)
  RESCHEDULE_REASON: 'Reschedule_reason', // เหตุผลเลื่อนแผนรถเข้า (reason_name)
  PO_ROUND_VIEW: 'V_PO_Round', // PO + ทุกรอบ (ประวัติเลื่อนแผน / Excel)
  SHIP_TO: 'Ship_to',
  TRUCK: 'Truck',
  WAREHOUSE: 'Warehouse',
  ROLE_PERMISSION: 'Role_permission',
  USER: 'User',
  TRANSACTION_LOG: 'Transaction_log',
  SETTING: 'Setting', // ค่าตั้งด้านความปลอดภัยการเข้าสู่ระบบ (services/settingsService)
  LEGACY_SETTING: 'App_setting', // ชื่อเดิม ใช้เปลี่ยนชื่อตารางอัตโนมัติ (initSettings)
  LEGACY_AUDIT_LOG: 'Audit_log', // ชื่อเดิม ใช้เปลี่ยนชื่อตารางอัตโนมัติ (ensureTransactionLogTable)
};

const DASHBOARD_TYPES = {
  TRUCK: 'TRUCK',
  WAREHOUSE: 'WAREHOUSE',
  OVERVIEW: 'OVERVIEW',
};

const getDefaultDashboardType = (roleId) => {
  const r = String(roleId || '').toUpperCase();
  if (r.includes('YUSEN') || r.includes('CAR_REGISTER') || r.includes('TRUCKER')) return DASHBOARD_TYPES.TRUCK;
  if (r.includes('LEADER') || r.includes('PICK') || r.includes('LOAD') || r === 'ADMIN_OUTSIDE') return DASHBOARD_TYPES.WAREHOUSE;
  return DASHBOARD_TYPES.OVERVIEW;
};

const normalizeDashboardType = (value) => {
  const v = String(value || '').trim().toUpperCase();
  return Object.values(DASHBOARD_TYPES).includes(v) ? v : null;
};

module.exports = {
  TABLES,
  DASHBOARD_TYPES,
  getDefaultDashboardType,
  normalizeDashboardType,
};
