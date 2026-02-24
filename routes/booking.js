const express = require('express')
const router = express.Router()

//imp controller
const {register,login,currentUser,} = require('../controllers/auth')
const {authCheck,subCheck,adminCheck} = require('../middlewere/authCheck')
const {createBooking,checkbooking,editBooking} = require('../controllers/booking') 

router.post('/booking',createBooking)
router.post('/checkbooking',checkbooking)

router.put("/editBooking/:id",editBooking);



module.exports = router