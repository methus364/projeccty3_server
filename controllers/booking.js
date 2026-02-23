const pool = require("../config/db"); // เปลี่ยนไปใช้ pool จากไฟล์ db.js ที่เราสร้างใหม่
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

exports.createBooking = async (req, res) => {
    const client = await pool.connect();
    const { roomId, userId, startDate, endDate, bookingType } = req.body;

    try {
        await client.query("BEGIN");

        // 1. หาราคาที่ถูกต้อง (เช็ค Special Rate)
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
        if (priceRes.rows.length === 0) throw new Error("ไม่พบข้อมูลห้องพัก");
        const finalPrice = priceRes.rows[0].active_price;

        // 2. เช็กการจองซ้อน (Overlap Booking Check) *** จุดที่เพิ่มเข้ามา ***
        // เงื่อนไขคือ: (วันเริ่มใหม่ < วันจบที่มีอยู่) AND (วันจบใหม่ > วันเริ่มที่มีอยู่)
        const overlapQuery = `
            SELECT id FROM "Booking"
            WHERE "roomId" = $1 
            AND "status" != 'CANCELLED'
            AND ($2 < "endDate" AND $3 > "startDate")
            LIMIT 1;
        `;
        const overlapRes = await client.query(overlapQuery, [roomId, startDate, endDate]);
        
        if (overlapRes.rows.length > 0) {
            throw new Error("ห้องนี้ถูกจองแล้วในช่วงเวลาดังกล่าว");
        }

        // 3. ตรวจสอบสถานะ RoomMonthly (กรณีจองรายวันแต่ติดคนเช่ารายเดือน)
        const checkMonthly = await client.query(
            `SELECT "isBooked" FROM "RoomMonthly" WHERE "roomId" = $1`,
            [roomId]
        );
        if (checkMonthly.rows[0]?.isBooked) {
            throw new Error("ห้องนี้ถูกจองแบบรายเดือนไว้แล้ว ไม่สามารถจองรายวันได้");
        }

        // 4. บันทึกข้อมูลลงตาราง Booking
        const bookingQuery = `
            INSERT INTO "Booking" ("userId", "roomId", "startDate", "endDate", "totalPrice", "status", "createdAt", "updatedAt")
            VALUES ($1, $2, $3, $4, $5, 'PENDING', NOW(), NOW())
            RETURNING id;
        `;
        const bookingRes = await client.query(bookingQuery, [userId, roomId, startDate, endDate, finalPrice]);

        // 5. ถ้าเป็นการจองรายเดือน ให้ Update RoomMonthly
        if (bookingType === 'monthly') {
            await client.query(
                `UPDATE "RoomMonthly" SET "isBooked" = true WHERE "roomId" = $1`,
                [roomId]
            );
        }

        await client.query("COMMIT");
        res.status(201).json({ success: true, bookingId: bookingRes.rows[0].id });

    } catch (error) {
        await client.query("ROLLBACK");
        console.error("Booking Error:", error.message);
        res.status(400).json({ success: false, message: error.message });
    } finally {
        client.release();
    }
};