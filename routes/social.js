const express = require("express");
const router = express.Router();

const { socialLogin, getMySocialAccounts } = require("../controllers/social");
const { authCheck } = require("../middleweres/authCheck");

// Public: เข้าสู่ระบบ/สมัครผ่าน social (auto-link/register)
router.post("/auth/social", socialLogin);

// ผู้ล็อกอิน: ดูบัญชี social ที่ผูกไว้
router.get("/my-social-accounts", authCheck, getMySocialAccounts);

module.exports = router;
