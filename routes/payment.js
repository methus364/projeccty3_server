const express = require("express");
const router = express.Router();
const multer = require("multer");

const {
    getPromptpayQr,
    createPayment,
    verifyPayment,
    getPayments,
    getMyPayments,
} = require("../controllers/payment");
const { authCheck, adminCheck } = require("../middleweres/authCheck");

// รับไฟล์สลิปไว้ใน memory (แล้วส่งต่อขึ้น Supabase Storage) — จำกัด 5MB
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
});

// Admin: ดูรายการชำระทั้งหมด
router.get("/payments", authCheck, adminCheck, getPayments);

// Tenant: ดูประวัติการชำระของตัวเอง (ต้องวางก่อน '/payment/:id' กัน path ชน)
router.get("/my-payments", authCheck, getMyPayments);

// Admin: ยืนยัน/ปฏิเสธการชำระ
router.put("/payment/:id/verify", authCheck, adminCheck, verifyPayment);

// Tenant/Admin: แจ้งชำระ/บันทึกการชำระ (แนบสลิปได้ field ชื่อ 'slip')
router.post("/payment", authCheck, upload.single("slip"), createPayment);

// Admin หรือเจ้าของบิล: ขอ QR PromptPay (ownership check อยู่ใน controller)
router.get("/invoice/:id/promptpay", authCheck, getPromptpayQr);

module.exports = router;
