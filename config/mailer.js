// ส่งอีเมลแนบใบแจ้งหนี้ PDF — ใช้ Gmail SMTP ผ่าน nodemailer
// อ่านค่า MAIL_USER / MAIL_PASS จาก .env (App Password ของ Gmail)
// ใช้รูปแบบ fail-fast เหมือน config/secret.js: ถ้าลืมตั้งค่าจะหยุดทันทีเมื่อเรียกใช้งานจริง
const nodemailer = require("nodemailer");
const dns = require("dns");
require("dotenv").config();

// บังคับให้ Node เลือก IPv4 ก่อนเสมอเมื่อ resolve ชื่อโฮสต์
// เหตุผล: Render ต่อ IPv6 ออกไป smtp.gmail.com ไม่ได้ (ENETUNREACH)
// การตั้งค่านี้ครอบทั้ง process จึงชัวร์กว่า option family:4 ของ nodemailer
dns.setDefaultResultOrder("ipv4first");

const MAIL_USER = process.env.MAIL_USER;
const MAIL_PASS = process.env.MAIL_PASS;

// สร้าง transporter เพียงครั้งเดียว (lazy) เพื่อ reuse connection pool
let transporter = null;

// resolve smtp.gmail.com เป็น IPv4 เอง แล้วต่อตรงไปที่ IP นั้น
// เหตุผล: บน Render การตั้ง family:4 / ipv4first ของ nodemailer ยังหลุดไปต่อ IPv6
// (ENETUNREACH 2404:6800:...:465) — การ resolve IPv4 เองแล้วใช้ IP เป็น host คือทางที่ชัวร์สุด
// พร้อมตั้ง tls.servername = smtp.gmail.com เพื่อให้ใบรับรอง TLS ยัง verify ผ่าน
const dnsp = require("dns").promises;
const SMTP_HOST = "smtp.gmail.com";

async function resolveIpv4(host) {
    try {
        const addrs = await dnsp.resolve4(host);
        if (addrs && addrs.length) return addrs[0];
    } catch (_) { /* ตกไปใช้ lookup family:4 ด้านล่าง */ }
    // สำรอง: lookup แบบบังคับ IPv4
    const { address } = await dnsp.lookup(host, { family: 4 });
    return address;
}

async function getTransporter() {
    // ตรวจค่า env ตอนใช้งานจริง — ไม่ throw ตอน require เพื่อให้ server ที่ยังไม่ใช้อีเมลรันได้
    if (!MAIL_USER || !MAIL_PASS) {
        throw new Error("ยังไม่ได้ตั้งค่า MAIL_USER / MAIL_PASS ใน server/.env (ต้องใช้ Gmail App Password)");
    }

    if (!transporter) {
        const ipv4 = await resolveIpv4(SMTP_HOST);
        // ระบุ host เป็น IPv4 ตรงๆ แทน service:"gmail" — เลี่ยงทั้งพอร์ตบล็อกและ IPv6
        // ใช้พอร์ต 465 (SSL) ซึ่ง Render อนุญาต outbound ได้ปกติ
        transporter = nodemailer.createTransport({
            host: ipv4,
            port: 465,
            secure: true,
            auth: { user: MAIL_USER, pass: MAIL_PASS },
            // host เป็น IP แล้ว จึงต้องบอกชื่อโดเมนจริงให้ TLS ตรวจใบรับรองให้ถูกต้อง
            tls: { servername: SMTP_HOST },
            family: 4,
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
    const mailer = await getTransporter();
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
    const mailer = await getTransporter();
    await mailer.sendMail({
        from: `หอพัก Around Loei <${MAIL_USER}>`,
        to,
        subject,
        text,
    });
}

module.exports = { sendInvoiceMail, sendMail };
