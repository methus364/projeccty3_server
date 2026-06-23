// ============================================================
// Unit tests — M10b Audit Log (controllers/audit.js + utils/audit.js)
// mock database — ไม่แตะ DB จริง
// รัน:  cd server && npm test
// ============================================================
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// ---------- mock pool ----------
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

const audit = require('../controllers/audit');
const { setAuditUser } = require('../utils/audit');

function makeRes() {
  return {
    statusCode: 200, body: undefined,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
const has = (s, frag) => s.includes(frag);

beforeEach(reset);

// ============================================================
// setAuditUser — ตั้ง app.user_id ผ่าน set_config (transaction-local)
// ============================================================
test('setAuditUser: เรียก set_config พร้อม user id เป็น string', async () => {
  await setAuditUser(mockClient, 7);
  const c = calls.find((c) => has(c.sql, 'set_config'));
  assert.ok(c, 'ต้องเรียก set_config');
  assert.equal(c.params[0], '7'); // แปลงเป็น string
});

test('setAuditUser: user id เป็น null → ไม่เรียก query', async () => {
  await setAuditUser(mockClient, null);
  assert.equal(calls.length, 0);
});

// ============================================================
// getAuditLogs — filter + แปลง label ไทย
// ============================================================
test('getAuditLogs: คืนรายการ + เติม table_label ไทย', async () => {
  setHandler(() => ({
    rows: [
      { audit_id: 2, table_name: 'invoices', record_id: 5, action: 'UPDATE', changed_by: 1, changed_by_name: 'แอดมิน' },
      { audit_id: 1, table_name: 'contracts', record_id: 3, action: 'INSERT', changed_by: 1, changed_by_name: 'แอดมิน' },
    ],
  }));
  const req = { query: {}, user: { id: 1, role: 'Admin' } };
  const res = makeRes();
  await audit.getAuditLogs(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.count, 2);
  assert.equal(res.body.data[0].table_label, 'ใบแจ้งหนี้');
  assert.equal(res.body.data[1].table_label, 'สัญญาเช่า');
});

test('getAuditLogs: ส่ง filter table+action → ใส่ WHERE และ param ครบ', async () => {
  let captured = null;
  setHandler((sql, params) => { if (has(sql, 'FROM audit_logs')) captured = { sql, params }; return { rows: [] }; });

  const req = { query: { table: 'payments', action: 'DELETE' }, user: { id: 1, role: 'Admin' } };
  const res = makeRes();
  await audit.getAuditLogs(req, res);

  assert.ok(has(captured.sql, 'a.table_name = $1'));
  assert.ok(has(captured.sql, 'a.action = $2'));
  // params = [table, action, limit, offset]
  assert.equal(captured.params[0], 'payments');
  assert.equal(captured.params[1], 'DELETE');
  assert.equal(captured.params[2], 100); // limit default
  assert.equal(captured.params[3], 0);   // offset default
});

test('getAuditLogs: limit เกิน 500 → ถูกจำกัดที่ 500', async () => {
  let captured = null;
  setHandler((sql, params) => { if (has(sql, 'FROM audit_logs')) captured = { sql, params }; return { rows: [] }; });

  const req = { query: { limit: '9999' }, user: { id: 1, role: 'Admin' } };
  const res = makeRes();
  await audit.getAuditLogs(req, res);

  // params = [limit, offset] (ไม่มี filter)
  assert.equal(captured.params[0], 500);
});
