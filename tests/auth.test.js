// ============================================================
// Unit tests — M1 Auth & Members (controllers/auth.js)
// ใช้ node:test (built-in) + mock database — ไม่แตะ DB จริง
// bcrypt/jwt ใช้ของจริง (เร็วพอสำหรับ unit test, ทดสอบ hash/compare ตามพฤติกรรมจริง)
// รัน:  cd server && npm test
// ============================================================
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const bcrypt = require('bcryptjs');

const calls = [];
let handler = () => ({ rows: [] });

function setHandler(h) { handler = h; }
function reset() { calls.length = 0; handler = () => ({ rows: [] }); }

const mockPool = {
  query: async (sql, params) => { calls.push({ sql, params }); return handler(sql, params); },
};

function injectMock(relPath, exportsObj) {
  const abs = require.resolve(path.join(__dirname, '..', relPath));
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports: exportsObj };
}

injectMock('config/db.js', mockPool);
injectMock('config/secret.js', 'test-secret-for-unit-tests');

const auth = require('../controllers/auth');

function makeRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
const has = (s, frag) => s.includes(frag);

beforeEach(reset);

// ============================================================
// register
// ============================================================
test('register: ไม่ส่ง username → 400', async () => {
  const res = makeRes();
  await auth.register({ body: { password: '123456', full_name: 'ทดสอบ' } }, res);
  assert.equal(res.statusCode, 400);
});

test('register: username ซ้ำ → 400', async () => {
  setHandler((sql) => {
    if (has(sql, 'SELECT username FROM Members')) return { rows: [{ username: 'user1' }] };
    return { rows: [] };
  });
  const res = makeRes();
  await auth.register({ body: { username: 'user1', password: '123456', full_name: 'ทดสอบ' } }, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /already exists/);
});

test('register: สมัครสำเร็จ → 201 + role บังคับเป็น Daily_Tenant เสมอ', async () => {
  setHandler((sql) => {
    if (has(sql, 'SELECT username FROM Members')) return { rows: [] };
    if (sql.trim().startsWith('INSERT INTO Members')) return { rows: [] };
    return { rows: [] };
  });
  const res = makeRes();
  // ส่ง user_role: 'Admin' มาทดสอบว่าระบบไม่ยอมให้ยกระดับสิทธิ์เอง (privilege escalation)
  await auth.register({ body: { username: 'user2', password: '123456', full_name: 'ทดสอบ', user_role: 'Admin' } }, res);
  assert.equal(res.statusCode, 201);
  const insertCall = calls.find((c) => c.sql.trim().startsWith('INSERT INTO Members'));
  assert.equal(insertCall.params[5], 'Daily_Tenant');
});

test('register: เลือก user_role เป็น Monthly_Tenant ตอนสมัคร → เก็บ Monthly_Tenant', async () => {
  setHandler((sql) => {
    if (has(sql, 'SELECT username FROM Members')) return { rows: [] };
    if (sql.trim().startsWith('INSERT INTO Members')) return { rows: [] };
    return { rows: [] };
  });
  const res = makeRes();
  await auth.register({ body: { username: 'user3', password: '123456', full_name: 'ทดสอบ', user_role: 'Monthly_Tenant' } }, res);
  assert.equal(res.statusCode, 201);
  const insertCall = calls.find((c) => c.sql.trim().startsWith('INSERT INTO Members'));
  assert.equal(insertCall.params[5], 'Monthly_Tenant');
});

// ============================================================
// login
// ============================================================
test('login: ไม่ส่ง username/password → 400', async () => {
  const res = makeRes();
  await auth.login({ body: {} }, res);
  assert.equal(res.statusCode, 400);
});

test('login: ไม่พบผู้ใช้ → 400', async () => {
  setHandler(() => ({ rows: [] }));
  const res = makeRes();
  await auth.login({ body: { username: 'nouser', password: '123456' } }, res);
  assert.equal(res.statusCode, 400);
});

test('login: บัญชี social-only (password NULL) → 401', async () => {
  setHandler(() => ({ rows: [{ member_id: 1, username: 'social1', password: null, user_role: 'Daily_Tenant' }] }));
  const res = makeRes();
  await auth.login({ body: { username: 'social1', password: '123456' } }, res);
  assert.equal(res.statusCode, 401);
  assert.match(res.body.message, /Social Login/);
});

test('login: รหัสผ่านผิด → 401', async () => {
  const hashed = await bcrypt.hash('correctpass', 10);
  setHandler(() => ({ rows: [{ member_id: 1, username: 'user1', password: hashed, user_role: 'Daily_Tenant' }] }));
  const res = makeRes();
  await auth.login({ body: { username: 'user1', password: 'wrongpass' } }, res);
  assert.equal(res.statusCode, 401);
});

test('login: ถูกต้อง → คืน token + payload', async () => {
  const hashed = await bcrypt.hash('correctpass', 10);
  setHandler(() => ({ rows: [{ member_id: 1, username: 'user1', password: hashed, user_role: 'Daily_Tenant' }] }));
  const res = makeRes();
  await new Promise((resolve) => {
    auth.login({ body: { username: 'user1', password: 'correctpass' } }, {
      status(c) { res.statusCode = c; return this; },
      json(b) { res.body = b; resolve(); },
    });
  });
  assert.ok(res.body.token);
  assert.equal(res.body.payload.username, 'user1');
  assert.equal(res.body.payload.role, 'Daily_Tenant');
});

// ============================================================
// currentUser
// ============================================================
test('currentUser: ไม่พบผู้ใช้ → 404', async () => {
  setHandler(() => ({ rows: [] }));
  const res = makeRes();
  await auth.currentUser({ user: { username: 'ghost' } }, res);
  assert.equal(res.statusCode, 404);
});

test('currentUser: พบผู้ใช้ → 200 + ข้อมูล', async () => {
  setHandler(() => ({ rows: [{ member_id: 1, username: 'user1', full_name: 'ทดสอบ' }] }));
  const res = makeRes();
  await auth.currentUser({ user: { username: 'user1' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.username, 'user1');
});

// ============================================================
// getMembers / getMemberById
// ============================================================
test('getMembers: คืนรายชื่อสมาชิกทั้งหมด', async () => {
  setHandler(() => ({ rows: [{ member_id: 1 }, { member_id: 2 }] }));
  const res = makeRes();
  await auth.getMembers({}, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.count, 2);
});

test('getMemberById: ไม่พบสมาชิก → 404', async () => {
  setHandler(() => ({ rows: [] }));
  const res = makeRes();
  await auth.getMemberById({ params: { id: 999 } }, res);
  assert.equal(res.statusCode, 404);
});

test('getMemberById: พบสมาชิก → 200', async () => {
  setHandler(() => ({ rows: [{ member_id: 1, username: 'user1' }] }));
  const res = makeRes();
  await auth.getMemberById({ params: { id: 1 } }, res);
  assert.equal(res.statusCode, 200);
});

// ============================================================
// updateMember (admin)
// ============================================================
test('updateMember: ไม่พบสมาชิก → 404', async () => {
  setHandler(() => ({ rows: [] }));
  const res = makeRes();
  await auth.updateMember({ params: { id: 999 }, body: {} }, res);
  assert.equal(res.statusCode, 404);
});

test('updateMember: อัปเดตสำเร็จ + คงค่าฟิลด์ที่ไม่ได้ส่งมา', async () => {
  setHandler((sql) => {
    if (sql.trim().startsWith('SELECT * FROM members')) {
      return { rows: [{ member_id: 1, full_name: 'เดิม', email: 'old@x.com', phone_number: '0800000000', user_role: 'Daily_Tenant' }] };
    }
    return { rows: [] };
  });
  const res = makeRes();
  await auth.updateMember({ params: { id: 1 }, body: { user_role: 'Monthly_Tenant' } }, res);
  assert.equal(res.statusCode, 200);
  const updateCall = calls.find((c) => c.sql.trim().startsWith('UPDATE members'));
  assert.equal(updateCall.params[0], 'เดิม');           // full_name คงเดิม
  assert.equal(updateCall.params[3], 'Monthly_Tenant'); // user_role อัปเดตใหม่
});

test('updateMember: user_role ไม่ใช่ค่าที่รู้จัก → 400 (กันหลุดจากทุก role check)', async () => {
  const res = makeRes();
  await auth.updateMember({ params: { id: 1 }, body: { user_role: 'SuperAdmin' } }, res);
  assert.equal(res.statusCode, 400);
  // ต้องไม่ยิง UPDATE ออกไปเลย
  assert.equal(calls.some((c) => c.sql.trim().startsWith('UPDATE members')), false);
});

// ============================================================
// deleteMember (admin)
// ============================================================
test('deleteMember: ไม่พบสมาชิก → 404', async () => {
  setHandler(() => ({ rowCount: 0 }));
  const res = makeRes();
  await auth.deleteMember({ params: { id: 999 } }, res);
  assert.equal(res.statusCode, 404);
});

test('deleteMember: ลบสำเร็จ → 200', async () => {
  setHandler(() => ({ rowCount: 1 }));
  const res = makeRes();
  await auth.deleteMember({ params: { id: 1 } }, res);
  assert.equal(res.statusCode, 200);
});

// ============================================================
// updateProfile (self)
// ============================================================
test('updateProfile: ไม่พบสมาชิก → 404', async () => {
  setHandler(() => ({ rows: [] }));
  const res = makeRes();
  await auth.updateProfile({ user: { id: 999 }, body: {} }, res);
  assert.equal(res.statusCode, 404);
});

test('updateProfile: อัปเดตตัวเองสำเร็จ (แก้ได้แค่ full_name/email/phone_number)', async () => {
  setHandler((sql) => {
    if (sql.trim().startsWith('SELECT * FROM members')) {
      return { rows: [{ member_id: 1, full_name: 'เดิม', email: 'old@x.com', phone_number: '0800000000' }] };
    }
    return { rows: [] };
  });
  const res = makeRes();
  await auth.updateProfile({ user: { id: 1 }, body: { full_name: 'ใหม่' } }, res);
  assert.equal(res.statusCode, 200);
  const updateCall = calls.find((c) => c.sql.trim().startsWith('UPDATE members'));
  assert.equal(updateCall.params[0], 'ใหม่');
  assert.equal(updateCall.params[1], 'old@x.com'); // email คงเดิม
});
