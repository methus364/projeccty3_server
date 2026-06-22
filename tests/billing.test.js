// ============================================================
// Unit tests — utils/billing.js (proration ค่าเช่ารายเดือน M10a)
// ฟังก์ชันล้วน ไม่ต้อง mock DB
// รัน:  cd server && npm test
// ============================================================
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeMonthlyRoomCost, proratedRent, dailyRate } = require('../utils/billing');

// เคสอ้างอิงในเอกสาร: ห้อง 3,000/เดือน · เข้าพัก 20 ม.ค. (prepaid ครอบ 20 ม.ค.–18 ก.พ.)
const CHECK_IN = '2026-01-20';
const PRICE = 3000;

test('computeMonthlyRoomCost: เดือนเดียวกับเข้าพัก (ม.ค.) อยู่ในช่วง prepaid → 0', () => {
  const r = computeMonthlyRoomCost(CHECK_IN, PRICE, '2026-01');
  assert.equal(r.roomCost, 0);
  assert.equal(r.isFullMonth, false);
});

test('computeMonthlyRoomCost: เดือนที่ prepaid หมดกลางเดือน (ก.พ.) → prorate 10 วัน = 1,000', () => {
  // prepaid ครอบถึง 18 ก.พ. → คิด 19–28 ก.พ. = 10 วัน × (3000/30) = 1,000
  const r = computeMonthlyRoomCost(CHECK_IN, PRICE, '2026-02');
  assert.equal(r.days, 10);
  assert.equal(r.roomCost, 1000);
  assert.equal(r.isFullMonth, false);
});

test('computeMonthlyRoomCost: เดือนปกติหลังพ้น prepaid (มี.ค.) → เต็มเดือน 3,000', () => {
  const r = computeMonthlyRoomCost(CHECK_IN, PRICE, '2026-03');
  assert.equal(r.roomCost, 3000);
  assert.equal(r.isFullMonth, true);
});

test('dailyRate: 3000/30 = 100', () => {
  assert.equal(dailyRate(3000), 100);
});

test('proratedRent: อยู่จริง 10 วัน @3000 = 1,000', () => {
  assert.equal(proratedRent(3000, 10), 1000);
});
