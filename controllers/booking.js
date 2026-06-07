const pool = require("../config/db");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

// ==========================================
// 1. สร้างการจองห้องพัก (createBooking)
// ==========================================
exports.createBooking = async (req, res) => {
    const client = await pool.connect();
    // รับค่าโดยอ้างอิงตัวแปรตามสไตล์ API เดิมของคุณ
    const { roomId, userId, startDate, endDate } = req.body;

    try {
        await client.query("BEGIN");

        // 1. ดึงราคาห้องพักจริงจากความสัมพันธ์ของตาราง Rooms และ Room_Types
        const priceQuery = `
            SELECT rt.room_price, r.room_status 
            FROM Rooms r
            JOIN Room_Types rt ON r.room_type_id = rt.room_type_id
            WHERE r.room_id = $1 LIMIT 1
        `;
        const priceRes = await client.query(priceQuery, [roomId]);
        
        if (priceRes.rows.length === 0) {
            throw new Error("ไม่พบข้อมูลห้องพักนี้ในระบบ");
        }
        
        const { room_price, room_status } = priceRes.rows[0];

        // ตรวจสอบเบื้องต้นว่าห้องปิดปรับปรุงอยู่หรือไม่
        if (room_status === 'ปิดปรับปรุง') {
            throw new Error("ห้องพักนี้ปิดปรับปรุงอยู่ ไม่สามารถจองได้");
        }

        // 2. เช็กการจองซ้อน (Overlap Booking Check) 
        // เงื่อนไข: (วันเริ่มใหม่ < วันจบที่มีอยู่) AND (วันจบใหม่ > วันเริ่มที่มีอยู่) และบิลนั้นยังไม่ถูกยกเลิก
        const overlapQuery = `
            SELECT booking_id FROM Bookings
            WHERE room_id = $1 
            AND booking_status NOT IN ('ยกเลิก', 'ย้ายออกแล้ว')
            AND ($2 < check_out_date AND $3 > check_in_date)
            LIMIT 1;
        `;
        const overlapRes = await client.query(overlapQuery, [roomId, startDate, endDate]);
        
        if (overlapRes.rows.length > 0) {
            throw new Error("ห้องนี้ถูกจองหรือมีผู้เช่าพักอยู่แล้วในช่วงเวลาดังกล่าว");
        }

        // 3. คำนวณราคาสุทธิ (จำนวนวัน X ราคาห้องต่อวัน)
        const start = new Date(startDate);
        const end = new Date(endDate);
        const diffTime = Math.abs(end - start);
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)) || 1; // กันกรณีจองวันเดียวกัน ให้คิดเป็น 1 วัน
        const totalPrice = diffDays * room_price;

        // 4. บันทึกข้อมูลลงตาราง Bookings (ตามโครงสร้างฐานข้อมูลใหม่)
        const bookingQuery = `
            INSERT INTO Bookings (member_id, room_id, check_in_date, check_out_date, booking_status)
            VALUES ($1, $2, $3, $4, 'รอชำระมัดจำ')
            RETURNING booking_id;
        `;
        const bookingRes = await client.query(bookingQuery, [userId, roomId, startDate, endDate]);

        // 5. อัปเดตสถานะห้องพักให้เป็น 'มีผู้เช่า' ทันที
        await client.query(
            `UPDATE Rooms SET room_status = 'มีผู้เช่า' WHERE room_id = $1`,
            [roomId]
        );

        await client.query("COMMIT");
        res.status(201).json({ 
            success: true, 
            bookingId: bookingRes.rows[0].booking_id,
            totalPrice: totalPrice 
        });

    } catch (error) {
        await client.query("ROLLBACK");
        console.error("Booking Error:", error.message);
        res.status(400).json({ success: false, message: error.message });
    } finally {
        client.release();
    }
};

// ==========================================
// 2. ตรวจสอบประวัติการจองของผู้ใช้ (checkbooking)
// ==========================================
exports.checkbooking = async (req, res) => {
    const { userId } = req.body; 

    if (!userId) {
        return res.status(400).json({ 
            success: false, 
            message: "กรุณาระบุ userId ที่ต้องการตรวจสอบ" 
        });
    }

    try {
        const query = `
            SELECT 
                b.booking_id AS "bookingId",
                b.check_in_date AS "startDate",
                b.check_out_date AS "endDate",
                b.booking_status AS "bookingStatus",
                r.room_number AS "roomNumber",
                rt.type_name AS "roomType",
                rt.room_price AS "pricePerDay"
            FROM Bookings b
            JOIN Rooms r ON b.room_id = r.room_id
            JOIN Room_Types rt ON r.room_type_id = rt.room_type_id
            WHERE b.member_id = $1
            ORDER BY b.booking_date DESC;
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

// ==========================================
// 3. แก้ไขข้อมูลการจอง (editBooking)
// ==========================================
exports.editBooking = async (req, res) => {
  const client = await pool.connect();
  const { id } = req.params; // Booking ID
  const { startDate, endDate, status, roomId, userId } = req.body;

  try {
    await client.query("BEGIN");

    // 1. ตรวจสอบข้อมูลการจองปัจจุบันในระบบ
    const currentBookingRes = await client.query('SELECT * FROM Bookings WHERE booking_id = $1', [id]);
    if (currentBookingRes.rows.length === 0) {
      client.release();
      return res.status(404).json({ success: false, message: "ไม่พบข้อมูลการจองที่ระบุ" });
    }
    const current = currentBookingRes.rows[0];

    const targetRoomId = roomId || current.room_id;
    const targetStart = startDate || current.check_in_date;
    const targetEnd = endDate || current.check_out_date;

    // 2. ตรวจสอบเงื่อนไขทับซ้อนช่วงเวลา (Overlap) กรณีขยับวันหรือเปลี่ยนห้องพัก
    if (startDate || endDate || roomId) {
      const overlapQuery = `
        SELECT booking_id FROM Bookings
        WHERE room_id = $1 
        AND booking_id != $2
        AND booking_status NOT IN ('ยกเลิก', 'ย้ายออกแล้ว')
        AND (check_in_date < $4 AND check_out_date > $3)
      `;
      const overlapCheck = await client.query(overlapQuery, [targetRoomId, id, targetStart, targetEnd]);

      if (overlapCheck.rows.length > 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ 
          success: false, 
          message: "ไม่สามารถเปลี่ยนวันหรือห้องได้ เนื่องจากมีบุ๊คกิ้งอื่นจองไว้แล้ว" 
        });
      }
    }

    // 3. คำนวณราคาห้องพักใหม่ให้เหมาะสมกับจำนวนวันและประเภทห้องที่เปลี่ยน
    const roomRes = await client.query(
        'SELECT rt.room_price FROM Rooms r JOIN Room_Types rt ON r.room_type_id = rt.room_type_id WHERE r.room_id = $1', 
        [targetRoomId]
    );
    const pricePerDay = roomRes.rows[0].room_price;
    
    const start = new Date(targetStart);
    const end = new Date(targetEnd);
    const diffTime = Math.abs(end - start);
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)) || 1;
    const newTotalPrice = diffDays * pricePerDay;

    // 4. สั่ง Update ข้อมูลเข้าฐานข้อมูล PostgreSQL
    const updateQuery = `
      UPDATE Bookings SET
        room_id = $1,
        member_id = $2,
        check_in_date = $3,
        check_out_date = $4,
        booking_status = $5
      WHERE booking_id = $6
    `;

    await client.query(updateQuery, [
      targetRoomId,
      userId || current.member_id,
      targetStart,
      targetEnd,
      status || current.booking_status,
      id
    ]);

    // 5. ปรับปรุงสถานะห้องพักตามสถานะการจอง (เช่น หากกดยกเลิก ให้เปลี่ยนสถานะห้องกลับมาเป็น 'ว่าง')
    const finalStatus = status || current.booking_status;
    if (finalStatus === 'ยกเลิก' || finalStatus === 'ย้ายออกแล้ว') {
        await client.query(`UPDATE Rooms SET room_status = 'ว่าง' WHERE room_id = $1`, [targetRoomId]);
    } else if (finalStatus === 'กำลังเข้าพัก' || finalStatus === 'ยืนยันการจอง') {
        await client.query(`UPDATE Rooms SET room_status = 'มีผู้เช่า' WHERE room_id = $1`, [targetRoomId]);
    }

    await client.query("COMMIT");
    res.status(200).json({
      success: true,
      message: "แก้ไขข้อมูลการจองและอัปเดตสถานะห้องพักเรียบร้อยแล้ว",
      calculatedTotalPrice: newTotalPrice
    });

  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error in editBooking:", error);
    res.status(500).json({ success: false, message: "เกิดข้อผิดพลาดภายในเซิร์ฟเวอร์", error: error.message });
  } finally {
    client.release();
  }
};