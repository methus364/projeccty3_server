const express = require('express')
const router = express.Router()
const multer = require('multer')

// 1. นำเข้า Controllers
const { createRoom, getRooms, searchRooms, deleteRoom, editRoom, uploadRoomImages } = require('../controllers/room')

// 2. นำเข้า Middleware ตรวจสอบสิทธิ์ (ปรับพาร์ทและชื่อฟังก์ชันให้ตรงตามที่เราแก้ไขไว้)
const { authCheck, adminCheck } = require('../middleweres/authCheck')

// รับไฟล์รูปห้องไว้ใน memory (แล้วส่งต่อขึ้น Supabase Storage) — จำกัด 5MB/รูป + เฉพาะ image
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true)
    } else {
      cb(new Error('อัปโหลดได้เฉพาะไฟล์รูปภาพเท่านั้น (jpg, png, webp ฯลฯ)'))
    }
  },
})

// --- เส้นทางสำหรับผู้ใช้งานทั่วไป / หน้าบ้าน (Public or Users) ---

// ดึงข้อมูลห้องพักทั้งหมด
router.get('/getRoom', getRooms)

// ค้นหาห้องว่างตามช่วงเวลาเช็คอิน-เช็คเอาท์
router.post('/search-rooms', searchRooms)


// --- เส้นทางสำหรับผู้ดูแลระบบเท่านั้น (Admin Only) ---

// อัปโหลดรูปห้อง (ได้สูงสุด 8 รูป · field name = 'images') → คืน URL ไปเก็บใส่ image_urls
router.post('/uploadRoomImages', authCheck, adminCheck, upload.array('images', 8), uploadRoomImages)

// สร้างห้องพักใหม่
router.post('/addRoom', authCheck, adminCheck, createRoom)

// แก้ไขข้อมูลห้องพัก
router.put('/editRoom/:id', authCheck, adminCheck, editRoom)

// ลบห้องพักออกจากระบบ
router.delete('/deleteRoom/:id', authCheck, adminCheck, deleteRoom)

module.exports = router