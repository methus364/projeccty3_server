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
    
    next();
  } catch (err) {
    console.error(err);
    res.status(401).json({ message: "Token Invalid" });
  }
};

// --- 2. ตรวจสอบว่าเป็นกลุ่ม "ผู้เช่า" หรือไม่ (Tenant Check) ---
exports.tenantCheck = async (req, res, next) => {
  try {
    const { username } = req.user;
    
    // ดึงค่า user_role มาตรวจสอบ
    const result = await pool.query(
      'SELECT user_role FROM Members WHERE username = $1 LIMIT 1',
      [username]
    );
    const user = result.rows[0];
    
    // ตรวจสอบว่าเป็นผู้เช่ารายเดือน หรือ รายวัน (ถ้าใช่ไฟเขียวผ่านได้)
    if (!user || !["Daily_Tenant", "Monthly_Tenant"].includes(user.user_role)) {
       return res.status(403).json({ message: "Access Denied: Tenant Account Only" });
    }
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error Tenant access denied" });
  }
};

// --- 3. ตรวจสอบว่าเป็น Monthly_Tenant เท่านั้น (สำหรับฟีเจอร์เช่ารายเดือน เช่น แจ้งซ่อม/สัญญา) ---
exports.monthlyTenantCheck = async (req, res, next) => {
  try {
    const { username } = req.user;
    const result = await pool.query(
      'SELECT user_role FROM Members WHERE username = $1 LIMIT 1',
      [username]
    );
    const user = result.rows[0];
    // กันผู้เช่ารายวัน (Daily_Tenant) ยิง API แจ้งซ่อมตรงๆ
    if (!user || user.user_role !== 'Monthly_Tenant') {
      return res.status(403).json({ message: "Access Denied: Monthly Tenant Only" });
    }
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error access denied" });
  }
};

// --- 4. ตรวจสอบว่าเป็นผู้ดูแลระบบหรือไม่ (Admin Check) ---
exports.adminCheck = async (req, res, next) => {
  try {
    const { username } = req.user;
    
    // ดึงค่า user_role มาเช็คว่าเป็น Admin หรือไม่
    const result = await pool.query(
      'SELECT user_role FROM Members WHERE username = $1 LIMIT 1',
      [username]
    );
    const user = result.rows[0];
    
    if (!user || user.user_role !== "Admin") {
       return res.status(403).json({ message: "Access Denied: Admin Only" });
    }
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error Admin access denied" });
  }
};