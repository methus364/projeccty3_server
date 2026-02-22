const pool = require("../config/db"); // เปลี่ยนไปใช้ pool จากไฟล์ db.js ที่เราสร้างใหม่
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

exports.createBooking = async (req, res) => {
    const client = await pool.connect();
    const { 
        roomId, 
        userId, 
        startDate, 
        endDate, 
        bookingType, // 'daily' หรือ 'monthly'
        totalPrice 
    } = req.body;

    try {
        await client.query("BEGIN");

        // 1. ตรวจสอบก่อนว่าห้องยังว่างอยู่ไหม (ป้องกันการจองซ้ำในเสี้ยววินาที)
        // ถ้าเป็นรายเดือน เช็คจาก RoomMonthly
        if (bookingType === 'monthly') {
            const checkMonthly = await client.query(
                `SELECT "isBooked" FROM "RoomMonthly" 
                 WHERE "roomId" = $1 AND "month" = $2 AND "year" = $3`,
                [roomId, new Date(startDate).getMonth() + 1, new Date(startDate).getFullYear()]
            );
            if (checkMonthly.rows[0]?.isBooked) {
                throw new Error("ห้องนี้ถูกจองรายเดือนไปแล้ว");
            }
        }

        // 2. บันทึกข้อมูลลงตาราง Booking
        const bookingQuery = `
            INSERT INTO "Booking" ("roomId", "userId", "startDate", "endDate", "status", "totalPrice", "createdAt")
            VALUES ($1, $2, $3, $4, 'confirmed', $5, NOW())
            RETURNING id;
        `;
        const bookingRes = await client.query(bookingQuery, [roomId, userId, startDate, endDate, totalPrice]);
        const bookingId = bookingRes.rows[0].id;

        // 3. ถ้าเป็นรายเดือน ให้ไป Update สถานะใน RoomMonthly เป็น 'ไม่ว่าง'
        if (bookingType === 'monthly') {
            await client.query(
                `UPDATE "RoomMonthly" SET "isBooked" = true 
                 WHERE "roomId" = $1 AND "month" = $2 AND "year" = $3`,
                [roomId, new Date(startDate).getMonth() + 1, new Date(startDate).getFullYear()]
            );
        }

        await client.query("COMMIT");
        res.status(201).json({ success: true, message: "จองสำเร็จ", bookingId });

    } catch (error) {
        await client.query("ROLLBACK");
        res.status(500).json({ success: false, message: error.message });
    } finally {
        client.release();
    }
};