// ============================================================
// Unit tests — M8 Dashboard & Reports (controllers/dashboard.js)
// ใช้ node:test (built-in) + mock database — ไม่แตะ DB จริง
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

const mockPool = {
  query: async (sql, params) => { calls.push({ sql, params }); return handler(sql, params); },
};

function injectMock(relPath, exportsObj) {
  const abs = require.resolve(path.join(__dirname, '..', relPath));
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports: exportsObj };
}

injectMock('config/db.js', mockPool);

const dashboard = require('../controllers/dashboard');

// ---------- helpers ----------
function makeRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
const has = (s, frag) => s.includes(frag);
function paramsOf(frag) {
  const c = calls.find((c) => has(c.sql, frag));
  return c ? c.params : null;
}

beforeEach(reset);

// ============================================================
// getSummary
// ============================================================
test('getSummary: รวมตัวเลขจากหลายตารางเป็นการ์ดสรุป', async () => {
  setHandler((sql) => {
    // เช็ค invoices ก่อน payments เพราะ query หนี้มี subquery FROM payments อยู่ข้างใน
    if (has(sql, 'FROM invoices')) return { rows: [{ outstanding: 1200, unpaid_count: 2 }] };
    if (has(sql, 'FROM rooms')) {
      return { rows: [
        { room_status: 'ว่าง', count: 3 },
        { room_status: 'มีผู้เช่า', count: 7 },
        { room_status: 'ปิดปรับปรุง', count: 1 },
      ] };
    }
    if (has(sql, 'FROM payments')) return { rows: [{ revenue: 5000 }] };
    if (has(sql, 'FROM maintenance_requests')) return { rows: [{ pending_repairs: 4 }] };
    return { rows: [] };
  });

  const req = { user: { id: 1, role: 'Admin' } };
  const res = makeRes();
  await dashboard.getSummary(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  const d = res.body.data;
  assert.equal(d.revenueThisMonth, 5000);
  assert.equal(d.rooms.total, 11);       // 3 + 7 + 1
  assert.equal(d.rooms.occupied, 7);
  assert.equal(d.rooms.vacant, 3);
  assert.equal(d.rooms.maintenance, 1);
  assert.equal(d.outstandingDebt, 1200);
  assert.equal(d.unpaidInvoices, 2);
  assert.equal(d.pendingRepairs, 4);
});

test('getSummary: DB error → 500', async () => {
  setHandler(() => { throw new Error('db down'); });
  const req = { user: { id: 1, role: 'Admin' } };
  const res = makeRes();
  await dashboard.getSummary(req, res);
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.success, false);
});

// ============================================================
// getRevenue
// ============================================================
test('getRevenue: ไม่ส่ง months → default 6', async () => {
  setHandler(() => ({ rows: [] }));
  const req = { query: {}, user: { id: 1, role: 'Admin' } };
  const res = makeRes();
  await dashboard.getRevenue(req, res);
  assert.equal(res.statusCode, 200);
  const p = paramsOf('generate_series');
  assert.equal(p[0], 6);
});

test('getRevenue: months เกิน 24 → ถูกจำกัดที่ 24', async () => {
  setHandler(() => ({ rows: [] }));
  const req = { query: { months: '100' }, user: { id: 1, role: 'Admin' } };
  const res = makeRes();
  await dashboard.getRevenue(req, res);
  const p = paramsOf('generate_series');
  assert.equal(p[0], 24);
});

test('getRevenue: แปลง revenue เป็นตัวเลข', async () => {
  setHandler(() => ({ rows: [
    { month: '2026-05', revenue: '0' },
    { month: '2026-06', revenue: '3000' },
  ] }));
  const req = { query: { months: '2' }, user: { id: 1, role: 'Admin' } };
  const res = makeRes();
  await dashboard.getRevenue(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.count, 2);
  assert.strictEqual(res.body.data[1].revenue, 3000); // number ไม่ใช่ string
});

// ============================================================
// getOccupancyReport
// ============================================================
test('getOccupancyReport: คืนเฉพาะผู้กำลังเข้าพัก', async () => {
  setHandler((sql) => {
    assert.ok(has(sql, "booking_status = 'กำลังเข้าพัก'"));
    return { rows: [{ booking_id: 1, room_number: '101', tenant_name: 'สมชาย' }] };
  });
  const req = { user: { id: 1, role: 'Admin' } };
  const res = makeRes();
  await dashboard.getOccupancyReport(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.count, 1);
});

// ============================================================
// getDebtReport
// ============================================================
test('getDebtReport: คืนยอดคงค้างเป็นตัวเลข + กรองบิลที่ยังไม่ปิด', async () => {
  setHandler((sql) => {
    assert.ok(has(sql, "NOT IN ('ชำระแล้ว', 'ยกเลิก')"));
    return { rows: [
      { invoice_id: 1, room_number: '101', total_amount: '3000', paid_amount: '1000', outstanding: '2000' },
    ] };
  });
  const req = { user: { id: 1, role: 'Admin' } };
  const res = makeRes();
  await dashboard.getDebtReport(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.count, 1);
  assert.strictEqual(res.body.data[0].outstanding, 2000);
  assert.strictEqual(res.body.data[0].total_amount, 3000);
});
