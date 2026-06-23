const pool = require("../config/db");
const { _loadFullInvoice, _calculateLateFee } = require("./invoice");
const { buildInvoicePdf } = require("../utils/invoicePdf");
const { buildPromptpayQr } = require("../utils/promptpayQr");
const { sendInvoiceMail } = require("../config/mailer");
const { uploadSlip } = require("../config/supabase");
const { setAuditUser } = require("../utils/audit");

// ==========================================
// Helper: รวมยอดที่ "ยืนยันแล้ว" ของบิล + อัปเดต invoice_status ให้สอดคล้อง
//   - ยอดยืนยัน >= ยอดบิล → 'ชำระแล้ว'
//   - ยอดยืนยัน > 0        → 'ชำระบางส่วน'
//   - ยอดยืนยัน = 0        → 'ยังไม่ชำระ'
// คืน { status, paidSum, total }
// db = client (อยู่ใน transaction)
// ==========================================
async function recomputeInvoiceStatus(db, invoiceId) {
    // 1. ยอดรวมเฉพาะการชำระที่ยืนยันแล้ว
    const sumRes = await db.query(
        `SELECT COALESCE(SUM(amount_paid), 0) AS paid_sum
         FROM payments
         WHERE invoice_id = $1 AND payment_status = 'ยืนยันแล้ว'`,
        [invoiceId]
    );
    const paidSum = Number(sumRes.rows[0].paid_sum) || 0;

    // 2. ยอดบิลทั้งหมด
    const invRes = await db.query(
        `SELECT total_amount FROM invoices WHERE invoice_id = $1`,
        [invoiceId]
    );
    const total = Number(invRes.rows[0].total_amount) || 0;

    // 3. ตัดสินสถานะใหม่
    let status;
    if (paidSum >= total && total > 0) {
        status = "ชำระแล้ว";
    } else if (paidSum > 0) {
        status = "ชำระบางส่วน";
    } else {
        status = "ยังไม่ชำระ";
    }

    await db.query(
        `UPDATE invoices SET invoice_status = $1 WHERE invoice_id = $2`,
        [status, invoiceId]
    );

    return { status, paidSum, total };
}

// ==========================================
// Helper: gen ใบเสร็จ PDF + ส่งอีเมล (best-effort — ไม่ throw)
// payment: { payment_id, payment_method, payment_date }
// ==========================================
async function emailReceipt(invoice, payment) {
    if (!invoice.guest_email) {
        return { sent: false, message: "ผู้เช่าไม่มีอีเมล — ข้ามการส่งใบเสร็จ" };
    }
    try {
        // ใส่ข้อมูลการชำระลง invoice object เพื่อให้ PDF โหมด receipt ใช้ออกเลข/วันที่
        const receiptData = {
            ...invoice,
            payment_id: payment.payment_id,
            payment_method: payment.payment_method,
            payment_date: payment.payment_date,
        };
        const pdfBuffer = await buildInvoicePdf(receiptData, "receipt");
        const year = new Date(invoice.invoice_date).getFullYear();
        await sendInvoiceMail({
            to: invoice.guest_email,
            subject: `ใบเสร็จรับเงินหอพัก Around Loei (เลขที่ REC-${year}-${String(payment.payment_id).padStart(4, "0")})`,
            text: `เรียนคุณ ${invoice.guest_name || ""}\n\nหอพักได้รับชำระเงินค่าเช่าห้อง ${invoice.room_number} เรียบร้อยแล้ว แนบใบเสร็จมาด้วย ขอบคุณค่ะ`,
            pdfBuffer,
            filename: `receipt-${payment.payment_id}.pdf`,
        });
        return { sent: true, message: "ส่งใบเสร็จทางอีเมลแล้ว" };
    } catch (err) {
        console.error("ส่งใบเสร็จไม่สำเร็จ:", err.message);
        return { sent: false, message: "ยืนยันชำระสำเร็จ แต่ส่งใบเสร็จไม่สำเร็จ: " + err.message };
    }
}

// ==========================================
// 1. ขอ QR PromptPay สำหรับชำระบิล — Admin หรือเจ้าของบิล
//    GET /invoice/:id/promptpay
// ==========================================
exports.getPromptpayQr = async (req, res) => {
    const { id } = req.params;

    try {
        const invoice = await _loadFullInvoice(pool, id);
        if (!invoice) {
            return res.status(404).json({ success: false, message: "ไม่พบใบแจ้งหนี้ที่ระบุ" });
        }

        // Ownership: ผู้เช่าขอ QR ได้เฉพาะบิลของตัวเอง
        if (req.user.role !== "Admin" && invoice.member_id !== req.user.id) {
            return res.status(403).json({ success: false, message: "ไม่มีสิทธิ์เข้าถึงบิลนี้" });
        }

        // คิดยอดคงเหลือที่ต้องชำระ (ยอดบิล + ค่าปรับล่าช้า − ที่ยืนยันแล้ว)
        const sumRes = await pool.query(
            `SELECT COALESCE(SUM(amount_paid), 0) AS paid_sum
             FROM payments WHERE invoice_id = $1 AND payment_status = 'ยืนยันแล้ว'`,
            [id]
        );
        const lateFee = invoice.invoice_status !== 'ชำระแล้ว' ? _calculateLateFee(invoice.due_date) : 0;
        const remaining = Number(invoice.total_amount) + lateFee - Number(sumRes.rows[0].paid_sum);
        const qr = await buildPromptpayQr(remaining > 0 ? remaining : 0);

        res.json({
            success: true,
            data: {
                qrImage: qr.dataUrl,
                promptpayId: qr.promptpayId,
                amount: qr.amount,
                invoiceId: Number(id),
                late_fee: lateFee,
            },
        });
    } catch (error) {
        console.error("getPromptpayQr Error:", error.message);
        res.status(500).json({ success: false, message: error.message });
    }
};

// ==========================================
// 2. แจ้งชำระเงิน / บันทึกการชำระ — Tenant (แจ้งโอน) หรือ Admin (บันทึกเงินสด)
//    POST /payment  (multipart/form-data)
//    fields: invoice_id, amount_paid?, payment_method?  + ไฟล์ slip (optional)
//    - เงินสดโดย Admin → ยืนยันทันที, ที่เหลือ → 'รอตรวจ'
// ==========================================
exports.createPayment = async (req, res) => {
    const client = await pool.connect();
    const { invoice_id, amount_paid, payment_method } = req.body;
    const method = payment_method || "โอนเงิน";

    if (!invoice_id) {
        client.release();
        return res.status(400).json({ success: false, message: "กรุณาระบุ invoice_id" });
    }

    try {
        await client.query("BEGIN");
        await setAuditUser(client, req.user?.id); // M10b: บันทึกผู้ทำลง audit log

        // ล็อก invoice row ก่อนอ่าน+เขียน เพื่อกัน race condition ชำระพร้อมกัน
        await client.query(`SELECT invoice_id FROM invoices WHERE invoice_id = $1 FOR UPDATE`, [invoice_id]);

        // 1. โหลดบิล + เจ้าของ (ไว้เช็คสิทธิ์ + คิดยอดคงเหลือ)
        const invoice = await _loadFullInvoice(client, invoice_id);
        if (!invoice) throw new Error("ไม่พบใบแจ้งหนี้ที่ระบุ");

        // Ownership: ผู้เช่าแจ้งชำระได้เฉพาะบิลของตัวเอง
        if (req.user.role !== "Admin" && invoice.member_id !== req.user.id) {
            await client.query("ROLLBACK");
            return res.status(403).json({ success: false, message: "ไม่มีสิทธิ์ชำระบิลนี้" });
        }

        if (invoice.invoice_status === "ชำระแล้ว") {
            await client.query("ROLLBACK");
            return res.status(400).json({ success: false, message: "บิลนี้ชำระครบแล้ว" });
        }

        // 2. ยอดที่ชำระ — ถ้าไม่ส่งมาให้ default = ยอดคงเหลือ (คำนวณฝั่ง server)
        const sumRes = await client.query(
            `SELECT COALESCE(SUM(amount_paid), 0) AS paid_sum
             FROM payments WHERE invoice_id = $1 AND payment_status = 'ยืนยันแล้ว'`,
            [invoice_id]
        );
        const remaining = Number(invoice.total_amount) - Number(sumRes.rows[0].paid_sum);
        const payAmount = amount_paid != null ? Number(amount_paid) : remaining;

        if (!(payAmount > 0)) {
            await client.query("ROLLBACK");
            return res.status(400).json({ success: false, message: "จำนวนเงินที่ชำระต้องมากกว่า 0" });
        }

        // 3. อัปโหลดสลิป (ถ้าแนบมา) ขึ้น Supabase Storage → เก็บเป็น URL
        let evidenceUrl = null;
        if (req.file) {
            evidenceUrl = await uploadSlip(req.file.buffer, req.file.originalname, req.file.mimetype);
        }

        // 4. เงินสดที่ Admin บันทึก = ยืนยันทันที, นอกนั้นรอตรวจสลิป
        const isCashByAdmin = req.user.role === "Admin" && method === "เงินสด";
        const paymentStatus = isCashByAdmin ? "ยืนยันแล้ว" : "รอตรวจ";

        const payRes = await client.query(
            `INSERT INTO payments (invoice_id, payment_method, amount_paid, payment_evidence, payment_status)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING payment_id, invoice_id, payment_date, payment_method, amount_paid, payment_evidence, payment_status`,
            [invoice_id, method, payAmount, evidenceUrl, paymentStatus]
        );
        const payment = payRes.rows[0];

        // 5. ถ้ายืนยันทันที (เงินสด) → อัปเดตสถานะบิล + ออกใบเสร็จถ้าชำระครบ
        let receiptMsg = "";
        if (isCashByAdmin) {
            const result = await recomputeInvoiceStatus(client, invoice_id);
            await client.query("COMMIT");
            if (result.status === "ชำระแล้ว") {
                const fullInvoice = await _loadFullInvoice(pool, invoice_id);
                const mail = await emailReceipt(fullInvoice, payment);
                receiptMsg = " " + mail.message;
            }
        } else {
            await client.query("COMMIT");
        }

        res.status(201).json({
            success: true,
            data: payment,
            message: (isCashByAdmin ? "บันทึกการชำระเงินสำเร็จ" : "แจ้งชำระเงินสำเร็จ รอแอดมินตรวจสอบ") + receiptMsg,
        });

    } catch (error) {
        await client.query("ROLLBACK");
        console.error("createPayment Error:", error.message);
        res.status(400).json({ success: false, message: error.message });
    } finally {
        client.release();
    }
};

// ==========================================
// 3. ยืนยัน/ปฏิเสธการชำระ — Admin
//    PUT /payment/:id/verify  body: { action: 'approve' | 'reject' }
//    approve → 'ยืนยันแล้ว' + คิดสถานะบิลใหม่ (ชำระครบ → ออกใบเสร็จ)
//    reject  → 'ปฏิเสธ'
// ==========================================
exports.verifyPayment = async (req, res) => {
    const client = await pool.connect();
    const { id } = req.params;
    const { action } = req.body;

    if (!["approve", "reject"].includes(action)) {
        client.release();
        return res.status(400).json({ success: false, message: "action ต้องเป็น approve หรือ reject" });
    }

    try {
        await client.query("BEGIN");
        await setAuditUser(client, req.user?.id); // M10b: บันทึกผู้ทำลง audit log

        // ล็อก payment row + invoice row เพื่อกัน admin 2 คนยืนยันพร้อมกัน
        const payRes = await client.query(
            `SELECT payment_id, invoice_id, payment_status FROM payments WHERE payment_id = $1 FOR UPDATE`,
            [id]
        );
        if (payRes.rows.length === 0) {
            await client.query("ROLLBACK");
            return res.status(404).json({ success: false, message: "ไม่พบรายการชำระเงินที่ระบุ" });
        }
        const invoiceId = payRes.rows[0].invoice_id;
        // ล็อก invoice ด้วยเพื่อกัน recomputeInvoiceStatus ชนกัน
        await client.query(`SELECT invoice_id FROM invoices WHERE invoice_id = $1 FOR UPDATE`, [invoiceId]);

        // อัปเดตสถานะการชำระตาม action
        const newStatus = action === "approve" ? "ยืนยันแล้ว" : "ปฏิเสธ";
        await client.query(
            `UPDATE payments SET payment_status = $1 WHERE payment_id = $2`,
            [newStatus, id]
        );

        // คิดสถานะบิลใหม่จากยอดที่ยืนยันแล้วทั้งหมด
        const result = await recomputeInvoiceStatus(client, invoiceId);

        await client.query("COMMIT");

        // ชำระครบ → ออกใบเสร็จ + ส่งอีเมล (หลัง commit, best-effort)
        let receiptMsg = "";
        if (action === "approve" && result.status === "ชำระแล้ว") {
            const fullInvoice = await _loadFullInvoice(pool, invoiceId);
            const payInfo = await pool.query(
                `SELECT payment_id, payment_method, payment_date FROM payments WHERE payment_id = $1`,
                [id]
            );
            const mail = await emailReceipt(fullInvoice, payInfo.rows[0]);
            receiptMsg = " " + mail.message;
        }

        res.json({
            success: true,
            data: { payment_id: Number(id), payment_status: newStatus, invoice_status: result.status },
            message: (action === "approve" ? "ยืนยันการชำระเงินสำเร็จ" : "ปฏิเสธการชำระเงินแล้ว") + receiptMsg,
        });

    } catch (error) {
        await client.query("ROLLBACK");
        console.error("verifyPayment Error:", error.message);
        res.status(400).json({ success: false, message: error.message });
    } finally {
        client.release();
    }
};

// ==========================================
// 4. ดูรายการชำระเงินทั้งหมด — Admin
//    GET /payments?status=&invoice_id=
// ==========================================
exports.getPayments = async (req, res) => {
    const { status, invoice_id } = req.query;

    try {
        // ประกอบเงื่อนไข filter แบบ dynamic
        const conditions = [];
        const params = [];

        if (status) {
            params.push(status);
            conditions.push(`p.payment_status = $${params.length}`);
        }
        if (invoice_id) {
            params.push(invoice_id);
            conditions.push(`p.invoice_id = $${params.length}`);
        }
        const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

        const result = await pool.query(
            `SELECT
                p.payment_id, p.invoice_id, p.payment_date, p.payment_method,
                p.amount_paid, p.payment_evidence, p.payment_status,
                i.total_amount, i.invoice_status,
                m.full_name AS guest_name,
                r.room_number
             FROM payments p
             JOIN invoices i ON p.invoice_id = i.invoice_id
             JOIN bookings b ON i.booking_id = b.booking_id
             LEFT JOIN members m ON b.member_id = m.member_id
             JOIN rooms r ON b.room_id = r.room_id
             ${where}
             ORDER BY p.payment_date DESC, p.payment_id DESC`,
            params
        );

        res.json({ success: true, count: result.rows.length, data: result.rows });
    } catch (error) {
        console.error("getPayments Error:", error.message);
        res.status(500).json({ success: false, message: "เกิดข้อผิดพลาดในการดึงรายการชำระเงิน" });
    }
};

// ==========================================
// 5. ดูประวัติการชำระของตัวเอง — Tenant
//    GET /my-payments
// ==========================================
exports.getMyPayments = async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT
                p.payment_id, p.invoice_id, p.payment_date, p.payment_method,
                p.amount_paid, p.payment_evidence, p.payment_status,
                i.total_amount, i.invoice_status,
                r.room_number
             FROM payments p
             JOIN invoices i ON p.invoice_id = i.invoice_id
             JOIN bookings b ON i.booking_id = b.booking_id
             JOIN rooms r ON b.room_id = r.room_id
             WHERE b.member_id = $1
             ORDER BY p.payment_date DESC, p.payment_id DESC`,
            [req.user.id]
        );

        res.json({ success: true, count: result.rows.length, data: result.rows });
    } catch (error) {
        console.error("getMyPayments Error:", error.message);
        res.status(500).json({ success: false, message: "เกิดข้อผิดพลาดในการดึงประวัติการชำระเงิน" });
    }
};
