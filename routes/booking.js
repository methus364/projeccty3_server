const express = require('express')
const router = express.Router()

const { createBooking, checkbooking, editBooking, getAllBookings, adminCreateBooking, checkIn, checkOut } = require('../controllers/booking')
const { authCheck, tenantCheck, adminCheck } = require('../middleweres/authCheck')

// Tenant routes
router.post('/booking', authCheck, tenantCheck, createBooking)
router.post('/checkbooking', authCheck, checkbooking)
router.put('/editBooking/:id', authCheck, editBooking)

// Admin routes
router.get('/admin/bookings', authCheck, adminCheck, getAllBookings)
router.post('/admin/booking', authCheck, adminCheck, adminCreateBooking)
router.put('/admin/booking/:id/checkin', authCheck, adminCheck, checkIn)
router.put('/admin/booking/:id/checkout', authCheck, adminCheck, checkOut)

module.exports = router
