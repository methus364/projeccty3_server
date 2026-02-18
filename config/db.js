const { Pool } = require('pg');
require('dotenv').config(); // มั่นใจว่าโหลด dotenv ในไฟล์นี้ด้วย

const pool = new Pool({
  // ลองเอา URL มาใส่ตรงนี้ตรงๆ เพื่อเช็คว่าต่อติดไหม (ถ้าติดค่อยย้ายไป .env)
  connectionString: process.env.DATABASE_URL, 
  ssl: process.env.NODE_ENV === 'production' 
    ? { rejectUnauthorized: false } 
    : false
});

// เพิ่มส่วนนี้เพื่อเช็คว่าค่ามาไหม
if (!process.env.DATABASE_URL) {
  console.error("❌ Error: DATABASE_URL is undefined! Check your .env file.");
}

module.exports = pool;