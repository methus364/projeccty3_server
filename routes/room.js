const express = require('express')
const router = express.Router()

//imp controller
const {register,login,currentUser,} = require('../controllers/auth')
const {authCheck,subCheck,adminCheck} = require('../middlewere/authCheck')
const { createRoom,getRooms,searchRooms } = require('../controllers/room') 

router.post('/addRoom',createRoom)
router.put('/editRoom',getRooms)
router.post('/search-rooms',searchRooms)


router.get('/getRoom',getRooms)


module.exports = router