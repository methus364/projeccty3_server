const pool = require("../config/db");
const { _loadFullInvoice, _calculateLateFee } = require("./invoice");
const { buildInvoicePdf } = require("../utils/invoicePdf");
const { buildPromptpayQr } = require("../utils/promptpayQr");
const { sendInvoiceMail } = require("../config/mailer");
const { uploadSlip } = require("../config/supabase");
const { readSlipQr, verifySlipImage } = require("../utils/slipQr");
const { createPromptPayCharge, retrieveCharge } = require("../config/omise");
const { setAuditUser } = require("../utils/audit");
const { MONTHLY_LOCK_DEPOSIT } = require("../config/billing_rules");
const { WATER_RATE, ELEC_RATE } = require("../config/utility_rates");
const { buildPagination } = require("../utils/pagination");

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

    // 2. ยอดบิลทั้งหมด + ค่าปรับล่าช้า (ถ้ายังไม่ชำระแล้วและเลย due_date) — ต้องรวมด้วย ไม่งั้นจ่ายแค่ยอดบิลเดิมก็ปิด "ชำระแล้ว" ได้ทั้งที่ค่าปรับยังไม่จ่าย
    const invRes = await db.query(
        `SELECT total_amount, due_date, invoice_status FROM invoices WHERE invoice_id = $1`,
        [invoiceId]
    );
    const inv = invRes.rows[0];
    const total = Number(inv.total_amount) || 0;
    const lateFee = inv.invoice_status !== "ชำระแล้ว" ? _calculateLateFee(inv.due_date) : 0;
    const totalDue = total + lateFee;

    // 3. ตัดสินสถานะใหม่ (เทียบกับยอดบิล + ค่าปรับ)
    let status;
    if (paidSum >= totalDue && totalDue > 0) {
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

    // จ่ายครบ → ยืนยันการจองที่ผูกกับบิลนี้อัตโนมัติ (ครอบทุกช่องทาง: อัปสลิป/เงินสด)
    if (status === "ชำระแล้ว") {
        await db.query(
            `UPDATE bookings SET booking_status = 'ยืนยันการจอง'
             WHERE booking_id = (SELECT booking_id FROM invoices WHERE invoice_id = $1)
               AND booking_status = 'รอชำระมัดจำ'`,
            [invoiceId]
        );
    }

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
        // เลือกชื่อเอกสารใบเสร็จตามประเภทการเช่า (USER_FLOWS)
        const receiptTitle = invoice.rent_type === "daily"
            ? "ใบเสร็จจองห้องรายวัน"
            : "ใบเสร็จจ่ายค่าห้องรายเดือน";

        // ใส่ข้อมูลการชำระลง invoice object เพื่อให้ PDF โหมด receipt ใช้ออกเลข/วันที่
        const receiptData = {
            ...invoice,
            payment_id: payment.payment_id,
            payment_method: payment.payment_method,
            payment_date: payment.payment_date,
            receipt_title: receiptTitle,
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

        // 2. ยอดที่ชำระ — ถ้าไม่ส่งมาให้ default = ยอดคงเหลือ + ค่าปรับล่าช้า (คำนวณฝั่ง server เหมือน getPromptpayQr/createQrCharge)
        const sumRes = await client.query(
            `SELECT COALESCE(SUM(amount_paid), 0) AS paid_sum
             FROM payments WHERE invoice_id = $1 AND payment_status = 'ยืนยันแล้ว'`,
            [invoice_id]
        );
        const lateFee = invoice.invoice_status !== "ชำระแล้ว" ? _calculateLateFee(invoice.due_date) : 0;
        const remaining = Number(invoice.total_amount) + lateFee - Number(sumRes.rows[0].paid_sum);
        const payAmount = amount_paid != null ? Number(amount_paid) : remaining;

        if (!(payAmount > 0)) {
            await client.query("ROLLBACK");
            return res.status(400).json({ success: false, message: "จำนวนเงินที่ชำระต้องมากกว่า 0" });
        }

        // 3. อัปโหลดสลิป (ถ้าแนบมา) ขึ้น Supabase Storage → เก็บเป็น URL
        //    + อ่าน QR ในรูปสลิป (best-effort) ไว้ช่วย Admin ตอนตรวจ
        let evidenceUrl = null;
        let slipQrData = null;
        if (req.file) {
            // จ่ายแบบ "โอนเงิน" → รูปที่แนบต้องเป็นสลิปโอนเงินจริง (มี QR ตรวจสอบสลิปมาตรฐานไทย)
            // กันแนบรูปมั่ว/รูปที่ไม่ใช่สลิป · จ่าย "เงินสด" (Admin แนบรูปเงินสด) ไม่ต้องมี QR ข้ามการเช็ค
            if (method === "โอนเงิน") {
                const slipCheck = await verifySlipImage(req.file.buffer);
                if (!slipCheck.ok) {
                    await client.query("ROLLBACK");
                    return res.status(400).json({ success: false, message: slipCheck.reason });
                }
                slipQrData = slipCheck.qrText;
            } else {
                slipQrData = await readSlipQr(req.file.buffer);
            }
            evidenceUrl = await uploadSlip(req.file.buffer, req.file.originalname, req.file.mimetype);
        }

        // 4. เงินสดที่ Admin บันทึก = ยืนยันทันที, นอกนั้นรอตรวจสลิป
        const isCashByAdmin = req.user.role === "Admin" && method === "เงินสด";

        // จ่ายสดที่ออฟฟิศต้องแนบรูปหลักฐาน (เงินสด/สลิป) เสมอ ก่อนยืนยัน (USER_FLOWS)
        if (isCashByAdmin && !req.file) {
            await client.query("ROLLBACK");
            return res.status(400).json({ success: false, message: "กรุณาแนบรูปเงินสด/สลิปเป็นหลักฐานก่อนบันทึกการชำระเงินสด" });
        }

        const paymentStatus = isCashByAdmin ? "ยืนยันแล้ว" : "รอตรวจ";

        const payRes = await client.query(
            `INSERT INTO payments (invoice_id, payment_method, amount_paid, payment_evidence, payment_status, slip_qr_data)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING payment_id, invoice_id, payment_date, payment_method, amount_paid, payment_evidence, payment_status, slip_qr_data`,
            [invoice_id, method, payAmount, evidenceUrl, paymentStatus, slipQrData]
        );
        const payment = payRes.rows[0];

        // 4.5 มีสลิป/การชำระส่งเข้ามาแล้ว → หยุดนาฬิกา hold + ยืนยันการจองทันที (ไม่รอ verify)
        //     ป้องกัน cron ยกเลิก booking ที่ส่งสลิปแล้ว (USER_FLOWS ข้อ 7)
        const bookingUpdate = await client.query(
            `UPDATE bookings SET booking_status = 'ยืนยันการจอง', hold_expires_at = NULL
             WHERE booking_id = (SELECT booking_id FROM invoices WHERE invoice_id = $1)
               AND booking_status = 'รอชำระมัดจำ'
             RETURNING booking_id`,
            [invoice_id]
        );
        // การชำระนี้ทำให้การจอง (รายวัน) เปลี่ยนจากรอชำระ → ยืนยันการจองหรือไม่
        const bookingConfirmed = bookingUpdate.rowCount > 0;

        // 5. ออกใบเสร็จ — รอส่งเมลให้เสร็จก่อนตอบหน้าจอ (การันตีเมลถูกส่งจริง ไม่พึ่ง cron)
        //    ตัว mailer เปิด connection pool + timeout ไว้แล้ว การส่งเลยเร็ว/ไม่ค้างยาว หน้าจอจึงเด้งไวตาม
        let receiptMsg = "";
        if (isCashByAdmin) {
            // เงินสด (admin) → คิดสถานะบิล + ออกใบเสร็จถ้าชำระครบ
            const result = await recomputeInvoiceStatus(client, invoice_id);
            await client.query("COMMIT");
            if (result.status === "ชำระแล้ว") {
                const fullInvoice = await _loadFullInvoice(pool, invoice_id);
                const mail = await emailReceipt(fullInvoice, payment);
                receiptMsg = " " + mail.message;
            }
        } else {
            await client.query("COMMIT");
            // ลูกค้าอัปสลิปแล้วการจองถูกยืนยัน → ออกใบเสร็จ + รายละเอียดการจอง ส่งอีเมลกลับทันที
            if (bookingConfirmed) {
                const fullInvoice = await _loadFullInvoice(pool, invoice_id);
                const mail = await emailReceipt(fullInvoice, payment);
                receiptMsg = " " + mail.message;
            }
        }

        res.status(201).json({
            success: true,
            data: payment,
            bookingConfirmed,
            // ยืนยันการจองแล้ว → บอกว่าออกใบเสร็จให้ · บิลอื่น (เช่นรายเดือน) → รอแอดมินตรวจ
            message: isCashByAdmin
                ? "บันทึกการชำระเงินสำเร็จ" + receiptMsg
                : (bookingConfirmed
                    ? "ชำระเงินสำเร็จ ยืนยันการจองและออกใบเสร็จให้แล้ว" + receiptMsg
                    : "แจ้งชำระเงินสำเร็จ รอแอดมินตรวจสอบ"),
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
//    GET /payments?status=&invoice_id=&rentType=daily|monthly
// ==========================================
exports.getPayments = async (req, res) => {
    const { status, invoice_id, rentType } = req.query;

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
        // แยกรายการชำระ/ใบเสร็จรายวัน-รายเดือน ไม่ปนกัน
        if (rentType === "daily" || rentType === "monthly") {
            params.push(rentType);
            conditions.push(`b.rent_type = $${params.length}`);
        }
        const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

        // แบ่งหน้า (ถ้า client ส่ง ?limit มา) — ไม่ส่งมา = คืนทั้งหมดเหมือนเดิม
        const page = buildPagination(req.query);
        let limitClause = "";
        if (page) {
            params.push(page.limit, page.offset);
            limitClause = `LIMIT $${params.length - 1} OFFSET $${params.length}`;
        }

        const result = await pool.query(
            `SELECT
                p.payment_id, p.invoice_id, p.payment_date, p.payment_method,
                p.amount_paid, p.payment_evidence, p.payment_status, p.slip_qr_data,
                i.total_amount, i.invoice_status,
                b.member_id, b.rent_type,
                m.full_name AS guest_name,
                r.room_number
             FROM payments p
             JOIN invoices i ON p.invoice_id = i.invoice_id
             JOIN bookings b ON i.booking_id = b.booking_id
             LEFT JOIN members m ON b.member_id = m.member_id
             JOIN rooms r ON b.room_id = r.room_id
             ${where}
             ORDER BY p.payment_date DESC, p.payment_id DESC
             ${limitClause}`,
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
             VALUES ($1, 'โอนเงิน', $2, 'รอตรวจ')
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
//    ความปลอดภัย: Omise ไม่มี signature header ให้ตรวจ (ต่างจาก Stripe) — จึงห้ามเชื่อ
//    status/paid/metadata ที่แนบมาใน body ตรงๆ เพราะใครก็ปลอมส่งมาได้ ต้องถามยืนยันกับ
//    Omise ผ่าน retrieveCharge (ใช้ secret key ของเรา) อีกทีก่อนยืนยันการจ่ายเงินทุกครั้ง
// ==========================================
exports.omiseWebhook = async (req, res) => {
    try {
        const chargeId = req.body?.data?.id;
        const isChargeEvent = req.body?.data?.object === "charge";

        if (isChargeEvent && chargeId) {
            const charge = await retrieveCharge(chargeId); // ยืนยันสถานะจริงกับ Omise
            const paymentId = charge.metadata?.payment_id;
            if (charge.paid && paymentId) {
                await confirmPaymentPaid(Number(paymentId));
            }
        }

        // ตอบ 200 เสมอ เพื่อไม่ให้ Omise ส่งซ้ำ (การทำงานจริง idempotent อยู่แล้ว)
        res.json({ success: true });
    } catch (error) {
        console.error("omiseWebhook Error:", error.message);
        res.json({ success: true }); // ตอบ 200 กัน retry ถล่ม — log ไว้ตรวจเอง
    }
};

// ==========================================
// 9. จ่ายเงินตอนจอง (แบบ Agoda) — Tenant/Admin
//    POST /booking/:id/pay-now
//    รายวัน  = คิดค่าห้องเต็มจำนวน (ราคา/วัน × จำนวนวัน)
//    รายเดือน = มัดจำล็อกห้องคงที่ 2,000 บาท (กันห้องก่อนไปเช็คอิน)
//    สร้างบิล + QR PromptPay ให้จ่ายทันที (แนบสลิป → จองยืนยันอัตโนมัติ)
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

        // เช็คสิทธิ์ + เงื่อนไข (จ่ายตอนจอง + ยังรอชำระ)
        if (req.user.role !== "Admin" && bk.member_id !== req.user.id) {
            await client.query("ROLLBACK");
            return res.status(403).json({ success: false, message: "ไม่มีสิทธิ์ชำระการจองนี้" });
        }
        if (bk.booking_status !== "รอชำระมัดจำ") {
            await client.query("ROLLBACK");
            return res.status(400).json({ success: false, message: `การจองนี้สถานะ "${bk.booking_status}" ไม่ต้องชำระซ้ำ` });
        }

        // คิดยอดที่ต้องจ่ายตอนจอง แยกตามประเภทเช่า
        // invoiceType: รายเดือน = แค่มัดจำล็อกห้อง ไม่ใช่บิลค่าห้องจริง (บิลจริงออกทีหลังผ่าน createInvoice)
        //              รายวัน = จ่ายเต็มจำนวนตอนนี้เลย ถือเป็นบิลค่าห้องจริง
        let total;
        let itemName;
        let quantity;
        let unitPrice;
        let invoiceType;
        if (bk.rent_type === "monthly") {
            // รายเดือน: มัดจำล็อกห้องคงที่ 2,000 บาท (ไม่ผูกกับราคาห้อง)
            total = MONTHLY_LOCK_DEPOSIT;
            itemName = "มัดจำล็อกห้องรายเดือน";
            quantity = 1;
            unitPrice = MONTHLY_LOCK_DEPOSIT;
            invoiceType = "deposit";
        } else {
            // รายวัน: ค่าห้องเต็มจำนวน (ราคา/วัน × จำนวนวัน)
            const nights = Math.ceil(Math.abs(new Date(bk.check_out_date) - new Date(bk.check_in_date)) / 86400000) || 1;
            total = nights * Number(bk.room_price || 0);
            itemName = `ค่าห้องพักรายวัน (${nights} วัน)`;
            quantity = nights;
            unitPrice = bk.room_price;
            invoiceType = "rent";
        }
        if (!(total > 0)) throw new Error("คำนวณยอดที่ต้องชำระไม่ได้");

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
                    (booking_id, invoice_date, due_date, room_cost, water_cost, elec_cost, total_amount, invoice_status, invoice_type)
                 VALUES ($1, $2, $2, $3, 0, 0, $3, 'ยังไม่ชำระ', $4)
                 RETURNING invoice_id`,
                [id, today, total, invoiceType]
            );
            invoiceId = invRes.rows[0].invoice_id;
            // เรียงรายการย่อยให้อ่านง่าย: ค่าน้ำ → ค่าไฟ → ค่าห้อง
            // ณ ตอนจอง/จ่ายล่วงหน้ายังไม่มีมิเตอร์จริง จึงใส่ค่าน้ำ/ไฟเป็น 0 หน่วยไว้ก่อน แล้วไปอัปเดตยอดจริงตอนออกบิลรายเดือน (computeInvoice)
            await client.query(
                `INSERT INTO invoice_details (invoice_id, item_name, quantity, unit_price, subtotal)
                 VALUES
                    ($1, 'ค่าน้ำ (0 หน่วย)', 0, $2, 0),
                    ($1, 'ค่าไฟ (0 หน่วย)', 0, $3, 0),
                    ($1, $4, $5, $6, $7)`,
                [invoiceId, WATER_RATE, ELEC_RATE, itemName, quantity, unitPrice, total]
            );
        }

        await client.query("COMMIT");

        // สร้าง QR PromptPay static (ฟรี ไม่ง้อ gateway) — ผู้เช่าสแกนโอนแล้วอัปสลิปทีหลัง
        const qr = await buildPromptpayQr(total);

        res.status(201).json({
            success: true,
            data: { invoiceId, qrImage: qr.dataUrl, promptpayId: qr.promptpayId, amount: total },
            message: "สร้าง QR สำหรับชำระค่าจองสำเร็จ กรุณาโอนแล้วแนบสลิป",
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
