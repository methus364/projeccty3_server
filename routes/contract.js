const express = require("express");
const router = express.Router();

const {
    getContracts,
    getMyContracts,
    getContractById,
    giveNotice,
    settleContract,
} = require("../controllers/contract");
const { authCheck, adminCheck } = require("../middleweres/authCheck");

// Tenant: ดูสัญญาของตัวเอง (ต้องวางก่อน '/contract/:id' กัน path ชน)
router.get("/my-contracts", authCheck, getMyContracts);

// Admin: ดูรายการสัญญา / เคลียร์คืนมัดจำ
router.get("/contracts", authCheck, adminCheck, getContracts);
router.post("/contract/:id/settle", authCheck, adminCheck, settleContract);

// Admin หรือเจ้าของสัญญา: แจ้งย้ายออก / ดูสัญญา (ownership check อยู่ใน controller)
router.put("/contract/:id/notice", authCheck, giveNotice);
router.get("/contract/:id", authCheck, getContractById);

module.exports = router;
