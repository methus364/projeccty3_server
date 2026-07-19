// สคริปต์เพิ่มข้อมูลมิเตอร์น้ำ-ไฟจำลอง สำหรับเดือน 2026-06 และ 2026-07
// รันครั้งเดียวแล้วลบทิ้งได้ (ไม่ใช่ route ของระบบ)
const pool = require('../config/db');

async function main() {
  const client = await pool.connect();
  try {
    // 1) หา room_id ทั้งหมด
    const roomsResult = await client.query('SELECT room_id FROM rooms ORDER BY room_id');
    const roomIds = roomsResult.rows.map((r) => r.room_id);

    // 2) หา member_id ของ admin ไว้ใส่ recorded_by
    const adminResult = await client.query(
      "SELECT member_id FROM members WHERE user_role = 'Admin' LIMIT 1"
    );
    const adminId = adminResult.rows[0]?.member_id || null;

    const months = ['2026-06', '2026-07'];

    for (const roomId of roomIds) {
      // ค่าเริ่มต้นของห้องนี้ (สุ่มแบบสมเหตุสมผล)
      let waterUnit = 100 + Math.floor(Math.random() * 50);
      let elecUnit = 200 + Math.floor(Math.random() * 100);

      for (const month of months) {
        // เดือนถัดไปหน่วยต้องเพิ่มขึ้นจากการใช้งานจริง
        waterUnit += 5 + Math.floor(Math.random() * 15);
        elecUnit += 20 + Math.floor(Math.random() * 60);

        await client.query(
          `INSERT INTO utility_meters (room_id, record_month, water_current_unit, elec_current_unit, recorded_by)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (room_id, record_month) DO UPDATE
           SET water_current_unit = EXCLUDED.water_current_unit,
               elec_current_unit = EXCLUDED.elec_current_unit,
               recorded_by = EXCLUDED.recorded_by`,
          [roomId, month, waterUnit, elecUnit, adminId]
        );
      }
    }

    console.log(`เพิ่มข้อมูลมิเตอร์สำเร็จ: ${roomIds.length} ห้อง x ${months.length} เดือน`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('เกิดข้อผิดพลาด:', err);
  process.exit(1);
});
