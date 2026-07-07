// อัปโหลดไฟล์สลิปโอนเงินขึ้น Supabase Storage แล้วคืน public URL
// อ่าน SUPABASE_URL / SUPABASE_SERVICE_KEY จาก .env (degrade graceful แบบเดียวกับ mailer)
// ถ้ายังไม่ตั้งค่า → throw ตอนใช้งานจริง (controller จับ error แล้วแจ้งผู้ใช้)
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// ชื่อ bucket ที่เก็บสลิป (ต้องไปสร้าง bucket นี้แบบ public ใน Supabase ก่อน)
const SLIP_BUCKET = "payment-slips";

// สร้าง client เพียงครั้งเดียว (lazy) — ตรวจ env ตอนใช้งานจริง
let client = null;

function getClient() {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
        throw new Error("ยังไม่ได้ตั้งค่า SUPABASE_URL / SUPABASE_SERVICE_KEY ใน server/.env (สำหรับอัปโหลดสลิป)");
    }
    if (!client) {
        client = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    }
    return client;
}

// อัปโหลดไฟล์ขึ้น bucket แล้วคืน public URL (ใช้ร่วมกันทุกชนิดไฟล์: สลิป/บัตร/สัญญา/รูปซ่อม)
// fileBuffer: Buffer, originalName: ชื่อไฟล์เดิม (เดานามสกุล), mimeType: ชนิดไฟล์, prefix: คำนำหน้าชื่อไฟล์
async function uploadFile(fileBuffer, originalName, mimeType, prefix = "file") {
    const supabase = getClient();

    // 1. ตั้งชื่อไฟล์ใหม่กันชนกัน: <prefix>-<เวลา>-<สุ่ม>.<นามสกุลเดิม>
    const ext = (originalName || "").split(".").pop() || "bin";
    const fileName = `${prefix}-${Date.now()}-${Math.round(Math.random() * 1e6)}.${ext}`;

    // 2. อัปโหลดขึ้น bucket
    const { error } = await supabase.storage
        .from(SLIP_BUCKET)
        .upload(fileName, fileBuffer, { contentType: mimeType, upsert: false });

    if (error) {
        throw new Error("อัปโหลดไฟล์ไม่สำเร็จ: " + error.message);
    }

    // 3. ขอ public URL กลับไปเก็บในฐานข้อมูล
    const { data } = supabase.storage.from(SLIP_BUCKET).getPublicUrl(fileName);
    return data.publicUrl;
}

// อัปโหลดสลิป (wrapper เดิม — ใช้ prefix 'slip')
async function uploadSlip(fileBuffer, originalName, mimeType) {
    return uploadFile(fileBuffer, originalName, mimeType, "slip");
}

module.exports = { uploadSlip, uploadFile };
