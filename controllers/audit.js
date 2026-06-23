const pool = require("../config/db");

// ==========================================
// M10b — Audit Log (ดูประวัติการเปลี่ยนแปลง · read-only)
// ตาราง audit_logs เป็น append-only — ไม่มี endpoint แก้/ลบ
// ==========================================

// แปลชื่อตาราง (อังกฤษ) เป็นภาษาไทยให้ admin อ่านง่าย
const TABLE_LABELS = {
    invoices: "ใบแจ้งหนี้",
    payments: "การชำระเงิน",
    contracts: "สัญญาเช่า",
    bookings: "การจอง",
    members: "ผู้ใช้",
    products: "สินค้า",
    sales: "การขาย",
};

// ==========================================
// 1. ดูรายการ audit log (getAuditLogs) — Admin
//    GET /audit-logs?table=&action=&record_id=&limit=&offset=
// ==========================================
exports.getAuditLogs = async (req, res) => {
    const { table, action, record_id } = req.query;
    // จำกัดจำนวนต่อหน้า (กันดึงทีละมากเกิน) default 100
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const offset = Number(req.query.offset) || 0;

    try {
        // ประกอบเงื่อนไข filter แบบ dynamic
        const conditions = [];
        const params = [];

        if (table) {
            params.push(table);
            conditions.push(`a.table_name = $${params.length}`);
        }
        if (action) {
            params.push(action);
            conditions.push(`a.action = $${params.length}`);
        }
        if (record_id) {
            params.push(record_id);
            conditions.push(`a.record_id = $${params.length}`);
        }
        const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

        // ใส่ limit/offset เป็น param ท้ายสุด
        params.push(limit);
        params.push(offset);

        const result = await pool.query(
            `SELECT
                a.audit_id, a.table_name, a.record_id, a.action,
                a.old_data, a.new_data, a.changed_by, a.changed_at,
                m.full_name AS changed_by_name
             FROM audit_logs a
             LEFT JOIN members m ON a.changed_by = m.member_id
             ${where}
             ORDER BY a.changed_at DESC, a.audit_id DESC
             LIMIT $${params.length - 1} OFFSET $${params.length}`,
            params
        );

        // เติม label ไทยของตารางให้ frontend ใช้แสดง
        const data = result.rows.map((row) => ({
            ...row,
            table_label: TABLE_LABELS[row.table_name] || row.table_name,
        }));

        res.json({ success: true, count: data.length, data });
    } catch (error) {
        console.error("getAuditLogs Error:", error.message);
        res.status(500).json({ success: false, message: "เกิดข้อผิดพลาดในการดึงประวัติการเปลี่ยนแปลง" });
    }
};
