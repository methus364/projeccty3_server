const jwt = require("jsonwebtoken");
const pool = require("../config/db"); // เปลี่ยนไปใช้ pool จาก db.js

exports.authCheck = async (req, res, next) => {
  try {
    const headerToken = req.headers.authorization;
    if (!headerToken) {
      return res.status(401).json({ message: "No Token, Authorization" });
    }
    const token = headerToken.split(" ")[1];

    // ตรวจสอบความถูกต้องของ Token
    const decode = jwt.verify(token, process.env.SECRET);
    req.user = decode;

    // ตรวจสอบในฐานข้อมูลว่า User นี้ยังอยู่และถูกเปิดใช้งาน (enabled) ไหม
    const result = await pool.query(
      'SELECT enabled FROM users WHERE email = $1 LIMIT 1',
      [req.user.email]
    );
    const user = result.rows[0];

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    if (!user.enabled) {
      return res.status(400).json({ message: "This account cannot access" });
    }
    
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Token Invalid" });
  }
};

exports.subCheck = async (req, res, next) => {
  try {
    const { email } = req.user;
    
    // ดึงค่า role มาเช็คว่าเป็น SUBSCRIPTION หรือไม่
    const result = await pool.query(
      'SELECT role FROM users WHERE email = $1 LIMIT 1',
      [email]
    );
    const user = result.rows[0];
    
    if (!user || user.role.trim() !== "SUBSCRIPTION") {
       return res.status(403).json({ message: "Access Denied : SUBSCRIPTION Invalid" });
    }
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error SUBSCRIPTION access denied" });
  }
};

exports.adminCheck = async (req, res, next) => {
  try {
    const { email } = req.user;
    
    // ดึงค่า role มาเช็คว่าเป็น ADMIN หรือไม่
    const result = await pool.query(
      'SELECT role FROM users WHERE email = $1 LIMIT 1',
      [email]
    );
    const user = result.rows[0];
    
    if (!user || user.role.trim() !== "ADMIN") {
       return res.status(403).json({ message: "Access Denied : Admin Invalid" });
    }
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error Admin access denied" });
  }
};