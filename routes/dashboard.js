const express = require("express");
const router = express.Router();

const {
    getSummary,
    getRevenue,
    getOccupancyReport,
    getDebtReport,
} = require("../controllers/dashboard");
const { authCheck, adminCheck } = require("../middleweres/authCheck");

// ทุก endpoint ของแดชบอร์ดเป็นของ Admin เท่านั้น
router.get("/dashboard/summary", authCheck, adminCheck, getSummary);
router.get("/dashboard/revenue", authCheck, adminCheck, getRevenue);
router.get("/dashboard/occupancy", authCheck, adminCheck, getOccupancyReport);
router.get("/dashboard/debt", authCheck, adminCheck, getDebtReport);

module.exports = router;
