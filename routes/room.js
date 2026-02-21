const express = require('express')
const router = express.Router()

//imp controller
const {register,login,currentUser,} = require('../controllers/auth')
const {authCheck,subCheck,adminCheck} = require('../middlewere/authCheck')
const {addRoom} = require('../controllers/room') 

router.post('/addRoom',addRoom)



module.exports = router