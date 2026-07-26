// ที่เก็บรหัส OTP สำหรับรีเซ็ตรหัสผ่าน (แก้ไขข้อมูลผู้ใช้)
// เก็บใน memory ของ process — เหมาะกับ single instance (Render free tier)
// แต่ละ record มีอายุจำกัด และถูกล้างทิ้งอัตโนมัติเมื่อหมดเวลา
//
// โครงสร้าง key = "username|email" (lowercase) → { code, expiresAt, verified, attempts }

const OTP_TTL_MS = 5 * 60 * 1000;      // OTP มีอายุ 5 นาที
const VERIFIED_TTL_MS = 10 * 60 * 1000; // หลังยืนยันแล้ว มีเวลา 10 นาทีให้ตั้งรหัสใหม่
const MAX_ATTEMPTS = 5;                  // กรอกผิดได้สูงสุด 5 ครั้ง

const store = new Map();

const makeKey = (username, email) =>
  `${String(username).trim().toLowerCase()}|${String(email).trim().toLowerCase()}`;

// ล้าง record ที่หมดอายุออกจาก store (กัน memory โตเรื่อยๆ)
function cleanup() {
  const now = Date.now();
  for (const [key, rec] of store.entries()) {
    if (rec.expiresAt <= now) store.delete(key);
  }
}
// เรียก cleanup เป็นระยะ (ทุก 5 นาที) — unref เพื่อไม่ให้กัน process ปิด
const timer = setInterval(cleanup, OTP_TTL_MS);
if (timer.unref) timer.unref();

// สร้างและบันทึกรหัส OTP ใหม่ (แทนที่ของเดิมถ้ามี)
function createOtp(username, email) {
  const code = String(Math.floor(100000 + Math.random() * 900000)); // 6 หลัก
  store.set(makeKey(username, email), {
    code,
    expiresAt: Date.now() + OTP_TTL_MS,
    verified: false,
    attempts: 0,
  });
  return code;
}

// ตรวจสอบรหัส OTP — คืน { ok, reason }
function verifyOtp(username, email, code) {
  const key = makeKey(username, email);
  const rec = store.get(key);

  if (!rec || rec.expiresAt <= Date.now()) {
    store.delete(key);
    return { ok: false, reason: 'expired' };
  }
  if (rec.attempts >= MAX_ATTEMPTS) {
    store.delete(key);
    return { ok: false, reason: 'too_many_attempts' };
  }
  if (String(code).trim() !== rec.code) {
    rec.attempts += 1;
    return { ok: false, reason: 'invalid' };
  }

  // ถูกต้อง — มาร์คว่ายืนยันแล้ว และต่ออายุให้ตั้งรหัสผ่านใหม่
  rec.verified = true;
  rec.expiresAt = Date.now() + VERIFIED_TTL_MS;
  return { ok: true };
}

// ตรวจว่ามีการยืนยัน OTP สำเร็จแล้วหรือยัง (ใช้ก่อนตั้งรหัสผ่านใหม่)
function isVerified(username, email) {
  const rec = store.get(makeKey(username, email));
  return !!(rec && rec.verified && rec.expiresAt > Date.now());
}

// ลบ record ทิ้ง (ใช้หลังตั้งรหัสผ่านใหม่สำเร็จ)
function clearOtp(username, email) {
  store.delete(makeKey(username, email));
}

module.exports = { createOtp, verifyOtp, isVerified, clearOtp };
