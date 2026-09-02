-- ============================================================
-- เพิ่มคอลัมน์ที่ flow สมัคร/ล็อกอิน/ลืมรหัส ด้วยอีเมล+OTP ต้องใช้
-- รันด้วย:  node scripts/run-migration.js ./migrations/001_add_member_email.sql
-- (idempotent — รันซ้ำได้ปลอดภัย)  หรือวางรันตรงใน Supabase SQL Editor
-- ============================================================
ALTER TABLE Members ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE Members ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS members_email_key ON Members (email) WHERE email IS NOT NULL;
