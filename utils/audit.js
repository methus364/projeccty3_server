// ============================================================
// Helper สำหรับ Audit Log (M10b)
// ============================================================

// ตั้งค่า "ใครเป็นคนทำ" ให้ trigger fn_audit อ่านไปบันทึก changed_by
// ต้องเรียกหลัง BEGIN ภายใน transaction เดียวกัน (db = client)
// ใช้ set_config(..., true) = ค่าอยู่แค่ใน transaction นี้ (ไม่รั่วไป request อื่นใน pool)
async function setAuditUser(db, userId) {
    if (userId == null) return;
    await db.query("SELECT set_config('app.user_id', $1, true)", [String(userId)]);
}

module.exports = { setAuditUser };
