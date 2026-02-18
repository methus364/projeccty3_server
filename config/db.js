const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // สำหรับสายฟรี Supabase ต้องเปิด SSL เมื่อรันบน Cloud
  ssl: process.env.NODE_ENV === 'production' 
    ? { rejectUnauthorized: false } 
    : false
});

module.exports = pool;