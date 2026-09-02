// ============================================================
//  Auto-migration ตอนเซิร์ฟเวอร์บูต — สร้างคอลัมน์ที่ flow ใหม่ต้องใช้ให้ครบ
//  เหตุผล: flow สมัคร/ล็อกอิน/ลืมรหัส ด้วยอีเมล+OTP พึ่งพาคอลัมน์
//          Members.email และ Members.email_verified_at
//          ถ้าฐานข้อมูลจริง (Supabase) ยังไม่มี 2 คอลัมน์นี้ ทุก endpoint จะ 500
//  ทุกคำสั่งเป็น idempotent (IF NOT EXISTS) รันซ้ำกี่ครั้งก็ปลอดภัย
// ============================================================
const pool = require("../config/db");

// รวมคำสั่งไว้ที่เดียว — เพิ่มคอลัมน์/อินเด็กซ์ใหม่ในอนาคตต่อท้ายได้เลย
const STATEMENTS = [
  `ALTER TABLE Members ADD COLUMN IF NOT EXISTS email TEXT`,
  `ALTER TABLE Members ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ`,
  // กันอีเมลซ้ำ (partial index — ข้ามแถวที่ email เป็น NULL เช่นบัญชี social ที่ provider ไม่ส่งอีเมลมา)
  `CREATE UNIQUE INDEX IF NOT EXISTS members_email_key ON Members (email) WHERE email IS NOT NULL`,
];

// รันเป็นลำดับ — ไม่ throw ออกไปให้ process ล้ม (log ไว้พอ) เพื่อไม่ให้เซิร์ฟเวอร์บูตไม่ขึ้น
async function ensureSchema() {
  for (const sql of STATEMENTS) {
    try {
      await pool.query(sql);
    } catch (err) {
      console.error("ensureSchema failed:", sql, "→", err.message);
    }
  }
  console.log("✅ ensureSchema: ตรวจ/เพิ่มคอลัมน์ Members (email, email_verified_at) เรียบร้อย");
}

module.exports = { ensureSchema };
