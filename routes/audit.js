const express = require("express");
const router = express.Router();

const { getAuditLogs } = require("../controllers/audit");
const { authCheck, adminCheck } = require("../middleweres/authCheck");

// Admin: ดูประวัติการเปลี่ยนแปลง (read-only — ไม่มี POST/PUT/DELETE)
router.get("/audit-logs", authCheck, adminCheck, getAuditLogs);

module.exports = router;
