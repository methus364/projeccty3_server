const express = require("express");
const router = express.Router();

const {
    createInvoice,
    getInvoices,
    getMyInvoices,
    getInvoiceById,
    getInvoicePdf,
    updateInvoice,
    sendInvoiceEmail,
    sendInvoiceBatch,
    generateMonthly,
} = require("../controllers/invoice");
const { authCheck, adminCheck } = require("../middleweres/authCheck");

// ออกบิลรายเดือนยกชุด / ส่งอีเมลยกชุด (ต้องวางก่อน '/invoice/:id' กัน path ชนกัน)
router.post("/invoices/generate-monthly", authCheck, adminCheck, generateMonthly);
router.post("/invoices/send-batch", authCheck, adminCheck, sendInvoiceBatch);

// Tenant: ดูบิลของตัวเอง
router.get("/my-invoices", authCheck, getMyInvoices);

// Admin: ออกบิล / ดูรายการบิล
router.post("/invoice", authCheck, adminCheck, createInvoice);
router.get("/invoices", authCheck, adminCheck, getInvoices);

// Admin: แก้บิล / ส่งอีเมล
router.put("/invoice/:id", authCheck, adminCheck, updateInvoice);
router.post("/invoice/:id/send", authCheck, adminCheck, sendInvoiceEmail);

// Admin หรือเจ้าของบิล: ดูบิล / เปิด PDF (ownership check อยู่ใน controller)
router.get("/invoice/:id/pdf", authCheck, getInvoicePdf);
router.get("/invoice/:id", authCheck, getInvoiceById);

module.exports = router;
