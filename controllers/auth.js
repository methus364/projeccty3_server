const pool = require("../config/db");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

// --- Register (สมัครสมาชิก) ---
exports.register = async (req, res) => {
  try {
    const { username, password, full_name, phone_number, citizen_id, user_role } = req.body;
    
    // Validation เบื้องต้น
    if (!username) return res.status(400).json({ message: "Username is required!" });
    if (!password) return res.status(400).json({ message: "Password is required!" });
    if (!full_name) return res.status(400).json({ message: "Full Name is required!" }); 

    // 1. ตรวจสอบว่ามี Username ซ้ำในตาราง Members ไหม
    const checkUser = await pool.query(
      'SELECT username FROM Members WHERE username = $1 LIMIT 1',
      [username]
    );

    if (checkUser.rows.length > 0) {
      return res.status(400).json({ message: "Username already exists" });
    }

    // 2. Hash Password
    const hashPassword = await bcrypt.hash(password, 10);

    // 3. กำหนด Role (ถ้าไม่มีการส่งมา ให้ default เป็นผู้เช่ารายเดือน)
    const finalRole = user_role || 'Monthly_Tenant';

    // 4. บันทึกข้อมูลลงฐานข้อมูลตาราง Members
    await pool.query(
      'INSERT INTO Members (username, password, full_name, phone_number, user_role) VALUES ($1, $2, $3, $4, $5)',
      [username, hashPassword, full_name, phone_number || null, finalRole]
    );

    res.status(201).send("Register Success");
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
};

// --- Login (เข้าสู่ระบบ) ---
exports.login = async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ message: "Username and Password are required!" });
    }

    // 1. ตรวจสอบ Username ในตาราง Members
    const result = await pool.query('SELECT * FROM Members WHERE username = $1 LIMIT 1', [username]);
    const user = result.rows[0];

    // ถ้าไม่พบผู้ใช้งาน
    if (!user) {
      return res.status(400).json({ message: "Invalid Username or Password" });
    }

    // 2. ตรวจสอบรหัสผ่านด้วย bcrypt
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ message: "Invalid Username or Password" });
    }

    // 3. สร้าง Payload โดยอ้างอิงฟิลด์ตามตารางใหม่
    const payload = {
      id: user.member_id,
      username: user.username,
      role: user.user_role,
    };

    // 4. สร้าง Token
    jwt.sign(payload, process.env.SECRET || "your_secret_key", { expiresIn: "1d" }, (err, token) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ message: "Server Error jwt" });
      }
      res.json({ payload, token });
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
};

// --- Current User (ดึงข้อมูลผู้ใช้ปัจจุบันจาก Token) ---
exports.currentUser = async (req, res) => {
  try {
    // ดึงข้อมูลผ่าน req.user.username (ดึงมาจาก Middleware ถอดรหัส Token)
    const result = await pool.query(
      'SELECT member_id, username, full_name, user_role FROM Members WHERE username = $1 LIMIT 1',
      [req.user.username]
    );
    const user = result.rows[0];

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    res.json({ user });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server Error" });
  }
};