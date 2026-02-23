const pool = require("../config/db"); // เปลี่ยนไปใช้ pool จากไฟล์ db.js ที่เราสร้างใหม่
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

exports.createRoom = async (req, res) => {
  // 1. จอง Client จาก Pool เพื่อทำ Transaction
  const client = await pool.connect();

  // ดึงข้อมูลจาก Body (Destructuring)
  const {
    number,
    type,
    floor,
    basePrice, // ราคาพื้นฐาน (รายวัน)
    basePriceMonthly, // ราคาเหมา (รายเดือน)
    description,
  } = req.body;

  try {
    // 2. เริ่มต้น Transaction
    await client.query("BEGIN");

    // 3. เพิ่มข้อมูลลงตาราง Room
    // อ้างอิงโครงสร้าง: id, number, type, floor, basePricedalliy, status, basePriceMonly, description
    const roomQuery = `
            INSERT INTO "Room" (
                "number", 
                "type", 
                "floor", 
                "basePricedaily", 
                "status", 
                "basePriceMonthly", 
                "description", 
                "createdAt", 
                "updatedAt"
            ) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW()) 
            RETURNING id;
        `;

    const roomRes = await client.query(roomQuery, [
      number,
      type,
      floor,
      basePrice,
      true, // status: true (เปิดใช้งาน)
      basePriceMonthly,
      description,
    ]);

    const newRoomId = roomRes.rows[0].id;

    // 4. เพิ่มข้อมูลลงตาราง RoomMonthly (เพื่อใช้เช็คสถานะว่างรายเดือน)
    const monthlyQuery = `
            INSERT INTO "RoomMonthly" (
                "roomId", 
                "price", 
                "isBooked"
            ) 
            VALUES ($1, $2, $3, $4, $5);
        `;

    await client.query(monthlyQuery, [
      newRoomId,
      basePriceMonthly,
      false, // isBooked: false (ว่างพร้อมจอง)
    ]);

    // 5. หากสำเร็จทั้งหมดให้ Commit
    await client.query("COMMIT");

    res.status(201).json({
      success: true,
      message: "สร้างห้องพักและข้อมูลรายเดือนสำเร็จ",
      roomId: newRoomId,
    });
  } catch (error) {
    // 6. หากพังจุดใดจุดหนึ่ง ให้ Rollback (ข้อมูลจะไม่ถูกบันทึกเลย)ๆ
    await client.query("ROLLBACK");
    console.error("Error in addRoom Transaction:", error);

    res.status(500).json({
      success: false,
      message: "ไม่สามารถเพิ่มข้อมูลได้",
      error: error.message,
    });
  } finally {
    // 7. คืน Client กลับเข้า Pool (สำคัญมาก!)
    client.release();
  }
};

exports.getRooms = async (req, res) => {
  try {
    const query = `
            SELECT 
                r.id, 
                r.number, 
                r.type, 
                r.floor, 
                r."basePricedaily", 
                r."basePriceMonthly",
                r.description,
                rm."isBooked" as "isMonthlyBooked", -- สถานะรายเดือน
                rm.price as "currentMonthPrice"
            FROM "Room" r
            LEFT JOIN "RoomMonthly" rm ON r.id = rm."roomId" 
            WHERE r.status = true -- เฉพาะห้องที่พร้อมเปิดใช้งาน
            ORDER BY r.floor ASC, r.number ASC;
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

exports.editRoom = async (req, res) => {
  const client = await pool.connect();
  const { id } = req.params; // ID ของห้องที่จะแก้ไข
  const {
    number,
    type,
    floor,
    basePrice,
    basePriceMonly,
    status,
    description,
    month,
    year,
  } = req.body;

  try {
    await client.query("BEGIN");

    // 1. ตรวจสอบข้อมูลเดิมจาก Database
    const currentDataRes = await client.query(
      'SELECT * FROM "Room" WHERE id = $1',
      [id],
    );
    if (currentDataRes.rows.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: "ไม่พบห้องพักที่ต้องการแก้ไข" });
    }
    const current = currentDataRes.rows[0];

    // 2. อัปเดตตาราง Room (ใช้ค่าใหม่ หรือถ้าไม่มีให้ใช้ค่าเดิม)
    const roomUpdateQuery = `
            UPDATE "Room" SET 
                "number" = $1, 
                "type" = $2, 
                "basePricedaily" = $3, 
                "status" = $4, 
                "basePriceMonthly" = $5, 
                "description" = $6, 
                "updatedAt" = NOW()
            WHERE id = $7
        `;

    await client.query(roomUpdateQuery, [
      number !== undefined ? number : current.number,
      type !== undefined ? type : current.type,
      basePrice !== undefined ? basePrice : current.basePricedaily,
      status !== undefined ? status : current.status,
      basePriceMonthly !== undefined
        ? basePriceMonthly
        : current.basePriceMonthly,
      description !== undefined ? description : current.description,
      id,
    ]);

    // 3. อัปเดตราคาใน RoomMonthly (ถ้ามีการส่งเดือน ปี หรือราคามา)
    // หมายเหตุ: จะอัปเดตเฉพาะ Row ที่ตรงกับเดือน/ปี ที่ระบุ
    if (month && year) {
      const monthlyUpdateQuery = `
                UPDATE "RoomMonthly" 
                SET "price" = $1 
                WHERE "roomId" = $2 AND "month" = $3 AND "year" = $4
            `;
      await client.query(monthlyUpdateQuery, [
        basePriceMonly !== undefined ? basePriceMonly : current.basePriceMonly,
        id,
        month,
        year,
      ]);
    }

    await client.query("COMMIT");

    res.status(200).json({
      success: true,
      message: "แก้ไขข้อมูลห้องพักสำเร็จ",
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error in editRoom Transaction:", error);
    res.status(500).json({
      success: false,
      message: "เกิดข้อผิดพลาดในการแก้ไขข้อมูล",
      error: error.message,
    });
  } finally {
    client.release();
  }
};

exports.searchRooms = async (req, res) => {
  // รองรับทั้งการส่งผ่าน Body (POST) หรือ Query (GET)
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
        r.id, 
        r.number, 
        r.type, 
        r.floor, 
        r."basePricedaily", 
        r."basePriceMonthly",
        rm.price AS monthly_price_current,
        rm."isBooked" AS monthly_booked_status
    FROM "Room" r
    INNER JOIN "RoomMonthly" rm ON r.id = rm."roomId"
    WHERE rm."isBooked" = false -- เงื่อนไข 1: ไม่มีการเช่ารายเดือนอยู่
    AND r.status = true        -- เงื่อนไขเพิ่มเติม: ห้องต้องพร้อมใช้งาน (status ในตาราง Room)
    AND r.id NOT IN (
        -- เงื่อนไข 2: ไม่อยู่ในช่วงที่มีคนจอง (Booking)
        SELECT "roomId" 
        FROM "Booking"
        WHERE status != 'CANCELLED' 
        AND (
            ("startDate" < $2 AND "endDate" > $1) -- สูตรตรวจสอบการทับซ้อนของวันที่
        )
    )
    ORDER BY r.floor ASC, r.number ASC;
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
      error: "เกิดข้อผิดพลาดในการเชื่อมต่อฐานข้อมูล" 
    });
  }
};