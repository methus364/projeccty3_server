// ============================================================
// Unit tests — M10a Contracts (controllers/contract.js)
// mock database — ไม่แตะ DB จริง
// รัน:  cd server && npm test
// ============================================================
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// ---------- mock pool (แทน config/db) ----------
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

const contract = require('../controllers/contract');

// ---------- helpers ----------
function makeRes() {
  return {
    statusCode: 200, body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
const has = (s, frag) => s.includes(frag);
function paramsOf(frag) {
  const c = calls.find((c) => has(c.sql, frag));
  return c ? c.params : null;
}

// สัญญาตัวอย่าง: ห้อง 3,000/เดือน · ประกัน 3,000 · กุญแจ 200 · สิ้นสุด 2027-01-20
const baseContract = {
  contract_id: 10, booking_id: 5, member_id: 2, room_id: 3,
  start_date: '2026-01-20', end_date: '2027-01-20',
  rent_prepaid: 3000, security_deposit: 3000, key_deposit: 200,
  contract_status: 'มีผลใช้งาน', notice_date: null, settled_at: null,
};

beforeEach(reset);

// ============================================================
// settleContract — คืนมัดจำ + คิดเงินคืนฝั่ง server
// ============================================================
test('settleContract: ไม่ส่ง move_out_date → 400', async () => {
  const req = { params: { id: 10 }, body: {}, user: { id: 1, role: 'Admin' } };
  const res = makeRes();
  await contract.settleContract(req, res);
  assert.equal(res.statusCode, 400);
});

test('settleContract: สัญญาเคลียร์ไปแล้ว → 400 (กันคืนซ้ำ)', async () => {
  setHandler((sql) => {
    const s = sql.trim();
    if (s.startsWith('BEGIN') || s.startsWith('ROLLBACK')) return { rows: [] };
    if (has(s, 'FOR UPDATE')) return { rows: [{ ...baseContract, settled_at: '2026-06-01' }] };
    return { rows: [] };
  });
  const req = { params: { id: 10 }, body: { move_out_date: '2027-01-20' }, user: { id: 1, role: 'Admin' } };
  const res = makeRes();
  await contract.settleContract(req, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /เคลียร์/);
});

test('settleContract: ครบสัญญา + คืนกุญแจ + แจ้งล่วงหน้า → คืนเต็ม ประกัน+กุญแจ−ค่าใช้จ่าย', async () => {
  setHandler((sql) => {
    const s = sql.trim();
    if (s.startsWith('BEGIN') || s.startsWith('COMMIT') || s.startsWith('ROLLBACK')) return { rows: [] };
    if (has(s, 'FOR UPDATE')) return { rows: [{ ...baseContract }] };
    if (has(s, 'SELECT c.*')) return { rows: [{ ...baseContract, contract_status: 'หมดอายุ', refund_amount: 2500 }] };
    return { rows: [] };
  });
  // ย้ายออกวันครบสัญญา · คืนกุญแจ · แจ้งล่วงหน้า · ค่าทำความสะอาด 300 + น้ำไฟค้าง 400
  const req = {
    params: { id: 10 },
    body: {
      move_out_date: '2027-01-20', key_returned: true, notice_given: true,
      cleaning_cost: 300, utility_cost: 400,
    },
    user: { id: 1, role: 'Admin' },
  };
  const res = makeRes();
  await contract.settleContract(req, res);

  assert.equal(res.statusCode, 200);
  // refund = 0(rent) + 3000(security) + 200(key) − (0+300+400+0) = 2500
  const p = paramsOf('UPDATE contracts SET');
  assert.equal(p[4], false);   // security_forfeited = false (ครบสัญญา)
  assert.equal(p[10], 2500);   // refund_amount
});

test('settleContract: ออกก่อนครบสัญญา → ริบประกัน (security_forfeited = true)', async () => {
  setHandler((sql) => {
    const s = sql.trim();
    if (s.startsWith('BEGIN') || s.startsWith('COMMIT') || s.startsWith('ROLLBACK')) return { rows: [] };
    if (has(s, 'FOR UPDATE')) return { rows: [{ ...baseContract }] };
    if (has(s, 'SELECT c.*')) return { rows: [{ ...baseContract }] };
    return { rows: [] };
  });
  // ย้ายออกก่อนครบสัญญา (2026-06-01 < 2027-01-20) · คืนกุญแจ
  const req = {
    params: { id: 10 },
    body: { move_out_date: '2026-06-01', key_returned: true },
    user: { id: 1, role: 'Admin' },
  };
  const res = makeRes();
  await contract.settleContract(req, res);

  assert.equal(res.statusCode, 200);
  const p = paramsOf('UPDATE contracts SET');
  assert.equal(p[4], true);    // security_forfeited = true
  // refund = 0 + 0(ริบประกัน) + 200(key) − 0 = 200
  assert.equal(p[10], 200);
});

test('settleContract: ไม่แจ้งล่วงหน้า → ไม่คืนค่าเช่าล่วงหน้าส่วนเกิน', async () => {
  setHandler((sql) => {
    const s = sql.trim();
    if (s.startsWith('BEGIN') || s.startsWith('COMMIT') || s.startsWith('ROLLBACK')) return { rows: [] };
    if (has(s, 'FOR UPDATE')) return { rows: [{ ...baseContract }] };
    if (has(s, 'SELECT c.*')) return { rows: [{ ...baseContract }] };
    return { rows: [] };
  });
  // ส่ง rent_refund 2000 มา แต่ไม่แจ้งล่วงหน้า → ระบบต้องบังคับเป็น 0
  const req = {
    params: { id: 10 },
    body: { move_out_date: '2027-01-20', notice_given: false, rent_refund: 2000, key_returned: true },
    user: { id: 1, role: 'Admin' },
  };
  const res = makeRes();
  await contract.settleContract(req, res);

  assert.equal(res.statusCode, 200);
  const p = paramsOf('UPDATE contracts SET');
  assert.equal(p[5], 0);       // rent_refund ถูกบังคับเป็น 0 (ไม่แจ้งล่วงหน้า)
  // refund = 0 + 3000 + 200 = 3200
  assert.equal(p[10], 3200);
});

// ============================================================
// getContractById — ownership
// ============================================================
test('getContractById: ผู้เช่าเปิดสัญญาคนอื่น → 403', async () => {
  setHandler((sql) => {
    if (has(sql, 'FROM contracts c')) return { rows: [{ ...baseContract }] }; // member_id = 2
    return { rows: [] };
  });
  const req = { params: { id: 10 }, user: { id: 999, role: 'Monthly_Tenant' } };
  const res = makeRes();
  await contract.getContractById(req, res);
  assert.equal(res.statusCode, 403);
});

// ============================================================
// giveNotice — บันทึกวันแจ้งย้าย
// ============================================================
test('giveNotice: เจ้าของสัญญาแจ้งย้ายได้ → 200 + บันทึก notice_date (ล็อกด้วย FOR UPDATE)', async () => {
  setHandler((sql) => {
    const s = sql.trim();
    if (s.startsWith('BEGIN') || s.startsWith('COMMIT') || s.startsWith('ROLLBACK')) return { rows: [] };
    if (has(s, 'FOR UPDATE')) return { rows: [{ ...baseContract }] };
    return { rows: [] };
  });
  const req = { params: { id: 10 }, body: { notice_date: '2026-12-20' }, user: { id: 2, role: 'Monthly_Tenant' } };
  const res = makeRes();
  await contract.giveNotice(req, res);
  assert.equal(res.statusCode, 200);
  const p = paramsOf('UPDATE contracts SET notice_date');
  assert.equal(p[0], '2026-12-20');
  assert.ok(calls.some((c) => has(c.sql, 'FOR UPDATE')), 'ต้องล็อกแถวสัญญาก่อนแก้ กันแข่งกับ settleContract');
  assert.ok(calls.some((c) => has(c.sql, 'COMMIT')), 'ต้อง COMMIT เมื่อสำเร็จ');
});

test('giveNotice: สัญญาเคลียร์ปิดไปแล้ว (settled_at) → 400', async () => {
  setHandler((sql) => {
    const s = sql.trim();
    if (s.startsWith('BEGIN') || s.startsWith('ROLLBACK')) return { rows: [] };
    if (has(s, 'FOR UPDATE')) return { rows: [{ ...baseContract, settled_at: '2026-06-01' }] };
    return { rows: [] };
  });
  const req = { params: { id: 10 }, body: { notice_date: '2026-12-20' }, user: { id: 2, role: 'Monthly_Tenant' } };
  const res = makeRes();
  await contract.giveNotice(req, res);
  assert.equal(res.statusCode, 400);
  assert.ok(calls.some((c) => has(c.sql, 'ROLLBACK')), 'ต้อง ROLLBACK เมื่อสัญญาปิดไปแล้ว');
});
