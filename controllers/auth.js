const pool = require("../config/db");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const SECRET = require("../config/secret");
const { sendMail } = require("../config/mailer");
const { createOtp, verifyOtp, isVerified, clearOtp } = require("../utils/otpStore");

// --- Register (สมัครสมาชิก) ---
exports.register = async (req, res) => {
  try {
    const { username, password, full_name, email, phone_number, user_role } = req.body;

    if (!username) return res.status(400).json({ message: "Username is required!" });
    if (!password) return res.status(400).json({ message: "Password is required!" });
    if (!full_name) return res.status(400).json({ message: "Full Name is required!" });

    // 1. ตรวจสอบ username ซ้ำ
    const checkUser = await pool.query(
      'SELECT username FROM Members WHERE username = $1 LIMIT 1',
      [username]
    );
    if (checkUser.rows.length > 0) {
      return res.status(400).json({ message: "Username already exists" });
    }

    // 1.1 ตรวจสอบ email ซ้ำ (เฉพาะกรณีที่ผู้ใช้กรอกมา เพราะ email nullable ได้)
    if (email) {
      const checkEmail = await pool.query(
        'SELECT email FROM Members WHERE email = $1 LIMIT 1',
        [email]
      );
      if (checkEmail.rows.length > 0) {
        return res.status(400).json({ message: "Email already exists" });
      }
    }

    // 2. Hash Password
    const hashPassword = await bcrypt.hash(password, 10);

    // 3. รับ role ที่เลือกตอนสมัครได้ แต่ whitelist เฉพาะ Daily_Tenant/Monthly_Tenant เท่านั้น
    // ห้ามรับ "Admin" หรือค่าอื่นจาก client เด็ดขาด (กัน privilege escalation)
    const finalRole = user_role === 'Monthly_Tenant' ? 'Monthly_Tenant' : 'Daily_Tenant';

    // 4. INSERT รวม email
    await pool.query(
      'INSERT INTO Members (username, password, full_name, email, phone_number, user_role) VALUES ($1, $2, $3, $4, $5, $6)',
      [username, hashPassword, full_name, email || null, phone_number || null, finalRole]
    );

    res.status(201).json({ success: true, message: "Register Success" });
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
    // กัน error 500 กรณีบัญชี social-only ที่ password เป็น NULL
    if (!user.password) {
      return res.status(401).json({ message: "บัญชีนี้ผูกกับ Social Login — กรุณาเข้าสู่ระบบผ่าน Line/Google" });
    }
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
    jwt.sign(payload, SECRET, { expiresIn: "1d" }, (err, token) => {
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
    const result = await pool.query(
      'SELECT member_id, username, full_name, email, phone_number, user_role FROM members WHERE username = $1 LIMIT 1',
      [req.user.username]
    );
    const user = result.rows[0];
    if (!user) return res.status(404).json({ success: false, message: "User not found" });
    res.json({ success: true, data: user });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "Server Error" });
  }
};

// --- Get All Members (Admin) ---
exports.getMembers = async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT member_id, username, full_name, email, phone_number, user_role FROM members ORDER BY member_id ASC'
    );
    res.json({ success: true, count: rows.length, data: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// --- Get Member By ID (Admin) ---
exports.getMemberById = async (req, res) => {
  try {
    const { id } = req.params;
    const { rows } = await pool.query(
      'SELECT member_id, username, full_name, email, phone_number, user_role FROM members WHERE member_id = $1 LIMIT 1',
      [id]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: "ไม่พบสมาชิก" });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// role ที่ระบบรู้จัก — ต้องตรงกับที่ authCheck.js ใช้เช็คสิทธิ์ทุกที่ (Admin/tenantCheck/monthlyTenantCheck)
const VALID_ROLES = ["Admin", "Daily_Tenant", "Monthly_Tenant"];

// --- Update Member (Admin) ---
exports.updateMember = async (req, res) => {
  try {
    const { id } = req.params;
    const { full_name, email, phone_number, user_role } = req.body;

    // กันตั้ง user_role เป็นค่าที่ระบบไม่รู้จัก — พิมพ์ผิด/ค่าแปลกจะทำให้ user คนนั้นหลุดจากทุก role check ทันที
    if (user_role !== undefined && !VALID_ROLES.includes(user_role)) {
      return res.status(400).json({ success: false, message: `user_role ต้องเป็นหนึ่งใน ${VALID_ROLES.join(", ")}` });
    }

    const cur = await pool.query('SELECT * FROM members WHERE member_id = $1 LIMIT 1', [id]);
    if (!cur.rows[0]) return res.status(404).json({ success: false, message: "ไม่พบสมาชิก" });
    const c = cur.rows[0];

    await pool.query(
      `UPDATE members SET full_name=$1, email=$2, phone_number=$3, user_role=$4 WHERE member_id=$5`,
      [
        full_name    !== undefined ? full_name    : c.full_name,
        email        !== undefined ? email        : c.email,
        phone_number !== undefined ? phone_number : c.phone_number,
        user_role    !== undefined ? user_role    : c.user_role,
        id,
      ]
    );
    res.json({ success: true, message: "อัปเดตข้อมูลสมาชิกเรียบร้อย" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// --- Delete Member (Admin) ---
exports.deleteMember = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM members WHERE member_id = $1', [id]);
    if (result.rowCount === 0) return res.status(404).json({ success: false, message: "ไม่พบสมาชิก" });
    res.json({ success: true, message: "ลบสมาชิกเรียบร้อย" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};

// ============================================================
//  ลืมรหัสผ่าน / แก้ไขข้อมูลผู้ใช้ ด้วย OTP ทางอีเมล
// ============================================================

// --- ส่งรหัส OTP ไปที่อีเมล ---
// รับ { username, email } → ตรวจว่ามีสมาชิกนี้จริงและอีเมลตรงกัน แล้วส่ง OTP
exports.sendOtp = async (req, res) => {
  try {
    const username = (req.body.username || "").trim();
    const email = (req.body.email || "").trim();

    if (!username || !email) {
      return res.status(400).json({ success: false, message: "กรุณากรอกชื่อผู้ใช้และอีเมลให้ครบ" });
    }

    // ตรวจสอบว่ามีสมาชิกที่ username + email ตรงกันจริง
    // เทียบ username แบบไม่สนตัวพิมพ์ + ตัดช่องว่างทั้งสองฝั่ง (กันกรณี DB เก็บ "Kimkim"/"kimkim ")
    const { rows } = await pool.query(
      'SELECT member_id, email FROM Members WHERE LOWER(BTRIM(username)) = LOWER(BTRIM($1)) LIMIT 1',
      [username]
    );
    const user = rows[0];
    if (!user || !user.email || user.email.trim().toLowerCase() !== email.toLowerCase()) {
      // ไม่บอกชัดว่าอันไหนผิด เพื่อกันการเดาข้อมูลผู้ใช้ (account enumeration)
      const mask = (e) => {
        if (!e) return null;
        const [loc, dom] = String(e).trim().split("@");
        if (!dom) return "***";
        return `${loc.slice(0, 2)}***@${dom}`;
      };
      return res.status(400).json({
        success: false,
        message: "ไม่พบชื่อผู้ใช้ที่ตรงกับอีเมลนี้",
        debug: { usernameFound: !!user, emailOnFileMasked: mask(user && user.email), emailTypedMasked: mask(email) },
      });
    }

    // สร้าง OTP แล้วส่งอีเมล
    const code = createOtp(username, email);
    try {
      await sendMail({
        to: user.email,
        subject: "รหัส OTP สำหรับเปลี่ยนรหัสผ่าน — หอพัก Around Loei",
        text:
          `สวัสดีคุณ ${username}\n\n` +
          `รหัส OTP สำหรับเปลี่ยนรหัสผ่านของคุณคือ: ${code}\n\n` +
          `รหัสนี้จะหมดอายุใน 5 นาที กรุณาอย่าเปิดเผยรหัสนี้แก่ผู้อื่น\n` +
          `หากคุณไม่ได้เป็นผู้ร้องขอ กรุณาเพิกเฉยต่ออีเมลฉบับนี้`,
      });
    } catch (mailErr) {
      console.error("Send OTP mail error:", mailErr);
      return res.status(502).json({ success: false, message: "ส่งอีเมลไม่สำเร็จ กรุณาลองใหม่อีกครั้ง" });
    }

    res.json({ success: true, message: "ส่งรหัส OTP ไปที่อีเมลของคุณแล้ว" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "เกิดข้อผิดพลาดภายในเซิร์ฟเวอร์" });
  }
};

// --- ตรวจสอบรหัส OTP ---
// รับ { username, email, otp }
exports.verifyOtp = async (req, res) => {
  try {
    const username = (req.body.username || "").trim();
    const email = (req.body.email || "").trim();
    const otp = (req.body.otp || "").trim();

    if (!username || !email || !otp) {
      return res.status(400).json({ success: false, message: "ข้อมูลไม่ครบถ้วน" });
    }

    const result = verifyOtp(username, email, otp);
    if (!result.ok) {
      const messages = {
        expired: "รหัส OTP หมดอายุแล้ว กรุณาขอรหัสใหม่",
        too_many_attempts: "กรอกรหัสผิดหลายครั้งเกินไป กรุณาขอรหัสใหม่",
        invalid: "รหัส OTP ไม่ถูกต้อง",
      };
      return res.status(400).json({ success: false, message: messages[result.reason] || "รหัส OTP ไม่ถูกต้อง" });
    }

    res.json({ success: true, message: "ยืนยันรหัส OTP สำเร็จ" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "เกิดข้อผิดพลาดภายในเซิร์ฟเวอร์" });
  }
};

// --- ตั้งรหัสผ่านใหม่ (ต้องยืนยัน OTP สำเร็จมาก่อน) ---
// รับ { username, email, newPassword }
exports.resetPassword = async (req, res) => {
  try {
    const username = (req.body.username || "").trim();
    const email = (req.body.email || "").trim();
    const newPassword = req.body.newPassword || "";

    if (!username || !email || !newPassword) {
      return res.status(400).json({ success: false, message: "ข้อมูลไม่ครบถ้วน" });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ success: false, message: "รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร" });
    }

    // ต้องผ่านการยืนยัน OTP มาก่อนเท่านั้น (กันการตั้งรหัสผ่านโดยไม่ยืนยันตัวตน)
    if (!isVerified(username, email)) {
      return res.status(403).json({ success: false, message: "กรุณายืนยันรหัส OTP ก่อนตั้งรหัสผ่านใหม่" });
    }

    // ยืนยันอีกครั้งว่าสมาชิกยังมีอยู่จริง (เทียบ username แบบเดียวกับ send-otp)
    const { rows } = await pool.query(
      'SELECT member_id, email FROM Members WHERE LOWER(BTRIM(username)) = LOWER(BTRIM($1)) LIMIT 1',
      [username]
    );
    const user = rows[0];
    if (!user || !user.email || user.email.trim().toLowerCase() !== email.toLowerCase()) {
      return res.status(400).json({ success: false, message: "ไม่พบชื่อผู้ใช้ที่ตรงกับอีเมลนี้" });
    }

    const hashPassword = await bcrypt.hash(newPassword, 10);
    await pool.query(
      'UPDATE Members SET password = $1 WHERE member_id = $2',
      [hashPassword, user.member_id]
    );

    // ใช้ OTP ครั้งเดียวแล้วทิ้ง
    clearOtp(username, email);

    res.json({ success: true, message: "เปลี่ยนรหัสผ่านเรียบร้อยแล้ว" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "เกิดข้อผิดพลาดภายในเซิร์ฟเวอร์" });
  }
};

// --- Update Own Profile (Tenant/Admin) ---
exports.updateProfile = async (req, res) => {
  try {
    const id = req.user.id;
    const { full_name, email, phone_number } = req.body;

    const cur = await pool.query('SELECT * FROM members WHERE member_id = $1 LIMIT 1', [id]);
    if (!cur.rows[0]) return res.status(404).json({ success: false, message: "ไม่พบสมาชิก" });
    const c = cur.rows[0];

    await pool.query(
      `UPDATE members SET full_name=$1, email=$2, phone_number=$3 WHERE member_id=$4`,
      [
        full_name    !== undefined ? full_name    : c.full_name,
        email        !== undefined ? email        : c.email,
        phone_number !== undefined ? phone_number : c.phone_number,
        id,
      ]
    );
    res.json({ success: true, message: "อัปเดตโปรไฟล์เรียบร้อย" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Server error" });
  }
};