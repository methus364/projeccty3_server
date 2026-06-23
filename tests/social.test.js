// ============================================================
// Unit tests — M10c Social Login (controllers/social.js)
// mock database — ไม่แตะ DB จริง · ใช้ SECRET จริงจาก .env เพื่อเซ็น JWT
// รัน:  cd server && npm test
// ============================================================
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// ---------- mock pool ----------
const calls = [];
let handler = () => ({ rows: [] });
function setHandler(h) { handler = h; }
function reset() { calls.length = 0; handler = () => ({ rows: [] }); }

const mockClient = {
  query: async (sql, params) => { calls.push({ sql, params }); return handler(sql, params); },
  release: () => {},
};
const mockPool = {
  connect: async () => mockClient,
  query: async (sql, params) => { calls.push({ sql, params }); return handler(sql, params); },
};

const dbAbs = require.resolve(path.join(__dirname, '..', 'config', 'db.js'));
require.cache[dbAbs] = { id: dbAbs, filename: dbAbs, loaded: true, exports: mockPool };

const social = require('../controllers/social');

function makeRes() {
  return {
    statusCode: 200, body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
const has = (s, frag) => s.includes(frag);
const called = (frag) => calls.some((c) => has(c.sql, frag));

const memberRow = { member_id: 5, username: 'somchai', full_name: 'สมชาย', email: 'a@b.com', user_role: 'Daily_Tenant' };

beforeEach(reset);

// ============================================================
// validation
// ============================================================
test('socialLogin: provider ไม่ถูกต้อง → 400', async () => {
  const req = { body: { provider: 'twitter', provider_id: 'x1' } };
  const res = makeRes();
  await social.socialLogin(req, res);
  assert.equal(res.statusCode, 400);
});

test('socialLogin: ไม่ส่ง provider_id → 400', async () => {
  const req = { body: { provider: 'google' } };
  const res = makeRes();
  await social.socialLogin(req, res);
  assert.equal(res.statusCode, 400);
});

// ============================================================
// เจอบัญชี social เดิม → ใช้เลย
// ============================================================
test('socialLogin: เจอบัญชี social เดิม → คืน token, ไม่สมัครใหม่', async () => {
  setHandler((sql) => {
    const s = sql.trim();
    if (s.startsWith('BEGIN') || s.startsWith('COMMIT') || s.startsWith('ROLLBACK')) return { rows: [] };
    if (has(s, 'FROM social_accounts s')) return { rows: [memberRow] }; // เจอเลย
    return { rows: [] };
  });
  const req = { body: { provider: 'google', provider_id: 'g123' } };
  const res = makeRes();
  await social.socialLogin(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.isNewUser, false);
  assert.equal(res.body.linked, false);
  assert.ok(res.body.token, 'ต้องคืน JWT');
  assert.equal(res.body.payload.id, 5);
  assert.equal(called('INSERT INTO members'), false, 'ไม่ควรสมัครใหม่');
});

// ============================================================
// อีเมลตรง member เดิม → auto-link
// ============================================================
test('socialLogin: อีเมลตรงสมาชิกเดิม → ผูกบัญชี (auto-link)', async () => {
  setHandler((sql) => {
    const s = sql.trim();
    if (s.startsWith('BEGIN') || s.startsWith('COMMIT') || s.startsWith('ROLLBACK')) return { rows: [] };
    if (has(s, 'FROM social_accounts s')) return { rows: [] };        // ยังไม่ผูก
    if (has(s, 'FROM members WHERE email')) return { rows: [memberRow] }; // อีเมลตรง
    return { rows: [] };
  });
  const req = { body: { provider: 'line', provider_id: 'L9', email: 'a@b.com' } };
  const res = makeRes();
  await social.socialLogin(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.linked, true);
  assert.equal(res.body.isNewUser, false);
  assert.equal(called('INSERT INTO members'), false, 'ไม่สมัครใหม่ (ใช้ member เดิม)');
  assert.ok(called('INSERT INTO social_accounts'), 'ต้องผูกบัญชี social');
});

// ============================================================
// ไม่เจอเลย → สมัครใหม่ (role Daily_Tenant, password NULL)
// ============================================================
test('socialLogin: ผู้ใช้ใหม่ → สมัครสมาชิก + role Daily_Tenant', async () => {
  setHandler((sql) => {
    const s = sql.trim();
    if (s.startsWith('BEGIN') || s.startsWith('COMMIT') || s.startsWith('ROLLBACK')) return { rows: [] };
    if (has(s, 'FROM social_accounts s')) return { rows: [] };   // ไม่เจอ
    if (has(s, 'FROM members WHERE email')) return { rows: [] }; // อีเมลไม่ตรง
    if (has(s, 'INSERT INTO members')) return { rows: [{ ...memberRow, member_id: 9, username: 'google_g777' }] };
    return { rows: [] };
  });
  const req = { body: { provider: 'google', provider_id: 'g777', email: 'new@x.com', full_name: 'คนใหม่' } };
  const res = makeRes();
  await social.socialLogin(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.isNewUser, true);
  assert.equal(res.body.payload.id, 9);
  // ตรวจว่า insert member ด้วย role Daily_Tenant
  const insMember = calls.find((c) => has(c.sql, 'INSERT INTO members'));
  assert.ok(has(insMember.sql, "'Daily_Tenant'"), 'role ต้องเป็น Daily_Tenant');
  assert.ok(called('INSERT INTO social_accounts'), 'ต้องผูกบัญชี social');
});
