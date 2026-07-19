const express = require("express");
const router = express.Router();
const multer = require("multer");

const {
    getContracts,
    getMyContracts,
    getContractById,
    requestNotice,
    giveNotice,
    cancelNotice,
    settleContract,
    requestRenewal,
    renewContract,
    getContractHistory,
} = require("../controllers/contract");
const { authCheck, adminCheck, monthlyTenantCheck } = require("../middleweres/authCheck");

// รับไฟล์สัญญา (รูป/สแกน) ไว้ใน memory แล้วส่งขึ้น Supabase — จำกัด 5MB เฉพาะรูป
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith("image/")) cb(null, true);
        else cb(new Error("อัปโหลดได้เฉพาะไฟล์รูปภาพเท่านั้น"));
    },
});

// Tenant: ดูสัญญาของตัวเอง (ต้องวางก่อน '/contract/:id' กัน path ชน)
// เฉพาะผู้เช่ารายเดือนเท่านั้น — รายวันไม่มีสัญญาเช่า
router.get("/my-contracts", authCheck, monthlyTenantCheck, getMyContracts);

// Admin: ดูรายการสัญญา / เคลียร์คืนมัดจำ
router.get("/contracts", authCheck, adminCheck, getContracts);
router.post("/contract/:id/settle", authCheck, adminCheck, settleContract);

// แจ้งย้ายออก: ผู้เช่าขอ (รายเดือนเท่านั้น) → Admin ยืนยัน/ยกเลิก
router.post("/contract/:id/notice-request", authCheck, monthlyTenantCheck, requestNotice);
router.put("/contract/:id/notice", authCheck, adminCheck, giveNotice);
router.put("/contract/:id/notice/cancel", authCheck, adminCheck, cancelNotice);

// ต่อสัญญา: ผู้เช่าขอ (รายเดือนเท่านั้น) → Admin ต่อ (แนบไฟล์สัญญาใหม่ field 'contract_file')
router.post("/contract/:id/renew-request", authCheck, monthlyTenantCheck, requestRenewal);
router.put("/contract/:id/renew", authCheck, adminCheck, upload.single("contract_file"), renewContract);

// Admin หรือเจ้าของสัญญา: ดูประวัติ / ดูสัญญา (ownership check อยู่ใน controller
// อนุญาต Admin ด้วย จึงเช็คแค่ authCheck — role-scope จริงอยู่ในตัว controller แล้ว)
router.get("/contract/:id/history", authCheck, getContractHistory);
router.get("/contract/:id", authCheck, getContractById);

module.exports = router;
