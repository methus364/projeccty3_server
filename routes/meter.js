const express = require('express');
const router = express.Router();

const { recordMeter, getMeters, getMeterYear } = require('../controllers/meter');
const { authCheck, adminCheck } = require('../middleweres/authCheck');

// Admin บันทึก/แก้ไขมิเตอร์ (UPSERT)
router.post('/meter', authCheck, adminCheck, recordMeter);

// Admin ดูมิเตอร์ทั้งปีแบบตาราง (?year=YYYY) — ต้องวางก่อน '/meters' กัน path ชนกัน
router.get('/meters/year', authCheck, adminCheck, getMeterYear);

// Admin ดูรายการมิเตอร์ทุกห้องในเดือนที่เลือก (?month=YYYY-MM)
router.get('/meters', authCheck, adminCheck, getMeters);

module.exports = router;
