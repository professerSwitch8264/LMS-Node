// ทำ permissions_json ของทุก role ให้มี key สิทธิ์ครบเท่ากัน (เติม key ที่ขาดเป็น false, ตัด key ที่ไม่ใช่สิทธิ์ทิ้ง)
//
//   node scripts/normalize-role-permissions.js            → dry-run: แสดงสิ่งที่จะเปลี่ยน ไม่เขียนอะไร
//   node scripts/normalize-role-permissions.js --apply    → เขียนลงฐานข้อมูล (ใน transaction เดียว)
//
// ใช้ฐานข้อมูลตาม DB_NAME ใน .env (ตั้ง DB_NAME=... ก่อนรันเพื่อเลือกฐานอื่น)
// ถ้าสิทธิ์ที่ใช้ได้จริงของ role ไหนจะเปลี่ยน script จะแจ้งเตือนและไม่ยอม --apply
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { sql, getPool } = require('../src/config/db');
const { TABLES } = require('../src/config/constants');
const { parsePermissionsJson, getEffectivePermissions } = require('../src/services/permissionService');
const { PERMISSION_KEYS, sanitizePermissions, DEFAULT_SHEET3_PERMISSIONS } = require('../src/controllers/permissionController');

const apply = process.argv.includes('--apply');

const effectiveChanges = (roleId, before, after) => {
  const a = getEffectivePermissions(roleId, before, DEFAULT_SHEET3_PERMISSIONS);
  const b = getEffectivePermissions(roleId, after, DEFAULT_SHEET3_PERMISSIONS);
  if (a.isAdminSystem || b.isAdminSystem) return [];
  return PERMISSION_KEYS
    .filter((k) => Boolean(a.perms[k]) !== Boolean(b.perms[k]))
    .map((k) => `${k}: ${Boolean(a.perms[k])} → ${Boolean(b.perms[k])}`);
};

(async () => {
  const pool = await getPool();
  const { recordset } = await pool.request().query(`SELECT role_id, permissions_json FROM ${TABLES.ROLE_PERMISSION} ORDER BY role_id`);

  const updates = [];
  let blocked = false;
  console.log(`ฐานข้อมูล: ${process.env.DB_NAME || 'LMS'} | สิทธิ์ทั้งหมด ${PERMISSION_KEYS.length} key | โหมด: ${apply ? 'APPLY' : 'dry-run'}\n`);

  for (const row of recordset) {
    const before = parsePermissionsJson(row.permissions_json) || {};
    const after = sanitizePermissions(before);
    const added = PERMISSION_KEYS.filter((k) => !(k in before));
    const removed = Object.keys(before).filter((k) => !PERMISSION_KEYS.includes(k));
    const coerced = PERMISSION_KEYS.filter((k) => k in before && before[k] !== true && before[k] !== false);
    const changes = effectiveChanges(row.role_id, before, after);

    const same = JSON.stringify(before) === JSON.stringify(after);
    console.log(`${row.role_id}: ${Object.keys(before).length} → ${PERMISSION_KEYS.length} key${same ? ' (ไม่ต้องแก้)' : ''}`);
    if (added.length) console.log(`  เติม false: ${added.join(', ')}`);
    if (removed.length) console.log(`  ลบทิ้ง: ${removed.join(', ')}`);
    if (coerced.length) console.log(`  ค่าไม่ใช่ true/false (จะเป็น false): ${coerced.map((k) => `${k}=${JSON.stringify(before[k])}`).join(', ')}`);
    if (changes.length) {
      blocked = true;
      console.log(`  ⚠️ สิทธิ์ที่ใช้ได้จริงจะเปลี่ยน: ${changes.join(', ')}`);
    }
    if (!same) updates.push({ roleId: row.role_id, json: JSON.stringify(after) });
  }

  console.log(`\nจะแก้ ${updates.length} role`);
  if (blocked) {
    console.log('⚠️ มี role ที่สิทธิ์ใช้งานจริงจะเปลี่ยน — ตรวจสอบในหน้ากำหนดสิทธิ์ก่อน ไม่ได้เขียนอะไรลงฐานข้อมูล');
    process.exit(2);
  }
  if (!apply) {
    console.log('dry-run: ยังไม่ได้เขียนอะไร — รันซ้ำพร้อม --apply เพื่อบันทึก');
    process.exit(0);
  }

  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    for (const u of updates) {
      await new sql.Request(tx)
        .input('role_id', u.roleId)
        .input('json', u.json)
        .query(`UPDATE ${TABLES.ROLE_PERMISSION} SET permissions_json = @json, updated_at = GETDATE() WHERE role_id = @role_id`);
    }
    await tx.commit();
    console.log(`✅ บันทึกแล้ว ${updates.length} role — restart backend เพื่อล้าง cache สิทธิ์`);
    process.exit(0);
  } catch (err) {
    await tx.rollback();
    console.error('❌ บันทึกไม่สำเร็จ ยกเลิกทั้งหมด:', err.message);
    process.exit(1);
  }
})().catch((err) => {
  console.error('❌', err.message);
  process.exit(1);
});
