const pool = require("../config/db");
const { WATER_RATE, ELEC_RATE, WATER_MINIMUM } = require("../config/utility_rates");
const { computeMonthlyRoomCost } = require("../utils/billing");
const { buildInvoicePdf } = require("../utils/invoicePdf");
const { sendInvoiceMail } = require("../config/mailer");

// ==========================================
// Helper: คืนค่าเดือนก่อนหน้าจาก 'YYYY-MM' (reuse logic เดียวกับ meter)
// ==========================================
function getPrevMonth(yyyyMM) {
    const [year, month] = yyyyMM.split("-").map(Number);
    if (month === 1) return `${year - 1}-12`;
    return `${year}-${String(month - 1).padStart(2, "0")}`;
}

// คืนเดือนปัจจุบันรูปแบบ 'YYYY-MM'
function getCurrentMonth() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

// ==========================================
// Helper: คำนวณยอดบิลของ booking สำหรับเดือนที่ระบุ (ฝั่ง server เสมอ)
// คืน { room_cost, water_cost, elec_cost, total_amount, details: [...] }
// db = client (ใน transaction) หรือ pool ก็ได้
// ==========================================
async function computeInvoice(db, booking, month) {
    // 1. ค่าห้อง — รายเดือนคิดแบบ proration (ข้ามช่วง prepaid 30 วันแรก), รายวันใช้ room_price × จำนวนวัน
    let roomCost;
    let roomItemName;
    if (booking.rent_type === "monthly") {
        // เดือนแรกหลังเข้าพักจะถูก prepaid ครอบ → คิดเฉพาะวันที่เกิน (ดู utils/billing.js)
        const rent = computeMonthlyRoomCost(booking.check_in_date, booking.price_monthly, month);
        roomCost = rent.roomCost;
        roomItemName = rent.itemName;
    } else {
        const start = new Date(booking.check_in_date);
        const end = new Date(booking.check_out_date);
        const days = Math.ceil(Math.abs(end - start) / 86400000) || 1;
        roomCost = days * (Number(booking.room_price) || 0);
        roomItemName = `ค่าห้อง (${days} วัน)`;
    }

    // 2. ค่าน้ำ/ค่าไฟ — (มิเตอร์เดือนนี้ − เดือนก่อน) × เรต (reuse logic M5)
    const prevMonth = getPrevMonth(month);
    const meterRes = await db.query(
        `SELECT
            curr.water_current_unit AS curr_water,
            curr.elec_current_unit  AS curr_elec,
            prev.water_current_unit AS prev_water,
            prev.elec_current_unit  AS prev_elec
         FROM rooms r
         LEFT JOIN utility_meters curr
            ON curr.room_id = r.room_id AND curr.record_month = $2
         LEFT JOIN utility_meters prev
            ON prev.room_id = r.room_id AND prev.record_month = $3
         WHERE r.room_id = $1`,
        [booking.room_id, month, prevMonth]
    );

    const meter = meterRes.rows[0] || {};
    const hasWater = meter.curr_water != null && meter.prev_water != null;
    const hasElec  = meter.curr_elec  != null && meter.prev_elec  != null;
    const waterUnits = hasWater ? meter.curr_water - meter.prev_water : 0;
    const elecUnits  = hasElec  ? meter.curr_elec  - meter.prev_elec  : 0;
    // ค่าน้ำคิดขั้นต่ำ: ถ้ามีมิเตอร์แล้วคิดตามหน่วยได้ต่ำกว่าขั้นต่ำ → ใช้ค่าขั้นต่ำแทน
    const waterByUnit = waterUnits * WATER_RATE;
    const waterCost = hasWater ? Math.max(waterByUnit, WATER_MINIMUM) : 0;
    const elecCost  = elecUnits  * ELEC_RATE;

    // 3. ยอดรวม + รายการย่อย (1 บรรทัด/ประเภท)
    const totalAmount = roomCost + waterCost + elecCost;
    // ถ้าค่าน้ำโดนขั้นต่ำ ให้ชื่อรายการบอกชัดว่าเป็นขั้นต่ำ (subtotal จะไม่เท่ากับ หน่วย×เรต)
    const waterItemName = (hasWater && waterByUnit < WATER_MINIMUM)
        ? `ค่าน้ำ (${waterUnits} หน่วย, ขั้นต่ำ)`
        : `ค่าน้ำ (${waterUnits} หน่วย)`;
    const details = [
        { item_name: roomItemName, quantity: 1, unit_price: roomCost, subtotal: roomCost },
        { item_name: waterItemName, quantity: waterUnits, unit_price: WATER_RATE, subtotal: waterCost },
        { item_name: `ค่าไฟ (${elecUnits} หน่วย)`, quantity: elecUnits, unit_price: ELEC_RATE, subtotal: elecCost },
    ];

    return { room_cost: roomCost, water_cost: waterCost, elec_cost: elecCost, total_amount: totalAmount, details };
}

// ==========================================
// Helper: โหลดข้อมูล invoice แบบเต็ม (header + รายการ + ผู้เช่า/ห้อง) สำหรับ PDF/อีเมล
// คืน null ถ้าไม่พบ
// ==========================================
async function loadFullInvoice(db, invoiceId) {
    const headRes = await db.query(
        `SELECT
            i.invoice_id, i.booking_id, i.invoice_date, i.due_date,
            i.room_cost, i.water_cost, i.elec_cost, i.total_amount, i.invoice_status,
            b.member_id,
            m.full_name AS guest_name,
            m.email     AS guest_email,
            r.room_number
         FROM invoices i
         JOIN bookings b ON i.booking_id = b.booking_id
         LEFT JOIN members m ON b.member_id = m.member_id
         JOIN rooms r ON b.room_id = r.room_id
         WHERE i.invoice_id = $1`,
        [invoiceId]
    );

    if (headRes.rows.length === 0) return null;

    const detailRes = await db.query(
        `SELECT item_name, quantity, unit_price, subtotal
         FROM invoice_details WHERE invoice_id = $1 ORDER BY invoice_detail_id`,
        [invoiceId]
    );

    const invoice = headRes.rows[0];
    invoice.details = detailRes.rows;
    return invoice;
}

// ==========================================
// Helper: gen PDF + ส่งอีเมลใบแจ้งหนี้ (best-effort)
// คืน { sent: boolean, message } — ไม่ throw เพื่อไม่ให้การออกบิลล้มเพราะอีเมล
// ==========================================
async function emailInvoice(invoice) {
    if (!invoice.guest_email) {
        return { sent: false, message: "ผู้เช่าไม่มีอีเมล — ข้ามการส่ง" };
    }
    try {
        const pdfBuffer = await buildInvoicePdf(invoice, "invoice");
        await sendInvoiceMail({
            to: invoice.guest_email,
            subject: `ใบแจ้งหนี้หอพัก Around Loei (เลขที่ INV-${new Date(invoice.invoice_date).getFullYear()}-${String(invoice.invoice_id).padStart(4, "0")})`,
            text: `เรียนคุณ ${invoice.guest_name || ""}\n\nแนบใบแจ้งหนี้ค่าเช่าห้อง ${invoice.room_number} ยอดรวม ${Number(invoice.total_amount).toLocaleString()} บาท\nกรุณาชำระภายในวันครบกำหนด ขอบคุณค่ะ`,
            pdfBuffer,
            filename: `invoice-${invoice.invoice_id}.pdf`,
        });
        return { sent: true, message: "ส่งอีเมลสำเร็จ" };
    } catch (err) {
        console.error("ส่งอีเมลใบแจ้งหนี้ไม่สำเร็จ:", err.message);
        return { sent: false, message: "ออกบิลสำเร็จ แต่ส่งอีเมลไม่สำเร็จ: " + err.message };
    }
}

// ==========================================
// 1. ออกบิล (createInvoice) — Admin
//    POST /invoice  body: { booking_id, month?, due_date? }
//    คำนวณยอด → insert invoice + invoice_details → gen PDF + ส่งอีเมล
//    กันออกซ้ำ: booking เดียวกันในเดือนเดียวกัน
// ==========================================
exports.createInvoice = async (req, res) => {
    const client = await pool.connect();
    const { booking_id, due_date } = req.body;
    const month = req.body.month || getCurrentMonth();

    if (!booking_id) {
        client.release();
        return res.status(400).json({ success: false, message: "กรุณาระบุ booking_id" });
    }

    try {
        await client.query("BEGIN");

        // 1. โหลดข้อมูลการจอง + ห้อง
        const bookingRes = await client.query(
            `SELECT b.booking_id, b.room_id, b.member_id, b.rent_type,
                    b.check_in_date, b.check_out_date,
                    r.room_price, r.price_monthly
             FROM bookings b
             JOIN rooms r ON b.room_id = r.room_id
             WHERE b.booking_id = $1`,
            [booking_id]
        );
        if (bookingRes.rows.length === 0) throw new Error("ไม่พบการจองที่ระบุ");
        const booking = bookingRes.rows[0];

        // 2. กันออกบิลซ้ำ booking + เดือนเดียวกัน (ยกเว้นบิลที่ถูกยกเลิก)
        const dupRes = await client.query(
            `SELECT invoice_id FROM invoices
             WHERE booking_id = $1
               AND to_char(invoice_date, 'YYYY-MM') = $2
               AND invoice_status != 'ยกเลิก'
             LIMIT 1`,
            [booking_id, month]
        );
        if (dupRes.rows.length > 0) {
            throw new Error(`มีใบแจ้งหนี้ของการจองนี้ในเดือน ${month} อยู่แล้ว`);
        }

        // 3. คำนวณยอด (ฝั่ง server)
        const calc = await computeInvoice(client, booking, month);

        // 4. กำหนดวันออกบิล = วันแรกของเดือนที่ระบุ, due_date default = +7 วัน
        const invoiceDate = `${month}-01`;
        const dueDate = due_date || new Date(new Date(invoiceDate).getTime() + 7 * 86400000).toISOString().split("T")[0];

        // 5. insert header
        const invRes = await client.query(
            `INSERT INTO invoices
                (booking_id, invoice_date, due_date, room_cost, water_cost, elec_cost, total_amount, invoice_status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'ยังไม่ชำระ')
             RETURNING invoice_id`,
            [booking_id, invoiceDate, dueDate, calc.room_cost, calc.water_cost, calc.elec_cost, calc.total_amount]
        );
        const invoiceId = invRes.rows[0].invoice_id;

        // 6. insert รายการย่อย
        for (const d of calc.details) {
            await client.query(
                `INSERT INTO invoice_details (invoice_id, item_name, quantity, unit_price, subtotal)
                 VALUES ($1, $2, $3, $4, $5)`,
                [invoiceId, d.item_name, d.quantity, d.unit_price, d.subtotal]
            );
        }

        await client.query("COMMIT");

        // 7. หลัง commit: ส่งอีเมลแนบ PDF (ไม่ให้ล้มถ้าอีเมลพัง)
        const fullInvoice = await loadFullInvoice(pool, invoiceId);
        const mailResult = await emailInvoice(fullInvoice);

        res.status(201).json({
            success: true,
            data: fullInvoice,
            message: "ออกใบแจ้งหนี้สำเร็จ" + (mailResult.sent ? " และส่งอีเมลแล้ว" : ` (${mailResult.message})`),
        });

    } catch (error) {
        await client.query("ROLLBACK");
        console.error("createInvoice Error:", error.message);
        res.status(400).json({ success: false, message: error.message });
    } finally {
        client.release();
    }
};

// ==========================================
// 2. ดูรายการบิลทั้งหมด (getInvoices) — Admin
//    GET /invoices?status=&month=
// ==========================================
exports.getInvoices = async (req, res) => {
    const { status, month } = req.query;

    try {
        // สร้างเงื่อนไขแบบ dynamic ตาม filter ที่ส่งมา
        const conditions = [];
        const params = [];

        if (status) {
            params.push(status);
            conditions.push(`i.invoice_status = $${params.length}`);
        }
        if (month) {
            params.push(month);
            conditions.push(`to_char(i.invoice_date, 'YYYY-MM') = $${params.length}`);
        }
        const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

        const result = await pool.query(
            `SELECT
                i.invoice_id, i.booking_id, i.invoice_date, i.due_date,
                i.room_cost, i.water_cost, i.elec_cost, i.total_amount, i.invoice_status,
                m.full_name   AS guest_name,
                r.room_number
             FROM invoices i
             JOIN bookings b ON i.booking_id = b.booking_id
             LEFT JOIN members m ON b.member_id = m.member_id
             JOIN rooms r ON b.room_id = r.room_id
             ${where}
             ORDER BY i.invoice_date DESC, i.invoice_id DESC`,
            params
        );

        res.json({ success: true, count: result.rows.length, data: result.rows });
    } catch (error) {
        console.error("getInvoices Error:", error.message);
        res.status(500).json({ success: false, message: "เกิดข้อผิดพลาดในการดึงรายการบิล" });
    }
};

// ==========================================
// 2.5 ดูบิลของตัวเอง (getMyInvoices) — Tenant
//    GET /my-invoices?status=
//    คืนเฉพาะบิลของผู้เช่าที่ล็อกอินอยู่ (ผ่าน booking.member_id)
// ==========================================
exports.getMyInvoices = async (req, res) => {
    const { status } = req.query;

    try {
        // เงื่อนไขหลัก: บิลที่ผูกกับ booking ของ user คนนี้
        const params = [req.user.id];
        let where = `WHERE b.member_id = $1`;
        if (status) {
            params.push(status);
            where += ` AND i.invoice_status = $${params.length}`;
        }

        const result = await pool.query(
            `SELECT
                i.invoice_id, i.booking_id, i.invoice_date, i.due_date,
                i.room_cost, i.water_cost, i.elec_cost, i.total_amount, i.invoice_status,
                r.room_number
             FROM invoices i
             JOIN bookings b ON i.booking_id = b.booking_id
             JOIN rooms r ON b.room_id = r.room_id
             ${where}
             ORDER BY i.invoice_date DESC, i.invoice_id DESC`,
            params
        );

        res.json({ success: true, count: result.rows.length, data: result.rows });
    } catch (error) {
        console.error("getMyInvoices Error:", error.message);
        res.status(500).json({ success: false, message: "เกิดข้อผิดพลาดในการดึงบิลของคุณ" });
    }
};

// ==========================================
// 3. ดูบิลรายตัว (getInvoiceById) — Admin หรือเจ้าของบิล
//    GET /invoice/:id
// ==========================================
exports.getInvoiceById = async (req, res) => {
    const { id } = req.params;

    try {
        const invoice = await loadFullInvoice(pool, id);
        if (!invoice) {
            return res.status(404).json({ success: false, message: "ไม่พบใบแจ้งหนี้ที่ระบุ" });
        }

        // Ownership: ผู้เช่าดูได้เฉพาะของตัวเอง, Admin ดูได้หมด
        if (req.user.role !== "Admin" && invoice.member_id !== req.user.id) {
            return res.status(403).json({ success: false, message: "ไม่มีสิทธิ์ดูใบแจ้งหนี้นี้" });
        }

        res.json({ success: true, data: invoice });
    } catch (error) {
        console.error("getInvoiceById Error:", error.message);
        res.status(500).json({ success: false, message: "เกิดข้อผิดพลาดในการดึงใบแจ้งหนี้" });
    }
};

// ==========================================
// 4. เปิด/ดาวน์โหลด PDF (getInvoicePdf) — Admin หรือเจ้าของบิล
//    GET /invoice/:id/pdf
// ==========================================
exports.getInvoicePdf = async (req, res) => {
    const { id } = req.params;

    try {
        const invoice = await loadFullInvoice(pool, id);
        if (!invoice) {
            return res.status(404).json({ success: false, message: "ไม่พบใบแจ้งหนี้ที่ระบุ" });
        }

        if (req.user.role !== "Admin" && invoice.member_id !== req.user.id) {
            return res.status(403).json({ success: false, message: "ไม่มีสิทธิ์เปิดใบแจ้งหนี้นี้" });
        }

        const pdfBuffer = await buildInvoicePdf(invoice, "invoice");
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `inline; filename="invoice-${id}.pdf"`);
        res.send(pdfBuffer);
    } catch (error) {
        console.error("getInvoicePdf Error:", error.message);
        res.status(500).json({ success: false, message: "เกิดข้อผิดพลาดในการสร้าง PDF" });
    }
};

// ==========================================
// 5. แก้ไขบิล (updateInvoice) — Admin
//    PUT /invoice/:id  body: { due_date?, details?: [{item_name, quantity, unit_price}] }
//    คำนวณยอดใหม่จาก details · ล็อกถ้าบิล 'ชำระแล้ว' → 403
// ==========================================
exports.updateInvoice = async (req, res) => {
    const client = await pool.connect();
    const { id } = req.params;
    const { due_date, details } = req.body;

    try {
        await client.query("BEGIN");

        const invRes = await client.query(
            `SELECT invoice_id, invoice_status FROM invoices WHERE invoice_id = $1`,
            [id]
        );
        if (invRes.rows.length === 0) {
            await client.query("ROLLBACK");
            return res.status(404).json({ success: false, message: "ไม่พบใบแจ้งหนี้ที่ระบุ" });
        }

        // ล็อกบิลที่ชำระแล้ว — แก้ไม่ได้
        if (invRes.rows[0].invoice_status === "ชำระแล้ว") {
            await client.query("ROLLBACK");
            return res.status(403).json({ success: false, message: "บิลนี้ชำระแล้ว ไม่สามารถแก้ไขได้" });
        }

        // ถ้าส่ง details มา → แทนที่รายการเดิมทั้งหมดแล้วคำนวณยอดใหม่
        if (Array.isArray(details)) {
            let roomCost = 0, waterCost = 0, elecCost = 0;

            await client.query(`DELETE FROM invoice_details WHERE invoice_id = $1`, [id]);

            for (const d of details) {
                const qty = Number(d.quantity) || 0;
                const unitPrice = Number(d.unit_price) || 0;
                const subtotal = qty * unitPrice; // คำนวณ subtotal ฝั่ง server เสมอ

                await client.query(
                    `INSERT INTO invoice_details (invoice_id, item_name, quantity, unit_price, subtotal)
                     VALUES ($1, $2, $3, $4, $5)`,
                    [id, d.item_name, qty, unitPrice, subtotal]
                );

                // แยกยอดเข้า room/water/elec ตามชื่อรายการ (เพื่อเก็บลง header ให้สอดคล้อง)
                if (d.item_name && d.item_name.includes("น้ำ")) waterCost += subtotal;
                else if (d.item_name && d.item_name.includes("ไฟ")) elecCost += subtotal;
                else roomCost += subtotal;
            }

            const totalAmount = roomCost + waterCost + elecCost;
            await client.query(
                `UPDATE invoices SET
                    room_cost = $1, water_cost = $2, elec_cost = $3, total_amount = $4,
                    due_date = COALESCE($5, due_date)
                 WHERE invoice_id = $6`,
                [roomCost, waterCost, elecCost, totalAmount, due_date || null, id]
            );
        } else if (due_date) {
            // แก้แค่ due_date
            await client.query(`UPDATE invoices SET due_date = $1 WHERE invoice_id = $2`, [due_date, id]);
        }

        await client.query("COMMIT");

        const fullInvoice = await loadFullInvoice(pool, id);
        res.json({ success: true, data: fullInvoice, message: "แก้ไขใบแจ้งหนี้สำเร็จ" });

    } catch (error) {
        await client.query("ROLLBACK");
        console.error("updateInvoice Error:", error.message);
        res.status(400).json({ success: false, message: error.message });
    } finally {
        client.release();
    }
};

// ==========================================
// 6. ส่ง/ส่งซ้ำอีเมล (sendInvoiceEmail) — Admin
//    POST /invoice/:id/send
// ==========================================
exports.sendInvoiceEmail = async (req, res) => {
    const { id } = req.params;

    try {
        const invoice = await loadFullInvoice(pool, id);
        if (!invoice) {
            return res.status(404).json({ success: false, message: "ไม่พบใบแจ้งหนี้ที่ระบุ" });
        }

        const result = await emailInvoice(invoice);
        if (!result.sent) {
            return res.status(400).json({ success: false, message: result.message });
        }
        res.json({ success: true, message: result.message });
    } catch (error) {
        console.error("sendInvoiceEmail Error:", error.message);
        res.status(500).json({ success: false, message: "เกิดข้อผิดพลาดในการส่งอีเมล" });
    }
};

// ==========================================
// 7. ออกบิลรายเดือนยกชุด (generateMonthly) — Admin
//    POST /invoices/generate-monthly  body: { month? }
//    ออกบิลให้ทุกการจองรายเดือนที่ 'กำลังเข้าพัก' และยังไม่มีบิลในเดือนนั้น
// ==========================================
exports.generateMonthly = async (req, res) => {
    const month = req.body.month || getCurrentMonth();
    const invoiceDate = `${month}-01`;
    const dueDate = new Date(new Date(invoiceDate).getTime() + 7 * 86400000).toISOString().split("T")[0];

    try {
        // หาการจองรายเดือนที่กำลังเข้าพัก และยังไม่มีบิลในเดือนนี้
        const targetsRes = await pool.query(
            `SELECT b.booking_id, b.room_id, b.member_id, b.rent_type,
                    b.check_in_date, b.check_out_date,
                    r.room_price, r.price_monthly
             FROM bookings b
             JOIN rooms r ON b.room_id = r.room_id
             WHERE b.rent_type = 'monthly'
               AND b.booking_status = 'กำลังเข้าพัก'
               AND NOT EXISTS (
                   SELECT 1 FROM invoices i
                   WHERE i.booking_id = b.booking_id
                     AND to_char(i.invoice_date, 'YYYY-MM') = $1
                     AND i.invoice_status != 'ยกเลิก'
               )`,
            [month]
        );

        const created = [];

        // ออกบิลทีละการจอง (แต่ละบิลเป็น transaction ของตัวเอง)
        for (const booking of targetsRes.rows) {
            const client = await pool.connect();
            try {
                await client.query("BEGIN");
                const calc = await computeInvoice(client, booking, month);

                const invRes = await client.query(
                    `INSERT INTO invoices
                        (booking_id, invoice_date, due_date, room_cost, water_cost, elec_cost, total_amount, invoice_status)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, 'ยังไม่ชำระ')
                     RETURNING invoice_id`,
                    [booking.booking_id, invoiceDate, dueDate, calc.room_cost, calc.water_cost, calc.elec_cost, calc.total_amount]
                );
                const invoiceId = invRes.rows[0].invoice_id;

                for (const d of calc.details) {
                    await client.query(
                        `INSERT INTO invoice_details (invoice_id, item_name, quantity, unit_price, subtotal)
                         VALUES ($1, $2, $3, $4, $5)`,
                        [invoiceId, d.item_name, d.quantity, d.unit_price, d.subtotal]
                    );
                }

                await client.query("COMMIT");

                // ส่งอีเมลแนบ PDF (best-effort)
                const fullInvoice = await loadFullInvoice(pool, invoiceId);
                await emailInvoice(fullInvoice);
                created.push(invoiceId);
            } catch (err) {
                await client.query("ROLLBACK");
                console.error(`ออกบิล booking ${booking.booking_id} ไม่สำเร็จ:`, err.message);
            } finally {
                client.release();
            }
        }

        res.status(201).json({
            success: true,
            count: created.length,
            data: created,
            message: `ออกบิลรายเดือนสำเร็จ ${created.length} ใบ สำหรับเดือน ${month}`,
        });

    } catch (error) {
        console.error("generateMonthly Error:", error.message);
        res.status(500).json({ success: false, message: "เกิดข้อผิดพลาดในการออกบิลรายเดือน" });
    }
};

// export helper เพื่อให้ controller อื่น (เช่น booking checkIn) reuse ได้
exports._computeInvoice = computeInvoice;
exports._loadFullInvoice = loadFullInvoice;
