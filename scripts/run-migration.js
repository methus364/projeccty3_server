// ============================================================
// ตัวรัน migration กับฐานข้อมูลจริง (Supabase)
// ใช้:  node scripts/run-migration.js ../db/migrations/<ไฟล์>.sql
// อ่าน DATABASE_URL จาก server/.env · เปิด SSL ให้ Supabase อัตโนมัติ
// ============================================================
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
require("dotenv").config();

async function main() {
    const fileArg = process.argv[2];
    if (!fileArg) {
        console.error("ใช้: node scripts/run-migration.js <path ไฟล์ .sql>");
        process.exit(1);
    }

    const sqlPath = path.resolve(fileArg);
    if (!fs.existsSync(sqlPath)) {
        console.error("ไม่พบไฟล์:", sqlPath);
        process.exit(1);
    }

    const sql = fs.readFileSync(sqlPath, "utf8");

    // Supabase ต้องใช้ SSL — เปิดไว้เสมอตอนรัน migration
    const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
    });

    try {
        console.log("กำลังรัน:", path.basename(sqlPath));
        await pool.query(sql);
        console.log("✅ รัน migration สำเร็จ");
    } catch (err) {
        console.error("❌ รัน migration ไม่สำเร็จ:", err.message);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
}

main();
