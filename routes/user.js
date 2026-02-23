const express = require('express')
const router = express.Router()

//imp controller
const {register,login,currentUser,} = require('../controllers/auth')
const {authCheck,subCheck,adminCheck} = require('../middlewere/authCheck')
const {createBooking,checkbooking} = require('../controllers/booking') 

router.post('/booking',createBooking)
router.post('/checkbooking',checkbooking)




module.exports = router