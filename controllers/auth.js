const pool = require("../config/db");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const SECRET = require("../config/secret");
const { sendMail } = require("../config/mailer");
const { createOtp, verifyOtp, isVerified, clearOtp } = require("../utils/otpStore");

// role ที่ผู้ใช้เลือกเองได้ตอนสมัคร — เฉพาะผู้เช่าเท่านั้น (ห้าม Admin เด็ดขาด กัน privilege escalation)
const SIGNUP_ROLES = ["Daily_Tenant", "Monthly_Tenant"];

// ตรวจรูปแบบอีเมลแบบง่ายๆ (มี @ และมีจุดหลัง @) — พอสำหรับกันพิมพ์ผิดเบื้องต้น
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// สร้าง JWT ให้สมาชิก แล้วส่ง response แบบเดียวกับ social login ({ success, payload, token })
function signInResponse(res, user, message) {
  const payload = {
    id: user.member_id,
    username: user.username,
    role: user.user_role,
  };
  const token = jwt.sign(payload, SECRET, { expiresIn: "1d" });
  res.json({ success: true, payload, token, message });
}

// --- Register (สมัครสมาชิก) ---
// flow ใหม่: สร้างบัญชีสถานะ "ยังไม่ยืนยันอีเมล" แล้วส่ง OTP ไปอีเมล
//   ผู้ใช้ต้องยืนยัน OTP ที่ /auth/verify-registration ก่อนถึงจะ login ได้
exports.register = async (req, res) => {
  try {
    const username = (req.body.username || "").trim();
    const email = (req.body.email || "").trim();
    const password = req.body.password || "";
    const full_name = (req.body.full_name || "").trim();
    const phone_number = req.body.phone_number || null;
    const user_role = req.body.user_role;

    // 1. ตรวจ field ที่จำเป็นให้ครบก่อน
    if (!username) return res.status(400).json({ success: false, message: "กรุณากรอกชื่อผู้ใช้" });
    if (!password) return res.status(400).json({ success: false, message: "กรุณากรอกรหัสผ่าน" });
    if (password.length < 6) return res.status(400).json({ success: false, message: "รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร" });
    if (!full_name) return res.status(400).json({ success: false, message: "กรุณากรอกชื่อ-นามสกุล" });
    if (!email) return res.status(400).json({ success: false, message: "กรุณากรอกอีเมล" });
    if (!isValidEmail(email)) return res.status(400).json({ success: false, message: "รูปแบบอีเมลไม่ถูกต้อง" });

    // 2. ต้องเลือกประเภทผู้เช่า (รายวัน/รายเดือน) ตอนสมัคร
    if (!SIGNUP_ROLES.includes(user_role)) {
      return res.status(400).json({ success: false, message: "กรุณาเลือกประเภทสมาชิก (ผู้เช่ารายวัน หรือ รายเดือน)" });
    }

    // 3. ตรวจ username ซ้ำ
    const checkUser = await pool.query(
      'SELECT username FROM Members WHERE username = $1 LIMIT 1',
      [username]
    );
    if (checkUser.rows.length > 0) {
      return res.status(400).json({ success: false, message: "ชื่อผู้ใช้นี้ถูกใช้แล้ว" });
    }

    // 4. ตรวจ email ซ้ำ
    const checkEmail = await pool.query(
      'SELECT email FROM Members WHERE email = $1 LIMIT 1',
      [email]
    );
    if (checkEmail.rows.length > 0) {
      return res.status(400).json({ success: false, message: "อีเมลนี้ถูกใช้แล้ว" });
    }

    // 5. Hash รหัสผ่าน แล้ว INSERT สมาชิกใหม่ (email_verified_at = NULL คือยังไม่ยืนยัน)
    const hashPassword = await bcrypt.hash(password, 10);
    await pool.query(
      'INSERT INTO Members (username, password, full_name, email, phone_number, user_role) VALUES ($1, $2, $3, $4, $5, $6)',
      [username, hashPassword, full_name, email, phone_number, user_role]
    );

    // 6. สร้าง OTP แล้วส่งไปอีเมลให้ยืนยัน
    await sendRegistrationOtp(username, email);

    res.status(201).json({
      success: true,
      message: "สมัครสมาชิกสำเร็จ กรุณายืนยันรหัส OTP ที่ส่งไปยังอีเมลของคุณ",
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "เกิดข้อผิดพลาดภายในเซิร์ฟเวอร์" });
  }
};

// ตัวช่วย: สร้าง OTP สำหรับยืนยันการสมัคร แล้วส่งอีเมล
async function sendRegistrationOtp(username, email) {
  const code = createOtp(username, email);
  await sendMail({
    to: email,
    subject: "รหัส OTP ยืนยันการสมัครสมาชิก — หอพัก Around Loei",
    text:
      `สวัสดีคุณ ${username}\n\n` +
      `รหัส OTP สำหรับยืนยันการสมัครสมาชิกของคุณคือ: ${code}\n\n` +
      `รหัสนี้จะหมดอายุใน 5 นาที กรุณาอย่าเปิดเผยรหัสนี้แก่ผู้อื่น\n` +
      `หากคุณไม่ได้เป็นผู้สมัคร กรุณาเพิกเฉยต่ออีเมลฉบับนี้`,
  });
}

// --- ยืนยัน OTP การสมัคร → เปิดใช้งานบัญชี + login ให้เลย ---
// รับ { email, otp }
exports.verifyRegistration = async (req, res) => {
  try {
    const email = (req.body.email || "").trim();
    const otp = (req.body.otp || "").trim();

    if (!email || !otp) {
      return res.status(400).json({ success: false, message: "กรุณากรอกอีเมลและรหัส OTP" });
    }

    // 1. หาสมาชิกจากอีเมล (ต้องมีอยู่จริง เพราะสร้างตอนสมัครแล้ว)
    const { rows } = await pool.query(
      'SELECT * FROM Members WHERE email = $1 LIMIT 1',
      [email]
    );
    const user = rows[0];
    if (!user) {
      return res.status(404).json({ success: false, message: "ไม่พบบัญชีที่ใช้อีเมลนี้" });
    }
    if (user.email_verified_at) {
      return res.status(400).json({ success: false, message: "อีเมลนี้ยืนยันแล้ว กรุณาเข้าสู่ระบบ" });
    }

    // 2. ตรวจ OTP (key ใน otpStore = username|email — ใช้ username จาก DB ให้ตรงกับตอนส่ง)
    const result = verifyOtp(user.username, email, otp);
    if (!result.ok) {
      const messages = {
        expired: "รหัส OTP หมดอายุแล้ว กรุณาขอรหัสใหม่",
        too_many_attempts: "กรอกรหัสผิดหลายครั้งเกินไป กรุณาขอรหัสใหม่",
        invalid: "รหัส OTP ไม่ถูกต้อง",
      };
      return res.status(400).json({ success: false, message: messages[result.reason] || "รหัส OTP ไม่ถูกต้อง" });
    }

    // 3. ยืนยันสำเร็จ — มาร์คบัญชีว่ายืนยันแล้ว + ล้าง OTP ทิ้ง
    await pool.query('UPDATE Members SET email_verified_at = NOW() WHERE member_id = $1', [user.member_id]);
    clearOtp(user.username, email);

    // 4. login ให้เลย (ออก token) เพื่อ UX ที่ลื่นไหล
    signInResponse(res, user, "ยืนยันอีเมลสำเร็จ ยินดีต้อนรับ");
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "เกิดข้อผิดพลาดภายในเซิร์ฟเวอร์" });
  }
};

// --- ขอส่งรหัส OTP ยืนยันการสมัครใหม่ (กรณีไม่ได้รับ/หมดอายุ) ---
// รับ { email }
exports.resendRegistrationOtp = async (req, res) => {
  try {
    const email = (req.body.email || "").trim();
    if (!email) {
      return res.status(400).json({ success: false, message: "กรุณากรอกอีเมล" });
    }

    // ส่งซ้ำเฉพาะบัญชีที่มีอยู่จริงและยังไม่ยืนยันเท่านั้น
    const { rows } = await pool.query(
      'SELECT username, email_verified_at FROM Members WHERE email = $1 LIMIT 1',
      [email]
    );
    const user = rows[0];
    if (user && !user.email_verified_at) {
      await sendRegistrationOtp(user.username, email);
    }

    // ตอบข้อความกลางๆ เสมอ ไม่ยืนยันว่ามีบัญชีนี้อยู่จริงไหม (กันการเดาข้อมูลผู้ใช้)
    res.json({ success: true, message: "ถ้าอีเมลนี้รอการยืนยันอยู่ ระบบได้ส่งรหัส OTP ใหม่ให้แล้ว" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "เกิดข้อผิดพลาดภายในเซิร์ฟเวอร์" });
  }
};

// --- Login (เข้าสู่ระบบด้วยอีเมล หรือ ชื่อผู้ใช้) ---
exports.login = async (req, res) => {
  try {
    // รับได้ทั้งอีเมลและชื่อผู้ใช้ (รองรับ key เดิม `email`/`username` เพื่อความเข้ากันได้ — mobile ส่ง username)
    const loginId = (req.body.login || req.body.email || req.body.username || "").trim();
    const password = req.body.password || "";

    if (!loginId || !password) {
      return res.status(400).json({ success: false, message: "กรุณากรอกอีเมล/ชื่อผู้ใช้ และรหัสผ่าน" });
    }

    // 1. หาสมาชิกจากอีเมล หรือ ชื่อผู้ใช้ (อันไหนตรงก็ได้)
    const result = await pool.query(
      'SELECT * FROM Members WHERE email = $1 OR username = $1 LIMIT 1',
      [loginId]
    );
    const user = result.rows[0];
    if (!user) {
      return res.status(400).json({ success: false, message: "อีเมล/ชื่อผู้ใช้ หรือรหัสผ่านไม่ถูกต้อง" });
    }

    // 2. บัญชี social-only (password เป็น NULL) — กัน error แล้วบอกให้ไปใช้ social login
    if (!user.password) {
      return res.status(401).json({ success: false, message: "บัญชีนี้ผูกกับ Social Login — กรุณาเข้าสู่ระบบผ่าน Line/Google" });
    }

    // 3. ตรวจรหัสผ่าน
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: "อีเมล/ชื่อผู้ใช้ หรือรหัสผ่านไม่ถูกต้อง" });
    }

    // 4. ต้องยืนยันอีเมลก่อนถึงจะเข้าใช้งานได้
    if (!user.email_verified_at) {
      return res.status(403).json({
        success: false,
        message: "กรุณายืนยันอีเมลก่อนเข้าสู่ระบบ (ขอรหัส OTP ใหม่ได้ที่หน้ายืนยันอีเมล)",
        needVerification: true,
      });
    }

    // 5. ผ่านหมด — ออก token
    signInResponse(res, user, "เข้าสู่ระบบสำเร็จ");
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "เกิดข้อผิดพลาดภายในเซิร์ฟเวอร์" });
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

// ตัวช่วย: หาสมาชิกจาก "อีเมลหรือชื่อผู้ใช้" (คืน { member_id, username, email }) หรือ null ถ้าไม่พบ
// เทียบแบบไม่สนตัวพิมพ์ + ตัดช่องว่าง (กันกรณี DB เก็บ "Kimkim"/"kimkim ")
// ผู้ใช้ที่ลืมรหัสมักจำ username ไม่ได้ จึงให้กรอกอีเมลแทนได้ด้วย
async function findMemberByIdentifier(identifier) {
  const { rows } = await pool.query(
    `SELECT member_id, username, email FROM Members
       WHERE LOWER(BTRIM(username)) = LOWER(BTRIM($1))
          OR LOWER(BTRIM(email))    = LOWER(BTRIM($1))
       LIMIT 1`,
    [identifier]
  );
  return rows[0] || null;
}

// ตัวช่วย: ปิดบังอีเมลบางส่วนก่อนแสดงผล เช่น example@gmail.com → e****e@gmail.com
function maskEmail(email) {
  const [name, domain] = String(email).split("@");
  if (!domain) return email;
  const first = name.slice(0, 1);
  const last = name.length > 1 ? name.slice(-1) : "";
  return `${first}****${last}@${domain}`;
}

// --- ส่งรหัส OTP ไปที่อีเมล ---
// รับ { identifier } (อีเมลหรือชื่อผู้ใช้) → หาอีเมลของบัญชีนั้นจาก DB แล้วส่ง OTP ไปให้
// (รองรับ field เดิม email/username เพื่อความเข้ากันได้ย้อนหลัง)
exports.sendOtp = async (req, res) => {
  try {
    const identifier = (req.body.identifier || req.body.email || req.body.username || "").trim();

    if (!identifier) {
      return res.status(400).json({ success: false, message: "กรุณากรอกอีเมลหรือชื่อผู้ใช้" });
    }

    // หาบัญชีจากอีเมลหรือชื่อผู้ใช้ แล้วดึงอีเมลที่ผูกไว้มาใช้ส่ง OTP
    const user = await findMemberByIdentifier(identifier);
    if (!user || !user.email) {
      return res.status(400).json({
        success: false,
        message: "ไม่พบบัญชีนี้ หรือบัญชีนี้ไม่มีอีเมลสำหรับรับรหัส OTP",
      });
    }

    // สร้าง OTP (คีย์ด้วย username + อีเมลจาก DB เสมอ ให้ทุกขั้นตอนใช้คีย์เดียวกัน) แล้วส่งอีเมล
    const code = createOtp(user.username, user.email);
    try {
      await sendMail({
        to: user.email,
        subject: "รหัส OTP สำหรับเปลี่ยนรหัสผ่าน — หอพัก Around Loei",
        text:
          `สวัสดีคุณ ${user.username}\n\n` +
          `รหัส OTP สำหรับเปลี่ยนรหัสผ่านของคุณคือ: ${code}\n\n` +
          `รหัสนี้จะหมดอายุใน 5 นาที กรุณาอย่าเปิดเผยรหัสนี้แก่ผู้อื่น\n` +
          `หากคุณไม่ได้เป็นผู้ร้องขอ กรุณาเพิกเฉยต่ออีเมลฉบับนี้`,
      });
    } catch (mailErr) {
      console.error("Send OTP mail error:", mailErr);
      return res.status(502).json({ success: false, message: "ส่งอีเมลไม่สำเร็จ กรุณาลองใหม่อีกครั้ง" });
    }

    // คืนอีเมลแบบปิดบังบางส่วน ให้หน้าจอแสดงว่าส่งไปที่ไหน
    res.json({
      success: true,
      message: "ส่งรหัส OTP ไปที่อีเมลของคุณแล้ว",
      email: maskEmail(user.email),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "เกิดข้อผิดพลาดภายในเซิร์ฟเวอร์" });
  }
};

// --- ตรวจสอบรหัส OTP ---
// รับ { identifier, otp } → หาบัญชีจากอีเมล/ชื่อผู้ใช้ แล้วใช้ username+email จาก DB เป็นคีย์ตรวจ OTP
exports.verifyOtp = async (req, res) => {
  try {
    const identifier = (req.body.identifier || req.body.email || req.body.username || "").trim();
    const otp = (req.body.otp || "").trim();

    if (!identifier || !otp) {
      return res.status(400).json({ success: false, message: "ข้อมูลไม่ครบถ้วน" });
    }

    // หาบัญชีจากอีเมล/ชื่อผู้ใช้ (ต้องตรงกับตอนสร้าง OTP)
    const user = await findMemberByIdentifier(identifier);
    if (!user || !user.email) {
      return res.status(400).json({ success: false, message: "ไม่พบบัญชีนี้" });
    }

    const result = verifyOtp(user.username, user.email, otp);
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
// รับ { identifier, newPassword } → หาบัญชีจากอีเมล/ชื่อผู้ใช้ มาใช้ username+email เป็นคีย์
exports.resetPassword = async (req, res) => {
  try {
    const identifier = (req.body.identifier || req.body.email || req.body.username || "").trim();
    const newPassword = req.body.newPassword || "";

    if (!identifier || !newPassword) {
      return res.status(400).json({ success: false, message: "ข้อมูลไม่ครบถ้วน" });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ success: false, message: "รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร" });
    }

    // หาบัญชีจากอีเมล/ชื่อผู้ใช้ (ใช้ username+email จาก DB เป็นคีย์ตรวจสถานะ OTP)
    const user = await findMemberByIdentifier(identifier);
    if (!user || !user.email) {
      return res.status(400).json({ success: false, message: "ไม่พบบัญชีนี้" });
    }

    // ต้องผ่านการยืนยัน OTP มาก่อนเท่านั้น (กันการตั้งรหัสผ่านโดยไม่ยืนยันตัวตน)
    if (!isVerified(user.username, user.email)) {
      return res.status(403).json({ success: false, message: "กรุณายืนยันรหัส OTP ก่อนตั้งรหัสผ่านใหม่" });
    }

    const hashPassword = await bcrypt.hash(newPassword, 10);
    await pool.query(
      'UPDATE Members SET password = $1 WHERE member_id = $2',
      [hashPassword, user.member_id]
    );

    // ใช้ OTP ครั้งเดียวแล้วทิ้ง
    clearOtp(user.username, user.email);

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