const pool = require("../config/db");
const { _loadFullInvoice, _calculateLateFee } = require("./invoice");
const { buildInvoicePdf } = require("../utils/invoicePdf");
const { buildPromptpayQr } = require("../utils/promptpayQr");
const { sendInvoiceMail } = require("../config/mailer");
const { uploadSlip } = require("../config/supabase");
const { createPromptPayCharge, retrieveCharge } = require("../config/omise");
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

// ==========================================
// Helper: ยืนยันการชำระ 1 รายการให้เป็น 'ยืนยันแล้ว' (ใช้ร่วมกันระหว่าง poll + webhook)
// ทำใน transaction + idempotent (ถ้ายืนยันแล้วไม่ทำซ้ำ) + ออกใบเสร็จถ้าชำระครบ
// คืน { status } = สถานะบิลล่าสุด
// ==========================================
async function confirmPaymentPaid(paymentId) {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        // ล็อก payment row กันยืนยันซ้ำพร้อมกัน (poll + webhook มาพร้อมกัน)
        const payRes = await client.query(
            `SELECT payment_id, invoice_id, payment_status FROM payments WHERE payment_id = $1 FOR UPDATE`,
            [paymentId]
        );
        if (payRes.rows.length === 0) {
            await client.query("ROLLBACK");
            return { status: null, notFound: true };
        }
        const pay = payRes.rows[0];

        // ยืนยันไปแล้ว → ไม่ทำซ้ำ (idempotent)
        if (pay.payment_status === "ยืนยันแล้ว") {
            await client.query("ROLLBACK");
            return { status: "ยืนยันแล้ว", already: true };
        }

        await client.query(`SELECT invoice_id FROM invoices WHERE invoice_id = $1 FOR UPDATE`, [pay.invoice_id]);
        await client.query(`UPDATE payments SET payment_status = 'ยืนยันแล้ว' WHERE payment_id = $1`, [paymentId]);
        const result = await recomputeInvoiceStatus(client, pay.invoice_id);

        // จ่ายครบ → ยืนยันการจองที่ผูกกับบิลนี้อัตโนมัติ (แบบ Agoda: จ่ายเสร็จ = จองยืนยัน)
        if (result.status === "ชำระแล้ว") {
            await client.query(
                `UPDATE bookings SET booking_status = 'ยืนยันการจอง'
                 WHERE booking_id = (SELECT booking_id FROM invoices WHERE invoice_id = $1)
                   AND booking_status = 'รอชำระมัดจำ'`,
                [pay.invoice_id]
            );
        }

        await client.query("COMMIT");

        // ชำระครบ → ออกใบเสร็จ + ส่งอีเมล (best-effort หลัง commit)
        if (result.status === "ชำระแล้ว") {
            const fullInvoice = await _loadFullInvoice(pool, pay.invoice_id);
            const payInfo = await pool.query(
                `SELECT payment_id, payment_method, payment_date FROM payments WHERE payment_id = $1`,
                [paymentId]
            );
            await emailReceipt(fullInvoice, payInfo.rows[0]);
        }
        return { status: result.status };
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
}

// ==========================================
// 6. สร้าง QR PromptPay แบบยืนยันอัตโนมัติผ่าน Omise — Tenant/Admin
//    POST /invoice/:id/qr-charge
//    สร้าง charge + payment row (รอตรวจ) แล้วคืนรูป QR ให้สแกน
// ==========================================
exports.createQrCharge = async (req, res) => {
    const client = await pool.connect();
    const { id } = req.params;

    try {
        await client.query("BEGIN");
        await setAuditUser(client, req.user?.id);

        // ล็อกบิล + โหลดข้อมูล
        await client.query(`SELECT invoice_id FROM invoices WHERE invoice_id = $1 FOR UPDATE`, [id]);
        const invoice = await _loadFullInvoice(client, id);
        if (!invoice) throw new Error("ไม่พบใบแจ้งหนี้ที่ระบุ");

        // Ownership: ผู้เช่าจ่ายได้เฉพาะบิลของตัวเอง
        if (req.user.role !== "Admin" && invoice.member_id !== req.user.id) {
            await client.query("ROLLBACK");
            return res.status(403).json({ success: false, message: "ไม่มีสิทธิ์ชำระบิลนี้" });
        }
        if (invoice.invoice_status === "ชำระแล้ว") {
            await client.query("ROLLBACK");
            return res.status(400).json({ success: false, message: "บิลนี้ชำระครบแล้ว" });
        }

        // คิดยอดคงเหลือที่ต้องจ่าย (ยอดบิล + ค่าปรับล่าช้า − ที่ยืนยันแล้ว)
        const sumRes = await client.query(
            `SELECT COALESCE(SUM(amount_paid), 0) AS paid_sum
             FROM payments WHERE invoice_id = $1 AND payment_status = 'ยืนยันแล้ว'`,
            [id]
        );
        const lateFee = invoice.invoice_status !== "ชำระแล้ว" ? _calculateLateFee(invoice.due_date) : 0;
        const remaining = Number(invoice.total_amount) + lateFee - Number(sumRes.rows[0].paid_sum);
        if (!(remaining > 0)) {
            await client.query("ROLLBACK");
            return res.status(400).json({ success: false, message: "ไม่มียอดค้างชำระสำหรับบิลนี้" });
        }

        // สร้าง payment row สถานะ 'รอตรวจ' ก่อน (จะได้ payment_id ไปแนบใน charge metadata)
        const payRes = await client.query(
            `INSERT INTO payments (invoice_id, payment_method, amount_paid, payment_status)
             VALUES ($1, 'PromptPay QR', $2, 'รอตรวจ')
             RETURNING payment_id`,
            [id, remaining]
        );
        const paymentId = payRes.rows[0].payment_id;

        // สร้าง charge กับ Omise (แนบ payment_id ไว้ match ตอนยืนยัน)
        const charge = await createPromptPayCharge(remaining, { payment_id: String(paymentId) });

        // เก็บ charge_id ไว้ใน payment_evidence เพื่อใช้ poll สถานะภายหลัง
        await client.query(
            `UPDATE payments SET payment_evidence = $1 WHERE payment_id = $2`,
            [charge.chargeId, paymentId]
        );

        await client.query("COMMIT");

        res.status(201).json({
            success: true,
            data: {
                paymentId,
                chargeId: charge.chargeId,
                qrImage: charge.qrImage,
                amount: remaining,
            },
            message: "สร้าง QR สำเร็จ กรุณาสแกนเพื่อชำระเงิน",
        });
    } catch (error) {
        await client.query("ROLLBACK");
        console.error("createQrCharge Error:", error.message);
        res.status(400).json({ success: false, message: error.message });
    } finally {
        client.release();
    }
};

// ==========================================
// 7. ตรวจสถานะการจ่าย QR (poll) — Tenant/Admin
//    GET /payment/:id/qr-status
//    ถาม Omise ว่า charge นี้จ่ายสำเร็จหรือยัง ถ้าจ่ายแล้ว → ยืนยันอัตโนมัติ
// ==========================================
exports.pollQrStatus = async (req, res) => {
    const { id } = req.params;

    try {
        // โหลด payment + เจ้าของ (เช็คสิทธิ์)
        const payRes = await pool.query(
            `SELECT p.payment_id, p.payment_status, p.payment_evidence, b.member_id
             FROM payments p
             JOIN invoices i ON p.invoice_id = i.invoice_id
             JOIN bookings b ON i.booking_id = b.booking_id
             WHERE p.payment_id = $1 LIMIT 1`,
            [id]
        );
        if (payRes.rows.length === 0) {
            return res.status(404).json({ success: false, message: "ไม่พบรายการชำระเงิน" });
        }
        const pay = payRes.rows[0];

        if (req.user.role !== "Admin" && pay.member_id !== req.user.id) {
            return res.status(403).json({ success: false, message: "ไม่มีสิทธิ์เข้าถึงรายการนี้" });
        }

        // ยืนยันไปแล้ว → ตอบเลย
        if (pay.payment_status === "ยืนยันแล้ว") {
            return res.json({ success: true, data: { payment_status: "ยืนยันแล้ว", paid: true } });
        }

        // ถาม Omise ว่าจ่ายหรือยัง
        const chargeId = pay.payment_evidence;
        const charge = await retrieveCharge(chargeId);

        if (charge.paid) {
            const result = await confirmPaymentPaid(pay.payment_id);
            return res.json({ success: true, data: { payment_status: "ยืนยันแล้ว", paid: true, invoice_status: result.status } });
        }

        res.json({ success: true, data: { payment_status: pay.payment_status, paid: false } });
    } catch (error) {
        console.error("pollQrStatus Error:", error.message);
        res.status(400).json({ success: false, message: error.message });
    }
};

// ==========================================
// 8. Webhook รับ event จาก Omise — ไม่มี auth (Omise เรียกจากภายนอก)
//    POST /payment/omise-webhook
//    เมื่อ charge.complete + จ่ายสำเร็จ → ยืนยัน payment อัตโนมัติ (ใช้ตอน deploy จริง)
// ==========================================
exports.omiseWebhook = async (req, res) => {
    try {
        const event = req.body;
        const charge = event?.data;

        // สนใจเฉพาะ event ที่เป็น charge จ่ายสำเร็จ
        const isPaidCharge = charge?.object === "charge" && charge?.status === "successful" && charge?.paid === true;
        const paymentId = charge?.metadata?.payment_id;

        if (isPaidCharge && paymentId) {
            await confirmPaymentPaid(Number(paymentId));
        }

        // ตอบ 200 เสมอ เพื่อไม่ให้ Omise ส่งซ้ำ (การทำงานจริง idempotent อยู่แล้ว)
        res.json({ success: true });
    } catch (error) {
        console.error("omiseWebhook Error:", error.message);
        res.json({ success: true }); // ตอบ 200 กัน retry ถล่ม — log ไว้ตรวจเอง
    }
};

// ==========================================
// 9. จ่ายเงินตอนจอง (แบบ Agoda) — เฉพาะรายวัน — Tenant/Admin
//    POST /booking/:id/pay-now
//    สร้างบิลค่าห้องเต็มจำนวน + QR Omise ให้จ่ายทันที (จ่ายครบ → จองยืนยันอัตโนมัติ)
// ==========================================
exports.payBookingNow = async (req, res) => {
    const client = await pool.connect();
    const { id } = req.params;

    try {
        await client.query("BEGIN");
        await setAuditUser(client, req.user?.id);

        // โหลด+ล็อกการจอง พร้อมราคาห้อง
        const bkRes = await client.query(
            `SELECT b.booking_id, b.member_id, b.rent_type, b.booking_status,
                    b.check_in_date, b.check_out_date, r.room_price
             FROM bookings b JOIN rooms r ON b.room_id = r.room_id
             WHERE b.booking_id = $1 FOR UPDATE`,
            [id]
        );
        if (bkRes.rows.length === 0) throw new Error("ไม่พบการจองที่ระบุ");
        const bk = bkRes.rows[0];

        // เช็คสิทธิ์ + เงื่อนไข (จ่ายตอนจองเฉพาะรายวัน + ยังรอชำระ)
        if (req.user.role !== "Admin" && bk.member_id !== req.user.id) {
            await client.query("ROLLBACK");
            return res.status(403).json({ success: false, message: "ไม่มีสิทธิ์ชำระการจองนี้" });
        }
        if (bk.rent_type !== "daily") {
            await client.query("ROLLBACK");
            return res.status(400).json({ success: false, message: "จ่ายตอนจองรองรับเฉพาะห้องรายวัน (รายเดือนชำระตอนเช็คอิน)" });
        }
        if (bk.booking_status !== "รอชำระมัดจำ") {
            await client.query("ROLLBACK");
            return res.status(400).json({ success: false, message: `การจองนี้สถานะ "${bk.booking_status}" ไม่ต้องชำระซ้ำ` });
        }

        // คิดค่าห้องเต็มจำนวน (ราคา/วัน × จำนวนวัน)
        const nights = Math.ceil(Math.abs(new Date(bk.check_out_date) - new Date(bk.check_in_date)) / 86400000) || 1;
        const total = nights * Number(bk.room_price || 0);
        if (!(total > 0)) throw new Error("คำนวณยอดค่าห้องไม่ได้");

        // หาบิลเดิมของการจองนี้ (กันออกซ้ำ) — ถ้าไม่มีค่อยสร้างใหม่
        let invoiceId;
        const existInv = await client.query(
            `SELECT invoice_id FROM invoices WHERE booking_id = $1 AND invoice_status != 'ยกเลิก' LIMIT 1`,
            [id]
        );
        if (existInv.rows.length > 0) {
            invoiceId = existInv.rows[0].invoice_id;
        } else {
            const today = new Date().toISOString().split("T")[0];
            const invRes = await client.query(
                `INSERT INTO invoices
                    (booking_id, invoice_date, due_date, room_cost, water_cost, elec_cost, total_amount, invoice_status)
                 VALUES ($1, $2, $2, $3, 0, 0, $3, 'ยังไม่ชำระ')
                 RETURNING invoice_id`,
                [id, today, total]
            );
            invoiceId = invRes.rows[0].invoice_id;
            await client.query(
                `INSERT INTO invoice_details (invoice_id, item_name, quantity, unit_price, subtotal)
                 VALUES ($1, $2, $3, $4, $5)`,
                [invoiceId, `ค่าห้องพักรายวัน (${nights} วัน)`, nights, bk.room_price, total]
            );
        }

        // สร้าง payment row 'รอตรวจ' + charge Omise
        const payRes = await client.query(
            `INSERT INTO payments (invoice_id, payment_method, amount_paid, payment_status)
             VALUES ($1, 'PromptPay QR', $2, 'รอตรวจ')
             RETURNING payment_id`,
            [invoiceId, total]
        );
        const paymentId = payRes.rows[0].payment_id;

        const charge = await createPromptPayCharge(total, { payment_id: String(paymentId) });
        await client.query(`UPDATE payments SET payment_evidence = $1 WHERE payment_id = $2`, [charge.chargeId, paymentId]);

        await client.query("COMMIT");

        res.status(201).json({
            success: true,
            data: { paymentId, invoiceId, chargeId: charge.chargeId, qrImage: charge.qrImage, amount: total },
            message: "สร้าง QR สำหรับชำระค่าจองสำเร็จ",
        });
    } catch (error) {
        await client.query("ROLLBACK");
        console.error("payBookingNow Error:", error.message);
        res.status(400).json({ success: false, message: error.message });
    } finally {
        client.release();
    }
};

// export helper เผื่อเขียน test
exports._confirmPaymentPaid = confirmPaymentPaid;
