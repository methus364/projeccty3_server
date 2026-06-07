const express = require('express')
const router = express.Router()

// 1. นำเข้า Controllers (แยกตามโมดูลอย่างชัดเจน)
const { register, login, currentUser } = require('../controllers/auth')
const { createBooking, checkbooking } = require('../controllers/booking') 

// 2. นำเข้า Middleware ตรวจสอบสิทธิ์ (ปรับพาร์ทและสิทธิ์ Tenant สำหรับระบบหอพัก)
const { authCheck, tenantCheck } = require('../middlewares/auth')

// --- ROUTES: ระบบสมาชิกและการยืนยันตัวตน (Auth) ---
router.post('/register', register)
router.post('/login', login)

// ตรวจสอบข้อมูลผู้ใช้ปัจจุบัน (ปรับเป็น GET ตามมาตรฐาน และใช้ tenantCheck ดักสิทธิ์)
router.get('/current-user', authCheck, tenantCheck, currentUser)


// --- ROUTES: ระบบการจองห้องพัก (Booking) ---
// สร้างการจอง (ต้องเข้าสู่ระบบ และมีสถานะเป็นผู้เช่าก่อน)
router.post('/booking', authCheck, tenantCheck, createBooking)

// ตรวจสอบประวัติการจองของผู้ใช้ (ต้องเข้าสู่ระบบก่อน)
router.post('/checkbooking', authCheck, checkbooking)

module.exports = router