const express = require("express");
const router = express.Router();

const { socialLogin, lineExchange, googleExchange, completeSocialProfile, getMySocialAccounts } = require("../controllers/social");
const { authCheck } = require("../middleweres/authCheck");

// Public: เข้าสู่ระบบ/สมัครผ่าน social (Google/Facebook — client ได้โปรไฟล์มาแล้ว)
router.post("/auth/social", socialLogin);

// Public: LINE redirect flow — backend แลก code → โปรไฟล์
router.post("/auth/line/exchange", lineExchange);

// Public: Google redirect flow — backend แลก code → โปรไฟล์
router.post("/auth/google/exchange", googleExchange);

// ผู้ล็อกอิน (ผู้ใช้ใหม่จาก social): เติมเบอร์โทร/รหัสผ่าน + เลือกประเภทผู้เช่า
router.post("/auth/social/complete", authCheck, completeSocialProfile);

// ผู้ล็อกอิน: ดูบัญชี social ที่ผูกไว้
router.get("/my-social-accounts", authCheck, getMySocialAccounts);

module.exports = router;
