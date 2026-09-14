// ============================================================
// เพิ่มสินค้าตัวอย่าง (เครื่องดื่ม) ลงฐานข้อมูลจริง (Supabase)
// ใช้:  node scripts/seed-drinks.js
// อ่าน DATABASE_URL จาก server/.env · เปิด SSL ให้ Supabase อัตโนมัติ
// idempotent — ถ้ามีสินค้าชื่อนี้อยู่แล้วจะข้าม (รันซ้ำได้ ไม่เพิ่มซ้ำ)
// ============================================================
const { Pool } = require("pg");
require("dotenv").config();

// รายการเครื่องดื่มตัวอย่าง [ชื่อ, ราคา/หน่วย, จำนวนคงเหลือเริ่มต้น]
const DRINKS = [
    { name: "น้ำดื่ม (ขวดเล็ก)", price: 7, stock: 100 },
    { name: "น้ำดื่ม (ขวดใหญ่)", price: 14, stock: 60 },
    { name: "โค้ก (กระป๋อง)", price: 15, stock: 48 },
    { name: "เป๊ปซี่ (กระป๋อง)", price: 15, stock: 48 },
    { name: "น้ำส้มกล่อง", price: 12, stock: 40 },
    { name: "ชาเขียวขวด", price: 20, stock: 36 },
    { name: "กาแฟกระป๋อง", price: 18, stock: 36 },
    { name: "เอ็ม-150", price: 12, stock: 50 },
];

async function main() {
    const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
    });

    try {
        let added = 0;
        let skipped = 0;

        for (const drink of DRINKS) {
            // เช็คก่อนว่ามีสินค้าชื่อนี้อยู่แล้วหรือยัง (กันเพิ่มซ้ำเวลารันหลายรอบ)
            const exists = await pool.query(
                `SELECT 1 FROM products WHERE product_name = $1 LIMIT 1`,
                [drink.name]
            );
            if (exists.rows.length > 0) {
                console.log(`ข้าม (มีอยู่แล้ว): ${drink.name}`);
                skipped++;
                continue;
            }

            await pool.query(
                `INSERT INTO products (product_name, price, stock) VALUES ($1, $2, $3)`,
                [drink.name, drink.price, drink.stock]
            );
            console.log(`เพิ่ม: ${drink.name} (฿${drink.price} · คงเหลือ ${drink.stock})`);
            added++;
        }

        console.log(`\n✅ เสร็จ — เพิ่มใหม่ ${added} รายการ, ข้าม ${skipped} รายการ`);
    } catch (err) {
        console.error("❌ เพิ่มสินค้าตัวอย่างไม่สำเร็จ:", err.message);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
}

main();
