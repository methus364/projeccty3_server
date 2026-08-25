const express = require("express");
const router = express.Router();

const { socialLogin, lineExchange, googleExchange, completeSocialProfile, getMySocialAccounts, lineMobileCallback, lineLink, googleLink } = require("../controllers/social");
const { authCheck, socialCompleteCheck } = require("../middleweres/authCheck");

// Public: เข้าสู่ระบบ/สมัครผ่าน social (Google/Facebook — client ได้โปรไฟล์มาแล้ว)
router.post("/auth/social", socialLogin);

// Public: LINE redirect flow — backend แลก code → โปรไฟล์
router.post("/auth/line/exchange", lineExchange);

// Public: LINE redirect flow สำหรับมือถือ/APK — LINE เด้ง code มาที่นี่ (https) แล้ว server เด้งกลับ deep link แอป
router.get("/auth/line/callback", lineMobileCallback);

// Public: Google redirect flow — backend แลก code → โปรไฟล์
router.post("/auth/google/exchange", googleExchange);

// ผู้ล็อกอิน (ผู้ใช้ใหม่จาก social): เติมเบอร์โทร/รหัสผ่าน + เลือกประเภทผู้เช่า
router.post("/auth/social/complete", socialCompleteCheck, completeSocialProfile);

// ผู้ล็อกอิน: เชื่อมบัญชี social เพิ่มเข้าบัญชีปัจจุบัน (เฟส 2 — เชื่อมได้ ยังไม่มีถอด)
router.post("/auth/line/link", authCheck, lineLink);
router.post("/auth/google/link", authCheck, googleLink);

// ผู้ล็อกอิน: ดูบัญชี social ที่ผูกไว้
router.get("/my-social-accounts", authCheck, getMySocialAccounts);

module.exports = router;
