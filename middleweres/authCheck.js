const jwt = require("jsonwebtoken");
const pool = require("../config/db");
const SECRET = require("../config/secret");

// --- 1. ตรวจสอบ Token และการมีตัวตนของผู้ใช้ ---
exports.authCheck = async (req, res, next) => {
  try {
    const headerToken = req.headers.authorization;
    if (!headerToken) {
      return res.status(401).json({ message: "No Token, Authorization" });
    }
    const token = headerToken.split(" ")[1];

    // ตรวจสอบความถูกต้องของ Token
    const decode = jwt.verify(token, SECRET);
    req.user = decode; // ในนี้จะมี id, username, role ตามที่ตั้งไว้ใน login controller

    // ตรวจสอบในฐานข้อมูลว่าสมาชิกคนนี้ยังมีตัวตนอยู่จริงไหม
    const result = await pool.query(
      'SELECT member_id, user_role FROM Members WHERE username = $1 LIMIT 1',
      [req.user.username]
    );
    const user = result.rows[0];

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // เก็บ role/member_id ที่เพิ่งดึงมา ลง req.user เพื่อให้ middleware เช็คสิทธิ์ตัวถัดไป
    // (adminCheck/tenantCheck ฯลฯ) อ่านต่อได้เลย ไม่ต้อง query ตาราง Members ซ้ำอีกรอบ
    req.user.member_id = user.member_id;
    req.user.user_role = user.user_role;

    next();
  } catch (err) {
    console.error(err);
    res.status(401).json({ message: "Token Invalid" });
  }
};

// หมายเหตุ: middleware เช็คสิทธิ์ทั้ง 3 ตัวด้านล่างถูกวางต่อจาก authCheck เสมอ (ดู /routes)
// ดังนั้น req.user.user_role ถูกเติมค่าจาก DB มาแล้วใน authCheck — อ่านจาก req.user ได้เลย
// ไม่ต้อง query ตาราง Members ซ้ำ ช่วยลด round-trip DB จาก 2 ครั้ง เหลือ 1 ครั้งต่อ request

// --- 2. ตรวจสอบว่าเป็นกลุ่ม "ผู้เช่า" หรือไม่ (Tenant Check) ---
exports.tenantCheck = (req, res, next) => {
  const role = req.user.user_role;
  // ตรวจสอบว่าเป็นผู้เช่ารายเดือน หรือ รายวัน (ถ้าใช่ไฟเขียวผ่านได้)
  if (!["Daily_Tenant", "Monthly_Tenant"].includes(role)) {
    return res.status(403).json({ message: "Access Denied: Tenant Account Only" });
  }
  next();
};

// --- 3. ตรวจสอบว่าเป็น Monthly_Tenant เท่านั้น (สำหรับฟีเจอร์เช่ารายเดือน เช่น แจ้งซ่อม/สัญญา) ---
exports.monthlyTenantCheck = (req, res, next) => {
  // กันผู้เช่ารายวัน (Daily_Tenant) ยิง API แจ้งซ่อมตรงๆ
  if (req.user.user_role !== 'Monthly_Tenant') {
    return res.status(403).json({ message: "Access Denied: Monthly Tenant Only" });
  }
  next();
};

// --- 4. ตรวจสอบว่าเป็นผู้ดูแลระบบหรือไม่ (Admin Check) ---
exports.adminCheck = (req, res, next) => {
  if (req.user.user_role !== "Admin") {
    return res.status(403).json({ message: "Access Denied: Admin Only" });
  }
  next();
};