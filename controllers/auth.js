const pool = require("../config/db"); // เปลี่ยนไปใช้ pool จากไฟล์ db.js ที่เราสร้างใหม่
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");


exports.addRoom = async (req, res) => {
  // 1. จอง Client 1 ตัวจาก Pool เพื่อทำ Transaction
  const client = await pool.connect(); 
  const { number, type, floor, basePrice, monthlyPrice, month, year, specialStart, specialEnd, specialPrice } = req.body;

  try {
    // 2. เริ่มต้น Transaction ด้วย Client ตัวนี้
    await client.query("BEGIN"); 

    // 3. Insert ลงตาราง Room
    const roomRes = await client.query(
      `INSERT INTO "Room" (number, type, floor, "basePrice", status, "createdAt", "updatedAt") 
       VALUES ($1, $2, $3, $4, $5, NOW(), NOW()) RETURNING id`,
      [number, type, floor, basePrice, true]
    );
    const newRoomId = roomRes.rows[0].id;

    // 4. Insert ลงตาราง RoomMonthly
    await client.query(
      `INSERT INTO "RoomMonthly" ("roomId", month, year, price, "isBooked") 
       VALUES ($1, $2, $3, $4, $5)`,
      [newRoomId, month, year, monthlyPrice, false]
    );

    // 5. Insert ลงตาราง RoomSpecialRate
    await client.query(
      `INSERT INTO "RoomSpecialRate" ("roomId", description, "startDate", "endDate", price) 
       VALUES ($1, $2, $3, $4, $5)`,
      [newRoomId, "Initial setup", specialStart, specialEnd, specialPrice]
    );

    // 6. ถ้าสำเร็จหมดให้ยืนยัน
    await client.query("COMMIT"); 
    res.status(201).json({ success: true, roomId: newRoomId });

  } catch (e) {
    // 7. ถ้ามีจุดไหนพลาด ให้ยกเลิกทั้งหมดที่ทำมาใน Client ตัวนี้
    await client.query("ROLLBACK"); 
    console.error("Transaction Error:", e);
    res.status(500).json({ success: false, error: e.message });
  } finally {
    // 8. สำคัญที่สุด: คืน Client กลับเข้า Pool เพื่อให้คนอื่นใช้งานต่อ
    client.release(); 
  }
};