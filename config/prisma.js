require('dotenv').config();
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');
const { PrismaClient } = require('@prisma/client'); 

// 1. สร้างการเชื่อมต่อด้วย pg pool
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// 2. สร้าง Adapter
const adapter = new PrismaPg(pool);

// 3. สร้าง Client โดยใช้ Adapter
const prisma = new PrismaClient({ adapter });

module.exports = { prisma };