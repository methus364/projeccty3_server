// ============================================================
// Unit tests — M4 Maintenance/แจ้งซ่อม (controllers/repair.js)
// ใช้ node:test (built-in) + mock database — ไม่แตะ DB จริง
// รัน:  cd server && npm test
// ============================================================
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

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

const repair = require('../controllers/repair');

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
// createRepair
// ============================================================
test('createRepair: ไม่ส่ง booking_id/problem_title → 400', async () => {
  const res = makeRes();
  await repair.createRepair({ body: {}, user: { id: 1 } }, res);
  assert.equal(res.statusCode, 400);
});

test('createRepair: booking ไม่ใช่ของตัวเอง/ไม่ได้กำลังเข้าพัก → 403', async () => {
  setHandler((sql) => {
    if (has(sql, 'FROM bookings')) return { rows: [] };
    return { rows: [] };
  });
  const res = makeRes();
  await repair.createRepair({ body: { booking_id: 1, problem_title: 'แอร์เสีย' }, user: { id: 2 } }, res);
  assert.equal(res.statusCode, 403);
});

test('createRepair: booking ถูกต้อง → 201 + บันทึกสำเร็จ', async () => {
  setHandler((sql) => {
    if (has(sql, 'FROM bookings')) return { rows: [{ booking_id: 1 }] };
    if (sql.trim().startsWith('INSERT INTO maintenance_requests')) {
      return { rows: [{ repair_id: 1, problem_title: 'แอร์เสีย' }] };
    }
    return { rows: [] };
  });
  const res = makeRes();
  await repair.createRepair({ body: { booking_id: 1, problem_title: 'แอร์เสีย' }, user: { id: 2 } }, res);
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.success, true);
});

// ============================================================
// getAllRepairs
// ============================================================
test('getAllRepairs: คืนรายการแจ้งซ่อมทั้งหมด', async () => {
  setHandler((sql) => {
    if (has(sql, 'FROM maintenance_requests mr')) {
      return { rows: [{ repair_id: 1, problem_title: 'แอร์เสีย' }] };
    }
    return { rows: [] };
  });
  const res = makeRes();
  await repair.getAllRepairs({}, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.length, 1);
});

// ============================================================
// getMyRepairs
// ============================================================
test('getMyRepairs: booking ไม่ใช่ของตัวเอง → 403', async () => {
  setHandler((sql) => {
    if (has(sql, 'FROM bookings WHERE booking_id')) return { rows: [] };
    return { rows: [] };
  });
  const res = makeRes();
  await repair.getMyRepairs({ params: { bookingId: 1 }, user: { id: 2 } }, res);
  assert.equal(res.statusCode, 403);
});

test('getMyRepairs: booking ถูกต้อง → 200 + รายการของตัวเอง', async () => {
  setHandler((sql) => {
    if (has(sql, 'FROM bookings WHERE booking_id')) return { rows: [{ booking_id: 1 }] };
    if (has(sql, 'FROM maintenance_requests')) return { rows: [{ repair_id: 1 }] };
    return { rows: [] };
  });
  const res = makeRes();
  await repair.getMyRepairs({ params: { bookingId: 1 }, user: { id: 2 } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.length, 1);
});

// ============================================================
// updateRepairStatus
// ============================================================
test('updateRepairStatus: สถานะไม่ถูกต้อง → 400', async () => {
  const res = makeRes();
  await repair.updateRepairStatus({ params: { id: 1 }, body: { status: 'ยกเลิก' } }, res);
  assert.equal(res.statusCode, 400);
});

test('updateRepairStatus: ไม่พบรายการ → 404', async () => {
  setHandler(() => ({ rows: [] }));
  const res = makeRes();
  await repair.updateRepairStatus({ params: { id: 999 }, body: { status: 'done' } }, res);
  assert.equal(res.statusCode, 404);
});

test('updateRepairStatus: อัปเดตสำเร็จ → 200', async () => {
  setHandler((sql) => {
    if (sql.trim().startsWith('UPDATE maintenance_requests')) {
      return { rows: [{ repair_id: 1, status: 'in_progress' }] };
    }
    return { rows: [] };
  });
  const res = makeRes();
  await repair.updateRepairStatus({ params: { id: 1 }, body: { status: 'in_progress' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.status, 'in_progress');
});
