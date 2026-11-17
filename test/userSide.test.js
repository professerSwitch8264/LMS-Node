// ฝ่ายของผู้ใช้ (DX / WANTHAI / YUSEN) และการกรองประวัติตามฝ่ายของผู้บันทึก — ไม่ต้องใช้ฐานข้อมูล
process.env.DB_USER = process.env.DB_USER || 'test';
process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'test';
process.env.LOG_LEVEL = 'error';
process.env.MFA_ENCRYPTION_KEY = process.env.MFA_ENCRYPTION_KEY || require('crypto').randomBytes(32).toString('base64');

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeUserGroup } = require('../src/controllers/userController');
const { visibleSides, sidesWhereSql } = require('../src/controllers/auditLogController');

describe('normalizeUserGroup', () => {
  it('accepts the 3 sides', () => {
    assert.equal(normalizeUserGroup('dx'), 'DX');
    assert.equal(normalizeUserGroup('WANTHAI'), 'WANTHAI');
    assert.equal(normalizeUserGroup(' yusen '), 'YUSEN');
  });
  it('guesses from the role when no side is given', () => {
    assert.equal(normalizeUserGroup('', 'ADMIN_SYSTEM'), 'DX');
    assert.equal(normalizeUserGroup(undefined, 'YUSEN_TRUCKER'), 'YUSEN');
    assert.equal(normalizeUserGroup(null, 'ADMIN_WAREHOUSE'), 'WANTHAI');
    assert.equal(normalizeUserGroup('SOMETHING_ELSE', 'LEADER_WAREHOUSE_PICKER'), 'WANTHAI');
  });
  it('an explicit side wins over the role', () => {
    assert.equal(normalizeUserGroup('WANTHAI', 'ADMIN_SYSTEM'), 'WANTHAI');
  });
});

describe('audit log: sides the viewer can see', () => {
  const perms = (p) => ({ isAdminSystem: false, perms: p });
  it('ADMIN_SYSTEM sees every side', () => {
    assert.deepEqual(visibleSides({ isAdminSystem: true, perms: {} }), ['DX', 'WANTHAI', 'YUSEN']);
  });
  it('only the sides that are not switched off (not set = visible, like before)', () => {
    assert.deepEqual(visibleSides(perms({ canViewAuditLogDx: false, canViewAuditLogWanthai: true, canViewAuditLogYusen: false })), ['WANTHAI']);
    assert.deepEqual(visibleSides(perms({ canViewAuditLogDx: false })), ['WANTHAI', 'YUSEN']);
    assert.deepEqual(visibleSides(perms({ canViewAuditLogDx: false, canViewAuditLogWanthai: false, canViewAuditLogYusen: false })), []);
  });
  it('DX must be switched on explicitly: roles saved before the DX permission existed do not see DX entries', () => {
    // role เดิมในฐานข้อมูล: มีแค่ 2 key เดิม ไม่มี canViewAuditLogDx
    assert.deepEqual(visibleSides(perms({ canViewAuditLogWanthai: true, canViewAuditLogYusen: true })), ['WANTHAI', 'YUSEN']);
    assert.deepEqual(visibleSides(perms({})), ['WANTHAI', 'YUSEN']);
    assert.deepEqual(visibleSides(perms({ canViewAuditLogDx: true })), ['DX', 'WANTHAI', 'YUSEN']);
  });
  it('the side filter narrows within what is allowed, never beyond', () => {
    const p = perms({ canViewAuditLogDx: false, canViewAuditLogWanthai: true, canViewAuditLogYusen: true });
    assert.deepEqual(visibleSides(p, 'yusen'), ['YUSEN']);
    assert.deepEqual(visibleSides(p, 'DX'), [], 'cannot filter into a side you may not see');
    assert.deepEqual(visibleSides(p, 'ALL'), ['WANTHAI', 'YUSEN']);
  });
  it('SQL: nothing visible → matches no rows; otherwise an IN list of fixed values', () => {
    assert.equal(sidesWhereSql([]), '1=0');
    assert.match(sidesWhereSql(['WANTHAI', 'YUSEN']), /IN \('WANTHAI', 'YUSEN'\)$/);
  });
});
