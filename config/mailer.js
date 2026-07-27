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
// SendGrid HTTP API — Render ต่อได้ (Mailjet ต่อไม่ได้) ส่งหาอีเมลใครก็ได้ โดย verify แค่ single sender
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
// SMTP2GO HTTP API — Render ต่อได้ สมัครง่าย (ไม่ค่อยแบน) ส่งหาอีเมลใครก็ได้ โดย verify แค่ผู้ส่ง
const SMTP2GO_API_KEY = process.env.SMTP2GO_API_KEY;
// อีเมลผู้ส่ง — ต้องเป็น sender ที่ verify แล้ว (Mailjet/Brevo) / Resend ยังไม่ verify โดเมน = onboarding@resend.dev
const MAIL_FROM = process.env.MAIL_FROM || MAIL_USER;
const MAIL_FROM_NAME = "หอพัก Around Loei";

// ส่งอีเมลผ่าน SMTP2GO HTTP API (https://api.smtp2go.com/v3/email/send)
// verify แค่ผู้ส่ง ก็ส่งหาผู้รับใครก็ได้ (ไม่ต้องมีโดเมน) — ใช้ https+IPv4 ที่ Render ต่อได้
async function sendViaSmtp2go({ to, subject, text, attachments }) {
    if (!MAIL_FROM) {
        throw new Error("ยังไม่ได้ตั้งค่า MAIL_FROM / MAIL_USER (อีเมลผู้ส่งที่ verify ใน SMTP2GO)");
    }

    const body = {
        api_key: SMTP2GO_API_KEY,
        sender: `${MAIL_FROM_NAME} <${MAIL_FROM}>`,
        to: [to],
        subject,
        text_body: text,
    };
    if (attachments && attachments.length) {
        body.attachments = attachments.map((a) => ({
            filename: a.filename,
            fileblob: Buffer.isBuffer(a.content) ? a.content.toString("base64") : Buffer.from(a.content).toString("base64"),
            mimetype: a.contentType || "application/octet-stream",
        }));
    }

    const headers = { "Content-Type": "application/json", Accept: "application/json", "User-Agent": "AroundLoei-Server/1.0" };

    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const res = await postJsonIpv4("https://api.smtp2go.com/v3/email/send", headers, JSON.stringify(body));
            let data = {};
            try { data = JSON.parse(res.text || "{}"); } catch (_) { /* ignore */ }
            // SMTP2GO ตอบ 200 พร้อม data.succeeded — ถ้า succeeded < 1 ถือว่าไม่สำเร็จ
            if (res.status < 200 || res.status >= 300 || !(data?.data?.succeeded >= 1)) {
                throw new Error(`SMTP2GO API ${res.status}: ${String(res.text).slice(0, 300)}`);
            }
            return data;
        } catch (err) {
            lastErr = err;
            if (String(err.message || "").startsWith("SMTP2GO API ")) throw err;
            console.error(`SMTP2GO attempt ${attempt + 1} network error:`, err?.code || err?.message);
            await new Promise((r) => setTimeout(r, 1200));
        }
    }
    throw lastErr;
}

// ส่งอีเมลผ่าน SendGrid HTTP API (https://api.sendgrid.com/v3/mail/send)
// verify แค่ single sender ก็ส่งหาผู้รับใครก็ได้ (ไม่ต้องมีโดเมน) — ใช้ https+IPv4 ที่ Render ต่อได้
async function sendViaSendgrid({ to, subject, text, attachments }) {
    if (!MAIL_FROM) {
        throw new Error("ยังไม่ได้ตั้งค่า MAIL_FROM / MAIL_USER (single sender ที่ verify ใน SendGrid)");
    }

    const body = {
        personalizations: [{ to: [{ email: to }] }],
        from: { email: MAIL_FROM, name: MAIL_FROM_NAME },
        subject,
        content: [{ type: "text/plain", value: text }],
    };
    if (attachments && attachments.length) {
        body.attachments = attachments.map((a) => ({
            content: Buffer.isBuffer(a.content) ? a.content.toString("base64") : Buffer.from(a.content).toString("base64"),
            filename: a.filename,
            type: a.contentType || "application/octet-stream",
            disposition: "attachment",
        }));
    }

    const headers = {
        Authorization: `Bearer ${SENDGRID_API_KEY}`,
        "Content-Type": "application/json",
        "User-Agent": "AroundLoei-Server/1.0",
    };

    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const res = await postJsonIpv4("https://api.sendgrid.com/v3/mail/send", headers, JSON.stringify(body));
            // SendGrid ส่งสำเร็จ = 202 Accepted (ไม่มี body)
            if (res.status < 200 || res.status >= 300) {
                throw new Error(`SendGrid API ${res.status}: ${String(res.text).slice(0, 300)}`);
            }
            return {};
        } catch (err) {
            lastErr = err;
            if (String(err.message || "").startsWith("SendGrid API ")) throw err;
            console.error(`SendGrid attempt ${attempt + 1} network error:`, err?.code || err?.message);
            await new Promise((r) => setTimeout(r, 1200));
        }
    }
    throw lastErr;
}

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
    const headers = {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
        // บาง WAF หน้า Mailjet รีเซ็ตคำขอที่ไม่มี User-Agent (คำขอจาก cloud server) — ใส่ให้ดูเหมือน client ปกติ
        "User-Agent": "AroundLoei-Server/1.0",
        Accept: "application/json",
    };

    // retry เมื่อเจอ network error (ECONNRESET ฯลฯ) — ใช้ https + IPv4 เลี่ยงปัญหา IPv6 บน Render
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const res = await postJsonIpv4("https://api.mailjet.com/v3.1/send", headers, payload);
            if (res.status < 200 || res.status >= 300) {
                throw new Error(`Mailjet API ${res.status}: ${String(res.text).slice(0, 300)}`);
            }
            return JSON.parse(res.text || "{}");
        } catch (err) {
            lastErr = err;
            // ถ้าเป็น HTTP error (ไม่ใช่ network) ไม่ต้อง retry — โยนทันที
            if (String(err.message || "").startsWith("Mailjet API ")) throw err;
            console.error(`Mailjet attempt ${attempt + 1} network error:`, err?.code || err?.message);
            await new Promise((r) => setTimeout(r, 1200));
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
const https = require("https");
const SMTP_HOST = "smtp.gmail.com";

// POST JSON ผ่าน Node https module โดยบังคับ IPv4 (family:4)
// เหตุผล: undici/fetch บน Render พยายามต่อ IPv6 ไปบาง API (เช่น Mailjet) แล้วถูกรีเซ็ต (ECONNRESET)
// https.request + family:4 ต่อ IPv4 ตรงๆ พร้อม SNI ที่ถูกต้อง เลี่ยงปัญหานี้
function postJsonIpv4(urlStr, headers, bodyStr) {
    return new Promise((resolve, reject) => {
        const u = new URL(urlStr);
        const data = Buffer.from(bodyStr);
        const req = https.request(
            {
                host: u.hostname,
                path: u.pathname + u.search,
                method: "POST",
                family: 4,
                headers: { ...headers, "Content-Length": data.length },
                timeout: 20000,
            },
            (res) => {
                let chunks = "";
                res.setEncoding("utf8");
                res.on("data", (c) => (chunks += c));
                res.on("end", () => resolve({ status: res.statusCode, text: chunks }));
            }
        );
        req.on("error", reject);
        req.on("timeout", () => req.destroy(new Error("Request timeout")));
        req.write(data);
        req.end();
    });
}

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
    // ลำดับ: SMTP2GO → SendGrid → Resend → Mailjet → Brevo → SMTP (dev) — ตัวไหนตั้ง key ไว้ใช้ตัวนั้น
    if (SMTP2GO_API_KEY) return void (await sendViaSmtp2go({ to, subject, text, attachments }));
    if (SENDGRID_API_KEY) return void (await sendViaSendgrid({ to, subject, text, attachments }));
    if (RESEND_API_KEY) return void (await sendViaResend({ to, subject, text, attachments }));
    if (MAILJET_API_KEY && MAILJET_SECRET_KEY) return void (await sendViaMailjet({ to, subject, text, attachments }));
    if (BREVO_API_KEY) return void (await sendViaBrevo({ to, subject, text, attachments }));
    await sendWithRetry({ from: `${MAIL_FROM_NAME} <${MAIL_USER}>`, to, subject, text, attachments });
}

// ส่งอีเมลข้อความธรรมดา (ไม่มีไฟล์แนบ) — ใช้กับอีเมลยืนยันการจอง / OTP
// to: อีเมลผู้รับ, subject: หัวข้อ, text: ข้อความ
async function sendMail({ to, subject, text }) {
    if (SMTP2GO_API_KEY) return void (await sendViaSmtp2go({ to, subject, text }));
    if (SENDGRID_API_KEY) return void (await sendViaSendgrid({ to, subject, text }));
    if (RESEND_API_KEY) return void (await sendViaResend({ to, subject, text }));
    if (MAILJET_API_KEY && MAILJET_SECRET_KEY) return void (await sendViaMailjet({ to, subject, text }));
    if (BREVO_API_KEY) return void (await sendViaBrevo({ to, subject, text }));
    await sendWithRetry({ from: `${MAIL_FROM_NAME} <${MAIL_USER}>`, to, subject, text });
}

module.exports = { sendInvoiceMail, sendMail };
