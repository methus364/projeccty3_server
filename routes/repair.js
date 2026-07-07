const express = require('express');
const router = express.Router();
const multer = require('multer');

const { createRepair, getAllRepairs, getMyRepairs, updateRepairStatus } = require('../controllers/repair');
const { authCheck, monthlyTenantCheck, adminCheck } = require('../middleweres/authCheck');

// รับไฟล์แนบแจ้งซ่อม (รูป+วิดีโอ) ไว้ใน memory — สูงสุด 5 ไฟล์ ไฟล์ละ 20MB
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024, files: 5 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/')) cb(null, true);
        else cb(new Error('อัปโหลดได้เฉพาะไฟล์รูปภาพหรือวิดีโอเท่านั้น'));
    },
});

// Tenant แจ้งซ่อม — เฉพาะผู้เช่ารายเดือน (Daily_Tenant ไม่มีสัญญาเช่า จึงแจ้งซ่อมไม่ได้)
router.post('/repair', authCheck, monthlyTenantCheck, upload.array('media', 5), createRepair);

// Tenant ดูรายการแจ้งซ่อมของตัวเองตาม booking — เฉพาะ Monthly เช่นกัน
router.get('/my-repairs/:bookingId', authCheck, monthlyTenantCheck, getMyRepairs);

// Admin ดูรายการทั้งหมด
router.get('/repairs', authCheck, adminCheck, getAllRepairs);

// Admin อัปเดตสถานะ
router.put('/repair/:id', authCheck, adminCheck, updateRepairStatus);

module.exports = router;
