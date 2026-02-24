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
                    r."basePricedaily"
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


exports.checkbooking = async (req, res) => {
    // ดึง userId จาก body (เพราะใช้ router.post)
    const { userId } = req.body; 

    // ตรวจสอบเบื้องต้นว่าส่ง ID มาไหม
    if (!userId) {
        return res.status(400).json({ 
            success: false, 
            message: "กรุณาระบุ userId ที่ต้องการตรวจสอบ" 
        });
    }

    try {
        const query = `
            SELECT 
                b.id AS "bookingId",
                b."startDate",
                b."endDate",
                b."totalPrice",
                b."status" AS "bookingStatus",
                r.number AS "roomNumber",
                r.type AS "roomType"
            FROM "Booking" b
            JOIN "Room" r ON b."roomId" = r.id
            WHERE b."userId" = $1
            ORDER BY b."createdAt" DESC;
        `;

        const result = await pool.query(query, [userId]);

        res.status(200).json({
            success: true,
            count: result.rows.length,
            data: result.rows
        });

    } catch (error) {
        console.error("Check Booking Error:", error);
        res.status(500).json({ 
            success: false, 
            message: "Server Error", 
            error: error.message 
        });
    }
};

exports.editBooking = async (req, res) => {
  const client = await pool.connect();
  const { id } = req.params; // ID ของการจอง (Booking ID)
  const {
    startDate,
    endDate,
    status,
    roomId,
    userId
  } = req.body;

  try {
    await client.query("BEGIN");

    // 1. ตรวจสอบว่ามีข้อมูลการจองนี้อยู่จริงหรือไม่
    const currentBookingRes = await client.query('SELECT * FROM "Booking" WHERE id = $1', [id]);
    if (currentBookingRes.rows.length === 0) {
      client.release();
      return res.status(404).json({ success: false, message: "ไม่พบข้อมูลการจอง" });
    }
    const current = currentBookingRes.rows[0];

    // 2. ถ้ามีการเปลี่ยนวันที่ หรือ เปลี่ยนห้อง ต้องตรวจสอบว่าห้องว่างหรือไม่ (Prevent Overlap)
    // เงื่อนไข: ไม่นับรวม ID การจองของตัวเอง
    if (startDate || endDate || roomId) {
      const targetRoomId = roomId || current.roomId;
      const targetStart = startDate || current.startDate;
      const targetEnd = endDate || current.endDate;

      const overlapQuery = `
        SELECT id FROM "Booking"
        WHERE "roomId" = $1 
        AND id != $2
        AND status != 'CANCELLED'
        AND ("startDate" < $4 AND "endDate" > $3)
      `;
      const overlapCheck = await client.query(overlapQuery, [targetRoomId, id, targetStart, targetEnd]);

      if (overlapCheck.rows.length > 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ 
          success: false, 
          message: "ไม่สามารถเปลี่ยนวันหรือห้องได้ เนื่องจากมีการจองอื่นทับซ้อนในช่วงเวลาดังกล่าว" 
        });
      }
    }

    // 3. คำนวณราคาใหม่ (Optional: กรณีเปลี่ยนวันที่/ห้อง แล้วต้องการอัปเดตราคาอัตโนมัติ)
    let newTotalPrice = current.totalPrice;
    if (startDate || endDate || roomId) {
      const roomRes = await client.query('SELECT "basePricedaily" FROM "Room" WHERE id = $1', [roomId || current.roomId]);
      const pricePerDay = roomRes.rows[0].basePricedaily;
      
      const start = new Date(startDate || current.startDate);
      const end = new Date(endDate || current.endDate);
      const diffTime = Math.abs(end - start);
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
      newTotalPrice = diffDays * pricePerDay;
    }

    // 4. อัปเดตข้อมูลการจอง
    const updateQuery = `
      UPDATE "Booking" SET
        "roomId" = $1,
        "userId" = $2,
        "startDate" = $3,
        "endDate" = $4,
        "totalPrice" = $5,
        "status" = $6,
        "updatedAt" = NOW()
      WHERE id = $7
    `;

    await client.query(updateQuery, [
      roomId || current.roomId,
      userId || current.userId,
      startDate || current.startDate,
      endDate || current.endDate,
      newTotalPrice,
      status || current.status,
      id
    ]);

    await client.query("COMMIT");
    res.status(200).json({
      success: true,
      message: "แก้ไขข้อมูลการจองเรียบร้อยแล้ว",
      newTotalPrice: newTotalPrice
    });

  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error in editBooking:", error);
    res.status(500).json({ success: false, message: "เกิดข้อผิดพลาดภายในเซิร์ฟเวอร์", error: error.message });
  } finally {
    client.release();
  }
};