// สคริปต์วินิจฉัยการส่งอีเมล OTP — รันบน Render Shell (หรือเครื่องที่มี .env จริง)
//   node scripts/test-mail.js you@example.com
// จะบอกว่า provider ตัวไหนถูกตั้งค่าไว้ และดึง error จริงจาก provider ออกมาเต็ม ๆ
// (ตัว mailer เดิม return แค่ 502 "ส่งอีเมลไม่สำเร็จ" ทำให้ไม่เห็นสาเหตุ)
require("dotenv").config();
const { sendMail } = require("../config/mailer");

// เลือก provider ตัวแรกที่ถูกตั้ง (ลำดับเดียวกับ mailer.js)
function activeProvider() {
  if (process.env.SMTP2GO_API_KEY) return "SMTP2GO";
  if (process.env.SENDGRID_API_KEY) return "SendGrid";
  if (process.env.RESEND_API_KEY) return "Resend";
  if (process.env.MAILJET_API_KEY && process.env.MAILJET_SECRET_KEY) return "Mailjet";
  if (process.env.BREVO_API_KEY) return "Brevo";
  if (process.env.MAIL_USER && process.env.MAIL_PASS) return "SMTP (Gmail)";
  return "(ไม่มีเลย — ยังไม่ตั้ง key ผู้ให้บริการใด ๆ)";
}

function mask(v) {
  if (!v) return "(ไม่ได้ตั้ง)";
  return v.length <= 8 ? "****" : v.slice(0, 4) + "…" + v.slice(-4);
}

(async () => {
  const to = process.argv[2];
  if (!to) {
    console.error("ใช้: node scripts/test-mail.js อีเมลผู้รับ@example.com");
    process.exit(1);
  }

  console.log("== ค่าที่เกี่ยวข้องกับอีเมล (ปิดบัง) ==");
  console.log("Provider ที่จะใช้ :", activeProvider());
  console.log("MAIL_FROM        :", process.env.MAIL_FROM || process.env.MAIL_USER || "(ไม่ได้ตั้ง)");
  console.log("MAIL_USER        :", process.env.MAIL_USER || "(ไม่ได้ตั้ง)");
  console.log("BREVO_API_KEY    :", mask(process.env.BREVO_API_KEY));
  console.log("SENDGRID_API_KEY :", mask(process.env.SENDGRID_API_KEY));
  console.log("RESEND_API_KEY   :", mask(process.env.RESEND_API_KEY));
  console.log("MAILJET_API_KEY  :", mask(process.env.MAILJET_API_KEY));
  console.log("SMTP2GO_API_KEY  :", mask(process.env.SMTP2GO_API_KEY));
  console.log("\n== กำลังส่งอีเมลทดสอบไปที่:", to, "==");

  try {
    await sendMail({
      to,
      subject: "ทดสอบระบบอีเมล — หอพัก Around Loei",
      text: "นี่คืออีเมลทดสอบจากสคริปต์ test-mail.js ถ้าคุณได้รับ แปลว่าระบบส่งอีเมลทำงานปกติ",
    });
    console.log("\n✅ ส่งสำเร็จ! ระบบอีเมลใช้งานได้ — ปัญหา 502 น่าจะมาจากค่า env เดิมที่เพิ่งถูกแก้ หรือ cold start");
  } catch (err) {
    console.error("\n❌ ส่งไม่สำเร็จ — นี่คือ error จริงจาก provider:");
    console.error("MESSAGE:", err && err.message);
    if (err && err.stack) console.error("STACK:", err.stack);
    process.exit(2);
  }
})();
