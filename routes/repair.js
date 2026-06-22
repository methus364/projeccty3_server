const express = require('express');
const router = express.Router();

const { createRepair, getAllRepairs, getMyRepairs, updateRepairStatus } = require('../controllers/repair');
const { authCheck, tenantCheck, adminCheck } = require('../middleweres/authCheck');

// Tenant แจ้งซ่อม
router.post('/repair', authCheck, tenantCheck, createRepair);

// Tenant ดูรายการแจ้งซ่อมของตัวเองตาม booking
router.get('/my-repairs/:bookingId', authCheck, tenantCheck, getMyRepairs);

// Admin ดูรายการทั้งหมด
router.get('/repairs', authCheck, adminCheck, getAllRepairs);

// Admin อัปเดตสถานะ
router.put('/repair/:id', authCheck, adminCheck, updateRepairStatus);

module.exports = router;
