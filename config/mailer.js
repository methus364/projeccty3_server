// ส่งอีเมลแนบใบแจ้งหนี้ PDF — ใช้ Gmail SMTP ผ่าน nodemailer
// อ่านค่า MAIL_USER / MAIL_PASS จาก .env (App Password ของ Gmail)
// ใช้รูปแบบ fail-fast เหมือน config/secret.js: ถ้าลืมตั้งค่าจะหยุดทันทีเมื่อเรียกใช้งานจริง
const nodemailer = require("nodemailer");
require("dotenv").config();

const MAIL_USER = process.env.MAIL_USER;
const MAIL_PASS = process.env.MAIL_PASS;

// สร้าง transporter เพียงครั้งเดียว (lazy) เพื่อ reuse connection pool
let transporter = null;

function getTransporter() {
    // ตรวจค่า env ตอนใช้งานจริง — ไม่ throw ตอน require เพื่อให้ server ที่ยังไม่ใช้อีเมลรันได้
    if (!MAIL_USER || !MAIL_PASS) {
        throw new Error("ยังไม่ได้ตั้งค่า MAIL_USER / MAIL_PASS ใน server/.env (ต้องใช้ Gmail App Password)");
    }

    if (!transporter) {
        transporter = nodemailer.createTransport({
            service: "gmail",
            auth: { user: MAIL_USER, pass: MAIL_PASS },
            // เปิด connection pool — reuse การเชื่อมต่อ Gmail ไม่ต้อง handshake ใหม่ทุกครั้ง (ส่งเร็วขึ้น)
            pool: true,
            maxConnections: 3,
            maxMessages: 100,
            // ใส่ timeout กันค้างยาวเมื่อเจออีเมลมั่ว/Gmail อืด — เลิกรอไวขึ้น หน้าจอไม่ค้าง
            connectionTimeout: 10000, // รอเชื่อมต่อ SMTP สูงสุด 10 วิ
            greetingTimeout: 10000,   // รอ greeting จากเซิร์ฟเวอร์สูงสุด 10 วิ
            socketTimeout: 15000,     // ไม่มีข้อมูลวิ่งเกิน 15 วิ = ตัดทิ้ง
        });
    }
    return transporter;
}

// ส่งอีเมลพร้อมแนบไฟล์ PDF
// to: อีเมลผู้รับ, subject: หัวข้อ, text: ข้อความ, pdfBuffer: Buffer ของ PDF, filename: ชื่อไฟล์แนบ
async function sendInvoiceMail({ to, subject, text, pdfBuffer, filename }) {
    const mailer = getTransporter();
    await mailer.sendMail({
        from: `หอพัก Around Loei <${MAIL_USER}>`,
        to,
        subject,
        text,
        attachments: [
            { filename, content: pdfBuffer, contentType: "application/pdf" },
        ],
    });
}

// ส่งอีเมลข้อความธรรมดา (ไม่มีไฟล์แนบ) — ใช้กับอีเมลยืนยันการจอง
// to: อีเมลผู้รับ, subject: หัวข้อ, text: ข้อความ
async function sendMail({ to, subject, text }) {
    const mailer = getTransporter();
    await mailer.sendMail({
        from: `หอพัก Around Loei <${MAIL_USER}>`,
        to,
        subject,
        text,
    });
}

module.exports = { sendInvoiceMail, sendMail };
