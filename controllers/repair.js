const pool = require("../config/db");

// ==========================================
// 1. Tenant แจ้งซ่อม (createRepair)
// ==========================================
exports.createRepair = async (req, res) => {
    const { booking_id, problem_title, problem_details } = req.body;
    const memberId = req.user.id;

    if (!booking_id || !problem_title) {
        return res.status(400).json({ success: false, message: 'กรุณาระบุ booking_id และหัวข้อปัญหา' });
    }

    // ตรวจสอบว่า booking นั้นเป็นของ tenant คนนี้จริง และกำลังเข้าพักอยู่
    const bookingRes = await pool.query(
        `SELECT booking_id FROM bookings
         WHERE booking_id = $1 AND member_id = $2 AND booking_status = 'กำลังเข้าพัก'
         LIMIT 1`,
        [booking_id, memberId]
    );

    if (bookingRes.rows.length === 0) {
        return res.status(403).json({
            success: false,
            message: 'ไม่พบการจองที่กำลังเข้าพักอยู่ หรือไม่มีสิทธิ์แจ้งซ่อมการจองนี้'
        });
    }

    const result = await pool.query(
        `INSERT INTO maintenance_requests (booking_id, problem_title, problem_details)
         VALUES ($1, $2, $3) RETURNING *`,
        [booking_id, problem_title, problem_details || null]
    );

    res.status(201).json({ success: true, data: result.rows[0], message: 'แจ้งซ่อมสำเร็จ' });
};

// ==========================================
// 2. Admin ดูรายการแจ้งซ่อมทั้งหมด (getAllRepairs)
// ==========================================
exports.getAllRepairs = async (req, res) => {
    const result = await pool.query(
        `SELECT
            mr.repair_id,
            mr.booking_id,
            mr.problem_title,
            mr.problem_details,
            mr.reported_date,
            mr.status,
            r.room_number,
            m.full_name AS tenant_name
         FROM maintenance_requests mr
         JOIN bookings b ON mr.booking_id = b.booking_id
         JOIN rooms r ON b.room_id = r.room_id
         LEFT JOIN members m ON b.member_id = m.member_id
         ORDER BY mr.reported_date DESC`
    );

    res.json({ success: true, data: result.rows });
};

// ==========================================
// 3. Tenant ดูรายการแจ้งซ่อมของตัวเองตาม booking (getMyRepairs)
// ==========================================
exports.getMyRepairs = async (req, res) => {
    const { bookingId } = req.params;
    const memberId = req.user.id;

    // ตรวจสอบว่า booking นั้นเป็นของ tenant คนนี้จริง
    const ownerCheck = await pool.query(
        `SELECT booking_id FROM bookings WHERE booking_id = $1 AND member_id = $2 LIMIT 1`,
        [bookingId, memberId]
    );

    if (ownerCheck.rows.length === 0) {
        return res.status(403).json({ success: false, message: 'ไม่มีสิทธิ์ดูข้อมูลนี้' });
    }

    const result = await pool.query(
        `SELECT repair_id, problem_title, problem_details, reported_date, status
         FROM maintenance_requests
         WHERE booking_id = $1
         ORDER BY reported_date DESC`,
        [bookingId]
    );

    res.json({ success: true, data: result.rows });
};

// ==========================================
// 4. Admin อัปเดตสถานะการซ่อม (updateRepairStatus)
// ==========================================
exports.updateRepairStatus = async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;

    const validStatuses = ['pending', 'in_progress', 'done'];
    if (!validStatuses.includes(status)) {
        return res.status(400).json({
            success: false,
            message: 'สถานะไม่ถูกต้อง ต้องเป็น pending, in_progress หรือ done'
        });
    }

    const result = await pool.query(
        `UPDATE maintenance_requests SET status = $1 WHERE repair_id = $2 RETURNING *`,
        [status, id]
    );

    if (result.rows.length === 0) {
        return res.status(404).json({ success: false, message: 'ไม่พบรายการแจ้งซ่อมนี้' });
    }

    res.json({ success: true, data: result.rows[0], message: 'อัปเดตสถานะสำเร็จ' });
};
