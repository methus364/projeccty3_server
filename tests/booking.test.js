// ============================================================
// Unit tests — M3 Booking (controllers/booking.js)
// ใช้ node:test (built-in) + mock database — ไม่แตะ Supabase จริง
// รัน:  cd server && npm test
// ============================================================
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// ---------- mock pool (แทน config/db) ----------
const calls = [];          // เก็บทุก query ที่ถูกเรียก (ไว้ assert)
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

// inject mock เข้า require cache ก่อน controller จะ require ('../config/db')
const dbAbs = require.resolve(path.join(__dirname, '..', 'config', 'db.js'));
require.cache[dbAbs] = { id: dbAbs, filename: dbAbs, loaded: true, exports: mockPool };

// mock supabase upload (ไม่แตะ Storage จริง) — คืน URL ปลอม
const supaAbs = require.resolve(path.join(__dirname, '..', 'config', 'supabase.js'));
require.cache[supaAbs] = {
  id: supaAbs, filename: supaAbs, loaded: true,
  exports: { uploadFile: async () => 'https://mock/file.jpg', uploadSlip: async () => 'https://mock/slip.jpg' },
};

const booking = require('../controllers/booking');

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
const called = (frag) => calls.some((c) => has(c.sql, frag));

// handler สำหรับ flow create/admin-create
function scenarioCreate({ room, overlap = [], bookingId = 99 }) {
  setHandler((sql) => {
    const s = sql.trim();
    if (s.startsWith('BEGIN') || s.startsWith('COMMIT') || s.startsWith('ROLLBACK')) return { rows: [] };
    if (has(s, 'SELECT room_price') && has(s, 'FROM rooms')) return { rows: room ? [room] : [] };
    if (has(s, 'FROM bookings') && has(s, 'booking_status NOT IN')) return { rows: overlap };
    if (s.startsWith('INSERT INTO bookings')) return { rows: [{ booking_id: bookingId }] };
    return { rows: [] };
  });
}

beforeEach(reset);

// ============================================================
// createBooking — คำนวณราคา + guard
// ============================================================
test('createBooking: รายวัน 3 วัน → totalPrice = วัน × room_price, status 201', async () => {
  scenarioCreate({ room: { room_price: 500, price_monthly: 4500, room_status: 'ว่าง' } });
  const req = { user: { id: 2 }, body: { roomId: 1, startDate: '2026-07-01', endDate: '2026-07-04', rentType: 'daily' } };
  const res = makeRes();
  await booking.createBooking(req, res);

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.success, true);
  assert.equal(res.body.totalPrice, 1500);      // 3 วัน × 500
  assert.equal(res.body.bookingId, 99);
  assert.ok(called('UPDATE rooms'), 'ต้องอัปเดต room_status เป็นมีผู้เช่า');
  assert.ok(called('COMMIT'), 'ต้อง COMMIT');
  assert.ok(called('FOR UPDATE'), 'ต้องล็อกแถวห้องก่อนเช็ค overlap กันจองซ้ำ');
});

test('createBooking: รายเดือน 30 วัน → totalPrice = เดือน × price_monthly', async () => {
  scenarioCreate({ room: { room_price: 500, price_monthly: 4500, room_status: 'ว่าง' } });
  const req = { user: { id: 2 }, body: { roomId: 1, startDate: '2026-07-01', endDate: '2026-07-31', rentType: 'monthly' } };
  const res = makeRes();
  await booking.createBooking(req, res);

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.totalPrice, 4500);       // 1 เดือน × 4500
});

test('createBooking: ไม่พบห้อง → 400 + ROLLBACK', async () => {
  scenarioCreate({ room: null });
  const res = makeRes();
  await booking.createBooking({ user: { id: 2 }, body: { roomId: 999, startDate: '2026-07-01', endDate: '2026-07-02' } }, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.success, false);
  assert.match(res.body.message, /ไม่พบข้อมูลห้องพัก/);
  assert.ok(called('ROLLBACK'));
});

test('createBooking: ห้องปิดปรับปรุง → 400', async () => {
  scenarioCreate({ room: { room_price: 600, price_monthly: 5000, room_status: 'ปิดปรับปรุง' } });
  const res = makeRes();
  await booking.createBooking({ user: { id: 2 }, body: { roomId: 5, startDate: '2026-07-01', endDate: '2026-07-02' } }, res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /ปิดปรับปรุง/);
});

test('createBooking: ช่วงเวลาจองซ้อน → 400 (overlap)', async () => {
  scenarioCreate({ room: { room_price: 500, price_monthly: 4500, room_status: 'ว่าง' }, overlap: [{ booking_id: 7 }] });
  const res = makeRes();
  await booking.createBooking({ user: { id: 2 }, body: { roomId: 2, startDate: '2026-07-01', endDate: '2026-07-05' } }, res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /ถูกจองหรือมีผู้เช่า/);
  assert.equal(called('INSERT INTO bookings'), false, 'ต้องไม่ insert เมื่อ overlap');
});

// ============================================================
// checkIn — status transition + สร้างสัญญารายเดือน (M10a)
// (รายเดือนไม่ออกบิลตอนเช็คอินแล้ว — ค่าเช่าเดือนแรกเป็น prepaid)
// ============================================================
function scenarioCheckIn(bk) {
  setHandler((sql) => {
    const s = sql.trim();
    if (s.startsWith('BEGIN') || s.startsWith('COMMIT') || s.startsWith('ROLLBACK')) return { rows: [] };
    if (has(s, 'FROM bookings b') && has(s, 'JOIN rooms r')) return { rows: bk ? [bk] : [] };
    if (s.startsWith('INSERT INTO contracts')) return { rows: [{ contract_id: 70 }] }; // RETURNING contract_id
    return { rows: [] };
  });
}

test('checkIn: รายเดือน → สร้างสัญญา (ไม่ออกบิลตอนเช็คอิน)', async () => {
  scenarioCheckIn({ booking_id: 1, member_id: 2, room_id: 3, check_in_date: '2026-07-01', booking_status: 'ยืนยันการจอง', rent_type: 'monthly', price_monthly: 4500, deposit_amount: 4500 });
  const res = makeRes();
  await booking.checkIn({ params: { id: 1 }, body: {} }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.ok(called('INSERT INTO contracts'), 'รายเดือนต้องสร้างสัญญา');
  assert.equal(called('INSERT INTO invoices'), false, 'ไม่ออกบิลตอนเช็คอิน (เดือนแรก prepaid)');
  assert.ok(called("room_status = 'มีผู้เช่า'"), 'ห้องต้องเป็นมีผู้เช่า');
});

test('checkIn: รายวัน (แนบบัตร) → ไม่สร้างสัญญา/ไม่ออกบิล', async () => {
  scenarioCheckIn({ booking_id: 1, member_id: 2, room_id: 1, check_in_date: '2026-07-01', booking_status: 'ยืนยันการจอง', rent_type: 'daily', price_monthly: 0 });
  const res = makeRes();
  // รายวันต้องแนบสำเนาบัตร (multer.fields → req.files.id_card)
  const files = { id_card: [{ buffer: Buffer.from(''), originalname: 'id.jpg', mimetype: 'image/jpeg' }] };
  await booking.checkIn({ params: { id: 1 }, body: {}, files }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(called('INSERT INTO contracts'), false, 'รายวันไม่ต้องสร้างสัญญา');
  assert.equal(called('INSERT INTO invoices'), false, 'รายวันไม่ต้องออกบิล');
});

test('checkIn: รายวัน ไม่แนบบัตร → 400 (บังคับแนบสำเนาบัตร)', async () => {
  scenarioCheckIn({ booking_id: 1, member_id: 2, room_id: 1, check_in_date: '2026-07-01', booking_status: 'ยืนยันการจอง', rent_type: 'daily', price_monthly: 0 });
  const res = makeRes();
  await booking.checkIn({ params: { id: 1 }, body: {} }, res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /บัตร/);
});

test('checkIn: เช็คอินซ้ำ (สถานะกำลังเข้าพักอยู่แล้ว) → 400', async () => {
  scenarioCheckIn({ booking_id: 1, room_id: 1, check_in_date: '2026-07-01', booking_status: 'กำลังเข้าพัก', rent_type: 'daily', price_monthly: 0 });
  const res = makeRes();
  await booking.checkIn({ params: { id: 1 } }, res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /เช็คอินไปแล้ว/);
});

// ============================================================
// checkOut — คืนห้องเป็นว่าง
// ============================================================
function scenarioCheckOut(bk) {
  setHandler((sql) => {
    const s = sql.trim();
    if (s.startsWith('BEGIN') || s.startsWith('COMMIT') || s.startsWith('ROLLBACK')) return { rows: [] };
    if (has(s, 'SELECT room_id, booking_status FROM bookings')) return { rows: bk ? [bk] : [] };
    return { rows: [] };
  });
}

test('checkOut: สำเร็จ → คืนห้องเป็นว่าง + status ย้ายออกแล้ว', async () => {
  scenarioCheckOut({ room_id: 2, booking_status: 'กำลังเข้าพัก' });
  const res = makeRes();
  await booking.checkOut({ params: { id: 1 } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.ok(called("room_status = 'ว่าง'"), 'ต้องคืนห้องเป็นว่าง');
});

test('checkOut: เช็คเอาท์ซ้ำ → 400', async () => {
  scenarioCheckOut({ room_id: 2, booking_status: 'ย้ายออกแล้ว' });
  const res = makeRes();
  await booking.checkOut({ params: { id: 1 } }, res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /เช็คเอาท์ไปแล้ว/);
});

// ============================================================
// editBooking — ownership / not found
// ============================================================
test('editBooking: ผู้เช่าแก้ของคนอื่น → 403', async () => {
  setHandler((sql) => {
    const s = sql.trim();
    if (s.startsWith('SELECT * FROM bookings')) return { rows: [{ booking_id: 1, member_id: 3, room_id: 2, rent_type: 'daily' }] };
    return { rows: [] };
  });
  const req = { params: { id: 1 }, body: {}, user: { role: 'Daily_Tenant', id: 2 } };  // id 2 ≠ เจ้าของ 3
  const res = makeRes();
  await booking.editBooking(req, res);

  assert.equal(res.statusCode, 403);
  assert.match(res.body.message, /ไม่มีสิทธิ์/);
});

test('editBooking: ไม่พบการจอง → 404', async () => {
  setHandler(() => ({ rows: [] }));
  const req = { params: { id: 999 }, body: {}, user: { role: 'Admin', id: 1 } };
  const res = makeRes();
  await booking.editBooking(req, res);

  assert.equal(res.statusCode, 404);
});

test('editBooking: Admin ย้ายห้อง → ล็อกแถวห้องเป้าหมายก่อนเช็ค overlap (FOR UPDATE)', async () => {
  setHandler((sql) => {
    const s = sql.trim();
    if (s.startsWith('BEGIN') || s.startsWith('COMMIT') || s.startsWith('ROLLBACK')) return { rows: [] };
    if (s.startsWith('SELECT * FROM bookings')) {
      return { rows: [{ booking_id: 1, member_id: 3, room_id: 2, rent_type: 'daily', check_in_date: '2026-07-01', check_out_date: '2026-07-04', booking_status: 'รอชำระมัดจำ' }] };
    }
    if (has(s, 'FROM bookings') && has(s, 'booking_status NOT IN')) return { rows: [] }; // ไม่มี overlap
    if (has(s, 'SELECT room_price') && has(s, 'FROM rooms')) return { rows: [{ room_price: 500, price_monthly: 4500 }] };
    return { rows: [] };
  });
  const req = { params: { id: 1 }, body: { roomId: 9 }, user: { role: 'Admin', id: 1 } };
  const res = makeRes();
  await booking.editBooking(req, res);

  assert.equal(res.statusCode, 200);
  assert.ok(called('FOR UPDATE'), 'ต้องล็อกแถวห้องเป้าหมายก่อนเช็ค overlap กันชนกันตอนย้ายห้อง');
});

test('adminCreateBooking: สร้างสำเร็จ → ล็อกแถวห้องก่อนเช็ค overlap (FOR UPDATE)', async () => {
  scenarioCreate({ room: { room_price: 500, price_monthly: 4500, room_status: 'ว่าง' } });
  const req = { body: { roomId: 1, userId: 2, startDate: '2026-07-01', endDate: '2026-07-04', rentType: 'daily' } };
  const res = makeRes();
  await booking.adminCreateBooking(req, res);

  assert.equal(res.statusCode, 201);
  assert.ok(called('FOR UPDATE'), 'ต้องล็อกแถวห้องก่อนเช็ค overlap กันจองซ้ำ');
});
