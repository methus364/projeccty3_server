const pool = require("../config/db");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

// ==========================================
// 1. สร้างห้องพักใหม่ (createRoom)
// ==========================================
exports.createRoom = async (req, res) => {
  const {
    number,
    room_type_id, // ส่ง ID ของประเภทห้องพักมาจากหน้าบ้าน (เชื่อมกับตาราง Room_Types)
    room_status   // กำหนดค่าเริ่มต้นได้ เช่น 'ว่าง', 'ปิดปรับปรุง'
  } = req.body;

  if (!number || !room_type_id) {
    return res.status(400).json({ success: false, message: "กรุณาระบุหมายเลขห้องและรหัสประเภทห้อง" });
  }

  try {
    // โครงสร้างใหม่บันทึกจบในตารางเดียว ไม่ต้องทำมัลติทรานแซกชันให้ยุ่งยาก
    const roomQuery = `
        INSERT INTO Rooms (room_number, room_type_id, room_status) 
        VALUES ($1, $2, $3) 
        RETURNING room_id;
    `;

    const roomRes = await pool.query(roomQuery, [
      number,
      room_type_id,
      room_status || 'ว่าง'
    ]);

    res.status(201).json({
      success: true,
      message: "สร้างห้องพักสำเร็จ",
      roomId: roomRes.rows[0].room_id,
    });
  } catch (error) {
    console.error("Error in createRoom:", error);
    res.status(500).json({
      success: false,
      message: "ไม่สามารถเพิ่มข้อมูลห้องพักได้",
      error: error.message,
    });
  }
};

// ==========================================
// 2. ดึงรายการห้องพักทั้งหมด (getRooms)
// ==========================================
exports.getRooms = async (req, res) => {
  try {
    // ดึงข้อมูลห้องพักพร้อม Join รายละเอียดราคาและชื่อประเภทห้องมาจากตาราง Room_Types
    const query = `
        SELECT 
            r.room_id AS "id", 
            r.room_number AS "number", 
            r.room_status AS "status",
            rt.room_type_id AS "roomTypeId",
            rt.type_name AS "typeName", 
            rt.room_price AS "price"
        FROM Rooms r
        JOIN Room_Types rt ON r.room_type_id = rt.room_type_id
        WHERE r.room_status != 'ปิดปรับปรุง'
        ORDER BY r.room_number ASC;
    `;

    const { rows } = await pool.query(query);

    res.status(200).json({
      success: true,
      count: rows.length,
      data: rows,
    });
  } catch (error) {
    console.error("Get Rooms Error:", error);
    res.status(500).json({
      success: false,
      message: "ไม่สามารถดึงข้อมูลห้องพักได้",
      error: error.message,
    });
  }
};

// ==========================================
// 3. แก้ไขข้อมูลห้องพัก (editRoom)
// ==========================================
exports.editRoom = async (req, res) => {
  const { id } = req.params; // room_id
  const { number, room_type_id, status } = req.body;

  try {
    // 1. ตรวจสอบข้อมูลเดิมในระบบ
    const currentRes = await pool.query('SELECT * FROM Rooms WHERE room_id = $1', [id]);
    if (currentRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: "ไม่พบห้องพักที่ต้องการแก้ไข" });
    }
    const current = currentRes.rows[0];

    // 2. อัปเดตข้อมูลเข้าตาราง Rooms โดยใช้ค่าเก่าหากหน้าบ้านไม่ได้ส่งค่าใหม่มา
    const roomUpdateQuery = `
      UPDATE Rooms SET 
        room_number = $1, 
        room_type_id = $2, 
        room_status = $3
      WHERE room_id = $4
    `;

    await pool.query(roomUpdateQuery, [
      number !== undefined ? number : current.room_number,
      room_type_id !== undefined ? room_type_id : current.room_type_id,
      status !== undefined ? status : current.room_status,
      id
    ]);

    res.status(200).json({
      success: true,
      message: "แก้ไขข้อมูลห้องพักเสร็จสิ้น",
    });
  } catch (error) {
    console.error("Error in editRoom:", error);
    res.status(500).json({
      success: false,
      message: "เกิดข้อผิดพลาดในการแก้ไขข้อมูล",
      error: error.message,
    });
  }
};

// ==========================================
// 4. ค้นหาห้องว่างตามช่วงเวลาเช็คอิน-เช็คเอาท์ (searchRooms)
// ==========================================
exports.searchRooms = async (req, res) => {
  const checkIn = req.body.checkIn || req.query.checkIn;
  const checkOut = req.body.checkOut || req.query.checkOut;

  if (!checkIn || !checkOut) {
    return res.status(400).json({ 
      success: false,
      error: "กรุณาระบุวันที่เช็คอิน (checkIn) และเช็คเอาท์ (checkOut) ในรูปแบบ YYYY-MM-DD" 
    });
  }

  const sql = `
    SELECT 
        r.room_id AS "id", 
        r.room_number AS "number", 
        r.room_status AS "status",
        rt.type_name AS "roomType", 
        rt.room_price AS "price"
    FROM Rooms r
    JOIN Room_Types rt ON r.room_type_id = rt.room_type_id
    WHERE r.room_status = 'ว่าง'  -- ค้นหาเฉพาะห้องที่ไม่ได้ติดเคสผู้เช่ารายเดือนอยู่ ณ ปัจจุบัน
    AND r.room_id NOT IN (
        -- กรองห้องที่ถูกจับจองไปแล้วในช่วงเวลานั้น ๆ ออกไป
        SELECT room_id 
        FROM Bookings
        WHERE booking_status NOT IN ('ยกเลิก', 'ย้ายออกแล้ว') 
        AND ($2 < check_out_date AND $1 > check_in_date)
    )
    ORDER BY r.room_number ASC;
  `;

  try {
    const result = await pool.query(sql, [checkIn, checkOut]);
    
    res.status(200).json({
      success: true,
      count: result.rowCount,
      data: result.rows,
    });
  } catch (err) {
    console.error('Search Rooms Error:', err.message);
    res.status(500).json({ 
      success: false,
      error: "เกิดข้อผิดพลาดในการค้นหาข้อมูลห้องพักว่าง" 
    });
  }
};

// ==========================================
// 5. ลบห้องพัก (deleteRoom)
// ==========================================
exports.deleteRoom = async (req, res) => {
  const { id } = req.params; // room_id

  try {
    // ตรวจสอบความปลอดภัย: เช็คว่าห้องพักนี้เคยมีประวัติการจองอยู่ในระบบหรือไม่
    const checkBookingQuery = `SELECT booking_id FROM Bookings WHERE room_id = $1 AND booking_status NOT IN ('ยกเลิก', 'ย้ายออกแล้ว') LIMIT 1`;
    const bookingCheck = await pool.query(checkBookingQuery, [id]);

    if (bookingCheck.rows.length > 0) {
      return res.status(400).json({
        success: false,
        message: "ไม่สามารถลบห้องพักได้ เนื่องจากห้องพักนี้มีคิวจองที่กำลังใช้งานอยู่",
      });
    }

    // หากเคลียร์คิวหมดแล้ว สามารถลบออกจากตารางหลักได้ทันที
    const deleteRes = await pool.query('DELETE FROM Rooms WHERE room_id = $1', [id]);

    if (deleteRes.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "ไม่พบห้องพักที่ต้องการลบในระบบ",
      });
    }

    res.status(200).json({
      success: true,
      message: "ลบข้อมูลห้องพักออกจากระบบสำเร็จ",
    });
  } catch (error) {
    console.error("Error in deleteRoom:", error);
    res.status(500).json({
      success: false,
      message: "เกิดข้อผิดพลาดด้านระบบในการลบข้อมูล",
      error: error.message,
    });
  }
};