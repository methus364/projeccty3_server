const express = require('express')
const router = express.Router()

//imp controller
const {register,login,currentUser,} = require('../controllers/auth')
const {authCheck,subCheck,adminCheck} = require('../middlewere/authCheck')
const { createRoom,getRooms } = require('../controllers/room') 

router.post('/addRoom',createRoom)
router.put('/editRoom',getRooms)

router.get('/getRoom',getRooms)



module.exports = router