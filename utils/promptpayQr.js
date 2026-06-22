// สร้าง QR PromptPay สำหรับชำระบิล (gen สดทุกครั้งจากยอด + เลขหอพัก)
// ใช้ promptpay-qr (สร้าง payload ตามสเปก EMVCo) + qrcode (เรนเดอร์เป็นรูป)
const generatePayload = require("promptpay-qr");
const QRCode = require("qrcode");
const { getPromptpayId } = require("../config/promptpay");

// สร้าง QR เป็น Data URL (base64 PNG) — ฝั่ง web/mobile เอาไปใส่ <img src> ได้เลย
// amount: ยอดเงินที่ต้องชำระ (บาท)
// คืน { dataUrl, promptpayId, amount }
async function buildPromptpayQr(amount) {
    const promptpayId = getPromptpayId();
    const payAmount = Number(amount) || 0;

    // 1. สร้าง payload string ตามมาตรฐาน PromptPay
    const payload = generatePayload(promptpayId, { amount: payAmount });

    // 2. เรนเดอร์ payload เป็นรูป QR (Data URL)
    const dataUrl = await QRCode.toDataURL(payload, { width: 300, margin: 1 });

    return { dataUrl, promptpayId, amount: payAmount };
}

module.exports = { buildPromptpayQr };
