// ============================================================
// อ่าน QR จากรูปสลิปโอนเงิน (best-effort) — Phase 5 USER_FLOWS
// ใช้ jimp ถอดรูปเป็น pixel RGBA แล้วให้ @paulmillr/qr อ่าน QR
// เป็นแค่ตัวช่วยให้ Admin ดูประกอบตอนตรวจ — ไม่ใช่การยืนยันกับธนาคารจริง
// ============================================================
const { decodeQR } = require("@paulmillr/qr/decode.js");
const { Jimp } = require("jimp");

// แยกโครง EMVCo TLV (tag 2 หลัก + length 2 หลัก + value ตาม length)
function parseTLV(s) {
    const out = [];
    let i = 0;
    while (i + 4 <= s.length) {
        const tag = s.slice(i, i + 2);
        const len = parseInt(s.slice(i + 2, i + 4), 10);
        if (Number.isNaN(len) || i + 4 + len > s.length) break;
        out.push({ tag, len, value: s.slice(i + 4, i + 4 + len) });
        i += 4 + len;
    }
    return out;
}

// พยายามอ่านยอดเงินจาก EMVCo tag '54' (ถ้า QR เป็นรูปแบบ PromptPay/EMVCo)
function parseEmvAmount(text) {
    const f = parseTLV(text).find((t) => t.tag === "54");
    return f ? (Number(f.value) || null) : null;
}

// ถอด QR จาก buffer รูป → คืนข้อความ QR ดิบ (หรือ null ถ้าไม่พบ QR / อ่านไม่ได้)
async function decodeImageQr(buffer) {
    try {
        const img = await Jimp.read(buffer);
        return decodeQR({
            width: img.bitmap.width,
            height: img.bitmap.height,
            data: img.bitmap.data,
        }) || null;
    } catch (err) {
        console.error("อ่าน QR สลิปไม่สำเร็จ:", err.message);
        return null;
    }
}

// อ่าน QR จาก buffer รูปสลิป → คืนข้อความ QR (พร้อมยอดเงินถ้าอ่านได้)
// คืน null ถ้าอ่านไม่ได้ (ไม่ throw — ให้การอัปสลิปทำงานต่อได้เสมอ)
async function readSlipQr(buffer) {
    const text = await decodeImageQr(buffer);
    if (!text) return null;
    const amount = parseEmvAmount(text);
    return amount != null ? `${text} | ยอดที่อ่านได้: ${amount} บาท` : text;
}

// ตรวจว่ารูปที่อัปเป็น "สลิปโอนเงินไทย" จริงไหม (เช็คโครงสร้าง QR ตรวจสอบสลิปมาตรฐาน ITMX)
// สลิปโอนเงินมาตรฐานไทย QR จะมี: ประเทศ "TH" + รหัสธนาคารต้นทาง (3 หลัก) + เลขอ้างอิงรายการ (ref)
// คืน { ok, reason, qrText, bankCode, transRef }
async function verifySlipImage(buffer) {
    const text = await decodeImageQr(buffer);
    if (!text) {
        return { ok: false, reason: "ไม่พบ QR ในรูปที่แนบ — รูปนี้อาจไม่ใช่สลิปโอนเงิน" };
    }

    const fields = parseTLV(text);
    const hasCountryTH = fields.some((f) => f.value === "TH"); // ประเทศไทย (tag 51/58)

    // เลขอ้างอิง + รหัสธนาคาร อยู่ใน sub-field ของ tag '00'
    let bankCode = null;
    let transRef = null;
    const t00 = fields.find((f) => f.tag === "00");
    if (t00) {
        const sub = parseTLV(t00.value);
        const bank = sub.find((s) => /^\d{3}$/.test(s.value));  // รหัสธนาคาร 3 หลัก
        const ref = sub.find((s) => s.value.length >= 10);      // เลขอ้างอิงรายการ
        if (bank) bankCode = bank.value;
        if (ref) transRef = ref.value;
    }

    // เป็นสลิปโอนเงินจริง = มีทั้งประเทศ TH และเลขอ้างอิงรายการ
    if (!hasCountryTH || !transRef) {
        return { ok: false, reason: "QR ในรูปไม่ใช่รูปแบบสลิปโอนเงินของไทย กรุณาแนบสลิปการโอนที่ถูกต้อง" };
    }

    const amount = parseEmvAmount(text);
    const qrText = amount != null ? `${text} | ยอดที่อ่านได้: ${amount} บาท` : text;
    return { ok: true, qrText, bankCode, transRef };
}

module.exports = { readSlipQr, verifySlipImage };
