// ============================================================
// Cron ออกบิลรายเดือนอัตโนมัติ — รันทุกวันที่ 1 ของเดือน เวลา 01:00
// เดิม admin ต้องกดปุ่ม "gen รายเดือน" เอง (POST /invoices/generate-monthly) ทุกเดือน
// ใช้ req/res จำลองเรียก controller เดิมตรงๆ — ไม่ต้องแยก logic ซ้ำ
// ============================================================
const cron = require("node-cron");
const pool = require("../config/db");
const { generateMonthly } = require("../controllers/invoice");
const { sendMail } = require("../config/mailer");

// คืนเดือนปัจจุบันรูปแบบ 'YYYY-MM'
function currentMonth() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

// คืนรายชื่อห้อง (room_number) ที่มีผู้เช่ารายเดือนอยู่แต่ยังไม่จดมิเตอร์เดือนที่ระบุ
// ใช้ทั้ง cron เตือน และ dashboard summary
async function getUnrecordedMeterRooms(month) {
    const res = await pool.query(
        `SELECT DISTINCT r.room_number
         FROM bookings b
         JOIN rooms r ON b.room_id = r.room_id
         WHERE b.rent_type = 'monthly' AND b.booking_status = 'กำลังเข้าพัก'
           AND NOT EXISTS (
               SELECT 1 FROM utility_meters um
               WHERE um.room_id = r.room_id AND um.record_month = $1
           )
         ORDER BY r.room_number`,
        [month]
    );
    return res.rows.map((x) => x.room_number);
}

function startMonthlyBillingCron() {
    // "0 1 1 * *" = นาที 0, ชั่วโมง 1, วันที่ 1 ของทุกเดือน
    cron.schedule("0 1 1 * *", async () => {
        console.log("[cron] เริ่มออกบิลรายเดือนอัตโนมัติ...");

        const fakeReq = { body: {}, user: null }; // ไม่มี body.month → controller ใช้เดือนปัจจุบันเอง
        const fakeRes = {
            status() { return this; },
            json(body) {
                console.log("[cron] ผลลัพธ์ออกบิลรายเดือน:", body.message);
            },
        };

        try {
            await generateMonthly(fakeReq, fakeRes);
        } catch (error) {
            console.error("[cron] ออกบิลรายเดือนอัตโนมัติล้มเหลว:", error.message);
        }
    });

    console.log("[cron] ตั้งเวลาออกบิลรายเดือนอัตโนมัติแล้ว (ทุกวันที่ 1 เวลา 01:00)");
}

// ============================================================
// Cron ยกเลิกการจองที่หมดเวลาล็อกห้อง — รันทุก 1 นาที (USER_FLOWS ข้อ 8)
// booking ที่ 'รอชำระมัดจำ' + เลย hold_expires_at + ยังไม่มีสลิป/การชำระส่งเข้ามาเลย
//   → ลบทิ้งทั้งแถว (booking + บิล + รายละเอียดบิลที่ผูกกัน) ให้หายจากประวัติทั้ง user และ admin
//   + คืนห้องว่าง
// (booking ที่ส่งสลิปแล้วจะถูกเคลียร์ hold + เป็น 'ยืนยันการจอง' ตั้งแต่ตอน createPayment)
// ============================================================
async function cancelExpiredHolds() {
    // หา booking ที่หมดเวลาล็อก และยังไม่มี payment ผูกกับบิลของ booking นั้นเลย
    const expiredRes = await pool.query(
        `SELECT b.booking_id, b.room_id
         FROM bookings b
         WHERE b.booking_status = 'รอชำระมัดจำ'
           AND b.hold_expires_at IS NOT NULL
           AND b.hold_expires_at < NOW()
           AND NOT EXISTS (
               SELECT 1 FROM payments p
               JOIN invoices i ON p.invoice_id = i.invoice_id
               WHERE i.booking_id = b.booking_id
           )`
    );

    if (expiredRes.rows.length === 0) return;

    // รวม id ของทุก booking/room ที่หมดเวลา แล้วลบทั้งชุดใน transaction เดียว
    // (เดิมเปิด connection + transaction ใหม่ทีละแถว ซึ่ง cron นี้รันทุก 1 นาทีจึงสิ้นเปลืองมาก)
    const bookingIds = expiredRes.rows.map((row) => row.booking_id);
    const roomIds = expiredRes.rows.map((row) => row.room_id);

    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        // 1) ลบรายละเอียดบิล + บิล ที่ผูกกับ booking เหล่านี้ (ยังไม่มี payment แน่นอนจากเงื่อนไขข้างบน)
        await client.query(
            `DELETE FROM invoice_details
             WHERE invoice_id IN (SELECT invoice_id FROM invoices WHERE booking_id = ANY($1))`,
            [bookingIds]
        );
        await client.query(`DELETE FROM invoices WHERE booking_id = ANY($1)`, [bookingIds]);
        // 2) ลบตัว booking ทิ้ง
        await client.query(`DELETE FROM bookings WHERE booking_id = ANY($1)`, [bookingIds]);
        // 3) คืนห้องว่าง
        await client.query(`UPDATE rooms SET room_status = 'ว่าง' WHERE room_id = ANY($1)`, [roomIds]);
        await client.query("COMMIT");
        console.log(`[cron] ลบการจองที่หมดเวลาล็อกห้อง ${bookingIds.length} รายการ`);
    } catch (err) {
        await client.query("ROLLBACK");
        console.error(`[cron] ลบการจองหมดเวลาไม่สำเร็จ:`, err.message);
    } finally {
        client.release();
    }
}

function startHoldExpiryCron() {
    // "* * * * *" = ทุก 1 นาที
    cron.schedule("* * * * *", async () => {
        try {
            await cancelExpiredHolds();
        } catch (error) {
            console.error("[cron] ยกเลิกการจองหมดเวลาล้มเหลว:", error.message);
        }
    });

    console.log("[cron] ตั้งเวลายกเลิกการจองที่หมดเวลาล็อกห้องแล้ว (ทุก 1 นาที)");
}

// ============================================================
// Cron เตือนใกล้ครบสัญญา — รันทุกวัน 08:00 (USER_FLOWS ข้อ 154)
// สัญญา 'มีผลใช้งาน' ที่เหลือ ≤ 30 วัน และยังไม่เคยแจ้ง → อีเมลผู้เช่า + set renewal_notified_at
// ============================================================
async function notifyExpiringContracts() {
    const res = await pool.query(
        `SELECT c.contract_id, c.end_date, r.room_number, m.email, m.full_name
         FROM contracts c
         JOIN rooms r   ON c.room_id = r.room_id
         JOIN members m ON c.member_id = m.member_id
         WHERE c.contract_status = 'มีผลใช้งาน'
           AND c.settled_at IS NULL
           AND c.renewal_notified_at IS NULL
           AND c.end_date <= (CURRENT_DATE + INTERVAL '30 days')
           AND c.end_date >= CURRENT_DATE`
    );

    for (const c of res.rows) {
        const daysLeft = Math.ceil((new Date(c.end_date) - new Date()) / 86400000);
        // ส่งอีเมล (ถ้ามี) — best-effort
        if (c.email) {
            try {
                await sendMail({
                    to: c.email,
                    subject: `แจ้งเตือนสัญญาเช่าใกล้ครบกำหนด - หอพัก Around Loei`,
                    text: `เรียน คุณ${c.full_name || ""}\n\nสัญญาเช่าห้อง ${c.room_number} จะครบกำหนดในอีก ${daysLeft} วัน (วันที่ ${String(c.end_date).split("T")[0]})\nกรุณาติดต่อต่อสัญญา หรือแจ้งย้ายออก\n\nขอบคุณค่ะ\nหอพัก Around Loei`,
                });
            } catch (err) {
                console.error(`[cron] ส่งอีเมลเตือนสัญญา ${c.contract_id} ไม่สำเร็จ:`, err.message);
            }
        }
    }

    if (res.rows.length > 0) {
        // ตั้ง flag กันแจ้งซ้ำให้ทุกสัญญาในชุดเดียว (แทนการ UPDATE ทีละรายการในลูป)
        const contractIds = res.rows.map((c) => c.contract_id);
        await pool.query(
            `UPDATE contracts SET renewal_notified_at = CURRENT_TIMESTAMP WHERE contract_id = ANY($1)`,
            [contractIds]
        );
        console.log(`[cron] แจ้งเตือนสัญญาใกล้ครบ ${res.rows.length} รายการ`);
    }
}

function startRenewalReminderCron() {
    cron.schedule("0 8 * * *", async () => {
        try {
            await notifyExpiringContracts();
        } catch (error) {
            console.error("[cron] แจ้งเตือนสัญญาใกล้ครบล้มเหลว:", error.message);
        }
    });
    console.log("[cron] ตั้งเวลาแจ้งเตือนสัญญาใกล้ครบแล้ว (ทุกวัน 08:00)");
}

// ============================================================
// Cron เตือน Admin จดมิเตอร์ — รันทุกวัน 09:00 แต่ทำงานเฉพาะ "วันสิ้นเดือน − 1" (USER_FLOWS)
// ถ้ายังมีห้องรายเดือนที่ยังไม่จดมิเตอร์เดือนนี้ → อีเมลเตือน Admin ทุกคน
// ============================================================
async function remindMeterReading() {
    const now = new Date();
    // วันสุดท้ายของเดือนนี้
    const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    // ทำงานเฉพาะวันสิ้นเดือน − 1 เท่านั้น
    if (now.getDate() !== lastDay - 1) return;

    const rooms = await getUnrecordedMeterRooms(currentMonth());
    if (rooms.length === 0) return;

    // ส่งอีเมลเตือน Admin ทุกคนที่มีอีเมล
    const admins = await pool.query(`SELECT email, full_name FROM members WHERE user_role = 'Admin' AND email IS NOT NULL`);
    for (const a of admins.rows) {
        try {
            await sendMail({
                to: a.email,
                subject: `เตือนจดมิเตอร์ก่อนออกบิล - หอพัก Around Loei`,
                text: `เรียน ${a.full_name || "แอดมิน"}\n\nยังมี ${rooms.length} ห้องที่ยังไม่จดมิเตอร์เดือนนี้: ${rooms.join(", ")}\nกรุณาจดมิเตอร์ให้ครบก่อนถึงรอบออกบิลวันที่ 1 ของเดือนถัดไป\n\nหอพัก Around Loei`,
            });
        } catch (err) {
            console.error(`[cron] ส่งอีเมลเตือนมิเตอร์ถึง ${a.email} ไม่สำเร็จ:`, err.message);
        }
    }
    console.log(`[cron] เตือนจดมิเตอร์: ยังไม่จด ${rooms.length} ห้อง`);
}

function startMeterReminderCron() {
    cron.schedule("0 9 * * *", async () => {
        try {
            await remindMeterReading();
        } catch (error) {
            console.error("[cron] เตือนจดมิเตอร์ล้มเหลว:", error.message);
        }
    });
    console.log("[cron] ตั้งเวลาเตือนจดมิเตอร์แล้ว (ทุกวัน 09:00 · ทำงานวันสิ้นเดือน−1)");
}

module.exports = {
    startMonthlyBillingCron,
    startHoldExpiryCron,
    startRenewalReminderCron,
    startMeterReminderCron,
    cancelExpiredHolds,
    getUnrecordedMeterRooms,
};
