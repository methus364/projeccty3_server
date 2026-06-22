// ============================================================
// Unit tests — M9 Products & Sales (controllers/product.js)
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

const mockClient = {
  query: async (sql, params) => { calls.push({ sql, params }); return handler(sql, params); },
  release: () => {},
};
const mockPool = {
  connect: async () => mockClient,
  query: async (sql, params) => { calls.push({ sql, params }); return handler(sql, params); },
};

function injectMock(relPath, exportsObj) {
  const abs = require.resolve(path.join(__dirname, '..', relPath));
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports: exportsObj };
}

injectMock('config/db.js', mockPool);

const product = require('../controllers/product');

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
// createProduct
// ============================================================
test('createProduct: ไม่ส่งชื่อ/ราคา → 400', async () => {
  const req = { body: { product_name: 'น้ำดื่ม' }, user: { id: 1, role: 'Admin' } };
  const res = makeRes();
  await product.createProduct(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.success, false);
});

test('createProduct: ราคาติดลบ → 400', async () => {
  const req = { body: { product_name: 'น้ำดื่ม', price: -5 }, user: { id: 1, role: 'Admin' } };
  const res = makeRes();
  await product.createProduct(req, res);
  assert.equal(res.statusCode, 400);
});

test('createProduct: ข้อมูลครบ → 201 + default stock 0', async () => {
  setHandler((sql) => {
    if (has(sql, 'INSERT INTO products')) {
      return { rows: [{ product_id: 1, product_name: 'น้ำดื่ม', price: 10, stock: 0 }] };
    }
    return { rows: [] };
  });
  const req = { body: { product_name: 'น้ำดื่ม', price: 10 }, user: { id: 1, role: 'Admin' } };
  const res = makeRes();
  await product.createProduct(req, res);

  assert.equal(res.statusCode, 201);
  const p = paramsOf('INSERT INTO products');
  assert.equal(p[2], 0); // stock default 0
});

// ============================================================
// updateProduct
// ============================================================
test('updateProduct: ไม่พบสินค้า → 404', async () => {
  setHandler(() => ({ rows: [] }));
  const req = { params: { id: 99 }, body: { price: 12 }, user: { id: 1, role: 'Admin' } };
  const res = makeRes();
  await product.updateProduct(req, res);
  assert.equal(res.statusCode, 404);
});

// ============================================================
// deleteProduct — กันลบสินค้าที่มีประวัติการขาย
// ============================================================
test('deleteProduct: มีประวัติการขาย → 400', async () => {
  setHandler((sql) => {
    if (has(sql, 'FROM sales WHERE product_id')) return { rows: [{ '?column?': 1 }] };
    return { rows: [] };
  });
  const req = { params: { id: 1 }, user: { id: 1, role: 'Admin' } };
  const res = makeRes();
  await product.deleteProduct(req, res);
  assert.equal(res.statusCode, 400);
});

// ============================================================
// createSale
// ============================================================
test('createSale: ไม่ส่ง product_id/quantity → 400', async () => {
  const req = { body: {}, user: { id: 1, role: 'Admin' } };
  const res = makeRes();
  await product.createSale(req, res);
  assert.equal(res.statusCode, 400);
});

test('createSale: ขายเกิน stock → 400', async () => {
  setHandler((sql) => {
    const s = sql.trim();
    if (s.startsWith('BEGIN') || s.startsWith('ROLLBACK')) return { rows: [] };
    if (has(s, 'FROM products WHERE product_id')) {
      return { rows: [{ product_id: 1, product_name: 'น้ำดื่ม', price: 10, stock: 3 }] };
    }
    return { rows: [] };
  });
  const req = { body: { product_id: 1, quantity: 5 }, user: { id: 1, role: 'Admin' } };
  const res = makeRes();
  await product.createSale(req, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /คงเหลือไม่พอ/);
});

test('createSale: ขายสำเร็จ → 201 + ตัด stock + total คำนวณ server-side', async () => {
  setHandler((sql) => {
    const s = sql.trim();
    if (s.startsWith('BEGIN') || s.startsWith('COMMIT') || s.startsWith('ROLLBACK')) return { rows: [] };
    if (has(s, 'FROM products WHERE product_id')) {
      return { rows: [{ product_id: 1, product_name: 'น้ำดื่ม', price: 10, stock: 10 }] };
    }
    if (has(s, 'INSERT INTO sales')) {
      return { rows: [{ sale_id: 5, product_id: 1, member_id: null, quantity: 3, total_price: 30 }] };
    }
    return { rows: [] };
  });
  const req = { body: { product_id: 1, quantity: 3 }, user: { id: 1, role: 'Admin' } };
  const res = makeRes();
  await product.createSale(req, res);

  assert.equal(res.statusCode, 201);
  // INSERT params: [product_id, member_id, quantity, total_price, sold_by]
  const p = paramsOf('INSERT INTO sales');
  assert.equal(p[2], 3);    // quantity
  assert.equal(p[3], 30);   // total_price = 10 * 3 (จากราคาใน DB)
  assert.equal(p[4], 1);    // sold_by = admin id
  // ยืนยันว่ามีการตัด stock
  assert.ok(calls.some((c) => has(c.sql, 'UPDATE products SET stock = stock - $1')));
  assert.equal(res.body.data.remaining_stock, 7);
});

// ============================================================
// getSales
// ============================================================
test('getSales: filter เดือน → ส่ง param เดือน', async () => {
  setHandler(() => ({ rows: [{ sale_id: 5, product_name: 'น้ำดื่ม', quantity: 3, total_price: 30 }] }));
  const req = { query: { month: '2026-06' }, user: { id: 1, role: 'Admin' } };
  const res = makeRes();
  await product.getSales(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.count, 1);
  const p = paramsOf("to_char(s.sale_date, 'YYYY-MM')");
  assert.equal(p[0], '2026-06');
});
