const express = require('express')
const router = express.Router()

// 1. นำเข้า Controllers
const { createRoom, getRooms, searchRooms, deleteRoom, editRoom } = require('../controllers/room') 

// 2. นำเข้า Middleware ตรวจสอบสิทธิ์ (ปรับพาร์ทและชื่อฟังก์ชันให้ตรงตามที่เราแก้ไขไว้)
const { authCheck, adminCheck } = require('../middlewares/auth')

// --- เส้นทางสำหรับผู้ใช้งานทั่วไป / หน้าบ้าน (Public or Users) ---

// ดึงข้อมูลห้องพักทั้งหมด
router.get('/getRoom', getRooms)

// ค้นหาห้องว่างตามช่วงเวลาเช็คอิน-เช็คเอาท์
router.post('/search-rooms', searchRooms)


// --- เส้นทางสำหรับผู้ดูแลระบบเท่านั้น (Admin Only) ---

// สร้างห้องพักใหม่
router.post('/addRoom', authCheck, adminCheck, createRoom)

// แก้ไขข้อมูลห้องพัก
router.put('/editRoom/:id', authCheck, adminCheck, editRoom)

// ลบห้องพักออกจากระบบ
router.delete('/deleteRoom/:id', authCheck, adminCheck, deleteRoom)

module.exports = router