// เลข PromptPay ของหอพัก — อ่านจาก .env (เบอร์มือถือ/เลขบัตรประชาชน/เลขนิติบุคคล)
// ใช้แบบ fail-fast ตอนใช้งานจริง: ถ้ายังไม่ตั้งค่าจะ throw เมื่อมีคนกดสร้าง QR
require("dotenv").config();

const PROMPTPAY_ID = process.env.PROMPTPAY_ID;

// ตรวจค่าตอนใช้งานจริง (ไม่ throw ตอน require เพื่อให้ส่วนอื่นของ server รันได้)
function getPromptpayId() {
    if (!PROMPTPAY_ID) {
        throw new Error("ยังไม่ได้ตั้งค่า PROMPTPAY_ID ใน server/.env (เบอร์/เลขบัตรของหอพักสำหรับรับเงิน)");
    }
    return PROMPTPAY_ID;
}

module.exports = { getPromptpayId };
