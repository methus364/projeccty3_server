const pool = require("../config/db");
const { DEFAULT_KEY_DEPOSIT, DEFAULT_CONTRACT_MONTHS, NOTICE_DAYS } = require("../config/billing_rules");
const { setAuditUser } = require("../utils/audit");

// ==========================================
// Helper: สร้างสัญญาเช่ารายเดือนให้ booking (เรียกจาก checkIn ตอนเช็คอินรายเดือน)
//   db   : client ที่อยู่ใน transaction
//   booking : { booking_id, member_id, room_id, check_in_date, price_monthly, deposit_amount }
//   opts : ค่า override จาก request (endDate?, billingDay?, rentPrepaid?, securityDeposit?, keyDeposit?)
// คืน contract_id ที่สร้าง
// ==========================================
async function createContractForBooking(db, booking, opts = {}) {
    const startDate = booking.check_in_date;

    // วันสิ้นสุดสัญญา default = วันเริ่ม + 12 เดือน (ปรับได้)
    let endDate = opts.endDate;
    if (!endDate) {
        const d = new Date(startDate);
        d.setMonth(d.getMonth() + DEFAULT_CONTRACT_MONTHS);
        endDate = d.toISOString().split("T")[0];
    }

    // มัดจำ 3 ก้อน — ใช้ค่าที่ส่งมา ถ้าไม่ส่งใช้ค่า default
    const rentPrepaid     = opts.rentPrepaid     != null ? Number(opts.rentPrepaid)     : (Number(booking.price_monthly)  || 0);
    const securityDeposit = opts.securityDeposit != null ? Number(opts.securityDeposit) : (Number(booking.deposit_amount) || Number(booking.price_monthly) || 0);
    const keyDeposit      = opts.keyDeposit      != null ? Number(opts.keyDeposit)      : DEFAULT_KEY_DEPOSIT;
    const billingDay      = opts.billingDay      != null ? Number(opts.billingDay)      : 1;

    const res = await db.query(
        `INSERT INTO contracts
            (booking_id, member_id, room_id, start_date, end_date, billing_day,
             rent_prepaid, security_deposit, key_deposit, contract_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'มีผลใช้งาน')
         RETURNING contract_id`,
        [booking.booking_id, booking.member_id, booking.room_id, startDate, endDate, billingDay,
         rentPrepaid, securityDeposit, keyDeposit]
    );
    return res.rows[0].contract_id;
}

// ==========================================
// Helper: โหลดสัญญาแบบเต็ม (+ ผู้เช่า/ห้อง) คืน null ถ้าไม่พบ
// ==========================================
async function loadContract(db, id) {
    const res = await db.query(
        `SELECT c.*, m.full_name AS guest_name, r.room_number
         FROM contracts c
         LEFT JOIN members m ON c.member_id = m.member_id
         LEFT JOIN rooms r   ON c.room_id   = r.room_id
         WHERE c.contract_id = $1`,
        [id]
    );
    return res.rows[0] || null;
}

// ==========================================
// 1. ดูสัญญาทั้งหมด (getContracts) — Admin
//    GET /contracts?status=
// ==========================================
exports.getContracts = async (req, res) => {
    const { status } = req.query;
    try {
        const params = [];
        let where = "";
        if (status) {
            params.push(status);
            where = `WHERE c.contract_status = $1`;
        }
        const result = await pool.query(
            `SELECT c.contract_id, c.booking_id, c.member_id, c.room_id,
                    c.start_date, c.end_date, c.contract_status,
                    c.rent_prepaid, c.security_deposit, c.key_deposit,
                    c.move_out_date, c.refund_amount, c.settled_at,
                    m.full_name AS guest_name, r.room_number
             FROM contracts c
             LEFT JOIN members m ON c.member_id = m.member_id
             LEFT JOIN rooms r   ON c.room_id   = r.room_id
             ${where}
             ORDER BY c.contract_id DESC`,
            params
        );
        res.json({ success: true, count: result.rows.length, data: result.rows });
    } catch (error) {
        console.error("getContracts Error:", error.message);
        res.status(500).json({ success: false, message: "เกิดข้อผิดพลาดในการดึงรายการสัญญา" });
    }
};

// ==========================================
// 2. ดูสัญญาของตัวเอง (getMyContracts) — Tenant
//    GET /my-contracts
// ==========================================
exports.getMyContracts = async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT c.contract_id, c.booking_id, c.room_id,
                    c.start_date, c.end_date, c.contract_status,
                    c.rent_prepaid, c.security_deposit, c.key_deposit,
                    c.notice_date, c.move_out_date, c.refund_amount, c.settled_at,
                    r.room_number
             FROM contracts c
             LEFT JOIN rooms r ON c.room_id = r.room_id
             WHERE c.member_id = $1
             ORDER BY c.contract_id DESC`,
            [req.user.id]
        );
        res.json({ success: true, count: result.rows.length, data: result.rows });
    } catch (error) {
        console.error("getMyContracts Error:", error.message);
        res.status(500).json({ success: false, message: "เกิดข้อผิดพลาดในการดึงสัญญาของคุณ" });
    }
};

// ==========================================
// 3. ดูสัญญารายตัว (getContractById) — Admin หรือเจ้าของสัญญา
//    GET /contract/:id
// ==========================================
exports.getContractById = async (req, res) => {
    const { id } = req.params;
    try {
        const contract = await loadContract(pool, id);
        if (!contract) {
            return res.status(404).json({ success: false, message: "ไม่พบสัญญาที่ระบุ" });
        }
        // Ownership: ผู้เช่าดูได้เฉพาะของตัวเอง
        if (req.user.role !== "Admin" && contract.member_id !== req.user.id) {
            return res.status(403).json({ success: false, message: "ไม่มีสิทธิ์ดูสัญญานี้" });
        }
        res.json({ success: true, data: contract });
    } catch (error) {
        console.error("getContractById Error:", error.message);
        res.status(500).json({ success: false, message: "เกิดข้อผิดพลาดในการดึงสัญญา" });
    }
};

// ==========================================
// 4. แจ้งย้ายออกล่วงหน้า (giveNotice) — Admin หรือเจ้าของสัญญา
//    PUT /contract/:id/notice  body: { notice_date? }  (default = วันนี้)
// ==========================================
exports.giveNotice = async (req, res) => {
    const { id } = req.params;
    const noticeDate = req.body.notice_date || new Date().toISOString().split("T")[0];
    try {
        const contract = await loadContract(pool, id);
        if (!contract) {
            return res.status(404).json({ success: false, message: "ไม่พบสัญญาที่ระบุ" });
        }
        if (req.user.role !== "Admin" && contract.member_id !== req.user.id) {
            return res.status(403).json({ success: false, message: "ไม่มีสิทธิ์แจ้งย้ายออกสัญญานี้" });
        }
        if (contract.settled_at) {
            return res.status(400).json({ success: false, message: "สัญญานี้เคลียร์ปิดไปแล้ว" });
        }
        await pool.query(`UPDATE contracts SET notice_date = $1 WHERE contract_id = $2`, [noticeDate, id]);
        res.json({ success: true, message: "บันทึกการแจ้งย้ายออกแล้ว", data: { notice_date: noticeDate } });
    } catch (error) {
        console.error("giveNotice Error:", error.message);
        res.status(500).json({ success: false, message: "เกิดข้อผิดพลาดในการแจ้งย้ายออก" });
    }
};

// ==========================================
// 5. เคลียร์สัญญา + คืนมัดจำ (settleContract) — Admin
//    POST /contract/:id/settle
//    body: { move_out_date, key_returned?, notice_given?, rent_refund?,
//            damage_cost?, cleaning_cost?, utility_cost?, outstanding_cost? }
//    - คิดเงินคืนสุทธิฝั่ง server เสมอ · กันเคลียร์ซ้ำด้วย FOR UPDATE + settled_at
//    - เคลียร์เสร็จ = เช็คเอาท์ booking + คืนห้องเป็นว่าง ในธุรกรรมเดียว
// ==========================================
exports.settleContract = async (req, res) => {
    const client = await pool.connect();
    const { id } = req.params;
    const b = req.body;

    if (!b.move_out_date) {
        client.release();
        return res.status(400).json({ success: false, message: "กรุณาระบุ move_out_date (วันย้ายออก)" });
    }

    try {
        await client.query("BEGIN");
        await setAuditUser(client, req.user?.id); // M10b: บันทึกผู้ทำลง audit log

        // 1. ล็อกแถวสัญญา (กันเคลียร์ซ้ำตอน admin กดพร้อมกัน)
        const cRes = await client.query(
            `SELECT * FROM contracts WHERE contract_id = $1 FOR UPDATE`,
            [id]
        );
        if (cRes.rows.length === 0) throw new Error("ไม่พบสัญญาที่ระบุ");
        const contract = cRes.rows[0];

        if (contract.settled_at) throw new Error("สัญญานี้เคลียร์คืนมัดจำไปแล้ว");

        // 2. เงื่อนไขหลัก
        const moveOut = new Date(b.move_out_date);
        const endDate = new Date(contract.end_date);
        const securityForfeited = moveOut < endDate; // ออกก่อนครบสัญญา = ริบประกัน

        // แจ้งล่วงหน้าครบ 30 วันไหม — ใช้ค่าที่ส่งมา ถ้าไม่ส่งคำนวณจาก notice_date
        let noticeGiven;
        if (b.notice_given != null) {
            noticeGiven = Boolean(b.notice_given);
        } else if (contract.notice_date) {
            const daysAhead = Math.floor((moveOut - new Date(contract.notice_date)) / 86400000);
            noticeGiven = daysAhead >= NOTICE_DAYS;
        } else {
            noticeGiven = false;
        }

        // 3. ค่าใช้จ่าย (admin กรอก) — คำนวณยอดคืนฝั่ง server
        const num = (v) => Math.max(0, Number(v) || 0);
        const damage      = num(b.damage_cost);
        const cleaning    = num(b.cleaning_cost);
        const utility     = num(b.utility_cost);      // ค่าน้ำ-ไฟค้างรอบสุดท้าย (admin กรอกมือ)
        const outstanding = num(b.outstanding_cost);  // หนี้บิลค้างอื่น
        // คืนค่าเช่าล่วงหน้าส่วนเกิน เฉพาะเมื่อแจ้งล่วงหน้าครบเท่านั้น
        const rentRefund  = noticeGiven ? num(b.rent_refund) : 0;

        const securityBack = securityForfeited ? 0 : Number(contract.security_deposit);
        const keyBack      = b.key_returned ? Number(contract.key_deposit) : 0;

        const refund = rentRefund + securityBack + keyBack - (damage + cleaning + utility + outstanding);
        const refundAmount = Math.round(refund * 100) / 100;

        const newStatus = securityForfeited ? "ยกเลิกสัญญา" : "หมดอายุ";

        // 4. บันทึกผลการเคลียร์ + ปิดสัญญา
        await client.query(
            `UPDATE contracts SET
                contract_status   = $1,
                move_out_date     = $2,
                notice_given      = $3,
                key_returned      = $4,
                security_forfeited = $5,
                rent_refund       = $6,
                damage_cost       = $7,
                cleaning_cost     = $8,
                utility_cost      = $9,
                outstanding_cost  = $10,
                refund_amount     = $11,
                settled_at        = CURRENT_TIMESTAMP,
                settled_by        = $12
             WHERE contract_id = $13`,
            [newStatus, b.move_out_date, noticeGiven, Boolean(b.key_returned), securityForfeited,
             rentRefund, damage, cleaning, utility, outstanding, refundAmount, req.user.id, id]
        );

        // 5. เช็คเอาท์: ปิด booking + คืนห้องเป็นว่าง
        await client.query(
            `UPDATE bookings SET booking_status = 'ย้ายออกแล้ว' WHERE booking_id = $1`,
            [contract.booking_id]
        );
        if (contract.room_id) {
            await client.query(`UPDATE rooms SET room_status = 'ว่าง' WHERE room_id = $1`, [contract.room_id]);
        }

        await client.query("COMMIT");

        const full = await loadContract(pool, id);
        res.json({
            success: true,
            data: full,
            message: `เคลียร์สัญญาสำเร็จ — เงินคืนสุทธิ ${refundAmount.toLocaleString()} บาท`
                + (refundAmount < 0 ? " (ติดลบ = ผู้เช่าต้องจ่ายเพิ่ม)" : ""),
        });

    } catch (error) {
        await client.query("ROLLBACK");
        console.error("settleContract Error:", error.message);
        res.status(400).json({ success: false, message: error.message });
    } finally {
        client.release();
    }
};

// export helper ให้ booking checkIn เรียกใช้สร้างสัญญาได้
exports._createContractForBooking = createContractForBooking;
