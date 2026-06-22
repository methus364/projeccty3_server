const pool = require("../config/db");
const { _createContractForBooking } = require("./contract");

// ==========================================
// 1. สร้างการจองห้องพัก (createBooking) — Tenant
// ==========================================
exports.createBooking = async (req, res) => {
    const client = await pool.connect();
    const { roomId, userId, startDate, endDate, rentType = 'daily' } = req.body;

    try {
        await client.query("BEGIN");

        // 1. ดึงราคาห้องพักจากตาราง rooms (ทั้ง daily และ monthly)
        const priceRes = await client.query(
            `SELECT room_price, price_monthly, room_status FROM rooms WHERE room_id = $1 LIMIT 1`,
            [roomId]
        );

        if (priceRes.rows.length === 0) throw new Error("ไม่พบข้อมูลห้องพักนี้ในระบบ");

        const { room_price, price_monthly, room_status } = priceRes.rows[0];

        if (room_status === 'ปิดปรับปรุง') throw new Error("ห้องพักนี้ปิดปรับปรุงอยู่ ไม่สามารถจองได้");

        // 2. เช็กการจองซ้อน (Overlap Booking Check)
        const overlapRes = await client.query(
            `SELECT booking_id FROM bookings
             WHERE room_id = $1
             AND booking_status NOT IN ('ยกเลิก', 'ย้ายออกแล้ว')
             AND ($2 < check_out_date AND $3 > check_in_date) LIMIT 1`,
            [roomId, startDate, endDate]
        );

        if (overlapRes.rows.length > 0) throw new Error("ห้องนี้ถูกจองหรือมีผู้เช่าพักอยู่แล้วในช่วงเวลาดังกล่าว");

        // 3. คำนวณราคาสุทธิตาม rent_type
        const diffDays = Math.ceil(Math.abs(new Date(endDate) - new Date(startDate)) / 86400000) || 1;
        let totalPrice;
        if (rentType === 'monthly') {
            // รายเดือน: นับเป็นจำนวนเดือน (30 วัน/เดือน)
            const diffMonths = Math.ceil(diffDays / 30) || 1;
            totalPrice = diffMonths * (price_monthly || 0);
        } else {
            // รายวัน: นับเป็นจำนวนวัน
            totalPrice = diffDays * (room_price || 0);
        }

        // 4. บันทึกการจองพร้อม rent_type
        const bookingRes = await client.query(
            `INSERT INTO bookings (member_id, room_id, check_in_date, check_out_date, booking_status, rent_type)
             VALUES ($1, $2, $3, $4, 'รอชำระมัดจำ', $5) RETURNING booking_id`,
            [userId, roomId, startDate, endDate, rentType]
        );

        // 5. อัปเดตสถานะห้องพักเป็น 'มีผู้เช่า'
        await client.query(
            `UPDATE rooms SET room_status = 'มีผู้เช่า' WHERE room_id = $1`,
            [roomId]
        );

        await client.query("COMMIT");
        res.status(201).json({
            success: true,
            bookingId: bookingRes.rows[0].booking_id,
            totalPrice
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
    // Ownership: ผู้เช่าเห็นได้เฉพาะของตัวเอง, Admin ดูของ userId ที่ระบุได้
    const isAdmin = req.user.role === "Admin";
    const userId = isAdmin ? (req.body.userId || req.user.id) : req.user.id;

    if (!userId) {
        return res.status(400).json({
            success: false,
            message: "กรุณาระบุ userId ที่ต้องการตรวจสอบ"
        });
    }

    try {
        const query = `
            SELECT
                b.booking_id     AS "bookingId",
                b.room_id        AS "roomId",
                b.check_in_date  AS "startDate",
                b.check_out_date AS "endDate",
                b.booking_status AS "bookingStatus",
                b.rent_type      AS "rentType",
                r.room_number    AS "roomNumber",
                r.type_name      AS "roomType",
                r.room_price     AS "pricePerDay",
                r.price_monthly  AS "priceMonthly"
            FROM bookings b
            JOIN rooms r ON b.room_id = r.room_id
            WHERE b.member_id = $1
            ORDER BY b.booking_date DESC
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
// 3. ดึงการจองทั้งหมด สำหรับ Admin (getAllBookings)
// ==========================================
exports.getAllBookings = async (req, res) => {
    try {
        const query = `
            SELECT
                b.booking_id     AS "bookingId",
                b.member_id      AS "memberId",
                b.room_id        AS "roomId",
                b.booking_date   AS "bookingDate",
                b.check_in_date  AS "checkInDate",
                b.check_out_date AS "checkOutDate",
                b.booking_status AS "bookingStatus",
                b.rent_type      AS "rentType",
                r.room_number    AS "roomNumber",
                r.type_name      AS "typeName",
                r.room_price     AS "pricePerDay",
                r.price_monthly  AS "priceMonthly",
                m.full_name      AS "guestName",
                m.username       AS "username"
            FROM bookings b
            JOIN rooms r ON b.room_id = r.room_id
            LEFT JOIN members m ON b.member_id = m.member_id
            ORDER BY b.booking_date DESC
        `;
        const result = await pool.query(query);
        res.status(200).json({ success: true, count: result.rows.length, data: result.rows });
    } catch (error) {
        console.error("getAllBookings Error:", error);
        res.status(500).json({ success: false, message: "Server Error", error: error.message });
    }
};

// ==========================================
// 4. Admin สร้างการจองแทนลูกค้า (adminCreateBooking)
// ==========================================
exports.adminCreateBooking = async (req, res) => {
    const client = await pool.connect();
    const { roomId, userId, startDate, endDate, rentType = 'daily' } = req.body;

    try {
        await client.query("BEGIN");

        const priceRes = await client.query(
            `SELECT room_price, price_monthly, room_status FROM rooms WHERE room_id = $1 LIMIT 1`,
            [roomId]
        );
        if (priceRes.rows.length === 0) throw new Error("ไม่พบข้อมูลห้องพักนี้ในระบบ");

        const { room_price, price_monthly, room_status } = priceRes.rows[0];
        if (room_status === 'ปิดปรับปรุง') throw new Error("ห้องพักนี้ปิดปรับปรุงอยู่ ไม่สามารถจองได้");

        const overlapRes = await client.query(
            `SELECT booking_id FROM bookings
             WHERE room_id = $1
             AND booking_status NOT IN ('ยกเลิก', 'ย้ายออกแล้ว')
             AND ($2 < check_out_date AND $3 > check_in_date) LIMIT 1`,
            [roomId, startDate, endDate]
        );
        if (overlapRes.rows.length > 0) throw new Error("ห้องนี้ถูกจองหรือมีผู้เช่าพักอยู่แล้วในช่วงเวลาดังกล่าว");

        const diffDays = Math.ceil(Math.abs(new Date(endDate) - new Date(startDate)) / 86400000) || 1;
        let totalPrice;
        if (rentType === 'monthly') {
            const diffMonths = Math.ceil(diffDays / 30) || 1;
            totalPrice = diffMonths * (price_monthly || 0);
        } else {
            totalPrice = diffDays * (room_price || 0);
        }

        const bookingRes = await client.query(
            `INSERT INTO bookings (member_id, room_id, check_in_date, check_out_date, booking_status, rent_type)
             VALUES ($1, $2, $3, $4, 'รอชำระมัดจำ', $5) RETURNING booking_id`,
            [userId, roomId, startDate, endDate, rentType]
        );

        await client.query(`UPDATE rooms SET room_status = 'มีผู้เช่า' WHERE room_id = $1`, [roomId]);
        await client.query("COMMIT");

        res.status(201).json({ success: true, bookingId: bookingRes.rows[0].booking_id, totalPrice });
    } catch (error) {
        await client.query("ROLLBACK");
        res.status(400).json({ success: false, message: error.message });
    } finally {
        client.release();
    }
};

// ==========================================
// 5. แก้ไขข้อมูลการจอง (editBooking)
// ==========================================
exports.editBooking = async (req, res) => {
    const client = await pool.connect();
    const { id } = req.params;
    const { startDate, endDate, status, roomId, userId } = req.body;

    try {
        await client.query("BEGIN");

        // 1. ดึงข้อมูลการจองปัจจุบัน
        const currentRes = await client.query('SELECT * FROM bookings WHERE booking_id = $1', [id]);
        if (currentRes.rows.length === 0) {
            await client.query("ROLLBACK");
            return res.status(404).json({ success: false, message: "ไม่พบข้อมูลการจองที่ระบุ" });
        }
        const current = currentRes.rows[0];

        // Ownership: ผู้เช่าแก้ได้เฉพาะของตัวเอง, Admin แก้ได้ทั้งหมด
        if (req.user.role !== "Admin" && current.member_id !== req.user.id) {
            await client.query("ROLLBACK");
            return res.status(403).json({ success: false, message: "ไม่มีสิทธิ์แก้ไขการจองนี้" });
        }

        const targetRoomId = roomId  || current.room_id;
        const targetStart  = startDate || current.check_in_date;
        const targetEnd    = endDate   || current.check_out_date;

        // 2. ตรวจสอบ overlap กรณีขยับวันหรือเปลี่ยนห้อง
        if (startDate || endDate || roomId) {
            const overlapCheck = await client.query(
                `SELECT booking_id FROM bookings
                 WHERE room_id = $1
                 AND booking_id != $2
                 AND booking_status NOT IN ('ยกเลิก', 'ย้ายออกแล้ว')
                 AND (check_in_date < $4 AND check_out_date > $3)`,
                [targetRoomId, id, targetStart, targetEnd]
            );

            if (overlapCheck.rows.length > 0) {
                await client.query("ROLLBACK");
                return res.status(400).json({
                    success: false,
                    message: "ไม่สามารถเปลี่ยนวันหรือห้องได้ เนื่องจากมีบุ๊คกิ้งอื่นจองไว้แล้ว"
                });
            }
        }

        // 3. คำนวณราคาใหม่ตาม rent_type ของการจอง
        const rentType = current.rent_type || 'daily';
        const roomRes = await client.query(
            'SELECT room_price, price_monthly FROM rooms WHERE room_id = $1',
            [targetRoomId]
        );
        const roomData = roomRes.rows[0];
        const diffDays = Math.ceil(Math.abs(new Date(targetEnd) - new Date(targetStart)) / 86400000) || 1;
        let newTotalPrice;
        if (rentType === 'monthly') {
            const diffMonths = Math.ceil(diffDays / 30) || 1;
            newTotalPrice = diffMonths * (roomData.price_monthly || 0);
        } else {
            newTotalPrice = diffDays * (roomData.room_price || 0);
        }

        // 4. Update ข้อมูลการจอง
        await client.query(
            `UPDATE bookings SET
                room_id        = $1,
                member_id      = $2,
                check_in_date  = $3,
                check_out_date = $4,
                booking_status = $5
             WHERE booking_id = $6`,
            [targetRoomId, userId || current.member_id, targetStart, targetEnd, status || current.booking_status, id]
        );

        // 5. sync room_status ตาม booking_status ที่เปลี่ยน
        const finalStatus = status || current.booking_status;
        if (finalStatus === 'ยกเลิก' || finalStatus === 'ย้ายออกแล้ว') {
            await client.query(`UPDATE rooms SET room_status = 'ว่าง' WHERE room_id = $1`, [targetRoomId]);
        } else if (finalStatus === 'กำลังเข้าพัก' || finalStatus === 'ยืนยันการจอง') {
            await client.query(`UPDATE rooms SET room_status = 'มีผู้เช่า' WHERE room_id = $1`, [targetRoomId]);
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

// ==========================================
// 6. เช็คอิน (checkIn) — Admin only
// ==========================================
exports.checkIn = async (req, res) => {
    const client = await pool.connect();
    const { id } = req.params;

    try {
        await client.query("BEGIN");

        // ดึงข้อมูลการจอง + ราคารายเดือน/ค่ามัดจำของห้อง
        const bookingRes = await client.query(
            `SELECT b.booking_id, b.member_id, b.room_id, b.check_in_date, b.booking_status, b.rent_type,
                    r.price_monthly, r.deposit_amount
             FROM bookings b
             JOIN rooms r ON b.room_id = r.room_id
             WHERE b.booking_id = $1`,
            [id]
        );

        if (bookingRes.rows.length === 0) throw new Error("ไม่พบข้อมูลการจองที่ระบุ");

        const booking = bookingRes.rows[0];

        if (booking.booking_status === 'กำลังเข้าพัก') throw new Error("เช็คอินไปแล้ว");
        if (booking.booking_status === 'ยกเลิก' || booking.booking_status === 'ย้ายออกแล้ว') {
            throw new Error("การจองนี้ถูกยกเลิกหรือเช็คเอาท์แล้ว ไม่สามารถเช็คอินได้");
        }

        // เปลี่ยนสถานะการจองเป็น 'กำลังเข้าพัก'
        await client.query(
            `UPDATE bookings SET booking_status = 'กำลังเข้าพัก' WHERE booking_id = $1`,
            [id]
        );

        // sync สถานะห้องเป็น 'มีผู้เช่า'
        await client.query(
            `UPDATE rooms SET room_status = 'มีผู้เช่า' WHERE room_id = $1`,
            [booking.room_id]
        );

        // สำหรับผู้เช่ารายเดือน: สร้างสัญญา + เก็บมัดจำ 3 ก้อน
        // (ค่าเช่าเดือนแรกเป็น prepaid ครอบ 30 วันแรก จึงยังไม่ออกบิลตอนนี้
        //  บิลใบแรกออกวันที่ 1 ของเดือนถัดไปผ่าน M6 โดยคิดเฉพาะวันที่เกิน prepaid)
        let contractId = null;
        if (booking.rent_type === 'monthly') {
            // รับค่า override สัญญาจาก request ได้ (ไม่ส่ง = ใช้ค่า default)
            const { endDate, billingDay, rentPrepaid, securityDeposit, keyDeposit } = req.body || {};
            contractId = await _createContractForBooking(client, booking, {
                endDate, billingDay, rentPrepaid, securityDeposit, keyDeposit,
            });
        }

        await client.query("COMMIT");
        res.status(200).json({
            success: true,
            message: booking.rent_type === 'monthly' ? "เช็คอินสำเร็จ + สร้างสัญญาแล้ว" : "เช็คอินสำเร็จ",
            contractId,
        });

    } catch (error) {
        await client.query("ROLLBACK");
        console.error("checkIn Error:", error.message);
        res.status(400).json({ success: false, message: error.message });
    } finally {
        client.release();
    }
};

// ==========================================
// 7. เช็คเอาท์ (checkOut) — Admin only
// ==========================================
exports.checkOut = async (req, res) => {
    const client = await pool.connect();
    const { id } = req.params;

    try {
        await client.query("BEGIN");

        const bookingRes = await client.query(
            `SELECT room_id, booking_status FROM bookings WHERE booking_id = $1`,
            [id]
        );

        if (bookingRes.rows.length === 0) throw new Error("ไม่พบข้อมูลการจองที่ระบุ");

        const booking = bookingRes.rows[0];

        if (booking.booking_status === 'ย้ายออกแล้ว') throw new Error("เช็คเอาท์ไปแล้ว");
        if (booking.booking_status === 'ยกเลิก') throw new Error("การจองนี้ถูกยกเลิกแล้ว");

        // เปลี่ยนสถานะการจองเป็น 'ย้ายออกแล้ว'
        await client.query(
            `UPDATE bookings SET booking_status = 'ย้ายออกแล้ว' WHERE booking_id = $1`,
            [id]
        );

        // คืนห้องเป็น 'ว่าง'
        await client.query(
            `UPDATE rooms SET room_status = 'ว่าง' WHERE room_id = $1`,
            [booking.room_id]
        );

        await client.query("COMMIT");
        res.status(200).json({ success: true, message: "เช็คเอาท์สำเร็จ" });

    } catch (error) {
        await client.query("ROLLBACK");
        console.error("checkOut Error:", error.message);
        res.status(400).json({ success: false, message: error.message });
    } finally {
        client.release();
    }
};
