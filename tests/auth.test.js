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
// mock mailer — กัน register/verify ยิงอีเมลจริงตอนเทสต์ (บันทึกไว้เช็คว่าถูกเรียก)
const sentMails = [];
injectMock('config/mailer.js', {
  sendMail: async (opt) => { sentMails.push(opt); },
  sendInvoiceMail: async () => {},
});

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
// register (flow ใหม่: บังคับ email + เลือก role + ส่ง OTP ยืนยัน)
// ============================================================
// ค่า body ครบถ้วนสำหรับ register (แต่ละเทสต์ override เฉพาะ field ที่ต้องการทดสอบ)
const validSignup = { username: 'user1', password: '123456', full_name: 'ทดสอบ', email: 'a@b.com', user_role: 'Daily_Tenant' };

test('register: ไม่ส่ง username → 400', async () => {
  const res = makeRes();
  await auth.register({ body: { ...validSignup, username: undefined } }, res);
  assert.equal(res.statusCode, 400);
});

test('register: ไม่ส่ง email → 400', async () => {
  const res = makeRes();
  await auth.register({ body: { ...validSignup, email: undefined } }, res);
  assert.equal(res.statusCode, 400);
});

test('register: รูปแบบอีเมลผิด → 400', async () => {
  const res = makeRes();
  await auth.register({ body: { ...validSignup, email: 'not-an-email' } }, res);
  assert.equal(res.statusCode, 400);
});

test('register: ไม่เลือก role → 400', async () => {
  const res = makeRes();
  await auth.register({ body: { ...validSignup, user_role: undefined } }, res);
  assert.equal(res.statusCode, 400);
});

test('register: เลือก role เป็น Admin → 400 (กันยกระดับสิทธิ์)', async () => {
  const res = makeRes();
  await auth.register({ body: { ...validSignup, user_role: 'Admin' } }, res);
  assert.equal(res.statusCode, 400);
});

test('register: username ซ้ำ → 400', async () => {
  setHandler((sql) => {
    if (has(sql, 'SELECT username FROM Members')) return { rows: [{ username: 'user1' }] };
    return { rows: [] };
  });
  const res = makeRes();
  await auth.register({ body: validSignup }, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /ชื่อผู้ใช้/);
});

test('register: email ซ้ำ → 400', async () => {
  setHandler((sql) => {
    if (has(sql, 'SELECT username FROM Members')) return { rows: [] };
    if (has(sql, 'SELECT email FROM Members')) return { rows: [{ email: 'a@b.com' }] };
    return { rows: [] };
  });
  const res = makeRes();
  await auth.register({ body: validSignup }, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /อีเมล/);
});

test('register: สมัครสำเร็จ → 201 + INSERT ด้วย role ที่เลือก + ส่ง OTP', async () => {
  sentMails.length = 0;
  setHandler((sql) => {
    if (has(sql, 'SELECT username FROM Members')) return { rows: [] };
    if (has(sql, 'SELECT email FROM Members')) return { rows: [] };
    if (sql.trim().startsWith('INSERT INTO Members')) return { rows: [] };
    return { rows: [] };
  });
  const res = makeRes();
  await auth.register({ body: { ...validSignup, user_role: 'Monthly_Tenant' } }, res);
  assert.equal(res.statusCode, 201);
  const insertCall = calls.find((c) => c.sql.trim().startsWith('INSERT INTO Members'));
  assert.equal(insertCall.params[5], 'Monthly_Tenant'); // เก็บ role ที่เลือก
  assert.equal(sentMails.length, 1);                     // ส่ง OTP ไปแล้ว 1 ฉบับ
  assert.equal(sentMails[0].to, 'a@b.com');
});

// ============================================================
// verifyRegistration (ยืนยัน OTP → เปิดใช้งาน + login)
// ============================================================
test('verifyRegistration: ไม่ส่ง email/otp → 400', async () => {
  const res = makeRes();
  await auth.verifyRegistration({ body: {} }, res);
  assert.equal(res.statusCode, 400);
});

test('verifyRegistration: ไม่พบบัญชี → 404', async () => {
  setHandler(() => ({ rows: [] }));
  const res = makeRes();
  await auth.verifyRegistration({ body: { email: 'x@y.com', otp: '123456' } }, res);
  assert.equal(res.statusCode, 404);
});

test('verifyRegistration: ยืนยันแล้ว → 400', async () => {
  setHandler(() => ({ rows: [{ member_id: 1, username: 'u1', email: 'a@b.com', email_verified_at: new Date() }] }));
  const res = makeRes();
  await auth.verifyRegistration({ body: { email: 'a@b.com', otp: '123456' } }, res);
  assert.equal(res.statusCode, 400);
});

test('verifyRegistration: OTP ถูกต้อง → 200 + คืน token', async () => {
  // สมัครก่อนเพื่อสร้าง OTP จริงใน otpStore (username|email)
  sentMails.length = 0;
  setHandler((sql) => {
    if (has(sql, 'SELECT username FROM Members')) return { rows: [] };
    if (has(sql, 'SELECT email FROM Members')) return { rows: [] };
    return { rows: [] };
  });
  await auth.register({ body: { ...validSignup, username: 'u1', email: 'verify@b.com' } }, makeRes());
  const otp = /: (\d{6})/.exec(sentMails[0].text)[1]; // ดึงเลข OTP จากเนื้ออีเมล

  setHandler((sql) => {
    if (has(sql, 'SELECT * FROM Members')) {
      return { rows: [{ member_id: 1, username: 'u1', email: 'verify@b.com', user_role: 'Daily_Tenant', email_verified_at: null }] };
    }
    return { rows: [] };
  });
  const res = makeRes();
  await auth.verifyRegistration({ body: { email: 'verify@b.com', otp } }, res);
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.token);
  assert.equal(res.body.payload.username, 'u1');
});

// ============================================================
// login (ด้วยอีเมล + ต้องยืนยันอีเมลก่อน)
// ============================================================
test('login: ไม่ส่ง email/password → 400', async () => {
  const res = makeRes();
  await auth.login({ body: {} }, res);
  assert.equal(res.statusCode, 400);
});

test('login: ไม่พบผู้ใช้ → 400', async () => {
  setHandler(() => ({ rows: [] }));
  const res = makeRes();
  await auth.login({ body: { email: 'no@user.com', password: '123456' } }, res);
  assert.equal(res.statusCode, 400);
});

test('login: บัญชี social-only (password NULL) → 401', async () => {
  setHandler(() => ({ rows: [{ member_id: 1, username: 'social1', email: 's@b.com', password: null, user_role: 'Daily_Tenant', email_verified_at: new Date() }] }));
  const res = makeRes();
  await auth.login({ body: { email: 's@b.com', password: '123456' } }, res);
  assert.equal(res.statusCode, 401);
  assert.match(res.body.message, /Social Login/);
});

test('login: รหัสผ่านผิด → 401', async () => {
  const hashed = await bcrypt.hash('correctpass', 10);
  setHandler(() => ({ rows: [{ member_id: 1, username: 'user1', email: 'a@b.com', password: hashed, user_role: 'Daily_Tenant', email_verified_at: new Date() }] }));
  const res = makeRes();
  await auth.login({ body: { email: 'a@b.com', password: 'wrongpass' } }, res);
  assert.equal(res.statusCode, 401);
});

test('login: ยังไม่ยืนยันอีเมล → 403', async () => {
  const hashed = await bcrypt.hash('correctpass', 10);
  setHandler(() => ({ rows: [{ member_id: 1, username: 'user1', email: 'a@b.com', password: hashed, user_role: 'Daily_Tenant', email_verified_at: null }] }));
  const res = makeRes();
  await auth.login({ body: { email: 'a@b.com', password: 'correctpass' } }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.needVerification, true);
});

test('login: ถูกต้อง + ยืนยันแล้ว → คืน token + payload', async () => {
  const hashed = await bcrypt.hash('correctpass', 10);
  setHandler(() => ({ rows: [{ member_id: 1, username: 'user1', email: 'a@b.com', password: hashed, user_role: 'Daily_Tenant', email_verified_at: new Date() }] }));
  const res = makeRes();
  await auth.login({ body: { email: 'a@b.com', password: 'correctpass' } }, res);
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.token);
  assert.equal(res.body.payload.username, 'user1');
  assert.equal(res.body.payload.role, 'Daily_Tenant');
});

test('login: ด้วยชื่อผู้ใช้ (field login) → 200 + query ด้วย email OR username', async () => {
  const hashed = await bcrypt.hash('correctpass', 10);
  setHandler(() => ({ rows: [{ member_id: 1, username: 'user1', email: 'a@b.com', password: hashed, user_role: 'Daily_Tenant', email_verified_at: new Date() }] }));
  const res = makeRes();
  await auth.login({ body: { login: 'user1', password: 'correctpass' } }, res);
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.token);
  // ต้อง query แบบรับได้ทั้งอีเมลและชื่อผู้ใช้
  const q = calls.find((c) => has(c.sql, 'FROM Members WHERE email = $1 OR username = $1'));
  assert.ok(q, 'ต้อง query ด้วย email OR username');
  assert.equal(q.params[0], 'user1');
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
