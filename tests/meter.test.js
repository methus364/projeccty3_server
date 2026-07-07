// ============================================================
// Unit tests — M5 Utility Meters (controllers/meter.js)
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

const meter = require('../controllers/meter');

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
// recordMeter
// ============================================================
test('recordMeter: ขาด field ที่จำเป็น → 400', async () => {
  const res = makeRes();
  await meter.recordMeter({ body: { room_id: 1 }, user: { id: 1 } }, res);
  assert.equal(res.statusCode, 400);
});

test('recordMeter: record_month ผิดรูปแบบ → 400', async () => {
  const res = makeRes();
  await meter.recordMeter({
    body: { room_id: 1, record_month: '2026/07', water_current_unit: 10, elec_current_unit: 20 },
    user: { id: 1 },
  }, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /YYYY-MM/);
});

test('recordMeter: หน่วยติดลบ → 400', async () => {
  const res = makeRes();
  await meter.recordMeter({
    body: { room_id: 1, record_month: '2026-07', water_current_unit: -5, elec_current_unit: 20 },
    user: { id: 1 },
  }, res);
  assert.equal(res.statusCode, 400);
});

test('recordMeter: หน่วยน้อยกว่าเดือนก่อนโดยไม่ override → 400', async () => {
  setHandler((sql) => {
    if (has(sql, 'FROM utility_meters')) return { rows: [{ water_current_unit: 50, elec_current_unit: 80 }] };
    return { rows: [] };
  });
  const res = makeRes();
  await meter.recordMeter({
    body: { room_id: 1, record_month: '2026-07', water_current_unit: 40, elec_current_unit: 90 },
    user: { id: 1 },
  }, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /น้อยกว่าเดือนก่อน/);
});

test('recordMeter: หน่วยน้อยกว่าเดือนก่อนแต่ override:true → บันทึกผ่าน', async () => {
  setHandler((sql) => {
    if (has(sql, 'FROM utility_meters')) return { rows: [{ water_current_unit: 50, elec_current_unit: 80 }] };
    if (sql.trim().startsWith('INSERT INTO utility_meters')) return { rows: [{ meter_id: 1 }] };
    return { rows: [] };
  });
  const res = makeRes();
  await meter.recordMeter({
    body: { room_id: 1, record_month: '2026-07', water_current_unit: 40, elec_current_unit: 90, override: true },
    user: { id: 1 },
  }, res);
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.success, true);
});

test('recordMeter: ไม่มีข้อมูลเดือนก่อน → บันทึกสำเร็จ (ไม่เช็ค diff)', async () => {
  setHandler((sql) => {
    if (has(sql, 'FROM utility_meters')) return { rows: [] };
    if (sql.trim().startsWith('INSERT INTO utility_meters')) return { rows: [{ meter_id: 2 }] };
    return { rows: [] };
  });
  const res = makeRes();
  await meter.recordMeter({
    body: { room_id: 2, record_month: '2026-07', water_current_unit: 10, elec_current_unit: 20 },
    user: { id: 1 },
  }, res);
  assert.equal(res.statusCode, 201);
});

test('recordMeter: DB error → 500', async () => {
  setHandler(() => { throw new Error('db down'); });
  const res = makeRes();
  await meter.recordMeter({
    body: { room_id: 1, record_month: '2026-07', water_current_unit: 10, elec_current_unit: 20 },
    user: { id: 1 },
  }, res);
  assert.equal(res.statusCode, 500);
});

// ============================================================
// getMeters
// ============================================================
test('getMeters: ไม่ส่ง month → 400', async () => {
  const res = makeRes();
  await meter.getMeters({ query: {} }, res);
  assert.equal(res.statusCode, 400);
});

test('getMeters: month ผิดรูปแบบ → 400', async () => {
  const res = makeRes();
  await meter.getMeters({ query: { month: '07-2026' } }, res);
  assert.equal(res.statusCode, 400);
});

test('getMeters: คำนวณ diff + ค่าใช้จ่ายถูกต้องตามเรตจริง (น้ำ 20, ไฟ 9)', async () => {
  setHandler((sql) => {
    if (has(sql, 'FROM rooms r')) {
      return {
        rows: [{
          room_id: 1, room_number: '101', room_status: 'มีผู้เช่า',
          meter_id: 5, water_current_unit: 60, elec_current_unit: 100,
          recorded_at: '2026-07-01', prev_water_unit: 50, prev_elec_unit: 80,
          recorded_by_name: 'แอดมิน',
        }],
      };
    }
    return { rows: [] };
  });
  const res = makeRes();
  await meter.getMeters({ query: { month: '2026-07' } }, res);
  assert.equal(res.statusCode, 200);
  const row = res.body.data[0];
  assert.equal(row.diff_water, 10);
  assert.equal(row.diff_elec, 20);
  assert.equal(row.water_cost, 200);  // 10 หน่วย × 20 บาท
  assert.equal(row.elec_cost, 180);   // 20 หน่วย × 9 บาท
});

test('getMeters: ห้องยังไม่มีข้อมูลเดือนก่อน → diff/cost เป็น null', async () => {
  setHandler((sql) => {
    if (has(sql, 'FROM rooms r')) {
      return {
        rows: [{
          room_id: 2, room_number: '102', room_status: 'ว่าง',
          meter_id: null, water_current_unit: null, elec_current_unit: null,
          recorded_at: null, prev_water_unit: null, prev_elec_unit: null,
          recorded_by_name: null,
        }],
      };
    }
    return { rows: [] };
  });
  const res = makeRes();
  await meter.getMeters({ query: { month: '2026-07' } }, res);
  const row = res.body.data[0];
  assert.equal(row.diff_water, null);
  assert.equal(row.water_cost, null);
});

test('getMeters: มิเตอร์ถูกรีเซ็ต (curr < prev) → diff โชว์ค่าจริง (ติดลบ) แต่ cost ต้องไม่ติดลบ', async () => {
  setHandler((sql) => {
    if (has(sql, 'FROM rooms r')) {
      return {
        rows: [{
          room_id: 3, room_number: '103', room_status: 'มีผู้เช่า',
          meter_id: 9, water_current_unit: 50, elec_current_unit: 30,
          recorded_at: '2026-07-01', prev_water_unit: 9800, prev_elec_unit: 5000,
          recorded_by_name: 'แอดมิน',
        }],
      };
    }
    return { rows: [] };
  });
  const res = makeRes();
  await meter.getMeters({ query: { month: '2026-07' } }, res);
  const row = res.body.data[0];
  assert.equal(row.diff_water, -9750); // โชว์ค่าจริงไว้ให้แอดมินสังเกตว่าถูกรีเซ็ต
  assert.equal(row.diff_elec, -4970);
  assert.equal(row.water_cost, 0);     // แต่ cost ต้องไม่ติดลบ
  assert.equal(row.elec_cost, 0);
});
