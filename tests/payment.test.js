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

// mock Omise — คุมผลลัพธ์การสร้าง QR + สถานะการจ่าย
let omiseChargePaid = false; // ปรับในแต่ละเทสว่า charge จ่ายแล้วหรือยัง
let omiseChargeMetadata = {}; // metadata ที่ "Omise" (mock) ยืนยันกลับมาจริง — ใช้แทนที่ metadata ใน webhook body ที่ปลอมได้
injectMock('config/omise.js', {
  createPromptPayCharge: async (amount) => ({ chargeId: 'chrg_test_1', qrImage: 'https://omise/qr.png', amount, status: 'pending' }),
  retrieveCharge: async () => ({
    status: omiseChargePaid ? 'successful' : 'pending',
    paid: omiseChargePaid,
    metadata: omiseChargeMetadata,
  }),
});

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

test('createPayment: admin บันทึกเงินสดแต่ไม่แนบหลักฐาน → 400 (USER_FLOWS: บังคับแนบเสมอ)', async () => {
  setHandler((sql) => {
    const s = sql.trim();
    if (s.startsWith('BEGIN') || s.startsWith('COMMIT') || s.startsWith('ROLLBACK')) return { rows: [] };
    if (has(s, 'FROM invoices i')) return { rows: [fullInvoiceHeader] };
    if (has(s, 'FROM invoice_details')) return { rows: [] };
    if (has(s, 'SUM(amount_paid)')) return { rows: [{ paid_sum: 0 }] };
    return { rows: [] };
  });

  // ไม่แนบไฟล์ (req.file undefined) → ต้องถูกปฏิเสธ
  const req = { body: { invoice_id: 77, amount_paid: 5400, payment_method: 'เงินสด' }, user: { id: 1, role: 'Admin' } };
  const res = makeRes();
  await payment.createPayment(req, res);

  assert.equal(res.statusCode, 400);
  assert.ok(/หลักฐาน/.test(res.body.message));
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
    if (has(s, 'total_amount, due_date, invoice_status FROM invoices')) return { rows: [{ total_amount: 5400, due_date: null, invoice_status: 'ยังไม่ชำระ' }] };
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
    if (has(s, 'total_amount, due_date, invoice_status FROM invoices')) return { rows: [{ total_amount: 5400, due_date: null, invoice_status: 'ยังไม่ชำระ' }] };
    return { rows: [] };
  });

  const req = { params: { id: 50 }, body: { action: 'reject' }, user: { id: 1, role: 'Admin' } };
  const res = makeRes();
  await payment.verifyPayment(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.payment_status, 'ปฏิเสธ');
  assert.equal(res.body.data.invoice_status, 'ยังไม่ชำระ');
});

test('verifyPayment: จ่ายครบแค่ total_amount แต่บิลเลยกำหนดมีค่าปรับ → ยังไม่ปิด "ชำระแล้ว" (ต้องจ่ายค่าปรับด้วย)', async () => {
  setHandler((sql) => {
    const s = sql.trim();
    if (s.startsWith('BEGIN') || s.startsWith('COMMIT') || s.startsWith('ROLLBACK')) return { rows: [] };
    if (has(s, 'SELECT payment_id, invoice_id, payment_status FROM payments')) {
      return { rows: [{ payment_id: 50, invoice_id: 77, payment_status: 'รอตรวจ' }] };
    }
    // จ่ายมาแค่พอดี total_amount (ไม่รวมค่าปรับ)
    if (has(s, 'SUM(amount_paid)')) return { rows: [{ paid_sum: 5400 }] };
    // due_date เลยมานานมาก → มีค่าปรับแน่นอน (50 บาท/วัน)
    if (has(s, 'total_amount, due_date, invoice_status FROM invoices')) {
      return { rows: [{ total_amount: 5400, due_date: '2020-01-01', invoice_status: 'ยังไม่ชำระ' }] };
    }
    return { rows: [] };
  });

  const req = { params: { id: 50 }, body: { action: 'approve' }, user: { id: 1, role: 'Admin' } };
  const res = makeRes();
  await payment.verifyPayment(req, res);

  assert.equal(res.statusCode, 200);
  // ยังไม่ครบเพราะไม่รวมค่าปรับ → ต้องเป็น "ชำระบางส่วน" ไม่ใช่ "ชำระแล้ว"
  assert.equal(res.body.data.invoice_status, 'ชำระบางส่วน');
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

// ============================================================
// createQrCharge — จ่ายด้วย QR อัตโนมัติ (Omise)
// ============================================================
test('createQrCharge: บิลของตัวเอง → 201 + คืน qrImage + สร้าง payment row', async () => {
  setHandler((s) => {
    const q = s.trim();
    if (q.startsWith('BEGIN') || q.startsWith('COMMIT') || q.startsWith('ROLLBACK')) return { rows: [] };
    if (has(q, 'FROM invoices i')) return { rows: [fullInvoiceHeader] };            // _loadFullInvoice
    if (has(q, "payment_status = 'ยืนยันแล้ว'")) return { rows: [{ paid_sum: 0 }] }; // ยอดที่จ่ายแล้ว
    if (q.startsWith('INSERT INTO payments')) return { rows: [{ payment_id: 90 }] };
    return { rows: [] };
  });
  const req = { params: { id: 77 }, user: { id: 2, role: 'Monthly_Tenant' } };
  const res = makeRes();
  await payment.createQrCharge(req, res);

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.data.paymentId, 90);
  assert.equal(res.body.data.qrImage, 'https://omise/qr.png');
});

test('createQrCharge: บิลของคนอื่น → 403', async () => {
  setHandler((s) => {
    const q = s.trim();
    if (has(q, 'FROM invoices i')) return { rows: [fullInvoiceHeader] }; // member_id = 2
    return { rows: [] };
  });
  const req = { params: { id: 77 }, user: { id: 999, role: 'Monthly_Tenant' } };
  const res = makeRes();
  await payment.createQrCharge(req, res);
  assert.equal(res.statusCode, 403);
});

// ============================================================
// pollQrStatus — poll ว่าจ่าย QR สำเร็จหรือยัง
// ============================================================
test('pollQrStatus: ยังไม่จ่าย → paid=false', async () => {
  omiseChargePaid = false;
  setHandler((s) => {
    const q = s.trim();
    if (has(q, 'FROM payments p') && has(q, 'JOIN invoices i')) {
      return { rows: [{ payment_id: 90, payment_status: 'รอตรวจ', payment_evidence: 'chrg_test_1', member_id: 2 }] };
    }
    return { rows: [] };
  });
  const req = { params: { id: 90 }, user: { id: 2, role: 'Monthly_Tenant' } };
  const res = makeRes();
  await payment.pollQrStatus(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.paid, false);
});

test('pollQrStatus: จ่ายแล้ว → ยืนยันอัตโนมัติ + paid=true', async () => {
  omiseChargePaid = true;
  setHandler((s) => {
    const q = s.trim();
    if (q.startsWith('BEGIN') || q.startsWith('COMMIT') || q.startsWith('ROLLBACK')) return { rows: [] };
    // โหลด payment + เจ้าของ (query ตอน poll)
    if (has(q, 'FROM payments p') && has(q, 'JOIN invoices i')) {
      return { rows: [{ payment_id: 90, payment_status: 'รอตรวจ', payment_evidence: 'chrg_test_1', member_id: 2 }] };
    }
    // ล็อก payment row ใน confirmPaymentPaid
    if (has(q, 'SELECT payment_id, invoice_id, payment_status FROM payments')) {
      return { rows: [{ payment_id: 90, invoice_id: 77, payment_status: 'รอตรวจ' }] };
    }
    if (has(q, 'total_amount, due_date, invoice_status FROM invoices')) return { rows: [{ total_amount: 5400, due_date: null, invoice_status: 'ยังไม่ชำระ' }] };
    if (has(q, "payment_status = 'ยืนยันแล้ว'")) return { rows: [{ paid_sum: 5400 }] };
    if (has(q, 'FROM invoices i')) return { rows: [fullInvoiceHeader] };
    return { rows: [] };
  });
  const req = { params: { id: 90 }, user: { id: 2, role: 'Monthly_Tenant' } };
  const res = makeRes();
  await payment.pollQrStatus(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.paid, true);
  assert.ok(calls.some((c) => has(c.sql, "UPDATE payments SET payment_status = 'ยืนยันแล้ว'")));
});

// ============================================================
// omiseWebhook — รับ event จาก Omise
// ============================================================
test('omiseWebhook: charge จ่ายสำเร็จ + มี payment_id → ยืนยัน payment (ยึดผลจาก retrieveCharge ไม่ใช่ body ที่ปลอมได้)', async () => {
  setHandler((s) => {
    const q = s.trim();
    if (q.startsWith('BEGIN') || q.startsWith('COMMIT') || q.startsWith('ROLLBACK')) return { rows: [] };
    if (has(q, 'SELECT payment_id, invoice_id, payment_status FROM payments')) {
      return { rows: [{ payment_id: 90, invoice_id: 77, payment_status: 'รอตรวจ' }] };
    }
    if (has(q, 'total_amount, due_date, invoice_status FROM invoices')) return { rows: [{ total_amount: 5400, due_date: null, invoice_status: 'ยังไม่ชำระ' }] };
    if (has(q, "payment_status = 'ยืนยันแล้ว'")) return { rows: [{ paid_sum: 5400 }] };
    if (has(q, 'FROM invoices i')) return { rows: [fullInvoiceHeader] };
    return { rows: [] };
  });
  omiseChargePaid = true;
  omiseChargeMetadata = { payment_id: '90' };
  // body ปลอมว่ายังไม่จ่าย + payment_id ผิด — ต้องถูกเมิน เพราะ code ต้องถาม retrieveCharge เท่านั้น
  const req = { body: { data: { object: 'charge', id: 'chrg_test_1', status: 'pending', paid: false, metadata: { payment_id: '999' } } } };
  const res = makeRes();
  await payment.omiseWebhook(req, res);
  assert.equal(res.body.success, true);
  assert.ok(calls.some((c) => has(c.sql, "UPDATE payments SET payment_status = 'ยืนยันแล้ว'")));
});

test('omiseWebhook: charge ยังไม่จ่ายจริง (retrieveCharge บอกไม่จ่าย) → ไม่ยืนยัน แม้ body จะปลอมว่าจ่ายแล้ว', async () => {
  setHandler(() => ({ rows: [] }));
  omiseChargePaid = false;
  omiseChargeMetadata = { payment_id: '90' };
  const req = { body: { data: { object: 'charge', id: 'chrg_test_1', status: 'successful', paid: true, metadata: { payment_id: '90' } } } };
  const res = makeRes();
  await payment.omiseWebhook(req, res);
  assert.equal(res.body.success, true);
  assert.equal(calls.some((c) => has(c.sql, "UPDATE payments SET payment_status = 'ยืนยันแล้ว'")), false);
});

// ============================================================
// payBookingNow — จ่ายค่าจองตอนจอง (แบบ Agoda, เฉพาะรายวัน)
// ============================================================
test('payBookingNow: รายวัน สถานะรอชำระ → 201 + สร้างบิล + QR', async () => {
  setHandler((s) => {
    const q = s.trim();
    if (q.startsWith('BEGIN') || q.startsWith('COMMIT') || q.startsWith('ROLLBACK')) return { rows: [] };
    if (has(q, 'FROM bookings b JOIN rooms r')) {
      return { rows: [{ booking_id: 5, member_id: 2, rent_type: 'daily', booking_status: 'รอชำระมัดจำ',
        check_in_date: '2026-07-01', check_out_date: '2026-07-04', room_price: 500 }] };
    }
    if (has(q, "invoice_status != 'ยกเลิก'")) return { rows: [] };       // ยังไม่มีบิลเดิม
    if (q.startsWith('INSERT INTO invoices')) return { rows: [{ invoice_id: 88 }] };
    return { rows: [] };
  });
  const req = { params: { id: 5 }, user: { id: 2, role: 'Monthly_Tenant' } };
  const res = makeRes();
  await payment.payBookingNow(req, res);

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.data.invoiceId, 88);
  assert.equal(res.body.data.amount, 1500);          // 3 วัน × 500
  assert.equal(res.body.data.qrImage, 'data:img');   // QR PromptPay static (mock buildPromptpayQr)
});

test('payBookingNow: รายเดือน → 400 (จ่ายตอนเช็คอิน)', async () => {
  setHandler((s) => {
    const q = s.trim();
    if (q.startsWith('BEGIN') || q.startsWith('ROLLBACK')) return { rows: [] };
    if (has(q, 'FROM bookings b JOIN rooms r')) {
      return { rows: [{ booking_id: 6, member_id: 2, rent_type: 'monthly', booking_status: 'รอชำระมัดจำ',
        check_in_date: '2026-07-01', check_out_date: '2026-08-01', room_price: 0 }] };
    }
    return { rows: [] };
  });
  const req = { params: { id: 6 }, user: { id: 2, role: 'Monthly_Tenant' } };
  const res = makeRes();
  await payment.payBookingNow(req, res);
  assert.equal(res.statusCode, 400);
});

test('payBookingNow: การจองของคนอื่น → 403', async () => {
  setHandler((s) => {
    const q = s.trim();
    if (q.startsWith('BEGIN') || q.startsWith('ROLLBACK')) return { rows: [] };
    if (has(q, 'FROM bookings b JOIN rooms r')) {
      return { rows: [{ booking_id: 5, member_id: 2, rent_type: 'daily', booking_status: 'รอชำระมัดจำ',
        check_in_date: '2026-07-01', check_out_date: '2026-07-04', room_price: 500 }] };
    }
    return { rows: [] };
  });
  const req = { params: { id: 5 }, user: { id: 999, role: 'Monthly_Tenant' } };
  const res = makeRes();
  await payment.payBookingNow(req, res);
  assert.equal(res.statusCode, 403);
});
