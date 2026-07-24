const pool = require("../config/db");
const { _createContractForBooking } = require("./contract");
const { setAuditUser } = require("../utils/audit");
const { sendMail } = require("../config/mailer");
const { uploadFile } = require("../config/supabase");
const { buildPagination } = require("../utils/pagination");
const bcrypt = require("bcryptjs");

// สร้างเลขอ้างอิงการจองให้อ่านง่าย เช่น BK-2026-0042
function formatBookingRef(bookingId) {
    const year = new Date().getFullYear();
    const idPart = String(bookingId).padStart(4, "0");
    return `BK-${year}-${idPart}`;
}

// ส่งอีเมลยืนยันการจอง — แยกเป็นฟังก์ชันเพื่ออ่านง่าย
// ใช้รูปแบบ degrade graceful เหมือน M6: ถ้าส่งไม่สำเร็จ การจองยังถือว่าสำเร็จ
async function sendBookingConfirmation({ email, fullName, bookingRef, roomNumber, checkIn, checkOut, nights, totalPrice, rentType }) {
    // ไม่มีอีเมลผู้เช่า → ข้ามการส่ง (ไม่ถือเป็น error)
    if (!email) return { sent: false, reason: "ไม่มีอีเมลผู้เช่า" };

    const rentLabel = rentType === "monthly" ? "รายเดือน" : "รายวัน";
    const text =
`เรียน คุณ${fullName || ""}

การจองห้องพักของคุณสำเร็จแล้ว รายละเอียดดังนี้

เลขที่การจอง : ${bookingRef}
ห้องพัก      : ${roomNumber}
ประเภท       : ${rentLabel}
วันเข้าพัก   : ${checkIn}
วันออก       : ${checkOut}
จำนวน        : ${nights} วัน
ยอดรวมโดยประมาณ : ${Number(totalPrice).toLocaleString()} บาท

สถานะปัจจุบัน: รอชำระมัดจำ
กรุณาติดต่อเจ้าหน้าที่เพื่อชำระมัดจำและยืนยันการเข้าพัก

ขอบคุณที่ใช้บริการ
หอพัก Around Loei`;

    try {
        await sendMail({
            to: email,
            subject: `ยืนยันการจอง ${bookingRef} - หอพัก Around Loei`,
            text,
        });
        return { sent: true };
    } catch (err) {
        // ส่งอีเมลล้มเหลวไม่ควรทำให้การจองล้มเหลว — แค่ log ไว้
        console.error("Booking Mail Error:", err.message);
        return { sent: false, reason: err.message };
    }
}

// ผู้เช่ารายเดือน 1 คน ถือครองห้องได้แค่ 1 ห้อง ณ เวลาหนึ่ง
// เช็คว่า member นี้มีการจองรายเดือนที่ยัง active (ไม่ใช่ยกเลิก/ย้ายออกแล้ว) ค้างอยู่หรือไม่
async function hasActiveMonthlyBooking(client, memberId) {
    // ล็อกแถวสมาชิกไว้ก่อน กันสอง request จองห้องรายเดือนพร้อมกันหลุดผ่านเช็คทั้งคู่
    await client.query(`SELECT member_id FROM members WHERE member_id = $1 FOR UPDATE`, [memberId]);
    const res = await client.query(
        `SELECT booking_id FROM bookings
         WHERE member_id = $1 AND rent_type = 'monthly'
         AND booking_status NOT IN ('ยกเลิก', 'ย้ายออกแล้ว') LIMIT 1`,
        [memberId]
    );
    return res.rows.length > 0;
}

// เช็ค role ของสมาชิกสดจาก DB แทนการเชื่อ role ใน JWT ตอน login
// (role อาจถูกเลื่อนอัตโนมัติหลัง login แล้ว เช่นตอนเช็คอินรายเดือน — ดู checkIn ด้านล่าง)
async function getFreshUserRole(client, memberId) {
    const res = await client.query(
        `SELECT user_role FROM members WHERE member_id = $1 LIMIT 1`,
        [memberId]
    );
    return res.rows[0]?.user_role || null;
}

// ==========================================
// 1. สร้างการจองห้องพัก (createBooking) — Tenant
// ==========================================
exports.createBooking = async (req, res) => {
    const client = await pool.connect();
    const { roomId, startDate, endDate, rentType = 'daily' } = req.body;
    // บังคับใช้ userId จาก token เสมอ — กันผู้เช่าจองในชื่อคนอื่น
    const userId = req.user.id;

    try {
        await client.query("BEGIN");
        await setAuditUser(client, req.user?.id); // M10b: บันทึกผู้ทำลง audit log

        // กันข้าม role: รายวันจองได้แค่รายวัน, รายเดือนจองได้แค่รายเดือน
        // เช็คสดจาก DB (ไม่ใช้ req.user.role จาก JWT) เพราะ role อาจถูกเลื่อนเป็น
        // Monthly_Tenant อัตโนมัติหลัง login แล้ว (ตอนเช็คอินรายเดือน) โดยไม่มีการออก token ใหม่
        const freshRole = await getFreshUserRole(client, userId);
        if (freshRole === "Daily_Tenant" && rentType !== "daily") {
            throw new Error("ผู้เช่ารายวันจองห้องแบบรายเดือนไม่ได้");
        }
        if (freshRole === "Monthly_Tenant" && rentType !== "monthly") {
            throw new Error("ผู้เช่ารายเดือนจองห้องแบบรายวันไม่ได้");
        }

        // 1. ดึงราคาห้องพักจากตาราง rooms (ทั้ง daily และ monthly)
        // ล็อกแถวห้องไว้ก่อน (FOR UPDATE) กันสองคนจองห้อง/ช่วงเวลาเดียวกันพร้อมกันแล้วผ่าน overlap check ทั้งคู่
        const priceRes = await client.query(
            `SELECT room_price, price_monthly, room_status, room_number FROM rooms WHERE room_id = $1 LIMIT 1 FOR UPDATE`,
            [roomId]
        );

        if (priceRes.rows.length === 0) throw new Error("ไม่พบข้อมูลห้องพักนี้ในระบบ");

        const { room_number, room_price, price_monthly, room_status } = priceRes.rows[0];

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

        // 2.5 รายเดือน: 1 คนถือครองได้แค่ 1 ห้อง — ห้ามจองซ้อนห้องอื่นถ้ายังมีรายการ active อยู่
        if (rentType === 'monthly' && await hasActiveMonthlyBooking(client, userId)) {
            throw new Error("คุณมีห้องพักรายเดือนที่กำลังเช่าหรือจองอยู่แล้ว ไม่สามารถจองห้องเพิ่มได้");
        }

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

        // 4. บันทึกการจองพร้อม rent_type + ล็อกห้องชั่วคราว 5 นาที (hold_expires_at)
        //    ถ้าไม่มีสลิปส่งเข้ามาภายใน 5 นาที cron จะยกเลิกให้อัตโนมัติ (USER_FLOWS)
        const bookingRes = await client.query(
            `INSERT INTO bookings (member_id, room_id, check_in_date, check_out_date, booking_status, rent_type, hold_expires_at)
             VALUES ($1, $2, $3, $4, 'รอชำระมัดจำ', $5, NOW() + interval '5 minutes') RETURNING booking_id, hold_expires_at`,
            [userId, roomId, startDate, endDate, rentType]
        );

        // 5. อัปเดตสถานะห้องพักเป็น 'มีผู้เช่า'
        await client.query(
            `UPDATE rooms SET room_status = 'มีผู้เช่า' WHERE room_id = $1`,
            [roomId]
        );

        await client.query("COMMIT");

        const bookingId = bookingRes.rows[0].booking_id;
        // คำนวณเวลาหมดอายุ hold ใน JS (เวลาปัจจุบัน + 5 นาที) เป็น ISO UTC ตรงๆ
        // ไม่อ่านค่า timestamp จาก DB กลับมา เพราะคอลัมน์เป็น timestamp without time zone
        // ทำให้ node-pg ตีความเป็นเวลาท้องถิ่น (เลื่อน TZ) → countdown ฝั่ง frontend เพี้ยนเป็นหมดเวลาทันที
        const holdExpiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
        const bookingRef = formatBookingRef(bookingId);

        // ส่งอีเมลยืนยันการจอง (หลัง COMMIT — ทำนอก transaction)
        // ดึงอีเมล/ชื่อผู้เช่าจากตาราง members
        const memberRes = await pool.query(
            `SELECT email, full_name FROM members WHERE member_id = $1 LIMIT 1`,
            [userId]
        );
        const member = memberRes.rows[0] || {};

        // รอส่งอีเมลให้เสร็จก่อนตอบหน้าจอ — การันตีว่าเมลถูกส่งจริง
        // (เคยลองทำแบบ fire-and-forget ให้หน้าจอเร็วขึ้น แต่บน Render free instance ถูกพัก
        //  หลังตอบ response ทำให้งานส่งเมลเบื้องหลังไม่ถูกทำจริง — เมลไม่มา จึงต้อง await เหมือนเดิม)
        const mailResult = await sendBookingConfirmation({
            email: member.email,
            fullName: member.full_name,
            bookingRef,
            roomNumber: room_number,
            checkIn: startDate,
            checkOut: endDate,
            nights: diffDays,
            totalPrice,
            rentType,
        });

        res.status(201).json({
            success: true,
            bookingId,
            bookingRef,
            roomNumber: room_number,
            checkInDate: startDate,
            checkOutDate: endDate,
            nights: diffDays,
            rentType,
            totalPrice,
            holdExpiresAt,
            emailSent: mailResult.sent,
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
              -- ไม่โชว์รายการที่ยังไม่ชำระ (รอชำระมัดจำ) หรือถูกยกเลิก — ประวัติมีเฉพาะการจองที่ชำระแล้ว/ใช้งานจริง
              AND b.booking_status NOT IN ('รอชำระมัดจำ', 'ยกเลิก')
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
// 2.5 ดึงบิล/การชำระของการจองหนึ่งใบ (getBookingInvoices)
//     GET /booking/:id/invoices — ผู้เช่าดูของตัวเอง, Admin ดูได้หมด
//     ให้ Roomhistory แสดง+เปิด PDF/จ่ายเงินได้ในหน้าเดียว
// ==========================================
exports.getBookingInvoices = async (req, res) => {
    const { id } = req.params;
    try {
        // ownership: ผู้เช่าดูได้เฉพาะ booking ของตัวเอง
        const bkRes = await pool.query(`SELECT member_id FROM bookings WHERE booking_id = $1`, [id]);
        if (bkRes.rows.length === 0) {
            return res.status(404).json({ success: false, message: "ไม่พบการจองที่ระบุ" });
        }
        if (req.user.role !== "Admin" && bkRes.rows[0].member_id !== req.user.id) {
            return res.status(403).json({ success: false, message: "ไม่มีสิทธิ์ดูบิลของการจองนี้" });
        }

        // บิลของ booking นี้ + ยอดที่ชำระยืนยันแล้ว (คำนวณคงเหลือ)
        const result = await pool.query(
            `SELECT i.invoice_id, i.invoice_date, i.due_date, i.total_amount, i.invoice_status,
                    COALESCE(p.paid, 0) AS paid_amount
             FROM invoices i
             LEFT JOIN (
                 SELECT invoice_id, SUM(amount_paid) AS paid
                 FROM payments WHERE payment_status = 'ยืนยันแล้ว'
                 GROUP BY invoice_id
             ) p ON p.invoice_id = i.invoice_id
             WHERE i.booking_id = $1
             ORDER BY i.invoice_date DESC, i.invoice_id DESC`,
            [id]
        );
        res.json({ success: true, count: result.rows.length, data: result.rows });
    } catch (error) {
        console.error("getBookingInvoices Error:", error.message);
        res.status(500).json({ success: false, message: "เกิดข้อผิดพลาดในการดึงบิลของการจอง" });
    }
};

// ==========================================
// 3. ดึงการจองทั้งหมด สำหรับ Admin (getAllBookings)
// ==========================================
exports.getAllBookings = async (req, res) => {
    try {
        // filter ตามประเภทเช่า (รายวัน/รายเดือน) สำหรับหน้าจัดการที่แยกกัน
        const { rentType } = req.query;
        const params = [];
        let rentFilter = "";
        if (rentType === "daily" || rentType === "monthly") {
            params.push(rentType);
            rentFilter = `WHERE b.rent_type = $1`;
        }

        // แบ่งหน้า (ถ้า client ส่ง ?limit มา) — ไม่ส่งมา = คืนทั้งหมดเหมือนเดิม
        const page = buildPagination(req.query);
        let limitClause = "";
        if (page) {
            params.push(page.limit, page.offset);
            limitClause = `LIMIT $${params.length - 1} OFFSET $${params.length}`;
        }

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
                m.username       AS "username",
                m.phone_number   AS "guestPhone",
                m.email          AS "guestEmail",
                pp.payment_id    AS "latestPaymentId",
                pp.payment_evidence AS "latestSlipUrl",
                pp.amount_paid   AS "latestAmount",
                pp.payment_method AS "latestMethod",
                pp.payment_status AS "latestPaymentStatus",
                (pp.payment_status = 'รอตรวจ') AS "hasPendingSlip"
            FROM bookings b
            JOIN rooms r ON b.room_id = r.room_id
            LEFT JOIN members m ON b.member_id = m.member_id
            LEFT JOIN LATERAL (
                -- การชำระล่าสุดของการจองนี้ ไม่ว่าจะตรวจแล้วหรือรอตรวจ (ผูกผ่านบิล)
                SELECT p.payment_id, p.payment_evidence, p.amount_paid, p.payment_method, p.payment_status
                FROM payments p
                JOIN invoices i ON p.invoice_id = i.invoice_id
                WHERE i.booking_id = b.booking_id
                ORDER BY p.payment_date DESC
                LIMIT 1
            ) pp ON true
            ${rentFilter}
            ORDER BY b.booking_date DESC
            ${limitClause}
        `;
        const result = await pool.query(query, params);
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
        await setAuditUser(client, req.user?.id); // M10b: บันทึกผู้ทำลง audit log

        // ล็อกแถวห้องไว้ก่อน (FOR UPDATE) กันจองซ้ำเวลามีสอง request พร้อมกัน
        const priceRes = await client.query(
            `SELECT room_price, price_monthly, room_status FROM rooms WHERE room_id = $1 LIMIT 1 FOR UPDATE`,
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

        if (rentType === 'monthly' && await hasActiveMonthlyBooking(client, userId)) {
            throw new Error("ผู้เช่าคนนี้มีห้องพักรายเดือนที่กำลังเช่าหรือจองอยู่แล้ว ไม่สามารถจองห้องเพิ่มได้");
        }

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
        await setAuditUser(client, req.user?.id); // M10b: บันทึกผู้ทำลง audit log

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

        // ถ้าไม่ใช่ Admin: ผู้เช่าแก้ได้เฉพาะ "วันเข้าพัก/วันออก" หรือ "ยกเลิก" และเฉพาะก่อนเช็คอิน
        if (req.user.role !== "Admin") {
            // ห้ามเปลี่ยนห้อง/เจ้าของการจอง (สิทธิ์ Admin เท่านั้น)
            if (roomId || userId) {
                await client.query("ROLLBACK");
                return res.status(403).json({ success: false, message: "ผู้เช่าเปลี่ยนห้อง/เจ้าของการจองไม่ได้" });
            }
            // ถ้าส่ง status มา ต้องเป็น 'ยกเลิก' เท่านั้น (เปลี่ยนสถานะอื่นไม่ได้)
            if (status && status !== "ยกเลิก") {
                await client.query("ROLLBACK");
                return res.status(403).json({ success: false, message: 'ผู้เช่าเปลี่ยนสถานะได้เฉพาะ "ยกเลิก" เท่านั้น' });
            }
            // แก้วันที่/ยกเลิก ได้เฉพาะก่อนเช็คอิน (สถานะรอ/ยืนยันแล้ว)
            const editableStatuses = ['รอชำระมัดจำ', 'ยืนยันการจอง'];
            if (!editableStatuses.includes(current.booking_status)) {
                await client.query("ROLLBACK");
                return res.status(400).json({
                    success: false,
                    message: `ไม่สามารถแก้ไข/ยกเลิกได้ สถานะปัจจุบันคือ "${current.booking_status}"`
                });
            }
        }

        const targetRoomId = roomId  || current.room_id;
        const targetStart  = startDate || current.check_in_date;
        const targetEnd    = endDate   || current.check_out_date;

        // 2. ตรวจสอบ overlap กรณีขยับวันหรือเปลี่ยนห้อง
        if (startDate || endDate || roomId) {
            // ล็อกแถวห้องเป้าหมายไว้ก่อน (FOR UPDATE) กันสอง request แก้ booking ชนกันเข้าห้องเดียวกัน
            await client.query('SELECT room_id FROM rooms WHERE room_id = $1 FOR UPDATE', [targetRoomId]);

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
        await setAuditUser(client, req.user?.id); // M10b: บันทึกผู้ทำลง audit log

        // ดึงข้อมูลการจอง + ราคารายเดือนของห้อง (ไม่ใช้ deposit_amount แล้ว USER_FLOWS)
        const bookingRes = await client.query(
            `SELECT b.booking_id, b.member_id, b.room_id, b.check_in_date, b.booking_status, b.rent_type,
                    r.price_monthly
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

        // ไฟล์แนบ (multer.fields) — แต่ละ field เป็น array
        const files = req.files || {};

        let contractId = null;
        if (booking.rent_type === 'monthly') {
            // ===== เช็คอินรายเดือน: สร้างสัญญา + เก็บมัดจำ 3 ก้อน (Admin กรอกฟอร์ม) =====
            const { startDate, endDate, contractMonths, billingDay, rentPrepaid, securityDeposit, keyDeposit } = req.body || {};

            // ถ้าส่งจำนวนเดือนมา ให้คำนวณ end_date จากวันเข้าพัก
            let computedEndDate = endDate;
            const baseStart = startDate || booking.check_in_date;
            if (!computedEndDate && contractMonths) {
                const d = new Date(baseStart);
                d.setMonth(d.getMonth() + Number(contractMonths));
                computedEndDate = d.toISOString().split("T")[0];
            }

            // อัปโหลดไฟล์รูปสัญญา (ถ้าแนบมา)
            let contractFileUrl = null;
            if (files.contract_file && files.contract_file[0]) {
                const f = files.contract_file[0];
                contractFileUrl = await uploadFile(f.buffer, f.originalname, f.mimetype, "contract");
            }

            // ถ้า Admin แก้วันเข้าพักตอนทำสัญญา → อัปเดต booking ด้วย
            if (startDate) {
                await client.query(`UPDATE bookings SET check_in_date = $1 WHERE booking_id = $2`, [startDate, id]);
                booking.check_in_date = startDate;
            }

            contractId = await _createContractForBooking(client, booking, {
                endDate: computedEndDate, billingDay, rentPrepaid, securityDeposit, keyDeposit, contractFileUrl,
            });

            // เลื่อน role เป็น Monthly_Tenant อัตโนมัติในทรานแซคชันเดียวกัน (⚠️1)
            if (booking.member_id) {
                await client.query(
                    `UPDATE members SET user_role = 'Monthly_Tenant' WHERE member_id = $1`,
                    [booking.member_id]
                );
            }
        } else {
            // ===== เช็คอินรายวัน: บังคับแนบสำเนาบัตร + (walk-in จ่ายสด) รูปเงินสด =====
            if (!files.id_card || !files.id_card[0]) {
                throw new Error("กรุณาแนบสำเนาบัตรประชาชน/บัตรนักศึกษาก่อนเช็คอิน");
            }
            const idFile = files.id_card[0];
            const idCardUrl = await uploadFile(idFile.buffer, idFile.originalname, idFile.mimetype, "idcard");

            // รูปเงินสด — เฉพาะ walk-in จ่ายสด (ไม่บังคับ)
            let cashPhotoUrl = null;
            if (files.cash_photo && files.cash_photo[0]) {
                const cf = files.cash_photo[0];
                cashPhotoUrl = await uploadFile(cf.buffer, cf.originalname, cf.mimetype, "cash");
            }

            await client.query(
                `UPDATE bookings SET id_card_image_url = $1, cash_photo_url = $2 WHERE booking_id = $3`,
                [idCardUrl, cashPhotoUrl, id]
            );
        }

        // เปลี่ยนสถานะการจองเป็น 'กำลังเข้าพัก' + sync ห้องเป็น 'มีผู้เช่า'
        await client.query(`UPDATE bookings SET booking_status = 'กำลังเข้าพัก' WHERE booking_id = $1`, [id]);
        await client.query(`UPDATE rooms SET room_status = 'มีผู้เช่า' WHERE room_id = $1`, [booking.room_id]);

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
        await setAuditUser(client, req.user?.id); // M10b: บันทึกผู้ทำลง audit log

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

// ==========================================
// 8. สร้าง/หาสมาชิกแบบเร็วสำหรับ walk-in (quickMember) — Admin
//    POST /admin/quick-member  body: { full_name, phone_number }
//    username=เบอร์, password=เบอร์(bcrypt), email=NULL, role=Daily_Tenant
//    เบอร์ซ้ำ = ใช้บัญชีเดิม
// ==========================================
exports.quickMember = async (req, res) => {
    const { full_name, phone_number } = req.body;
    if (!full_name || !phone_number) {
        return res.status(400).json({ success: false, message: "กรุณาระบุชื่อ-นามสกุลและเบอร์โทร" });
    }
    try {
        // เบอร์ตรงกับสมาชิกเดิม (username ซ้ำ) → ใช้บัญชีเดิม
        const existing = await pool.query(`SELECT member_id FROM members WHERE username = $1 LIMIT 1`, [phone_number]);
        if (existing.rows.length > 0) {
            return res.json({ success: true, memberId: existing.rows[0].member_id, existed: true, message: "ใช้บัญชีเดิมที่มีเบอร์นี้อยู่แล้ว" });
        }

        // สร้างสมาชิกใหม่: password = เบอร์โทร (hash), email = NULL (กันระบบส่งอีเมลไปเบอร์)
        const hash = await bcrypt.hash(phone_number, 10);
        const ins = await pool.query(
            `INSERT INTO members (username, password, full_name, phone_number, user_role)
             VALUES ($1, $2, $3, $4, 'Daily_Tenant') RETURNING member_id`,
            [phone_number, hash, full_name, phone_number]
        );
        res.status(201).json({ success: true, memberId: ins.rows[0].member_id, existed: false, message: "สร้างบัญชีสมาชิกใหม่แล้ว" });
    } catch (error) {
        console.error("quickMember Error:", error.message);
        res.status(400).json({ success: false, message: error.message });
    }
};

// ==========================================
// 9. เช็คห้องว่าง ณ วันที่ที่เลือก (getAvailability) — Admin (สำหรับผังชั้นรายเดือน)
//    GET /rooms/availability?date=YYYY-MM-DD
//    คืนห้องทั้งหมด + available (ว่าง ณ วันนั้น กดจองได้ = true)
// ==========================================
exports.getAvailability = async (req, res) => {
    const { date } = req.query;
    if (!date) {
        return res.status(400).json({ success: false, message: "กรุณาระบุวันที่ (date)" });
    }
    try {
        const result = await pool.query(
            `SELECT r.room_id, r.room_number, r.type_name, r.room_price, r.price_monthly, r.room_status, r.image_url,
                    -- ว่างกดจองได้ = สถานะห้องต้องเป็น 'ว่าง' (มีผู้เช่า/ปิดปรับปรุง → แดง) และไม่มีการจองคาบเกี่ยววันนั้น
                    (r.room_status = 'ว่าง' AND NOT EXISTS (
                        SELECT 1 FROM bookings b
                        WHERE b.room_id = r.room_id
                          AND b.booking_status NOT IN ('ยกเลิก', 'ย้ายออกแล้ว')
                          AND b.check_in_date <= $1 AND b.check_out_date > $1
                    )) AS available
             FROM rooms r
             ORDER BY r.room_number`,
            [date]
        );
        res.json({ success: true, count: result.rows.length, data: result.rows });
    } catch (error) {
        console.error("getAvailability Error:", error.message);
        res.status(500).json({ success: false, message: "เกิดข้อผิดพลาดในการเช็คห้องว่าง" });
    }
};
