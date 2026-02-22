const pool = require("../config/db"); // เปลี่ยนไปใช้ pool จากไฟล์ db.js ที่เราสร้างใหม่
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

// --- Register ---
exports.register = async (req, res) => {
  try {
    const { email, password, name } = req.body;
    
    if (!email) return res.status(400).json({ message: "Email Is Required !!!" });
    if (!password) return res.status(400).json({ message: "Password Is Required !!!" });

    // 1. ตรวจสอบว่ามี Email หรือ Name ซ้ำไหม (ใช้ SQL OR)
    const checkUser = await pool.query(
      'SELECT email, name FROM "User" WHERE email = $1 OR name = $2 LIMIT 1',
      [email, name]
    );

    if (checkUser.rows.length > 0) {
      const user = checkUser.rows[0];
      const isEmailDup = user.email === email;
      return res.status(400).json({
        message: isEmailDup ? "Email already exists" : "Name already exists",
      });
    }

    // 2. Hash Password
    const HashPassword = await bcrypt.hash(password, 10);

    // 3. บันทึกข้อมูลลงฐานข้อมูล (ใช้ INSERT INTO)
    await pool.query(
     'INSERT INTO "User" (email, password, name,role, "updatedAt") VALUES ($1, $2, $3 , CURRENT_TIMESTAMP)',
      [email, HashPassword, name , 'USER']
    );

    res.send("Register Success");
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "server error" });
  }
};

// --- Login ---
exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;
    console.log(typeof(password));
    // 1. ตรวจสอบ Email ในฐานข้อมูล
    const result = await pool.query('SELECT * FROM "User" WHERE "email" = $1 LIMIT 1', [email]);
    const user = result.rows[0];

    if (!user || !user.enabled) {
      return res.status(400).json({ message: "User not Found or Disabled" });
    }

    // 2. ตรวจสอบรหัสผ่าน
    const IsMatch = await bcrypt.compare(password, user.password);
    if (!IsMatch) {
      return res.status(401).json({ message: "Password Invalid!!!" });
    }

    // 3. สร้าง Payload
    const payload = {
      id: user.id,
      email: user.email,
      role: user.role,
    };

    // 4. สร้าง Token
    jwt.sign(payload, process.env.SECRET, { expiresIn: "1d" }, (err, token) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ message: "Server Error jwt" });
      }
      res.json({ payload, token });
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "server error" });
  }
};

// --- Current User ---
exports.currentUser = async (req, res) => {
  try {
    // เลือกเฉพาะ field ที่ต้องการเหมือนกับ select ใน Prisma
    const result = await pool.query(
      'SELECT id, email, name, role FROM "User" WHERE email = $1 LIMIT 1',
      [req.user.email]
    );
    const user = result.rows[0];

    res.json({ user });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server Error" });
  }
};