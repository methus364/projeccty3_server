const express = require('express');
const router = express.Router();

const { recordMeter, getMeters } = require('../controllers/meter');
const { authCheck, adminCheck } = require('../middleweres/authCheck');

// Admin บันทึก/แก้ไขมิเตอร์ (UPSERT)
router.post('/meter', authCheck, adminCheck, recordMeter);

// Admin ดูรายการมิเตอร์ทุกห้องในเดือนที่เลือก (?month=YYYY-MM)
router.get('/meters', authCheck, adminCheck, getMeters);

module.exports = router;
