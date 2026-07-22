const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // สำหรับสายฟรี Supabase ต้องเปิด SSL เมื่อรันบน Cloud
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false,
  // ตั้งค่า pool ให้ชัดเจน (เดิมใช้ default max:10)
  max: 10,                     // จำนวน connection สูงสุดใน pool
  idleTimeoutMillis: 30000,    // ปิด connection ที่ว่างเกิน 30 วินาที คืน resource
  connectionTimeoutMillis: 5000, // ถ้าขอ connection ไม่ได้ใน 5 วินาที ให้ error แทนค้างไม่มีกำหนด
});

module.exports = pool;