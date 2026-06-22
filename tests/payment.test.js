// ============================================================
// Unit tests — M7 Payments (controllers/payment.js)
// ใช้ node:test (built-in) + mock database/mailer/pdf/qr/supabase — ไม่แตะ service จริง
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

// inject mock ต่างๆ เข้า require cache ก่อน controller จะ require
function injectMock(relPath, exportsObj) {
  const abs = require.resolve(path.join(__dirname, '..', relPath));
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports: exportsObj };
}

injectMock('config/db.js', mockPool);
injectMock('config/mailer.js', { sendInvoiceMail: async () => {} });
injectMock('utils/invoicePdf.js', { buildInvoicePdf: async () => Buffer.from('pdf') });
injectMock('utils/promptpayQr.js', { buildPromptpayQr: async (amt) => ({ dataUrl: 'data:img', promptpayId: '0812345678', amount: amt }) });
injectMock('config/supabase.js', { uploadSlip: async () => 'https://supabase/slip.jpg' });

const payment = require('../controllers/payment');

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

// header ที่ _loadFullInvoice คืน
const fullInvoiceHeader = {
  invoice_id: 77, booking_id: 5, invoice_date: '2026-06-01', due_date: '2026-06-08',
  room_cost: 4500, water_cost: 200, elec_cost: 700, total_amount: 5400,
  invoice_status: 'ยังไม่ชำระ', member_id: 2,
  guest_name: 'สมชาย', guest_email: 'a@b.com', room_number: 'A101',
};

const insertedPayment = {
  payment_id: 50, invoice_id: 77, payment_date: '2026-06-23',
  payment_method: 'โอนเงิน', amount_paid: 5400, payment_evidence: null, payment_status: 'รอตรวจ',
};

beforeEach(reset);

// ============================================================
// createPayment
// ============================================================
test('createPayment: ไม่ส่ง invoice_id → 400', async () => {
  const req = { body: {}, user: { id: 2, role: 'Monthly_Tenant' } };
  const res = makeRes();
  await payment.createPayment(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.success, false);
});

test('createPayment: ผู้เช่าชำระบิลของคนอื่น → 403', async () => {
  setHandler((sql) => {
    const s = sql.trim();
    if (s.startsWith('BEGIN') || s.startsWith('ROLLBACK')) return { rows: [] };
    if (has(s, 'FROM invoices i')) return { rows: [fullInvoiceHeader] }; // member_id = 2
    if (has(s, 'FROM invoice_details')) return { rows: [] };
    return { rows: [] };
  });

  const req = { body: { invoice_id: 77 }, user: { id: 999, role: 'Monthly_Tenant' } };
  const res = makeRes();
  await payment.createPayment(req, res);
  assert.equal(res.statusCode, 403);
});

test('createPayment: ผู้เช่าแจ้งโอน → payment_status รอตรวจ, 201', async () => {
  setHandler((sql) => {
    const s = sql.trim();
    if (s.startsWith('BEGIN') || s.startsWith('COMMIT') || s.startsWith('ROLLBACK')) return { rows: [] };
    if (has(s, 'FROM invoices i')) return { rows: [fullInvoiceHeader] };
    if (has(s, 'FROM invoice_details')) return { rows: [] };
    if (has(s, 'SUM(amount_paid)')) return { rows: [{ paid_sum: 0 }] };
    if (s.startsWith('INSERT INTO payments')) return { rows: [insertedPayment] };
    return { rows: [] };
  });

  const req = { body: { invoice_id: 77, amount_paid: 5400 }, user: { id: 2, role: 'Monthly_Tenant' } };
  const res = makeRes();
  await payment.createPayment(req, res);

  assert.equal(res.statusCode, 201);
  // INSERT params: [invoice_id, method, amount, evidence, status]
  const p = paramsOf('INSERT INTO payments');
  assert.equal(p[1], 'โอนเงิน');
  assert.equal(p[2], 5400);
  assert.equal(p[4], 'รอตรวจ');
});

test('createPayment: admin บันทึกเงินสดครบยอด → ยืนยันทันที + บิลชำระแล้ว', async () => {
  setHandler((sql) => {
    const s = sql.trim();
    if (s.startsWith('BEGIN') || s.startsWith('COMMIT') || s.startsWith('ROLLBACK')) return { rows: [] };
    if (has(s, 'FROM invoices i')) return { rows: [fullInvoiceHeader] };
    if (has(s, 'FROM invoice_details')) return { rows: [] };
    // SUM: ก่อน insert = 0 (ไม่กระทบ เพราะส่ง amount มาเอง), recompute หลัง insert = ครบยอด
    if (has(s, 'SUM(amount_paid)')) return { rows: [{ paid_sum: 5400 }] };
    if (s.startsWith('INSERT INTO payments')) {
      return { rows: [{ ...insertedPayment, payment_method: 'เงินสด', payment_status: 'ยืนยันแล้ว' }] };
    }
    if (has(s, 'SELECT total_amount FROM invoices')) return { rows: [{ total_amount: 5400 }] };
    return { rows: [] };
  });

  const req = { body: { invoice_id: 77, amount_paid: 5400, payment_method: 'เงินสด' }, user: { id: 1, role: 'Admin' } };
  const res = makeRes();
  await payment.createPayment(req, res);

  assert.equal(res.statusCode, 201);
  // insert ด้วยสถานะ 'ยืนยันแล้ว'
  const p = paramsOf('INSERT INTO payments');
  assert.equal(p[4], 'ยืนยันแล้ว');
  // อัปเดตบิลเป็น 'ชำระแล้ว'
  const u = paramsOf('UPDATE invoices SET invoice_status');
  assert.equal(u[0], 'ชำระแล้ว');
});

// ============================================================
// verifyPayment
// ============================================================
test('verifyPayment: action ผิด → 400', async () => {
  const req = { params: { id: 50 }, body: { action: 'xxx' }, user: { id: 1, role: 'Admin' } };
  const res = makeRes();
  await payment.verifyPayment(req, res);
  assert.equal(res.statusCode, 400);
});

test('verifyPayment: approve ชำระครบ → invoice_status ชำระแล้ว', async () => {
  setHandler((sql) => {
    const s = sql.trim();
    if (s.startsWith('BEGIN') || s.startsWith('COMMIT') || s.startsWith('ROLLBACK')) return { rows: [] };
    if (has(s, 'SELECT payment_id, invoice_id, payment_status FROM payments')) {
      return { rows: [{ payment_id: 50, invoice_id: 77, payment_status: 'รอตรวจ' }] };
    }
    if (has(s, 'SUM(amount_paid)')) return { rows: [{ paid_sum: 5400 }] };
    if (has(s, 'SELECT total_amount FROM invoices')) return { rows: [{ total_amount: 5400 }] };
    if (has(s, 'FROM invoices i')) return { rows: [fullInvoiceHeader] };
    if (has(s, 'FROM invoice_details')) return { rows: [] };
    if (has(s, 'payment_method, payment_date FROM payments')) {
      return { rows: [{ payment_id: 50, payment_method: 'โอนเงิน', payment_date: '2026-06-23' }] };
    }
    return { rows: [] };
  });

  const req = { params: { id: 50 }, body: { action: 'approve' }, user: { id: 1, role: 'Admin' } };
  const res = makeRes();
  await payment.verifyPayment(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.invoice_status, 'ชำระแล้ว');
  assert.equal(res.body.data.payment_status, 'ยืนยันแล้ว');
});

test('verifyPayment: reject → payment_status ปฏิเสธ, บิลยังไม่ชำระ', async () => {
  setHandler((sql) => {
    const s = sql.trim();
    if (s.startsWith('BEGIN') || s.startsWith('COMMIT') || s.startsWith('ROLLBACK')) return { rows: [] };
    if (has(s, 'SELECT payment_id, invoice_id, payment_status FROM payments')) {
      return { rows: [{ payment_id: 50, invoice_id: 77, payment_status: 'รอตรวจ' }] };
    }
    if (has(s, 'SUM(amount_paid)')) return { rows: [{ paid_sum: 0 }] };
    if (has(s, 'SELECT total_amount FROM invoices')) return { rows: [{ total_amount: 5400 }] };
    return { rows: [] };
  });

  const req = { params: { id: 50 }, body: { action: 'reject' }, user: { id: 1, role: 'Admin' } };
  const res = makeRes();
  await payment.verifyPayment(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.payment_status, 'ปฏิเสธ');
  assert.equal(res.body.data.invoice_status, 'ยังไม่ชำระ');
});

// ============================================================
// getMyPayments — ownership (กรองด้วย member_id ของผู้ล็อกอิน)
// ============================================================
test('getMyPayments: คืนเฉพาะของตัวเอง', async () => {
  setHandler((sql) => {
    const s = sql.trim();
    if (has(s, 'WHERE b.member_id')) {
      return { rows: [{ payment_id: 50, invoice_id: 77, amount_paid: 5400, payment_status: 'ยืนยันแล้ว' }] };
    }
    return { rows: [] };
  });

  const req = { query: {}, user: { id: 2, role: 'Monthly_Tenant' } };
  const res = makeRes();
  await payment.getMyPayments(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.count, 1);
  // ยืนยันว่ากรองด้วย id ของผู้ล็อกอิน
  const p = paramsOf('WHERE b.member_id');
  assert.equal(p[0], 2);
});
