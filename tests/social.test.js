// ============================================================
// Unit tests — M10c Social Login (controllers/social.js)
// mock database + mock fetch (provider) — ไม่แตะ DB/เครือข่ายจริง
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
const { _findOrCreateMember } = social;

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
// _findOrCreateMember — ตรรกะ link/register (ทดสอบตรง ไม่ต้อง mock network)
// ============================================================
test('findOrCreateMember: เจอบัญชี social เดิม → ใช้เลย ไม่สมัครใหม่', async () => {
  setHandler((sql) => {
    if (has(sql, 'FROM social_accounts s')) return { rows: [memberRow] };
    return { rows: [] };
  });
  const r = await _findOrCreateMember(mockClient, 'google', { provider_id: 'g1' });
  assert.equal(r.isNewUser, false);
  assert.equal(r.linked, false);
  assert.equal(r.member.member_id, 5);
  assert.equal(called('INSERT INTO members'), false);
  assert.ok(called('pg_advisory_xact_lock'), 'ต้องล็อกด้วย provider+provider_id กันสร้าง member ซ้ำตอน race');
});

test('findOrCreateMember: อีเมลตรงสมาชิกเดิม → auto-link (ผูก social ไม่สมัครใหม่)', async () => {
  setHandler((sql) => {
    if (has(sql, 'FROM social_accounts s')) return { rows: [] };
    if (has(sql, 'FROM members WHERE email')) return { rows: [memberRow] };
    return { rows: [] };
  });
  const r = await _findOrCreateMember(mockClient, 'line', { provider_id: 'L9', email: 'a@b.com' });
  assert.equal(r.linked, true);
  assert.equal(r.isNewUser, false);
  assert.equal(called('INSERT INTO members'), false);
  assert.ok(called('INSERT INTO social_accounts'));
});

test('findOrCreateMember: ผู้ใช้ใหม่ → สมัคร role Daily_Tenant + ผูก social', async () => {
  setHandler((sql) => {
    if (has(sql, 'FROM social_accounts s')) return { rows: [] };
    if (has(sql, 'FROM members WHERE email')) return { rows: [] };
    if (has(sql, 'INSERT INTO members')) return { rows: [{ ...memberRow, member_id: 9 }] };
    return { rows: [] };
  });
  const r = await _findOrCreateMember(mockClient, 'google', { provider_id: 'g777', email: 'new@x.com', full_name: 'คนใหม่' });
  assert.equal(r.isNewUser, true);
  assert.equal(r.member.member_id, 9);
  const insMember = calls.find((c) => has(c.sql, 'INSERT INTO members'));
  assert.ok(has(insMember.sql, "'Daily_Tenant'"), 'role ต้องเป็น Daily_Tenant');
  assert.ok(called('INSERT INTO social_accounts'));
});

// ============================================================
// socialLogin — validation + ตรวจ token (mock fetch)
// ============================================================
test('socialLogin: provider ไม่รองรับ → 400', async () => {
  const req = { body: { provider: 'twitter', token: 'x' } };
  const res = makeRes();
  await social.socialLogin(req, res);
  assert.equal(res.statusCode, 400);
});

test('socialLogin: google + id_token ถูกต้อง (mock tokeninfo) → 200 + token', async () => {
  process.env.GOOGLE_CLIENT_ID = 'my-google-client-id';
  const origFetch = global.fetch;
  // mock tokeninfo: aud ตรง client id ของเรา
  global.fetch = async () => ({ json: async () => ({ sub: 'g-sub-1', email: 'g@x.com', name: 'จี', aud: 'my-google-client-id' }) });

  setHandler((sql) => {
    const s = sql.trim();
    if (s.startsWith('BEGIN') || s.startsWith('COMMIT') || s.startsWith('ROLLBACK')) return { rows: [] };
    if (has(s, 'FROM social_accounts s')) return { rows: [memberRow] }; // เจอบัญชีเดิม
    return { rows: [] };
  });

  const req = { body: { provider: 'google', token: 'fake-id-token' } };
  const res = makeRes();
  await social.socialLogin(req, res);

  global.fetch = origFetch;
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.token, 'ต้องคืน JWT');
  assert.equal(res.body.payload.id, 5);
});

test('socialLogin: google + audience ไม่ตรง → 400 (กัน token ของแอปอื่น)', async () => {
  process.env.GOOGLE_CLIENT_ID = 'my-google-client-id';
  const origFetch = global.fetch;
  global.fetch = async () => ({ json: async () => ({ sub: 'x', aud: 'someone-else' }) });

  const req = { body: { provider: 'google', token: 'fake' } };
  const res = makeRes();
  await social.socialLogin(req, res);

  global.fetch = origFetch;
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /audience/);
});

// ============================================================
// lineExchange — validation
// ============================================================
test('lineExchange: ไม่ส่ง code → 400', async () => {
  const req = { body: { redirect_uri: 'http://x/cb' } };
  const res = makeRes();
  await social.lineExchange(req, res);
  assert.equal(res.statusCode, 400);
});
