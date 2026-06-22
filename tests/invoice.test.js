// ============================================================
// Unit tests — M6 Billing (controllers/invoice.js)
// ใช้ node:test (built-in) + mock database/mailer/pdf — ไม่แตะ Supabase/Gmail จริง
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

// inject mock db เข้า require cache ก่อน controller จะ require
const dbAbs = require.resolve(path.join(__dirname, '..', 'config', 'db.js'));
require.cache[dbAbs] = { id: dbAbs, filename: dbAbs, loaded: true, exports: mockPool };

// mock mailer — แค่ resolve ไม่ส่งจริง
const mailerAbs = require.resolve(path.join(__dirname, '..', 'config', 'mailer.js'));
require.cache[mailerAbs] = {
  id: mailerAbs, filename: mailerAbs, loaded: true,
  exports: { sendInvoiceMail: async () => {} },
};

// mock pdf — คืน Buffer เปล่า ไม่สร้างไฟล์จริง
const pdfAbs = require.resolve(path.join(__dirname, '..', 'utils', 'invoicePdf.js'));
require.cache[pdfAbs] = {
  id: pdfAbs, filename: pdfAbs, loaded: true,
  exports: { buildInvoicePdf: async () => Buffer.from('pdf') },
};

const invoice = require('../controllers/invoice');

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
// หา params ของ query แรกที่ตรง fragment
function paramsOf(frag) {
  const c = calls.find((c) => has(c.sql, frag));
  return c ? c.params : null;
}

// header ที่ loadFullInvoice คืน (ใช้สร้าง response/อีเมล)
const fullInvoiceHeader = {
  invoice_id: 77, booking_id: 5, invoice_date: '2026-06-01', due_date: '2026-06-08',
  room_cost: 4500, water_cost: 200, elec_cost: 700, total_amount: 5400,
  invoice_status: 'ยังไม่ชำระ', member_id: 2,
  guest_name: 'สมชาย', guest_email: 'a@b.com', room_number: 'A101',
};

beforeEach(reset);

// ============================================================
// createInvoice — คำนวณยอด + insert + guard
// ============================================================
test('createInvoice: รายเดือน + มิเตอร์ครบ → คำนวณ room/water/elec/total ถูกต้อง, 201', async () => {
  setHandler((sql) => {
    const s = sql.trim();
    if (s.startsWith('BEGIN') || s.startsWith('COMMIT') || s.startsWith('ROLLBACK')) return { rows: [] };
    // โหลด booking
    if (has(s, 'FROM bookings b') && has(s, 'JOIN rooms r') && has(s, 'WHERE b.booking_id')) {
      return { rows: [{
        booking_id: 5, room_id: 3, member_id: 2, rent_type: 'monthly',
        check_in_date: '2026-06-01', check_out_date: '2027-06-01',
        room_price: 500, price_monthly: 4500,
      }] };
    }
    // เช็คบิลซ้ำ → ไม่มี
    if (has(s, 'FROM invoices') && has(s, 'to_char')) return { rows: [] };
    // มิเตอร์: น้ำใช้ 20 หน่วย, ไฟใช้ 100 หน่วย
    if (has(s, 'utility_meters')) {
      return { rows: [{ curr_water: 120, prev_water: 100, curr_elec: 500, prev_elec: 400 }] };
    }
    if (s.startsWith('INSERT INTO invoices')) return { rows: [{ invoice_id: 77 }] };
    // loadFullInvoice header
    if (has(s, 'FROM invoices i')) return { rows: [fullInvoiceHeader] };
    if (has(s, 'FROM invoice_details')) return { rows: [] };
    return { rows: [] };
  });

  const req = { body: { booking_id: 5, month: '2026-06' }, user: { id: 1, role: 'Admin' } };
  const res = makeRes();
  await invoice.createInvoice(req, res);

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.success, true);

  // ตรวจ params ที่ insert ลง invoices: [booking, date, due, room, water, elec, total]
  const p = paramsOf('INSERT INTO invoices');
  assert.equal(p[3], 4500);        // room_cost = price_monthly
  assert.equal(p[4], 200);         // water = 20 × 10
  assert.equal(p[5], 700);         // elec  = 100 × 7
  assert.equal(p[6], 5400);        // total
});

test('createInvoice: ไม่ส่ง booking_id → 400', async () => {
  const req = { body: {}, user: { id: 1, role: 'Admin' } };
  const res = makeRes();
  await invoice.createInvoice(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.success, false);
});

test('createInvoice: มีบิลของ booking นี้ในเดือนเดียวกันแล้ว → 400', async () => {
  setHandler((sql) => {
    const s = sql.trim();
    if (s.startsWith('BEGIN') || s.startsWith('ROLLBACK')) return { rows: [] };
    if (has(s, 'FROM bookings b') && has(s, 'WHERE b.booking_id')) {
      return { rows: [{ booking_id: 5, room_id: 3, rent_type: 'monthly', price_monthly: 4500 }] };
    }
    if (has(s, 'FROM invoices') && has(s, 'to_char')) return { rows: [{ invoice_id: 1 }] }; // มีซ้ำ
    return { rows: [] };
  });

  const req = { body: { booking_id: 5, month: '2026-06' }, user: { id: 1, role: 'Admin' } };
  const res = makeRes();
  await invoice.createInvoice(req, res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /อยู่แล้ว/);
});

// ============================================================
// updateInvoice — ล็อกบิลชำระแล้ว + คำนวณยอดใหม่
// ============================================================
test('updateInvoice: บิลชำระแล้ว → 403 (ห้ามแก้)', async () => {
  setHandler((sql) => {
    const s = sql.trim();
    if (s.startsWith('BEGIN') || s.startsWith('ROLLBACK')) return { rows: [] };
    if (has(s, 'SELECT invoice_id, invoice_status')) return { rows: [{ invoice_id: 9, invoice_status: 'ชำระแล้ว' }] };
    return { rows: [] };
  });

  const req = { params: { id: 9 }, body: { details: [] }, user: { id: 1, role: 'Admin' } };
  const res = makeRes();
  await invoice.updateInvoice(req, res);

  assert.equal(res.statusCode, 403);
  assert.equal(res.body.success, false);
});

test('updateInvoice: ส่ง details ใหม่ → คำนวณ subtotal/total ฝั่ง server', async () => {
  setHandler((sql) => {
    const s = sql.trim();
    if (s.startsWith('BEGIN') || s.startsWith('COMMIT') || s.startsWith('ROLLBACK')) return { rows: [] };
    if (has(s, 'SELECT invoice_id, invoice_status')) return { rows: [{ invoice_id: 9, invoice_status: 'ยังไม่ชำระ' }] };
    if (has(s, 'FROM invoices i')) return { rows: [fullInvoiceHeader] };
    if (has(s, 'FROM invoice_details')) return { rows: [] };
    return { rows: [] };
  });

  const details = [
    { item_name: 'ค่าห้อง (รายเดือน)', quantity: 1, unit_price: 4500 },
    { item_name: 'ค่าน้ำ (10 หน่วย)', quantity: 10, unit_price: 10 },
  ];
  const req = { params: { id: 9 }, body: { details }, user: { id: 1, role: 'Admin' } };
  const res = makeRes();
  await invoice.updateInvoice(req, res);

  assert.equal(res.statusCode, 200);
  // UPDATE invoices SET room_cost=$1, water_cost=$2, elec_cost=$3, total_amount=$4 ...
  const p = paramsOf('UPDATE invoices SET');
  assert.equal(p[0], 4500);   // room
  assert.equal(p[1], 100);    // water = 10 × 10
  assert.equal(p[2], 0);      // elec
  assert.equal(p[3], 4600);   // total
});

// ============================================================
// getInvoiceById — ownership check
// ============================================================
test('getInvoiceById: ผู้เช่าเปิดบิลของคนอื่น → 403', async () => {
  setHandler((sql) => {
    const s = sql.trim();
    if (has(s, 'FROM invoices i')) return { rows: [fullInvoiceHeader] }; // member_id = 2
    if (has(s, 'FROM invoice_details')) return { rows: [] };
    return { rows: [] };
  });

  const req = { params: { id: 77 }, user: { id: 999, role: 'Monthly_Tenant' } };
  const res = makeRes();
  await invoice.getInvoiceById(req, res);

  assert.equal(res.statusCode, 403);
});

test('getInvoiceById: เจ้าของบิลเปิดได้ → 200', async () => {
  setHandler((sql) => {
    const s = sql.trim();
    if (has(s, 'FROM invoices i')) return { rows: [fullInvoiceHeader] }; // member_id = 2
    if (has(s, 'FROM invoice_details')) return { rows: [] };
    return { rows: [] };
  });

  const req = { params: { id: 77 }, user: { id: 2, role: 'Monthly_Tenant' } };
  const res = makeRes();
  await invoice.getInvoiceById(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
});

// ============================================================
// generateMonthly — ออกบิลยกชุด
// ============================================================
test('generateMonthly: มี 1 การจองที่ค้างบิล → ออกบิล 1 ใบ', async () => {
  setHandler((sql) => {
    const s = sql.trim();
    if (s.startsWith('BEGIN') || s.startsWith('COMMIT') || s.startsWith('ROLLBACK')) return { rows: [] };
    // เป้าหมาย: การจองรายเดือนที่ยังไม่มีบิล
    if (has(s, 'NOT EXISTS')) {
      return { rows: [{
        booking_id: 5, room_id: 3, member_id: 2, rent_type: 'monthly',
        check_in_date: '2026-06-01', check_out_date: '2027-06-01',
        room_price: 500, price_monthly: 4500,
      }] };
    }
    if (has(s, 'utility_meters')) return { rows: [{}] }; // ไม่มีมิเตอร์ → น้ำ/ไฟ = 0
    if (s.startsWith('INSERT INTO invoices')) return { rows: [{ invoice_id: 88 }] };
    if (has(s, 'FROM invoices i')) return { rows: [fullInvoiceHeader] };
    if (has(s, 'FROM invoice_details')) return { rows: [] };
    return { rows: [] };
  });

  const req = { body: { month: '2026-06' }, user: { id: 1, role: 'Admin' } };
  const res = makeRes();
  await invoice.generateMonthly(req, res);

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.count, 1);
});
