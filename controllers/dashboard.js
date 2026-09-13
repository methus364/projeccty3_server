const pool = require("../config/db");

// ==========================================
// M8 — Dashboard & Reports / สรุปภาพรวม + รายงาน
// ทุก endpoint เป็นของ Admin · ตัวเลขคำนวณฝั่ง server เสมอ
// ==========================================

// ==========================================
// 1. สรุปภาพรวม (getSummary)
//    GET /dashboard/summary
//    คืนการ์ดสรุป: รายได้เดือนนี้ / สถานะห้อง / หนี้ค้างชำระ / แจ้งซ่อมค้าง
// ==========================================
exports.getSummary = async (req, res) => {
    try {
        // การ์ดสรุปทั้ง 5 ตัวไม่พึ่งพากัน จึงยิง query พร้อมกันด้วย Promise.all
        // ทำให้ latency ของหน้า dashboard = query ที่ช้าที่สุดตัวเดียว แทนผลรวมทั้ง 5

        // --- 1.1 รายได้เดือนนี้ = ผลรวมเงินที่ "ยืนยันแล้ว" ในเดือนปัจจุบัน ---
        const revenuePromise = pool.query(
            `SELECT COALESCE(SUM(amount_paid), 0) AS revenue
             FROM payments
             WHERE payment_status = 'ยืนยันแล้ว'
               AND to_char(payment_date, 'YYYY-MM') = to_char(CURRENT_DATE, 'YYYY-MM')`
        );

        // --- 1.2 จำนวนห้องแยกตามสถานะ (ว่าง / มีผู้เช่า / ปิดปรับปรุง) ---
        const roomPromise = pool.query(
            `SELECT room_status, COUNT(*) AS count
             FROM rooms
             GROUP BY room_status`
        );

        // --- 1.3 หนี้ค้างชำระ = ยอดบิลคงค้าง (ยอดบิล − เงินที่ยืนยันแล้ว) ของบิลที่ยังไม่ปิด ---
        const debtPromise = pool.query(
            `SELECT
                COALESCE(SUM(i.total_amount - COALESCE(p.paid, 0)), 0) AS outstanding,
                COUNT(*) AS unpaid_count
             FROM invoices i
             LEFT JOIN (
                SELECT invoice_id, SUM(amount_paid) AS paid
                FROM payments
                WHERE payment_status = 'ยืนยันแล้ว'
                GROUP BY invoice_id
             ) p ON p.invoice_id = i.invoice_id
             WHERE i.invoice_status NOT IN ('ชำระแล้ว', 'ยกเลิก')`
        );

        // --- 1.4 แจ้งซ่อมที่ยังค้างอยู่ (ยังไม่ done) ---
        const repairPromise = pool.query(
            `SELECT COUNT(*) AS pending_repairs
             FROM maintenance_requests
             WHERE status <> 'done'`
        );

        // --- 1.5 ห้องรายเดือนที่ยังไม่จดมิเตอร์เดือนนี้ (เตือนก่อนออกบิล) ---
        const meterPromise = pool.query(
            `SELECT COUNT(*) AS unrecorded
             FROM bookings b
             JOIN rooms r ON b.room_id = r.room_id
             WHERE b.rent_type = 'monthly' AND b.booking_status = 'กำลังเข้าพัก'
               AND NOT EXISTS (
                   SELECT 1 FROM utility_meters um
                   WHERE um.room_id = r.room_id
                     AND um.record_month = to_char(CURRENT_DATE, 'YYYY-MM')
               )`
        );

        // --- 1.6 ห้องว่างสำหรับรายวัน "วันนี้" = ห้องที่ไม่ปิดปรับปรุง และไม่มีการจองคาบเกี่ยววันนี้ ---
        //         แยกนับตามประเภทห้อง (type_name) เพื่อบอกว่าว่างประเภทไหนกี่ห้อง
        const availDailyPromise = pool.query(
            `SELECT COALESCE(r.type_name, 'ไม่ระบุประเภท') AS type_name, COUNT(*) AS count
             FROM rooms r
             WHERE r.room_status <> 'ปิดปรับปรุง'
               AND NOT EXISTS (
                   SELECT 1 FROM bookings b
                   WHERE b.room_id = r.room_id
                     AND b.booking_status NOT IN ('ยกเลิก', 'ย้ายออกแล้ว')
                     AND b.check_in_date <= CURRENT_DATE
                     AND b.check_out_date > CURRENT_DATE
               )
             GROUP BY r.type_name
             ORDER BY r.type_name`
        );

        // --- 1.7 ห้องว่างสำหรับรายเดือน = ห้องที่ไม่ปิดปรับปรุง และไม่มีผู้เช่ารายเดือนกำลังพักอยู่ (แยกตามประเภทห้อง) ---
        const availMonthlyPromise = pool.query(
            `SELECT COALESCE(r.type_name, 'ไม่ระบุประเภท') AS type_name, COUNT(*) AS count
             FROM rooms r
             WHERE r.room_status <> 'ปิดปรับปรุง'
               AND NOT EXISTS (
                   SELECT 1 FROM bookings b
                   WHERE b.room_id = r.room_id
                     AND b.rent_type = 'monthly'
                     AND b.booking_status = 'กำลังเข้าพัก'
               )
             GROUP BY r.type_name
             ORDER BY r.type_name`
        );

        // รอผลทุก query พร้อมกัน
        const [revenueRes, roomRes, debtRes, repairRes, meterRes, availDailyRes, availMonthlyRes] = await Promise.all([
            revenuePromise, roomPromise, debtPromise, repairPromise, meterPromise, availDailyPromise, availMonthlyPromise,
        ]);

        // รวมยอดห้องว่าง + จัดรายการแยกประเภทห้อง (แปลง count เป็นตัวเลข)
        const toByType = (rows) => rows.map((r) => ({ type_name: r.type_name, count: Number(r.count) }));
        const sumCount = (rows) => rows.reduce((sum, r) => sum + Number(r.count), 0);
        const availableDailyByType = toByType(availDailyRes.rows);
        const availableMonthlyByType = toByType(availMonthlyRes.rows);

        // แปลงผลลัพธ์ห้องเป็นออบเจกต์อ่านง่าย พร้อมยอดรวม
        const rooms = { total: 0, vacant: 0, occupied: 0, maintenance: 0 };
        for (const row of roomRes.rows) {
            const count = Number(row.count);
            rooms.total += count;
            if (row.room_status === "ว่าง") rooms.vacant = count;
            else if (row.room_status === "มีผู้เช่า") rooms.occupied = count;
            else if (row.room_status === "ปิดปรับปรุง") rooms.maintenance = count;
        }

        res.json({
            success: true,
            data: {
                revenueThisMonth: Number(revenueRes.rows[0].revenue),
                rooms,
                outstandingDebt: Number(debtRes.rows[0].outstanding),
                unpaidInvoices: Number(debtRes.rows[0].unpaid_count),
                pendingRepairs: Number(repairRes.rows[0].pending_repairs),
                unrecordedMeters: Number(meterRes.rows[0]?.unrecorded || 0),
                // ห้องว่างวันนี้ แยกตามประเภทการเช่า + รายการแยกประเภทห้อง
                availableDaily: sumCount(availDailyRes.rows),
                availableMonthly: sumCount(availMonthlyRes.rows),
                availableDailyByType,
                availableMonthlyByType,
            },
        });
    } catch (error) {
        console.error("getSummary Error:", error.message);
        res.status(500).json({ success: false, message: "เกิดข้อผิดพลาดในการดึงข้อมูลสรุป" });
    }
};

// ==========================================
// 2. รายงานการเงิน — รายได้รายเดือน (getRevenue)
//    GET /dashboard/revenue?months=6
//    คืนรายได้ (เงินที่ยืนยันแล้ว) ย้อนหลัง N เดือน สำหรับวาดกราฟ
// ==========================================
exports.getRevenue = async (req, res) => {
    // จำนวนเดือนย้อนหลัง — จำกัด 1–24 กันค่าผิดปกติ (default 6)
    let months = parseInt(req.query.months, 10);
    if (isNaN(months) || months < 1) months = 6;
    if (months > 24) months = 24;

    try {
        // generate_series สร้างแถวครบทุกเดือน เดือนที่ไม่มีรายได้จะได้ 0 (ไม่ขาดช่วงในกราฟ)
        const result = await pool.query(
            `SELECT
                to_char(m.month, 'YYYY-MM') AS month,
                COALESCE(SUM(p.amount_paid), 0) AS revenue
             FROM generate_series(
                    date_trunc('month', CURRENT_DATE) - make_interval(months => $1 - 1),
                    date_trunc('month', CURRENT_DATE),
                    INTERVAL '1 month'
                  ) AS m(month)
             LEFT JOIN payments p
                    ON date_trunc('month', p.payment_date) = m.month
                   AND p.payment_status = 'ยืนยันแล้ว'
             GROUP BY m.month
             ORDER BY m.month`,
            [months]
        );

        // แปลง revenue เป็นตัวเลข (pg คืน NUMERIC เป็น string)
        const data = result.rows.map((row) => ({
            month: row.month,
            revenue: Number(row.revenue),
        }));

        res.json({ success: true, count: data.length, data });
    } catch (error) {
        console.error("getRevenue Error:", error.message);
        res.status(500).json({ success: false, message: "เกิดข้อผิดพลาดในการดึงรายงานรายได้" });
    }
};

// ==========================================
// 3. รายงานผู้เข้าพักปัจจุบัน (getOccupancyReport)
//    GET /dashboard/occupancy
//    คืนรายการผู้ที่ "กำลังเข้าพัก" พร้อมห้อง/ผู้เช่า/ประเภทเช่า
// ==========================================
exports.getOccupancyReport = async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT
                b.booking_id,
                r.room_number,
                m.full_name   AS tenant_name,
                m.phone_number,
                b.rent_type,
                b.check_in_date,
                b.check_out_date
             FROM bookings b
             JOIN rooms r   ON b.room_id = r.room_id
             LEFT JOIN members m ON b.member_id = m.member_id
             WHERE b.booking_status = 'กำลังเข้าพัก'
             ORDER BY r.room_number`
        );

        res.json({ success: true, count: result.rows.length, data: result.rows });
    } catch (error) {
        console.error("getOccupancyReport Error:", error.message);
        res.status(500).json({ success: false, message: "เกิดข้อผิดพลาดในการดึงรายงานผู้เข้าพัก" });
    }
};

// ==========================================
// 4. รายงานหนี้ค้างชำระ (getDebtReport)
//    GET /dashboard/debt
//    คืนรายการบิลที่ยังค้างชำระ พร้อมยอดคงค้างของแต่ละบิล
// ==========================================
exports.getDebtReport = async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT
                i.invoice_id,
                r.room_number,
                m.full_name AS tenant_name,
                i.invoice_date,
                i.due_date,
                i.total_amount,
                COALESCE(p.paid, 0) AS paid_amount,
                (i.total_amount - COALESCE(p.paid, 0)) AS outstanding,
                i.invoice_status
             FROM invoices i
             JOIN bookings b ON i.booking_id = b.booking_id
             JOIN rooms r    ON b.room_id = r.room_id
             LEFT JOIN members m ON b.member_id = m.member_id
             LEFT JOIN (
                SELECT invoice_id, SUM(amount_paid) AS paid
                FROM payments
                WHERE payment_status = 'ยืนยันแล้ว'
                GROUP BY invoice_id
             ) p ON p.invoice_id = i.invoice_id
             WHERE i.invoice_status NOT IN ('ชำระแล้ว', 'ยกเลิก')
             ORDER BY i.due_date`
        );

        // แปลงตัวเลขเงินจาก string เป็น number
        const data = result.rows.map((row) => ({
            ...row,
            total_amount: Number(row.total_amount),
            paid_amount: Number(row.paid_amount),
            outstanding: Number(row.outstanding),
        }));

        res.json({ success: true, count: data.length, data });
    } catch (error) {
        console.error("getDebtReport Error:", error.message);
        res.status(500).json({ success: false, message: "เกิดข้อผิดพลาดในการดึงรายงานหนี้ค้างชำระ" });
    }
};

// ==========================================
// 5. สถิติผู้เข้าพัก แยกรายวัน/รายเดือน ตามช่วงเวลา (getOccupancyStats)
//    GET /dashboard/occupancy-stats?start=YYYY-MM-DD&end=YYYY-MM-DD
//    นับ "การจองที่เข้าพักคาบเกี่ยว" ช่วงที่เลือก แยกตาม rent_type
//    (คาบเกี่ยว = check_in <= end AND check_out >= start · นับเฉพาะที่เช็คอินแล้ว/ย้ายออกแล้ว = พักจริง)
// ==========================================
exports.getOccupancyStats = async (req, res) => {
    // ช่วงเวลา — ถ้าไม่ส่งมา default = เดือนปัจจุบัน (จัดรูปแบบจากเวลาท้องถิ่น ไม่ใช้ toISOString ที่เลื่อนเป็น UTC)
    const fmtDate = (d) =>
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    let { start, end } = req.query;
    if (!start) start = fmtDate(new Date(new Date().getFullYear(), new Date().getMonth(), 1));
    if (!end) end = fmtDate(new Date());

    try {
        const result = await pool.query(
            `SELECT
                COUNT(*) FILTER (WHERE rent_type = 'daily')   AS daily,
                COUNT(*) FILTER (WHERE rent_type = 'monthly') AS monthly
             FROM bookings
             WHERE booking_status IN ('กำลังเข้าพัก', 'ย้ายออกแล้ว')
               AND check_in_date  <= $2
               AND check_out_date >= $1`,
            [start, end]
        );

        res.json({
            success: true,
            data: {
                start,
                end,
                daily: Number(result.rows[0].daily),
                monthly: Number(result.rows[0].monthly),
            },
        });
    } catch (error) {
        console.error("getOccupancyStats Error:", error.message);
        res.status(500).json({ success: false, message: "เกิดข้อผิดพลาดในการดึงสถิติผู้เข้าพัก" });
    }
};
