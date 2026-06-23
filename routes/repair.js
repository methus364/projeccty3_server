const express = require('express');
const router = express.Router();

const { createRepair, getAllRepairs, getMyRepairs, updateRepairStatus } = require('../controllers/repair');
const { authCheck, monthlyTenantCheck, adminCheck } = require('../middleweres/authCheck');

// Tenant แจ้งซ่อม — เฉพาะผู้เช่ารายเดือน (Daily_Tenant ไม่มีสัญญาเช่า จึงแจ้งซ่อมไม่ได้)
router.post('/repair', authCheck, monthlyTenantCheck, createRepair);

// Tenant ดูรายการแจ้งซ่อมของตัวเองตาม booking — เฉพาะ Monthly เช่นกัน
router.get('/my-repairs/:bookingId', authCheck, monthlyTenantCheck, getMyRepairs);

// Admin ดูรายการทั้งหมด
router.get('/repairs', authCheck, adminCheck, getAllRepairs);

// Admin อัปเดตสถานะ
router.put('/repair/:id', authCheck, adminCheck, updateRepairStatus);

module.exports = router;
