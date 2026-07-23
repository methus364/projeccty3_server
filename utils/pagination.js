// ==========================================
// Helper แบ่งหน้า (pagination) แบบ backward-compatible
// - ถ้า client ไม่ส่ง ?limit มา → คืน null (ให้ controller ดึงทั้งหมดเหมือนเดิม ไม่พังของเดิม)
// - ถ้าส่ง ?limit มา → คืน { limit, offset } สำหรับต่อท้าย SQL
//   รองรับทั้ง ?page=2&limit=20 (คำนวณ offset ให้) และ ?limit=20&offset=40 (ระบุ offset ตรงๆ)
// ==========================================
function buildPagination(query) {
    // ไม่ส่ง limit มา = ไม่แบ่งหน้า
    if (query.limit === undefined) return null;

    // จำกัด limit 1–200 กันดึงทีละมากเกินไป
    let limit = Number(query.limit);
    if (isNaN(limit) || limit < 1) limit = 20;
    if (limit > 200) limit = 200;

    // หาค่า offset — ให้ความสำคัญกับ ?offset ก่อน ถ้าไม่มีค่อยคำนวณจาก ?page
    let offset = Number(query.offset);
    if (isNaN(offset) || offset < 0) {
        const page = Number(query.page);
        offset = (!isNaN(page) && page > 1) ? (page - 1) * limit : 0;
    }

    return { limit, offset };
}

module.exports = { buildPagination };
