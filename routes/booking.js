const express = require('express')
const router = express.Router()

// 1. นำเข้า Controllers
const { createBooking, checkbooking, editBooking } = require('../controllers/booking') 

// 2. นำเข้า Middleware ตรวจสอบสิทธิ์ (ปรับพาร์ทและชื่อฟังก์ชันให้ตรงกับตัวปัจจุบัน)
const { authCheck, tenantCheck } = require('../middlewares/auth')

// --- เส้นทางจัดการการจองห้องพัก (ล็อกสิทธิ์ด้วย Middleware) ---

// 1. สร้างการจองห้องพัก (ต้องเข้าสู่ระบบ และมีสิทธิ์เป็นผู้เช่าเท่านั้น)
router.post('/booking', authCheck, tenantCheck, createBooking)

// 2. ตรวจสอบประวัติการจองของผู้ใช้ (ต้องเข้าสู่ระบบก่อน)
router.post('/checkbooking', authCheck, checkbooking)

// 3. แก้ไขข้อมูลหรือปรับสถานะการจอง (ต้องเข้าสู่ระบบก่อน)
router.put("/editBooking/:id", authCheck, editBooking)

module.exports = router