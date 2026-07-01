// ============================================================
// Cron ออกบิลรายเดือนอัตโนมัติ — รันทุกวันที่ 1 ของเดือน เวลา 01:00
// เดิม admin ต้องกดปุ่ม "gen รายเดือน" เอง (POST /invoices/generate-monthly) ทุกเดือน
// ใช้ req/res จำลองเรียก controller เดิมตรงๆ — ไม่ต้องแยก logic ซ้ำ
// ============================================================
const cron = require("node-cron");
const { generateMonthly } = require("../controllers/invoice");

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

module.exports = { startMonthlyBillingCron };
