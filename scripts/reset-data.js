// สคริปต์รีเซ็ตข้อมูลทดสอบ — เหลือแค่ตาราง rooms (ห้องพัก) + สมาชิกที่เป็น Admin เท่านั้น
// รัน: node scripts/reset-data.js (จาก D:\y3\server)
const pool = require('../config/db');

async function resetData() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ล้างข้อมูลการใช้งานทั้งหมด (จอง/บิล/ชำระเงิน/สัญญา/ขายของ/audit log) — ไม่แตะ rooms
    await client.query(`
      TRUNCATE sales, products, payments, invoice_details, invoices,
               utility_meters, maintenance_requests, contracts, bookings,
               social_accounts, audit_logs
      RESTART IDENTITY CASCADE
    `);

    // เหลือเฉพาะสมาชิกที่เป็น Admin
    const deleted = await client.query(`DELETE FROM members WHERE user_role != 'Admin'`);

    await client.query('COMMIT');
    console.log(`รีเซ็ตข้อมูลสำเร็จ — ลบสมาชิกที่ไม่ใช่ Admin ไป ${deleted.rowCount} คน (rooms คงเดิม)`);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('รีเซ็ตข้อมูลไม่สำเร็จ:', error.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

resetData();
