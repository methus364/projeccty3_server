const pool = require("../config/db"); // เปลี่ยนไปใช้ pool จากไฟล์ db.js ที่เราสร้างใหม่
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

exports.createBooking = async (req, res) => {
    const client = await pool.connect();
    const { roomId, userId, startDate, endDate, bookingType } = req.body;

    try {
        await client.query("BEGIN");

        // 1. หาค่าห้องที่ถูกต้อง (เช็คราคาพิเศษก่อน ถ้าไม่มีค่อยใช้ราคาฐาน)
        const priceQuery = `
            SELECT 
                COALESCE(
                    (SELECT price FROM "RoomSpecialRate" 
                     WHERE "roomId" = $1 AND $2 BETWEEN "startDate" AND "endDate" LIMIT 1),
                r."basePricedalliy"
                ) as active_price
            FROM "Room" r WHERE r.id = $1
        `;
        const priceRes = await client.query(priceQuery, [roomId, startDate]);
        const finalPrice = priceRes.rows[0].active_price;

        // 2. ตรวจสอบสถานะ RoomMonthly (ถ้าเป็นการจองในเดือนนั้น)
        const dateObj = new Date(startDate);
        const checkMonthly = await client.query(
            `SELECT "isBooked" FROM "RoomMonthly" WHERE "roomId" = $1 AND "month" = $2 AND "year" = $3`,
            [roomId, dateObj.getMonth() + 1, dateObj.getFullYear()]
        );

        if (checkMonthly.rows[0]?.isBooked) {
            throw new Error("ห้องนี้ถูกจองแบบรายเดือนไว้แล้ว ไม่สามารถจองรายวันได้");
        }

        // 3. บันทึกข้อมูลลงตาราง Booking
        // หมายเหตุ: ใช้ชื่อคอลัมน์ totalPrice ตาม Schema ของคุณ
        const bookingQuery = `
            INSERT INTO "Booking" ("userId", "roomId", "startDate", "endDate", "totalPrice", "status", "createdAt", "updatedAt")
            VALUES ($1, $2, $3, $4, $5, 'confirmed', NOW(), NOW())
            RETURNING id;
        `;
        const bookingRes = await client.query(bookingQuery, [userId, roomId, startDate, endDate, finalPrice]);

        // 4. ถ้าเป็นการจองรายเดือน (เช่น จอง 30 วัน) ให้ Update RoomMonthly ด้วย
        if (bookingType === 'monthly') {
            await client.query(
                `UPDATE "RoomMonthly" SET "isBooked" = true 
                 WHERE "roomId" = $1 AND "month" = $2 AND "year" = $3`,
                [roomId, dateObj.getMonth() + 1, dateObj.getFullYear()]
            );
        }

        await client.query("COMMIT");
        res.status(201).json({ success: true, bookingId: bookingRes.rows[0].id });

    } catch (error) {
        await client.query("ROLLBACK");
        res.status(500).json({ success: false, message: error.message });
    } finally {
        client.release();
    }
};