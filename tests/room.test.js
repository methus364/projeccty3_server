// ============================================================
// Unit tests — M2 Rooms (controllers/room.js)
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

const room = require('../controllers/room');

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

beforeEach(reset);

// ============================================================
// createRoom
// ============================================================
test('createRoom: ไม่ส่งหมายเลขห้อง → 400', async () => {
  const res = makeRes();
  await room.createRoom({ body: {} }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.success, false);
});

test('createRoom: ส่งครบ → 201 + คืน roomId', async () => {
  setHandler((sql) => {
    if (sql.trim().startsWith('INSERT INTO rooms')) return { rows: [{ room_id: 10 }] };
    return { rows: [] };
  });
  const res = makeRes();
  await room.createRoom({ body: { number: '101', room_price: 500 } }, res);
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.success, true);
  assert.equal(res.body.roomId, 10);
});

test('createRoom: ไม่ส่ง room_status → default เป็น "ว่าง"', async () => {
  setHandler((sql) => {
    if (sql.trim().startsWith('INSERT INTO rooms')) return { rows: [{ room_id: 1 }] };
    return { rows: [] };
  });
  const res = makeRes();
  await room.createRoom({ body: { number: '102' } }, res);
  const insertCall = calls.find((c) => has(c.sql, 'INSERT INTO rooms'));
  assert.equal(insertCall.params[1], 'ว่าง');
});

// ============================================================
// getRooms
// ============================================================
test('getRooms: คืนรายการห้อง (ไม่รวมห้องปิดปรับปรุง)', async () => {
  setHandler((sql) => {
    if (has(sql, 'FROM rooms')) return { rows: [{ id: 1, number: '101' }, { id: 2, number: '102' }] };
    return { rows: [] };
  });
  const res = makeRes();
  await room.getRooms({}, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.count, 2);
  assert.ok(calls.some((c) => has(c.sql, "!= 'ปิดปรับปรุง'")));
});

test('getRooms: DB error → 500', async () => {
  setHandler(() => { throw new Error('db down'); });
  const res = makeRes();
  await room.getRooms({}, res);
  assert.equal(res.statusCode, 500);
});

// ============================================================
// editRoom
// ============================================================
test('editRoom: ไม่พบห้อง → 404', async () => {
  setHandler(() => ({ rows: [] }));
  const res = makeRes();
  await room.editRoom({ params: { id: 999 }, body: {} }, res);
  assert.equal(res.statusCode, 404);
});

test('editRoom: พบห้อง → 200 + คงค่าฟิลด์ที่ไม่ได้ส่งมา', async () => {
  setHandler((sql) => {
    if (sql.trim().startsWith('SELECT * FROM rooms')) {
      return { rows: [{ room_id: 1, room_number: '101', room_status: 'ว่าง', room_price: 500 }] };
    }
    return { rows: [] };
  });
  const res = makeRes();
  await room.editRoom({ params: { id: 1 }, body: { room_price: 600 } }, res);
  assert.equal(res.statusCode, 200);
  const updateCall = calls.find((c) => sqlIsUpdate(c.sql));
  assert.equal(updateCall.params[0], '101');   // room_number คงเดิม
  assert.equal(updateCall.params[3], 600);     // room_price อัปเดตใหม่
});
function sqlIsUpdate(sql) { return sql.trim().startsWith('UPDATE rooms SET'); }

// ============================================================
// searchRooms
// ============================================================
test('searchRooms: ไม่ส่ง checkIn/checkOut → 400', async () => {
  const res = makeRes();
  await room.searchRooms({ body: {}, query: {} }, res);
  assert.equal(res.statusCode, 400);
});

test('searchRooms: ส่งครบ → 200 + คืนห้องว่าง', async () => {
  setHandler((sql) => {
    if (has(sql, "room_status = 'ว่าง'")) return { rows: [{ id: 1, number: '101' }], rowCount: 1 };
    return { rows: [] };
  });
  const res = makeRes();
  await room.searchRooms({ body: { checkIn: '2026-07-01', checkOut: '2026-07-05' }, query: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.count, 1);
});

// ============================================================
// deleteRoom
// ============================================================
test('deleteRoom: มีการจองที่ยังใช้งานอยู่ → 400', async () => {
  setHandler((sql) => {
    if (has(sql, 'FROM bookings')) return { rows: [{ booking_id: 1 }] };
    return { rows: [] };
  });
  const res = makeRes();
  await room.deleteRoom({ params: { id: 1 } }, res);
  assert.equal(res.statusCode, 400);
});

test('deleteRoom: ไม่พบห้อง → 404', async () => {
  setHandler((sql) => {
    if (has(sql, 'FROM bookings')) return { rows: [] };
    if (sql.trim().startsWith('DELETE FROM rooms')) return { rowCount: 0 };
    return { rows: [] };
  });
  const res = makeRes();
  await room.deleteRoom({ params: { id: 999 } }, res);
  assert.equal(res.statusCode, 404);
});

test('deleteRoom: ลบสำเร็จ → 200', async () => {
  setHandler((sql) => {
    if (has(sql, 'FROM bookings')) return { rows: [] };
    if (sql.trim().startsWith('DELETE FROM rooms')) return { rowCount: 1 };
    return { rows: [] };
  });
  const res = makeRes();
  await room.deleteRoom({ params: { id: 1 } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
});
