const express = require('express');
const router = express.Router();

// 1. นำเข้า Controllers
const { register, login, currentUser, getMembers, getMemberById, updateMember, deleteMember, updateProfile, sendOtp, verifyOtp, resetPassword } = require('../controllers/auth');

// 2. นำเข้า Middleware ตรวจสอบสิทธิ์ (ปรับพาร์ทไฟล์ให้ตรงกับโฟลเดอร์ปัจจุบัน)
const { authCheck, tenantCheck, adminCheck } = require('../middleweres/authCheck');

// --- หน้าบ้านเข้าถึงได้ทั่วไป (Public) ---
router.post('/register', register);
router.post('/login', login);

// --- ลืมรหัสผ่าน / แก้ไขข้อมูลผู้ใช้ ด้วย OTP ทางอีเมล (Public) ---
router.post('/auth/send-otp', sendOtp);
router.post('/auth/verify-otp', verifyOtp);
router.post('/auth/reset-password', resetPassword);

// --- ปรับเป็น GET สำหรับตรวจสอบผู้ใช้ปัจจุบันผ่าน Token (Protected Routes) ---
// ตรวจสอบสถานะผู้ใช้งานทั่วไป หรือผู้เช่าพัก (Tenant)
router.get('/current-user', authCheck, tenantCheck, currentUser);

// ตรวจสอบสถานะผู้ดูแลระบบ (Admin)
router.get('/current-admin', authCheck, adminCheck, currentUser);

// --- Member Management (Admin) ---
router.get('/members', authCheck, adminCheck, getMembers);
router.get('/member/:id', authCheck, adminCheck, getMemberById);
router.put('/members/:id', authCheck, adminCheck, updateMember);
router.delete('/members/:id', authCheck, adminCheck, deleteMember);

// --- Own Profile (any logged-in user) ---
router.put('/profile', authCheck, updateProfile);

module.exports = router;