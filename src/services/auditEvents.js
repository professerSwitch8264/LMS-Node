// รายการ Audit log ของแต่ละ endpoint — สร้างจากข้อมูลที่ส่งมา (req.body/params) และผลที่ handler ตอบกลับ
// ชื่อ action_type ต้องคงเดิม เพราะหน้า PO ใช้หาว่าใครบันทึกแต่ละขั้น (getStepUpdaterUsername)
const str = (v) => (v === null || v === undefined ? '' : String(v).trim());
const upper = (v) => str(v).toUpperCase();

const thaiDate = (value) => {
  const s = str(value);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    const y = Number(m[1]);
    return `${m[3]}/${m[2]}/${y > 2400 ? y : y + 543}`;
  }
  return /^\d{2}\/\d{2}\/\d{4}$/.test(s) ? s : '';
};
const hhmm = (value) => {
  const m = str(value).match(/(?:^|[T\s])(\d{1,2}):(\d{2})/);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : '';
};
const dateTimeText = (date, time) => {
  const d = thaiDate(date);
  const t = hhmm(time) || hhmm(date);
  if (!d && !t) return '-';
  return t ? `${d ? `${d} ` : ''}${t} น.` : d;
};
const poLabel = (po) => (upper(po).startsWith('PO') ? str(po) : `PO ${str(po)}`);

// PO ที่ handler แจ้งว่าไม่พบ ไม่ต้องบันทึก
const succeededPoNos = (req, body) => {
  const list = Array.isArray(req.body?.poNos) ? req.body.poNos : (req.body?.poNo ? [req.body.poNo] : []);
  const notFound = new Set((Array.isArray(body?.notFound) ? body.notFound : []).map(upper));
  return [...new Set(list.map(str).filter(Boolean))].filter((p) => !notFound.has(upper(p)));
};

const TASK_TITLES = {
  pickStart: 'เริ่มหยิบสินค้า',
  pickFinish: 'หยิบสินค้าเสร็จ',
  loadStart: 'เริ่มโหลดสินค้า',
  loadFinish: 'โหลดสินค้าเสร็จ',
};

const PO = {
  saveCarPlan: (req) => {
    const b = req.body || {};
    return {
      actionType: 'SAVE_CAR_PLAN',
      actionTitle: 'ลงแผนรถเข้า',
      poNo: b.poNo,
      details: `ทะเบียน ${str(b.licensePlate) || '-'} คนขับ ${str(b.driverName) || '-'} โทร ${str(b.driverTel) || '-'} เวลารถเข้า ${dateTimeText(b.registerDate, b.registerTime)}`,
    };
  },

  // รถเข้า: หน้าเว็บส่งแค่ poNo จึงไม่มีทะเบียนรถในรายละเอียด
  truckArrival: (req) => ({
    actionType: 'TRUCK_ARRIVAL',
    actionTitle: 'บันทึกเวลารถเข้า',
    poNo: req.body?.poNo,
    details: 'บันทึกรถเข้าโรงงานเรียบร้อย',
  }),

  cancel: (req, body) => {
    const reason = str(req.body?.reason || req.body?.cancelReason || req.body?.cancleReason) || '-';
    return succeededPoNos(req, body).map((poNo) => ({
      actionType: 'CANCEL_PO',
      actionTitle: 'ยกเลิก PO',
      poNo,
      details: `ยกเลิกรายการ PO เนื่องจาก: ${reason}`,
    }));
  },

  reschedule: (req, body) => {
    const b = req.body || {};
    return succeededPoNos(req, body).map((poNo) => ({
      actionType: 'RESCHEDULE_PO',
      actionTitle: 'เลื่อนเวลารถเข้า',
      poNo,
      details: `เลื่อนเวลารถเข้าเป็น ${dateTimeText(b.rescheduleDate, b.rescheduleTime)} เหตุผล: ${str(b.rescheduleReason) || '-'}`,
    }));
  },

  officeSave: (req) => {
    const b = req.body || {};
    const isNew = !b.receivedId;
    const rawQty = str(b.quantityOrder);
    const qty = rawQty && !Number.isNaN(Number(rawQty)) ? Number(rawQty).toLocaleString('th-TH') : rawQty;
    const qtyText = qty ? `${qty}${str(b.quantityUom) ? ` ${str(b.quantityUom)}` : ''}` : '-';
    return {
      actionType: isNew ? 'CREATE_PO' : 'UPDATE_PO',
      actionTitle: isNew ? 'เพิ่มข้อมูล PO' : 'แก้ไขข้อมูล PO',
      poNo: b.poNo,
      details: `${isNew ? 'สร้าง' : 'แก้ไข'} PO ${str(b.poNo)} สถานที่จัดส่ง ${str(b.shipToName || b.toLocation) || '-'} จำนวน ${qtyText}`,
    };
  },

  officeImport: (req, body) => {
    const total = Array.isArray(req.body?.items) ? req.body.items.length : 0;
    const imported = Number(body?.imported) || 0;
    return {
      actionType: 'IMPORT_PO',
      actionTitle: 'นำเข้าข้อมูล PO',
      details: `นำเข้าไฟล์สำเร็จ ${imported} รายการ (จากทั้งหมด ${total} รายการ)`,
    };
  },

  assignDock: (req) => ({
    actionType: 'ASSIGN_DOCK',
    actionTitle: 'เลือกประตูโหลด',
    poNo: req.body?.poNo,
    details: `เลือกประตูโหลด ${str(req.body?.dockDoorName) || str(req.body?.dockDoorCode) || '-'}`,
  }),

  issueTicket: (req) => ({
    actionType: 'ISSUE_TICKET',
    actionTitle: 'บันทึกเวลาออกตั๋ว',
    poNo: req.body?.poNo,
    details: 'บันทึกเวลาออกตั๋วเรียบร้อย',
  }),

  sendLcTicket: (req, body) => succeededPoNos(req, body).map((poNo) => ({
    actionType: 'SEND_LC_TICKET',
    actionTitle: 'บันทึกเวลา LC ส่งตั๋ว',
    poNo,
    details: 'บันทึกเวลา LC ส่งตั๋วเรียบร้อย',
  })),

  // หน้าเว็บส่งเวลาทุกขั้นมาพร้อมกัน จึงบอกขั้นที่กดผ่าน taskId (รับเฉพาะชื่อที่กำหนดไว้)
  outsideTask: (req) => {
    const taskId = str(req.body?.taskId);
    const title = TASK_TITLES[taskId];
    if (!title) return null;
    return {
      actionType: `ACTION_${taskId.toUpperCase()}`,
      actionTitle: `บันทึกเวลา ${title}`,
      poNo: req.body?.poNo,
      details: `บันทึกเวลา ${title} สำเร็จ`,
    };
  },

  setUrgent: (req) => {
    const on = Boolean(req.body?.isUrgent);
    const poNos = (Array.isArray(req.body?.poNos) ? req.body.poNos : []).map(str).filter(Boolean);
    const targets = poNos.length > 0
      ? poNos.map((p) => ({ poNo: p, label: poLabel(p) }))
      : (Array.isArray(req.body?.receivedIds) ? req.body.receivedIds : []).map((id) => ({ poNo: null, label: `รายการ ${str(id)}` }));
    return targets.map(({ poNo, label }) => ({
      actionType: 'SET_URGENT_PO',
      actionTitle: on ? 'กำหนดส่งด่วน' : 'ยกเลิกส่งด่วน',
      poNo,
      details: `${on ? 'เปิด' : 'ปิด'}สถานะส่งด่วน ${label}`,
    }));
  },
};

const doorLabel = (req) => str(req.body?.dockDoorCode || req.body?.code || req.params?.id || req.body?.dockDoorId || req.body?.id) || '-';

const DOOR = {
  create: (req) => ({
    actionType: 'CREATE_DOCK_DOOR',
    actionTitle: 'เพิ่มประตูโหลดใหม่',
    details: `เพิ่มประตู ${str(req.body?.dockDoorCode || req.body?.code)} ${str(req.body?.dockDoorName || req.body?.name)}`.trim(),
  }),
  toggleLock: (req) => {
    const locking = Boolean(req.body?.isLocked);
    return {
      actionType: locking ? 'DOOR_LOCK' : 'DOOR_UNLOCK',
      actionTitle: locking ? 'ล็อคประตูโหลด' : 'ปลดล็อคประตูโหลด',
      details: `${locking ? 'สั่งล็อค' : 'สั่งปลดล็อค'} ประตู ${doorLabel(req)}`,
    };
  },
  batchLock: (req) => {
    const locking = Boolean(req.body?.isLocked);
    return {
      actionType: locking ? 'DOOR_LOCK' : 'DOOR_UNLOCK',
      actionTitle: locking ? 'ล็อคประตูโหลด' : 'ปลดล็อคประตูโหลด',
      details: `${locking ? 'สั่งล็อค' : 'สั่งปลดล็อค'}ประตูที่ว่างทั้งหมด`,
    };
  },
  remove: (req) => ({
    actionType: 'DELETE_DOCK_DOOR',
    actionTitle: 'ลบประตูโหลดสินค้า',
    details: `ลบประตู ${doorLabel(req)}`,
  }),
  restore: (req) => ({
    actionType: 'RESTORE_DOCK_DOOR',
    actionTitle: 'กู้คืนประตูโหลดสินค้า',
    details: `กู้คืนประตู ${doorLabel(req)}`,
  }),
};

const roleOf = (req) => upper(req.params?.roleId || req.body?.roleId || req.body?.role_id) || '-';

const ROLE = {
  update: (req) => ({
    actionType: 'UPDATE_PERMISSION',
    actionTitle: 'บันทึกการกำหนดสิทธิ์',
    details: `บันทึกการกำหนดสิทธิ์ของ ${str(req.body?.role_name) || roleOf(req)}`,
  }),
  create: (req) => ({
    actionType: 'CREATE_ROLE',
    actionTitle: 'สร้างกลุ่มผู้ใช้งานใหม่',
    details: `สร้างกลุ่มผู้ใช้งาน ${str(req.body?.role_name)} (${roleOf(req)})`,
  }),
  remove: (req) => ({
    actionType: 'DELETE_ROLE',
    actionTitle: 'ลบกลุ่มผู้ใช้งาน',
    details: `ลบกลุ่มผู้ใช้งาน ${roleOf(req)}`,
  }),
  reset: (req) => ({
    actionType: 'RESET_PERMISSION',
    actionTitle: 'คืนค่าสิทธิ์เริ่มต้น',
    details: `คืนค่าสิทธิ์ของ ${roleOf(req) === '-' ? 'ทุกกลุ่มผู้ใช้งาน' : roleOf(req)} กลับเป็นค่าเริ่มต้น`,
  }),
};

const targetUser = (req) => upper(req.params?.username || req.body?.username) || '-';

const USER = {
  create: (req) => {
    const nameTh = str(req.body?.name_th);
    return {
      actionType: 'CREATE_USER',
      actionTitle: 'เพิ่มผู้ใช้งาน',
      details: `เพิ่มผู้ใช้งาน ${targetUser(req)}${nameTh ? ` (${nameTh})` : ''} กลุ่มผู้ใช้งาน ${upper(req.body?.role_id) || '-'}`,
    };
  },
  update: (req) => ({
    actionType: 'UPDATE_USER',
    actionTitle: 'แก้ไขข้อมูลผู้ใช้งาน',
    details: `แก้ไขข้อมูลของ ${targetUser(req)}${req.body?.role_id ? ` กลุ่มผู้ใช้งาน ${upper(req.body.role_id)}` : ''}`,
  }),
  resetPassword: (req, body) => ({
    actionType: 'RESET_PASSWORD_REQUEST',
    actionTitle: 'ส่งลิงก์ตั้งรหัสผ่านใหม่',
    details: `ส่งลิงก์ตั้งรหัสผ่านใหม่ให้ผู้ใช้งาน ${targetUser(req)}${body?.data?.email ? ` (${body.data.email})` : ''}`,
  }),
  remove: (req) => ({
    actionType: 'DELETE_USER',
    actionTitle: 'ลบผู้ใช้งาน',
    details: `ลบผู้ใช้งาน ${targetUser(req)}`,
  }),
};

module.exports = { PO, DOOR, ROLE, USER, TASK_TITLES, dateTimeText };
