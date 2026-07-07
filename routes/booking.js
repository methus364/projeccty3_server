const express = require('express')
const router = express.Router()
const multer = require('multer')

const { createBooking, checkbooking, editBooking, getAllBookings, adminCreateBooking, checkIn, checkOut, getBookingInvoices, quickMember, getAvailability } = require('../controllers/booking')
const { authCheck, tenantCheck, adminCheck } = require('../middleweres/authCheck')

// รับไฟล์แนบตอนเช็คอิน (บัตร/รูปเงินสด/รูปสัญญา) ไว้ใน memory — เฉพาะรูป 5MB
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) cb(null, true)
        else cb(new Error('อัปโหลดได้เฉพาะไฟล์รูปภาพเท่านั้น'))
    },
})
// รับได้ 3 field: id_card, cash_photo (รายวัน) · contract_file (รายเดือน)
const checkinUpload = upload.fields([
    { name: 'id_card', maxCount: 1 },
    { name: 'cash_photo', maxCount: 1 },
    { name: 'contract_file', maxCount: 1 },
])

// Tenant routes
router.post('/booking', authCheck, tenantCheck, createBooking)
router.post('/checkbooking', authCheck, checkbooking)
router.put('/editBooking/:id', authCheck, editBooking)
router.get('/booking/:id/invoices', authCheck, getBookingInvoices)

// เช็คห้องว่าง ณ วันที่ (ผังชั้นรายเดือน) — เปิดให้ทุกคนดูได้ เหมือน /search-rooms /getRoom
// ใช้ทั้งฝั่งผู้เช่า (หน้าจองรายเดือน) และ admin (จองแทน walk-in)
router.get('/rooms/availability', getAvailability)

// Admin routes
router.get('/admin/bookings', authCheck, adminCheck, getAllBookings)
router.post('/admin/quick-member', authCheck, adminCheck, quickMember)
router.post('/admin/booking', authCheck, adminCheck, adminCreateBooking)
router.put('/admin/booking/:id/checkin', authCheck, adminCheck, checkinUpload, checkIn)
router.put('/admin/booking/:id/checkout', authCheck, adminCheck, checkOut)

module.exports = router
