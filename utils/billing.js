// ============================================================
// Helper คำนวณค่าเช่ารายเดือน + proration (M10a)
// แยกออกมาเป็น util เพื่อ reuse (invoice.js, contract.js) และเขียน unit test ได้ง่าย
// อ้างอิงกฎธุรกิจใน docs/M10_DESIGN.md §0.3, §0.5
// ============================================================
const { PRORATION_DAYS } = require("../config/billing_rules");

// ชื่อเดือนไทยเต็ม ใช้ตั้งชื่อรายการบิล เช่น "1-31 พฤษภาคม 2568"
const THAI_MONTH_NAMES = [
    "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
    "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม",
];

// บวกวันเข้ากับวันที่ (คืน Date ใหม่)
function addDays(date, days) {
    const d = new Date(date);
    d.setDate(d.getDate() + days);
    return d;
}

// แปลงช่วงวันที่ (อยู่เดือนเดียวกัน) เป็นข้อความไทย เช่น "1-31 พฤษภาคม 2568"
function formatThaiDateRange(startDate, endDate) {
    const start = new Date(startDate);
    const end = new Date(endDate);
    const monthName = THAI_MONTH_NAMES[end.getMonth()];
    const yearBE = end.getFullYear() + 543;
    return `${start.getDate()}-${end.getDate()} ${monthName} ${yearBE}`;
}

// วันสุดท้ายของเดือน 'YYYY-MM' (เช่น '2026-02' → 28)
function lastDayOfMonth(yyyyMM) {
    const [year, month] = yyyyMM.split("-").map(Number);
    return new Date(year, month, 0).getDate(); // day 0 ของเดือนถัดไป = วันสุดท้ายเดือนนี้
}

// ค่าเช่าต่อวัน = ราคารายเดือน / 30 (ปัดทศนิยม 2 ตำแหน่ง)
function dailyRate(priceMonthly) {
    return Math.round((Number(priceMonthly) / PRORATION_DAYS) * 100) / 100;
}

// ============================================================
// คำนวณค่าห้องรายเดือนของ "บิลเดือนหนึ่ง" โดยข้ามช่วง 30 วันที่ prepaid ครอบไว้
// (รูปแบบ A: ค่าเช่าเดือนแรก = prepaid ครอบ 30 วันจากวันเข้าพัก)
//   checkInDate  : วันเข้าพัก (Date หรือ 'YYYY-MM-DD')
//   priceMonthly : ราคาห้อง/เดือน
//   invoiceMonth : เดือนของบิล 'YYYY-MM'
// คืน { roomCost, days, isFullMonth, itemName }
//   - เดือนปกติ (หลังพ้น prepaid) → คิดเต็มเดือน
//   - เดือนที่ prepaid หมดกลางเดือน → prorate เฉพาะวันที่เหลือ
//   - เดือนที่ยังอยู่ใน prepaid ทั้งเดือน → 0 (ไม่ควรออกบิล)
// ============================================================
function computeMonthlyRoomCost(checkInDate, priceMonthly, invoiceMonth) {
    const price = Number(priceMonthly) || 0;
    const checkIn = new Date(checkInDate);

    // วันแรกที่เริ่มคิดเงิน = วันถัดจาก prepaid 30 วัน
    const firstBillableDay = addDays(checkIn, PRORATION_DAYS);

    const monthStart = new Date(`${invoiceMonth}-01`);
    const lastDay = lastDayOfMonth(invoiceMonth);
    const monthEnd = new Date(`${invoiceMonth}-${String(lastDay).padStart(2, "0")}`);

    // วันเริ่มคิดเงินในเดือนนี้ = ช้าสุดระหว่าง (ต้นเดือน, วันพ้น prepaid)
    const billableStart = firstBillableDay > monthStart ? firstBillableDay : monthStart;

    // ยังอยู่ในช่วง prepaid ทั้งเดือน → ไม่มีค่าห้อง
    if (billableStart > monthEnd) {
        return { roomCost: 0, days: 0, isFullMonth: false, itemName: "ค่าห้อง (อยู่ในช่วงจ่ายล่วงหน้า)" };
    }

    // พ้น prepaid ก่อนเดือนนี้แล้ว → คิดเต็มเดือน
    if (billableStart <= monthStart) {
        return {
            roomCost: price,
            days: lastDay,
            isFullMonth: true,
            itemName: `ค่าเช่าห้องล่วงหน้า ${formatThaiDateRange(monthStart, monthEnd)}`,
        };
    }

    // เดือนที่ prepaid หมดกลางเดือน → prorate เฉพาะวันที่เหลือ
    const days = Math.round((monthEnd - billableStart) / 86400000) + 1; // inclusive
    const roomCost = Math.round(dailyRate(price) * days * 100) / 100;
    return {
        roomCost,
        days,
        isFullMonth: false,
        itemName: `ค่าเช่าห้องล่วงหน้า ${formatThaiDateRange(billableStart, monthEnd)}`,
    };
}

// ============================================================
// ค่าเช่าตามจริงของช่วงสุดท้าย (ตอนย้ายออก) = ค่าเช่า/วัน × จำนวนวันที่อยู่
//   ใช้คำนวณ "ค่าเช่าล่วงหน้าส่วนเกินที่ควรคืน" ตอนเคลียร์สัญญา
// ============================================================
function proratedRent(priceMonthly, days) {
    const d = Math.max(0, Number(days) || 0);
    return Math.round(dailyRate(priceMonthly) * d * 100) / 100;
}

module.exports = { addDays, lastDayOfMonth, dailyRate, computeMonthlyRoomCost, proratedRent, formatThaiDateRange };
