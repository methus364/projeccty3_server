const express = require('express')
const router = express.Router()

//imp controller
const {register,login,currentUser,} = require('../controllers/auth')
const {authCheck,subCheck,adminCheck} = require('../middlewere/authCheck')

router.post('/register',register)
router.post('/login',login)
router.post('/current-user',authCheck,subCheck,currentUser)
router.post('/current-admin',authCheck,subCheck,adminCheck,currentUser)




module.exports = router