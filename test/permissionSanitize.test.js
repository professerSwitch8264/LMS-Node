// ทดสอบการกรองสิทธิ์ก่อนบันทึก — ไม่ต้องใช้ฐานข้อมูล
process.env.DB_USER = process.env.DB_USER || 'test';
process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'test';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { PERMISSION_KEYS, sanitizePermissions } = require('../src/controllers/permissionController');

describe('sanitizePermissions', () => {
  it('always returns every permission key (45)', () => {
    assert.equal(PERMISSION_KEYS.length, 45);
    const clean = sanitizePermissions({ canAddPo: true });
    assert.deepEqual(Object.keys(clean), [...PERMISSION_KEYS]);
  });

  it('fills missing keys with false', () => {
    const clean = sanitizePermissions({ canEditCarPlan: true });
    assert.equal(clean.canEditCarPlan, true);
    assert.equal(clean.canActionPicking, false);
    assert.equal(clean.canEditDockDoor, false);
  });

  it('drops keys that are not permissions', () => {
    const clean = sanitizePermissions({ role_id: 'ADMIN_WAREHOUSE', role_name: 'X', view_mode: 'PC', canAddPo: true });
    assert.equal('role_id' in clean, false);
    assert.equal('role_name' in clean, false);
    assert.equal('view_mode' in clean, false);
  });

  it('only an actual true counts as allowed', () => {
    const clean = sanitizePermissions({ canEditCarPlan: 'true', canActionPicking: 1, canActionLoading: null, canEditDockDoor: true });
    assert.equal(clean.canEditCarPlan, false);
    assert.equal(clean.canActionPicking, false);
    assert.equal(clean.canActionLoading, false);
    assert.equal(clean.canEditDockDoor, true);
  });

  it('handles empty or invalid input', () => {
    assert.ok(Object.values(sanitizePermissions(null)).every((v) => v === false));
    assert.ok(Object.values(sanitizePermissions('x')).every((v) => v === false));
  });

  it('add/import/urgent/cancel/reschedule always follow "จัดการข้อมูล PO" (canEditPoData)', () => {
    const on = sanitizePermissions({ canEditPoData: true, canCancelPo: false });
    ['canAddPo', 'canImportPo', 'canSetUrgentPo', 'canCancelPo', 'canReschedulePo'].forEach((k) => assert.equal(on[k], true, k));
    const off = sanitizePermissions({ canEditPoData: false, canCancelPo: true, canAddPo: true });
    ['canAddPo', 'canImportPo', 'canSetUrgentPo', 'canCancelPo', 'canReschedulePo'].forEach((k) => assert.equal(off[k], false, k));
  });

  it('effective permissions derive the same way', () => {
    const { getEffectivePermissions } = require('../src/services/permissionService');
    assert.equal(getEffectivePermissions('X', { canEditPoData: true, canCancelPo: false }).perms.canCancelPo, true);
    assert.equal(getEffectivePermissions('X', { canEditPoData: false, canCancelPo: true }).perms.canCancelPo, false);
  });
});
