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

// Brevo (Sendinblue) HTTP API — ส่งอีเมลผ่าน HTTPS (พอร์ต 443)
// จำเป็นเพราะ Render บล็อก outbound SMTP (พอร์ต 25/465/587) การส่งผ่าน SMTP จึง connect timeout
// ถ้าตั้ง BREVO_API_KEY จะใช้ Brevo เป็นหลัก (โปรดัคชัน) — ถ้าไม่ตั้งจะ fallback ไป SMTP (ใช้ตอน dev)
const BREVO_API_KEY = process.env.BREVO_API_KEY;
// Resend HTTP API — ทางเลือกที่ใช้ได้ทันทีหลังสมัคร (ไม่มีด่านรอ activation แบบ Brevo)
// ถ้าไม่ verify โดเมน จะส่งได้เฉพาะอีเมลเจ้าของบัญชี และ from ต้องเป็น onboarding@resend.dev
const RESEND_API_KEY = process.env.RESEND_API_KEY;
// Mailjet HTTP API — ฟรี ส่งหาอีเมลใครก็ได้โดย verify แค่ "อีเมลผู้ส่ง" (ไม่ต้องมีโดเมน)
// ต้องมีทั้ง API key (public) และ Secret key
const MAILJET_API_KEY = process.env.MAILJET_API_KEY;
const MAILJET_SECRET_KEY = process.env.MAILJET_SECRET_KEY;
// อีเมลผู้ส่ง — ต้องเป็น sender ที่ verify แล้ว (Mailjet/Brevo) / Resend ยังไม่ verify โดเมน = onboarding@resend.dev
const MAIL_FROM = process.env.MAIL_FROM || MAIL_USER;
const MAIL_FROM_NAME = "หอพัก Around Loei";

// ส่งอีเมลผ่าน Mailjet HTTP API (https://api.mailjet.com/v3.1/send)
// verify แค่อีเมลผู้ส่ง ก็ส่งหาผู้รับใครก็ได้ (ไม่ต้องมีโดเมน)
async function sendViaMailjet({ to, subject, text, attachments }) {
    if (!MAIL_FROM) {
        throw new Error("ยังไม่ได้ตั้งค่า MAIL_FROM / MAIL_USER (อีเมลผู้ส่งที่ verify ใน Mailjet)");
    }

    const message = {
        From: { Email: MAIL_FROM, Name: MAIL_FROM_NAME },
        To: [{ Email: to }],
        Subject: subject,
        TextPart: text,
    };
    if (attachments && attachments.length) {
        message.Attachments = attachments.map((a) => ({
            ContentType: a.contentType || "application/octet-stream",
            Filename: a.filename,
            Base64Content: Buffer.isBuffer(a.content) ? a.content.toString("base64") : Buffer.from(a.content).toString("base64"),
        }));
    }

    // auth แบบ Basic: base64(APIKEY:SECRETKEY)
    const auth = Buffer.from(`${MAILJET_API_KEY}:${MAILJET_SECRET_KEY}`).toString("base64");
    const payload = JSON.stringify({ Messages: [message] });

    // retry เมื่อเจอ network error (ECONNRESET/fetch failed) — บน Render ต่อ Mailjet ถูกรีเซ็ตเป็นครั้งคราว
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 20000);
        try {
            const res = await fetch("https://api.mailjet.com/v3.1/send", {
                method: "POST",
                headers: {
                    Authorization: `Basic ${auth}`,
                    "Content-Type": "application/json",
                },
                body: payload,
                signal: controller.signal,
            });
            if (!res.ok) {
                const detail = await res.text().catch(() => "");
                throw new Error(`Mailjet API ${res.status}: ${detail.slice(0, 300)}`);
            }
            return res.json().catch(() => ({}));
        } catch (err) {
            lastErr = err;
            // ถ้าเป็น HTTP error (ไม่ใช่ network) ไม่ต้อง retry — โยนทันที
            if (String(err.message || "").startsWith("Mailjet API ")) throw err;
            console.error(`Mailjet attempt ${attempt + 1} network error:`, err?.cause?.code || err?.message);
            await new Promise((r) => setTimeout(r, 1200));
        } finally {
            clearTimeout(timer);
        }
    }
    throw lastErr;
}

// ส่งอีเมลผ่าน Resend HTTP API (https://api.resend.com/emails)
async function sendViaResend({ to, subject, text, attachments }) {
    // ยังไม่ verify โดเมน → from ต้องเป็น onboarding@resend.dev (ตั้ง RESEND_FROM ทับได้ถ้ามีโดเมนแล้ว)
    const from = process.env.RESEND_FROM || `${MAIL_FROM_NAME} <onboarding@resend.dev>`;
    const body = { from, to: [to], subject, text };
    if (attachments && attachments.length) {
        body.attachments = attachments.map((a) => ({
            filename: a.filename,
            content: Buffer.isBuffer(a.content) ? a.content.toString("base64") : Buffer.from(a.content).toString("base64"),
        }));
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    let res;
    try {
        res = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${RESEND_API_KEY}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timer);
    }

    if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`Resend API ${res.status}: ${detail.slice(0, 300)}`);
    }
    return res.json().catch(() => ({}));
}

// ส่งอีเมลผ่าน Brevo HTTP API
// รองรับไฟล์แนบ (Brevo รับเป็น base64 ผ่านฟิลด์ attachment[].content)
async function sendViaBrevo({ to, subject, text, attachments }) {
    if (!MAIL_FROM) {
        throw new Error("ยังไม่ได้ตั้งค่า MAIL_FROM / MAIL_USER (อีเมลผู้ส่งที่ verify ใน Brevo)");
    }

    const body = {
        sender: { name: MAIL_FROM_NAME, email: MAIL_FROM },
        to: [{ email: to }],
        subject,
        textContent: text,
    };
    if (attachments && attachments.length) {
        body.attachment = attachments.map((a) => ({
            name: a.filename,
            content: Buffer.isBuffer(a.content) ? a.content.toString("base64") : Buffer.from(a.content).toString("base64"),
        }));
    }

    // ใส่ timeout กันค้าง — ใช้ AbortController (Node 18+)
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    let res;
    try {
        res = await fetch("https://api.brevo.com/v3/smtp/email", {
            method: "POST",
            headers: {
                "api-key": BREVO_API_KEY,
                "Content-Type": "application/json",
                accept: "application/json",
            },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timer);
    }

    if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`Brevo API ${res.status}: ${detail.slice(0, 300)}`);
    }
    return res.json().catch(() => ({}));
}

// resolve smtp.gmail.com เป็น IPv4 เอง แล้วต่อตรงไปที่ IP นั้น
// เหตุผล: บน Render การตั้ง family:4 / ipv4first ของ nodemailer ยังหลุดไปต่อ IPv6
// (ENETUNREACH 2404:6800:...:465) — การ resolve IPv4 เองแล้วใช้ IP เป็น host คือทางที่ชัวร์สุด
// พร้อมตั้ง tls.servername = smtp.gmail.com เพื่อให้ใบรับรอง TLS ยัง verify ผ่าน
const dnsp = require("dns").promises;
const SMTP_HOST = "smtp.gmail.com";

async function resolveIpv4(host) {
    try {
        const addrs = await dnsp.resolve4(host);
        if (addrs && addrs.length) {
            // สุ่มเลือก IP — Gmail มีหลาย IP บางตัวอาจถูก throttle/ต่อช้าจาก Render
            // การสุ่มทำให้ retry แต่ละรอบมีโอกาสเจอ IP ที่ต่อติด
            return addrs[Math.floor(Math.random() * addrs.length)];
        }
    } catch (_) { /* ตกไปใช้ lookup family:4 ด้านล่าง */ }
    // สำรอง: lookup แบบบังคับ IPv4
    const { address } = await dnsp.lookup(host, { family: 4 });
    return address;
}

// สร้าง transporter สำหรับพอร์ตที่ระบุ (ไม่ cache — ปริมาณอีเมลน้อย สร้างใหม่ทุกครั้งเสถียรกว่า)
// port 465 = SSL ตรง (secure:true), port 587 = STARTTLS (secure:false + requireTLS)
async function buildTransporter(port) {
    if (!MAIL_USER || !MAIL_PASS) {
        throw new Error("ยังไม่ได้ตั้งค่า MAIL_USER / MAIL_PASS ใน server/.env (ต้องใช้ Gmail App Password)");
    }

    const ipv4 = await resolveIpv4(SMTP_HOST);
    return nodemailer.createTransport({
        host: ipv4,           // ใช้ IPv4 ตรงๆ — เลี่ยง ENETUNREACH ผ่าน IPv6 บน Render
        port,
        secure: port === 465, // 465 = SSL, 587 = STARTTLS
        requireTLS: port === 587,
        auth: { user: MAIL_USER, pass: MAIL_PASS },
        tls: { servername: SMTP_HOST }, // host เป็น IP จึงต้องบอกชื่อโดเมนจริงให้ TLS ตรวจใบรับรอง
        family: 4,
        pool: false,
        connectionTimeout: 15000, // รอเชื่อมต่อ SMTP สูงสุด 15 วิ
        greetingTimeout: 15000,
        socketTimeout: 20000,
    });
}

// ส่งอีเมลพร้อม retry + สลับพอร์ต — Render ต่อ Gmail หลุด/ช้าเป็นครั้งคราว และบางพอร์ตอาจถูกบล็อก
// ลองสลับ 465 → 587 → 465 (แต่ละครั้งสุ่ม IP ใหม่ด้วย) เพื่อเพิ่มโอกาสต่อติด
async function sendWithRetry(mailOptions) {
    const portSequence = [465, 587, 465];
    let lastErr;
    for (let i = 0; i < portSequence.length; i++) {
        const port = portSequence[i];
        try {
            const mailer = await buildTransporter(port);
            const info = await mailer.sendMail(mailOptions);
            mailer.close();
            return info;
        } catch (err) {
            lastErr = err;
            console.error(`sendMail attempt ${i + 1} (port ${port}) failed:`, err && err.message);
            if (i < portSequence.length - 1) await new Promise((r) => setTimeout(r, 1000));
        }
    }
    throw lastErr;
}

// ส่งอีเมลพร้อมแนบไฟล์ PDF
// to: อีเมลผู้รับ, subject: หัวข้อ, text: ข้อความ, pdfBuffer: Buffer ของ PDF, filename: ชื่อไฟล์แนบ
async function sendInvoiceMail({ to, subject, text, pdfBuffer, filename }) {
    const attachments = [{ filename, content: pdfBuffer, contentType: "application/pdf" }];
    // ลำดับ: Mailjet → Resend → Brevo → SMTP (dev) — ตัวไหนตั้ง key ไว้ใช้ตัวนั้น
    if (MAILJET_API_KEY && MAILJET_SECRET_KEY) return void (await sendViaMailjet({ to, subject, text, attachments }));
    if (RESEND_API_KEY) return void (await sendViaResend({ to, subject, text, attachments }));
    if (BREVO_API_KEY) return void (await sendViaBrevo({ to, subject, text, attachments }));
    await sendWithRetry({ from: `${MAIL_FROM_NAME} <${MAIL_USER}>`, to, subject, text, attachments });
}

// ส่งอีเมลข้อความธรรมดา (ไม่มีไฟล์แนบ) — ใช้กับอีเมลยืนยันการจอง / OTP
// to: อีเมลผู้รับ, subject: หัวข้อ, text: ข้อความ
async function sendMail({ to, subject, text }) {
    if (MAILJET_API_KEY && MAILJET_SECRET_KEY) return void (await sendViaMailjet({ to, subject, text }));
    if (RESEND_API_KEY) return void (await sendViaResend({ to, subject, text }));
    if (BREVO_API_KEY) return void (await sendViaBrevo({ to, subject, text }));
    await sendWithRetry({ from: `${MAIL_FROM_NAME} <${MAIL_USER}>`, to, subject, text });
}

module.exports = { sendInvoiceMail, sendMail };
