// เชื่อม Omise (Opn Payments) สำหรับ PromptPay QR แบบยืนยันอัตโนมัติ
// อ่าน OMISE_PUBLIC_KEY / OMISE_SECRET_KEY จาก .env (degrade graceful แบบเดียวกับ mailer/supabase)
// ถ้ายังไม่ตั้งค่า → throw ตอนใช้งานจริง (controller จับ error แล้วแจ้งผู้ใช้)
require("dotenv").config();

const OMISE_PUBLIC_KEY = process.env.OMISE_PUBLIC_KEY;
const OMISE_SECRET_KEY = process.env.OMISE_SECRET_KEY;

let client = null;

// สร้าง client เพียงครั้งเดียว (lazy) — ตรวจ env ตอนใช้งานจริง
function getOmise() {
    if (!OMISE_PUBLIC_KEY || !OMISE_SECRET_KEY) {
        throw new Error("ยังไม่ได้ตั้งค่า OMISE_PUBLIC_KEY / OMISE_SECRET_KEY ใน server/.env (สำหรับชำระเงินผ่าน QR อัตโนมัติ)");
    }
    if (!client) {
        client = require("omise")({
            publicKey: OMISE_PUBLIC_KEY,
            secretKey: OMISE_SECRET_KEY,
        });
    }
    return client;
}

// สร้าง charge แบบ PromptPay QR
// amountBaht: ยอดเงิน (บาท), metadata: ข้อมูลแนบไว้ match ตอน confirm (เช่น payment_id)
// คืน { chargeId, qrImage, amount, status }
async function createPromptPayCharge(amountBaht, metadata) {
    const omise = getOmise();

    // Omise คิดเงินเป็นสตางค์ (satang) — คูณ 100
    const amountSatang = Math.round(Number(amountBaht) * 100);

    // 1. สร้าง source แบบ promptpay
    const source = await omise.sources.create({
        type: "promptpay",
        amount: amountSatang,
        currency: "thb",
    });

    // 2. สร้าง charge จาก source นั้น
    const charge = await omise.charges.create({
        amount: amountSatang,
        currency: "thb",
        source: source.id,
        metadata: metadata || {},
    });

    // URL รูป QR ที่ให้ผู้เช่าสแกน (อยู่ใน source.scannable_code)
    const qrImage = charge.source?.scannable_code?.image?.download_uri || null;

    return {
        chargeId: charge.id,
        qrImage,
        amount: amountBaht,
        status: charge.status, // 'pending' ตอนเพิ่งสร้าง
    };
}

// ดึงสถานะ charge ล่าสุดจาก Omise (ใช้ตอน poll ว่าจ่ายสำเร็จหรือยัง)
// คืน { status, paid } — paid=true เมื่อจ่ายเงินสำเร็จแล้ว
async function retrieveCharge(chargeId) {
    const omise = getOmise();
    const charge = await omise.charges.retrieve(chargeId);
    return { status: charge.status, paid: charge.paid === true && charge.status === "successful" };
}

module.exports = { createPromptPayCharge, retrieveCharge };
