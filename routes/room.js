const express = require('express')
const router = express.Router()

//imp controller
const {register,login,currentUser,} = require('../controllers/auth')
const {authCheck,subCheck,adminCheck} = require('../middlewere/authCheck')
const { createRoom,getRooms,searchRooms,deleteRoom } = require('../controllers/room') 

router.post('/addRoom',createRoom)
router.put('/editRoom/:id',editRoom)
router.post('/search-rooms',searchRooms)
router.delete('/deleteRoom/:id',deleteRoom)

router.get('/getRoom',getRooms)


module.exports = router