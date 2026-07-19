const pool = require("../config/db");
const { DEFAULT_KEY_DEPOSIT, DEFAULT_CONTRACT_MONTHS, NOTICE_DAYS } = require("../config/billing_rules");
const { setAuditUser } = require("../utils/audit");
const { uploadFile } = require("../config/supabase");

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

    // มัดจำ 3 ก้อน — Admin กรอกเองทุกครั้งตอนเช็คอิน (ตัด fallback deposit_amount ออกแล้ว USER_FLOWS)
    // ค่าเช่าล่วงหน้ายังคง default เป็น price_monthly ถ้าไม่ส่ง · ประกัน/กุญแจเริ่มว่าง (0) ถ้าไม่ส่ง
    const rentPrepaid     = opts.rentPrepaid     != null ? Number(opts.rentPrepaid)     : (Number(booking.price_monthly) || 0);
    const securityDeposit = opts.securityDeposit != null ? Number(opts.securityDeposit) : 0;
    const keyDeposit      = opts.keyDeposit      != null ? Number(opts.keyDeposit)      : DEFAULT_KEY_DEPOSIT;
    const billingDay      = opts.billingDay      != null ? Number(opts.billingDay)      : 1;
    const contractFileUrl = opts.contractFileUrl || null;

    // ค่าเช่า/เดือนล็อกไว้ตอนทำสัญญา = ราคาห้อง ณ วันเช็คอิน — บิลเดือนถัดๆ ไปยึดค่านี้
    // ไม่ใช่ rooms.price_monthly ปัจจุบัน กันกรณี Admin แก้ราคาห้องแล้วกระทบสัญญาเก่า
    const monthlyRent = Number(booking.price_monthly) || 0;

    const res = await db.query(
        `INSERT INTO contracts
            (booking_id, member_id, room_id, start_date, end_date, billing_day,
             monthly_rent, rent_prepaid, security_deposit, key_deposit, contract_file_url, contract_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'มีผลใช้งาน')
         RETURNING contract_id`,
        [booking.booking_id, booking.member_id, booking.room_id, startDate, endDate, billingDay,
         monthlyRent, rentPrepaid, securityDeposit, keyDeposit, contractFileUrl]
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
                    c.notice_date, c.notice_requested_at,
                    c.renewal_notified_at, c.renewal_requested_at, c.contract_file_url,
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
                    c.notice_date, c.notice_requested_at,
                    c.renewal_notified_at, c.renewal_requested_at, c.contract_file_url,
                    c.move_out_date, c.refund_amount, c.settled_at,
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
// 4a. ผู้เช่าขอแจ้งย้ายออก (requestNotice) — Tenant (เจ้าของสัญญา)
//    POST /contract/:id/notice-request
//    เป็นแค่ "คำขอ" ยังไม่มีผลจริง → รอ Admin ยืนยัน (giveNotice)
// ==========================================
exports.requestNotice = async (req, res) => {
    const client = await pool.connect();
    const { id } = req.params;
    try {
        await client.query("BEGIN");
        await setAuditUser(client, req.user?.id);

        const cRes = await client.query(`SELECT * FROM contracts WHERE contract_id = $1 FOR UPDATE`, [id]);
        if (cRes.rows.length === 0) {
            await client.query("ROLLBACK");
            return res.status(404).json({ success: false, message: "ไม่พบสัญญาที่ระบุ" });
        }
        const contract = cRes.rows[0];

        // ownership: ผู้เช่าขอได้เฉพาะสัญญาของตัวเอง
        if (contract.member_id !== req.user.id) {
            await client.query("ROLLBACK");
            return res.status(403).json({ success: false, message: "ไม่มีสิทธิ์แจ้งย้ายออกสัญญานี้" });
        }
        if (contract.settled_at || contract.contract_status !== "มีผลใช้งาน") {
            await client.query("ROLLBACK");
            return res.status(400).json({ success: false, message: "สัญญานี้ปิดไปแล้ว" });
        }
        if (contract.notice_date) {
            await client.query("ROLLBACK");
            return res.status(400).json({ success: false, message: "สัญญานี้ยืนยันแจ้งย้ายออกแล้ว" });
        }

        await client.query(
            `UPDATE contracts SET notice_requested_at = CURRENT_TIMESTAMP WHERE contract_id = $1`,
            [id]
        );
        await client.query("COMMIT");
        res.json({ success: true, message: "ส่งคำขอแจ้งย้ายออกแล้ว รอแอดมินยืนยัน" });
    } catch (error) {
        await client.query("ROLLBACK");
        console.error("requestNotice Error:", error.message);
        res.status(500).json({ success: false, message: "เกิดข้อผิดพลาดในการส่งคำขอแจ้งย้ายออก" });
    } finally {
        client.release();
    }
};

// ==========================================
// 4b. Admin ยืนยันแจ้งย้ายออก (giveNotice) — Admin เท่านั้น
//    PUT /contract/:id/notice  body: { notice_date? }  (default = วันนี้)
//    ตั้ง notice_date จริง → เริ่มนับ 30 วันตามเงื่อนไขคืนมัดจำ
// ==========================================
exports.giveNotice = async (req, res) => {
    const client = await pool.connect();
    const { id } = req.params;
    const noticeDate = req.body.notice_date || new Date().toISOString().split("T")[0];
    try {
        await client.query("BEGIN");
        await setAuditUser(client, req.user?.id);

        const cRes = await client.query(`SELECT * FROM contracts WHERE contract_id = $1 FOR UPDATE`, [id]);
        if (cRes.rows.length === 0) {
            await client.query("ROLLBACK");
            return res.status(404).json({ success: false, message: "ไม่พบสัญญาที่ระบุ" });
        }
        const contract = cRes.rows[0];

        if (contract.settled_at || contract.contract_status !== "มีผลใช้งาน") {
            await client.query("ROLLBACK");
            return res.status(400).json({ success: false, message: "สัญญานี้เคลียร์ปิดไปแล้ว" });
        }

        await client.query(`UPDATE contracts SET notice_date = $1 WHERE contract_id = $2`, [noticeDate, id]);
        await client.query("COMMIT");

        res.json({ success: true, message: "ยืนยันการแจ้งย้ายออกแล้ว", data: { notice_date: noticeDate } });
    } catch (error) {
        await client.query("ROLLBACK");
        console.error("giveNotice Error:", error.message);
        res.status(500).json({ success: false, message: "เกิดข้อผิดพลาดในการยืนยันแจ้งย้ายออก" });
    } finally {
        client.release();
    }
};

// ==========================================
// 4c. Admin ยกเลิกแจ้งย้ายออก (cancelNotice) — Admin เท่านั้น
//    PUT /contract/:id/notice/cancel
//    เคลียร์ทั้ง notice_date + notice_requested_at กลับเป็น NULL (อยู่ต่อ)
// ==========================================
exports.cancelNotice = async (req, res) => {
    const client = await pool.connect();
    const { id } = req.params;
    try {
        await client.query("BEGIN");
        await setAuditUser(client, req.user?.id);

        const cRes = await client.query(`SELECT * FROM contracts WHERE contract_id = $1 FOR UPDATE`, [id]);
        if (cRes.rows.length === 0) {
            await client.query("ROLLBACK");
            return res.status(404).json({ success: false, message: "ไม่พบสัญญาที่ระบุ" });
        }
        if (cRes.rows[0].settled_at) {
            await client.query("ROLLBACK");
            return res.status(400).json({ success: false, message: "สัญญานี้เคลียร์ปิดไปแล้ว" });
        }

        await client.query(
            `UPDATE contracts SET notice_date = NULL, notice_requested_at = NULL WHERE contract_id = $1`,
            [id]
        );
        await client.query("COMMIT");
        res.json({ success: true, message: "ยกเลิกการแจ้งย้ายออกแล้ว สัญญากลับสู่สถานะปกติ" });
    } catch (error) {
        await client.query("ROLLBACK");
        console.error("cancelNotice Error:", error.message);
        res.status(500).json({ success: false, message: "เกิดข้อผิดพลาดในการยกเลิกแจ้งย้ายออก" });
    } finally {
        client.release();
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

        // รายการหักเพิ่มเติมที่ admin กรอกอิสระ [{item_name, amount}] — รวมยอดหักด้วย
        let extraDeductions = [];
        let extraTotal = 0;
        if (Array.isArray(b.extra_deductions)) {
            extraDeductions = b.extra_deductions
                .filter((d) => d && d.item_name)
                .map((d) => ({ item_name: String(d.item_name), amount: num(d.amount) }));
            extraTotal = extraDeductions.reduce((sum, d) => sum + d.amount, 0);
        }

        const refund = rentRefund + securityBack + keyBack - (damage + cleaning + utility + outstanding + extraTotal);
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
                extra_deductions  = $12,
                settled_at        = CURRENT_TIMESTAMP,
                settled_by        = $13
             WHERE contract_id = $14`,
            [newStatus, b.move_out_date, noticeGiven, Boolean(b.key_returned), securityForfeited,
             rentRefund, damage, cleaning, utility, outstanding, refundAmount,
             extraDeductions.length > 0 ? JSON.stringify(extraDeductions) : null, req.user.id, id]
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

// ==========================================
// 6. ผู้เช่าขอต่อสัญญา (requestRenewal) — Tenant (เจ้าของสัญญา)
//    POST /contract/:id/renew-request
//    แค่ตั้ง flag renewal_requested_at → Admin เห็นเป็นสถานะในรายการ
// ==========================================
exports.requestRenewal = async (req, res) => {
    const client = await pool.connect();
    const { id } = req.params;
    try {
        await client.query("BEGIN");
        await setAuditUser(client, req.user?.id);

        const cRes = await client.query(`SELECT * FROM contracts WHERE contract_id = $1 FOR UPDATE`, [id]);
        if (cRes.rows.length === 0) {
            await client.query("ROLLBACK");
            return res.status(404).json({ success: false, message: "ไม่พบสัญญาที่ระบุ" });
        }
        const contract = cRes.rows[0];
        if (contract.member_id !== req.user.id) {
            await client.query("ROLLBACK");
            return res.status(403).json({ success: false, message: "ไม่มีสิทธิ์ต่อสัญญานี้" });
        }
        if (contract.settled_at || contract.contract_status !== "มีผลใช้งาน") {
            await client.query("ROLLBACK");
            return res.status(400).json({ success: false, message: "สัญญานี้ปิดไปแล้ว" });
        }

        await client.query(
            `UPDATE contracts SET renewal_requested_at = CURRENT_TIMESTAMP WHERE contract_id = $1`,
            [id]
        );
        await client.query("COMMIT");
        res.json({ success: true, message: "ส่งคำขอต่อสัญญาแล้ว รอแอดมินดำเนินการ" });
    } catch (error) {
        await client.query("ROLLBACK");
        console.error("requestRenewal Error:", error.message);
        res.status(500).json({ success: false, message: "เกิดข้อผิดพลาดในการขอต่อสัญญา" });
    } finally {
        client.release();
    }
};

// ==========================================
// 7. Admin ต่อสัญญา (renewContract) — Admin (multipart, ไฟล์สัญญาใหม่)
//    PUT /contract/:id/renew  body: { months, contract_file? }
//    อัปเดตแถวเดิม: ขยาย end_date + ทับ contract_file_url + เคลียร์ flag แจ้งเตือน/ขอต่อ
//    ไม่เก็บมัดจำใหม่ (มัดจำเดิมยังใช้ต่อ) · audit log เก็บค่าก่อน/หลังให้อัตโนมัติ
// ==========================================
exports.renewContract = async (req, res) => {
    const client = await pool.connect();
    const { id } = req.params;
    const months = Number(req.body.months) || DEFAULT_CONTRACT_MONTHS;
    try {
        await client.query("BEGIN");
        await setAuditUser(client, req.user?.id);

        const cRes = await client.query(`SELECT * FROM contracts WHERE contract_id = $1 FOR UPDATE`, [id]);
        if (cRes.rows.length === 0) {
            await client.query("ROLLBACK");
            return res.status(404).json({ success: false, message: "ไม่พบสัญญาที่ระบุ" });
        }
        const contract = cRes.rows[0];
        if (contract.settled_at || contract.contract_status !== "มีผลใช้งาน") {
            await client.query("ROLLBACK");
            return res.status(400).json({ success: false, message: "ต่อได้เฉพาะสัญญาที่ยังมีผลใช้งาน" });
        }

        // คำนวณ end_date ใหม่ = end_date เดิม + จำนวนเดือนที่ต่อ
        const newEnd = new Date(contract.end_date);
        newEnd.setMonth(newEnd.getMonth() + months);
        const newEndDate = newEnd.toISOString().split("T")[0];

        // อัปโหลดไฟล์สัญญาใหม่ (ถ้าแนบมา) — ไม่แนบก็คงไฟล์เดิม
        let contractFileUrl = contract.contract_file_url;
        if (req.file) {
            contractFileUrl = await uploadFile(req.file.buffer, req.file.originalname, req.file.mimetype, "contract");
        }

        // อัปเดตแถวเดิม + เคลียร์ flag แจ้งเตือน/ขอต่อ (รอบใหม่เริ่มนับจาก end_date ล่าสุด)
        await client.query(
            `UPDATE contracts SET
                end_date = $1,
                contract_file_url = $2,
                renewal_notified_at = NULL,
                renewal_requested_at = NULL
             WHERE contract_id = $3`,
            [newEndDate, contractFileUrl, id]
        );
        await client.query("COMMIT");
        res.json({ success: true, message: `ต่อสัญญาสำเร็จ — สิ้นสุดใหม่ ${newEndDate}`, data: { end_date: newEndDate } });
    } catch (error) {
        await client.query("ROLLBACK");
        console.error("renewContract Error:", error.message);
        res.status(400).json({ success: false, message: error.message });
    } finally {
        client.release();
    }
};

// ==========================================
// 8. ดูประวัติการแก้ไข/ต่อสัญญา (getContractHistory) — Admin หรือเจ้าของสัญญา
//    GET /contract/:id/history  → ดึงจาก audit_logs (table_name='contracts')
// ==========================================
exports.getContractHistory = async (req, res) => {
    const { id } = req.params;
    try {
        // ownership: ผู้เช่าดูได้เฉพาะประวัติสัญญาของตัวเอง
        const cRes = await pool.query(`SELECT member_id FROM contracts WHERE contract_id = $1`, [id]);
        if (cRes.rows.length === 0) {
            return res.status(404).json({ success: false, message: "ไม่พบสัญญาที่ระบุ" });
        }
        if (req.user.role !== "Admin" && cRes.rows[0].member_id !== req.user.id) {
            return res.status(403).json({ success: false, message: "ไม่มีสิทธิ์ดูประวัติสัญญานี้" });
        }

        const result = await pool.query(
            `SELECT audit_id, action, old_data, new_data, changed_by, changed_at
             FROM audit_logs
             WHERE table_name = 'contracts' AND record_id = $1
             ORDER BY changed_at DESC`,
            [id]
        );
        res.json({ success: true, count: result.rows.length, data: result.rows });
    } catch (error) {
        console.error("getContractHistory Error:", error.message);
        res.status(500).json({ success: false, message: "เกิดข้อผิดพลาดในการดึงประวัติสัญญา" });
    }
};

// export helper ให้ booking checkIn เรียกใช้สร้างสัญญาได้
exports._createContractForBooking = createContractForBooking;
