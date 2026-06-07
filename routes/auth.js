const express = require('express');
const router = express.Router();

// 1. นำเข้า Controllers
const { register, login, currentUser } = require('../controllers/auth');

// 2. นำเข้า Middleware ตรวจสอบสิทธิ์ (ปรับพาร์ทไฟล์ให้ตรงกับโฟลเดอร์ปัจจุบัน)
const { authCheck, tenantCheck, adminCheck } = require('../middlewares/auth');

// --- หน้าบ้านเข้าถึงได้ทั่วไป (Public) ---
router.post('/register', register);
router.post('/login', login);

// --- ปรับเป็น GET สำหรับตรวจสอบผู้ใช้ปัจจุบันผ่าน Token (Protected Routes) ---
// ตรวจสอบสถานะผู้ใช้งานทั่วไป หรือผู้เช่าพัก (Tenant)
router.get('/current-user', authCheck, tenantCheck, currentUser);

// ตรวจสอบสถานะผู้ดูแลระบบ (Admin)
router.get('/current-admin', authCheck, adminCheck, currentUser);

module.exports = router;