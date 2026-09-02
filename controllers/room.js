const pool = require("../config/db");
const { uploadFile } = require("../config/supabase");

// แปลงค่า image_urls ที่รับมาจาก client ให้เป็น array เสมอ (หรือ null ถ้าไม่มีรูป)
// - รับได้ทั้ง image_urls (array หลายรูป) และ image_url เดิม (รูปเดียว)
function normalizeImageUrls(imageUrls, imageUrl) {
  if (Array.isArray(imageUrls) && imageUrls.length > 0) {
    return imageUrls;
  }
  if (imageUrl) {
    return [imageUrl];
  }
  return null;
}

// ==========================================
// 1. สร้างห้องพักใหม่ (createRoom)
// ==========================================
exports.createRoom = async (req, res) => {
  const { number, room_status, type_name, room_price, price_monthly, image_url, image_urls,
          description, amenities, room_size } = req.body;

  if (!number) {
    return res.status(400).json({ success: false, message: "กรุณาระบุหมายเลขห้อง" });
  }

  try {
    // รวมรูปเป็น array · รูปแรกใช้เป็นรูปปก (image_url) เผื่อหน้าจอเดิม
    const imageList = normalizeImageUrls(image_urls, image_url);
    const coverUrl = imageList ? imageList[0] : null;

    const result = await pool.query(
      `INSERT INTO rooms
         (room_number, room_status, type_name, room_price, price_monthly, image_url, image_urls,
          description, amenities, room_size)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING room_id`,
      [
        number, room_status || 'ว่าง', type_name || null,
        room_price || null, price_monthly || null, coverUrl, imageList,
        description || null, amenities || null, room_size || null,
      ]
    );

    res.status(201).json({
      success: true,
      message: "สร้างห้องพักสำเร็จ",
      roomId: result.rows[0].room_id,
    });
  } catch (error) {
    console.error("Error in createRoom:", error);
    res.status(500).json({ success: false, message: "ไม่สามารถเพิ่มข้อมูลห้องพักได้", error: error.message });
  }
};

// ==========================================
// 2. ดึงรายการห้องพักทั้งหมด (getRooms)
// ==========================================
exports.getRooms = async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         room_id        AS "id",
         room_number    AS "number",
         room_status    AS "status",
         type_name      AS "typeName",
         room_price     AS "price",
         price_monthly  AS "priceMonthly",
         image_url      AS "imageUrl",
         image_urls     AS "imageUrls",
         description    AS "description",
         amenities      AS "amenities",
         room_size      AS "roomSize"
       FROM rooms
       WHERE room_status != 'ปิดปรับปรุง'
       ORDER BY room_number ASC`
    );

    res.status(200).json({ success: true, count: rows.length, data: rows });
  } catch (error) {
    console.error("Get Rooms Error:", error);
    res.status(500).json({ success: false, message: "ไม่สามารถดึงข้อมูลห้องพักได้", error: error.message });
  }
};

// ==========================================
// 3. แก้ไขข้อมูลห้องพัก (editRoom)
// ==========================================
exports.editRoom = async (req, res) => {
  const { id } = req.params;
  const { number, status, type_name, room_price, price_monthly, image_url, image_urls,
          description, amenities, room_size } = req.body;

  try {
    const currentRes = await pool.query('SELECT * FROM rooms WHERE room_id = $1', [id]);
    if (currentRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: "ไม่พบห้องพักที่ต้องการแก้ไข" });
    }
    const c = currentRes.rows[0];

    // ถ้าส่ง image_urls มา → ใช้ค่าใหม่ (รูปแรกเป็นรูปปก) · ถ้าไม่ส่ง → คงรูปเดิมไว้
    let newImageList = c.image_urls;
    if (image_urls !== undefined) {
      newImageList = normalizeImageUrls(image_urls, image_url);
    } else if (image_url !== undefined) {
      newImageList = normalizeImageUrls(null, image_url);
    }
    const newCoverUrl = newImageList && newImageList.length > 0 ? newImageList[0] : null;

    await pool.query(
      `UPDATE rooms SET
         room_number    = $1,
         room_status    = $2,
         type_name      = $3,
         room_price     = $4,
         price_monthly  = $5,
         image_url      = $6,
         image_urls     = $7,
         description    = $8,
         amenities      = $9,
         room_size      = $10
       WHERE room_id = $11`,
      [
        number         !== undefined ? number         : c.room_number,
        status         !== undefined ? status         : c.room_status,
        type_name      !== undefined ? type_name      : c.type_name,
        room_price     !== undefined ? room_price     : c.room_price,
        price_monthly  !== undefined ? price_monthly  : c.price_monthly,
        newCoverUrl,
        newImageList,
        description    !== undefined ? description    : c.description,
        amenities      !== undefined ? amenities      : c.amenities,
        room_size      !== undefined ? room_size      : c.room_size,
        id,
      ]
    );

    res.status(200).json({ success: true, message: "แก้ไขข้อมูลห้องพักเสร็จสิ้น" });
  } catch (error) {
    console.error("Error in editRoom:", error);
    res.status(500).json({ success: false, message: "เกิดข้อผิดพลาดในการแก้ไขข้อมูล", error: error.message });
  }
};

// ==========================================
// 4. ค้นหาห้องว่างตามช่วงเวลา (searchRooms)
// ==========================================
exports.searchRooms = async (req, res) => {
  const checkIn  = req.body.checkIn  || req.query.checkIn;
  const checkOut = req.body.checkOut || req.query.checkOut;

  if (!checkIn || !checkOut) {
    return res.status(400).json({
      success: false,
      error: "กรุณาระบุ checkIn และ checkOut ในรูปแบบ YYYY-MM-DD",
    });
  }

  try {
    const result = await pool.query(
      `SELECT
         room_id        AS "id",
         room_number    AS "number",
         room_status    AS "status",
         type_name      AS "typeName",
         room_price     AS "price",
         price_monthly  AS "priceMonthly",
         image_url      AS "imageUrl",
         image_urls     AS "imageUrls",
         description    AS "description",
         amenities      AS "amenities",
         room_size      AS "roomSize"
       FROM rooms r
       WHERE r.room_status <> 'ปิดปรับปรุง'
         -- ห้องว่างจองรายวันได้ ถ้าไม่มีการจองที่ "ชนช่วงวันที่เลือก"
         -- ใช้ช่วงวันเป็นตัวตัดสิน (ไม่ใช่สถานะห้อง) เพราะสถานะอาจค้าง 'มีผู้เช่า'
         -- จากการจองเก่าที่จบไปแล้วแต่ยังไม่ได้เช็คเอาท์
         AND NOT EXISTS (
           SELECT 1 FROM bookings b
           WHERE b.room_id = r.room_id
             AND b.booking_status NOT IN ('ยกเลิก', 'ย้ายออกแล้ว')
             AND (
               -- กันห้องที่มีผู้เช่ารายเดือนไว้ทั้งหมด (วันออกรายเดือนเป็นค่าชั่วคราว เชื่อไม่ได้)
               b.rent_type = 'monthly'
               -- รายวัน: กันเฉพาะที่ช่วงวันซ้อนกับที่ค้นหา ($1=วันเข้า $2=วันออก)
               OR ($1 < b.check_out_date AND $2 > b.check_in_date)
             )
         )
       ORDER BY r.room_number ASC`,
      [checkIn, checkOut]
    );

    res.status(200).json({ success: true, count: result.rowCount, data: result.rows });
  } catch (err) {
    console.error('Search Rooms Error:', err.message);
    res.status(500).json({ success: false, error: "เกิดข้อผิดพลาดในการค้นหาห้องว่าง" });
  }
};

// ==========================================
// 5. ลบห้องพัก (deleteRoom)
// ==========================================
exports.deleteRoom = async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // ล็อกแถวห้องไว้ก่อน (FOR UPDATE) กันมีคนจองห้องนี้เข้ามาแทรกระหว่างเช็ค-แล้ว-ลบ
    // (ไม่ล็อกไว้ก่อน booking ที่เพิ่ง insert เข้ามาพอดีจะโดน cascade ลบไปด้วยตอน DELETE rooms)
    const roomRes = await client.query('SELECT room_id FROM rooms WHERE room_id = $1 FOR UPDATE', [id]);
    if (roomRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "ไม่พบห้องพักที่ต้องการลบ" });
    }

    // บล็อกการลบเฉพาะเมื่อ "ยังมีคนอยู่จริง" หรือ "มีการจองที่ยังไม่สิ้นสุด"
    //   - booking_status = 'กำลังเข้าพัก'  → มีคนเข้าพักอยู่ตอนนี้
    //   - check_out_date >= วันนี้          → การจอง/เข้าพักที่ยังไม่หมดวัน (รวมที่จองล่วงหน้า)
    // ปล่อยให้ลบได้ถ้าเหลือแต่การจองเก่าที่จบไปแล้ว (check_out_date < วันนี้) แม้สถานะยังค้าง
    const bookingCheck = await client.query(
      `SELECT booking_id FROM bookings
       WHERE room_id = $1
         AND booking_status NOT IN ('ยกเลิก', 'ย้ายออกแล้ว')
         AND (booking_status = 'กำลังเข้าพัก' OR check_out_date >= CURRENT_DATE)
       LIMIT 1`,
      [id]
    );

    if (bookingCheck.rows.length > 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: "ไม่สามารถลบได้ เนื่องจากห้องนี้มีผู้เข้าพักอยู่ หรือมีการจองที่ยังไม่สิ้นสุด",
      });
    }

    await client.query('DELETE FROM rooms WHERE room_id = $1', [id]);
    await client.query("COMMIT");

    res.status(200).json({ success: true, message: "ลบห้องพักสำเร็จ" });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Error in deleteRoom:", error);
    res.status(500).json({ success: false, message: "เกิดข้อผิดพลาดในการลบ", error: error.message });
  } finally {
    client.release();
  }
};

// ==========================================
// 6. อัปโหลดรูปห้อง (uploadRoomImages) — multipart, ได้หลายไฟล์
//    คืน public URL กลับไปให้ frontend เก็บใส่ image_urls ตอนบันทึกห้อง
// ==========================================
exports.uploadRoomImages = async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ success: false, message: "กรุณาเลือกไฟล์รูปอย่างน้อย 1 รูป" });
  }

  try {
    // อัปโหลดทีละไฟล์ขึ้น Supabase Storage → เก็บ URL เรียงตามลำดับที่เลือกมา
    const urls = [];
    for (const file of req.files) {
      const url = await uploadFile(file.buffer, file.originalname, file.mimetype, "room");
      urls.push(url);
    }

    res.status(201).json({ success: true, urls });
  } catch (error) {
    console.error("Error in uploadRoomImages:", error);
    res.status(500).json({ success: false, message: "อัปโหลดรูปไม่สำเร็จ", error: error.message });
  }
};
