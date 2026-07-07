// ============================================================
// อ่าน QR จากรูปสลิปโอนเงิน (best-effort) — Phase 5 USER_FLOWS
// ใช้ jimp ถอดรูปเป็น pixel RGBA แล้วให้ @paulmillr/qr อ่าน QR
// เป็นแค่ตัวช่วยให้ Admin ดูประกอบตอนตรวจ — ไม่ใช่การยืนยันกับธนาคารจริง
// ============================================================
const { decodeQR } = require("@paulmillr/qr/decode.js");
const { Jimp } = require("jimp");

// พยายามอ่านยอดเงินจาก EMVCo tag '54' (ถ้า QR เป็นรูปแบบ PromptPay/EMVCo)
// EMVCo เก็บข้อมูลแบบ TLV: tag(2 หลัก) + length(2 หลัก) + value(ตาม length)
function parseEmvAmount(text) {
    let i = 0;
    while (i + 4 <= text.length) {
        const tag = text.slice(i, i + 2);
        const len = parseInt(text.slice(i + 2, i + 4), 10);
        if (Number.isNaN(len)) break;
        const value = text.slice(i + 4, i + 4 + len);
        if (tag === "54") return Number(value) || null; // tag 54 = จำนวนเงิน
        i += 4 + len;
    }
    return null;
}

// อ่าน QR จาก buffer รูปสลิป → คืนข้อความ QR (พร้อมยอดเงินถ้าอ่านได้)
// คืน null ถ้าอ่านไม่ได้ (ไม่ throw — ให้การอัปสลิปทำงานต่อได้เสมอ)
async function readSlipQr(buffer) {
    try {
        const img = await Jimp.read(buffer);
        const text = decodeQR({
            width: img.bitmap.width,
            height: img.bitmap.height,
            data: img.bitmap.data,
        });
        if (!text) return null;

        const amount = parseEmvAmount(text);
        // เก็บเป็นข้อความอ่านง่าย: ถ้ามียอดเงินให้ต่อท้ายไว้ให้ Admin เห็นชัด
        return amount != null ? `${text} | ยอดที่อ่านได้: ${amount} บาท` : text;
    } catch (err) {
        console.error("อ่าน QR สลิปไม่สำเร็จ:", err.message);
        return null;
    }
}

module.exports = { readSlipQr };
