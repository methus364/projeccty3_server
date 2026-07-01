// ============================================================
// Unit tests — Cron ออกบิลรายเดือนอัตโนมัติ (utils/scheduler.js)
// mock node-cron เพื่อตรวจ pattern ที่ตั้ง + เรียก generateMonthly ถูกต้อง
// ไม่รอ cron ทำงานจริง (จะช้าเกินไปสำหรับ unit test)
// รัน:  cd server && npm test
// ============================================================
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

let scheduledPattern = null;
let scheduledJob = null;

function injectAbsMock(absPath, exportsObj) {
  require.cache[absPath] = { id: absPath, filename: absPath, loaded: true, exports: exportsObj };
}
function injectMock(relPath, exportsObj) {
  injectAbsMock(require.resolve(path.join(__dirname, '..', relPath)), exportsObj);
}

// mock node-cron — เก็บ pattern + job function ไว้เรียกเองในเทส (ไม่รอเวลาจริง)
injectAbsMock(require.resolve('node-cron'), {
  schedule: (pattern, job) => { scheduledPattern = pattern; scheduledJob = job; },
});

// mock controllers/invoice — เก็บว่า generateMonthly ถูกเรียกด้วย req/res แบบไหน
let generateMonthlyCalls = [];
injectMock('controllers/invoice.js', {
  generateMonthly: async (req, res) => {
    generateMonthlyCalls.push(req);
    res.status(201).json({ success: true, message: 'ออกบิลรายเดือนสำเร็จ 2 ใบ' });
  },
});

const { startMonthlyBillingCron } = require('../utils/scheduler');

beforeEach(() => {
  scheduledPattern = null;
  scheduledJob = null;
  generateMonthlyCalls = [];
});

test('startMonthlyBillingCron: ตั้ง pattern ทุกวันที่ 1 เวลา 01:00', () => {
  startMonthlyBillingCron();
  assert.equal(scheduledPattern, '0 1 1 * *');
});

test('startMonthlyBillingCron: เมื่อถึงเวลา เรียก generateMonthly โดยไม่ระบุ month (ให้ controller ใช้เดือนปัจจุบันเอง)', async () => {
  startMonthlyBillingCron();
  await scheduledJob(); // จำลอง cron ถึงเวลาทำงาน
  assert.equal(generateMonthlyCalls.length, 1);
  assert.deepEqual(generateMonthlyCalls[0].body, {});
});

test('startMonthlyBillingCron: generateMonthly error → ไม่ throw ออกมา (catch ไว้ใน job)', async () => {
  injectMock('controllers/invoice.js', {
    generateMonthly: async () => { throw new Error('db down'); },
  });
  // ต้อง require ใหม่ให้ดึง mock ล่าสุด (cache เดิมอาจโดน node ล็อกไว้ในเทสนี้เพราะ mock แบบ static)
  delete require.cache[require.resolve('../utils/scheduler')];
  const { startMonthlyBillingCron: startAgain } = require('../utils/scheduler');
  startAgain();
  await assert.doesNotReject(scheduledJob());
});
