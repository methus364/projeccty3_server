// JWT secret — บังคับอ่านจาก .env เท่านั้น (ไม่มี fallback hardcode)
require("dotenv").config();

const SECRET = process.env.SECRET;

if (!SECRET) {
  // fail-fast: หยุด server ทันทีถ้าลืมตั้งค่า เพื่อกันการเซ็น token ด้วยคีย์ที่เดาได้
  throw new Error("Missing required env var: SECRET (ตั้งค่าใน server/.env)");
}

module.exports = SECRET;
