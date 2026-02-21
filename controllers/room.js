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
        basePrice,    // ราคาพื้นฐาน (รายวัน)
        basePriceMonly, // ราคาเหมา (รายเดือน)
        month, 
        year,
        description 
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
                "basePricedalliy", 
                "status", 
                "basePriceMonly", 
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
            basePriceMonly, 
            description
        ]);
        
        const newRoomId = roomRes.rows[0].id;

        // 4. เพิ่มข้อมูลลงตาราง RoomMonthly (เพื่อใช้เช็คสถานะว่างรายเดือน)
        const monthlyQuery = `
            INSERT INTO "RoomMonthly" (
                "roomId", 
                "month", 
                "year", 
                "price", 
                "isBooked"
            ) 
            VALUES ($1, $2, $3, $4, $5);
        `;

        await client.query(monthlyQuery, [
            newRoomId, 
            month, 
            year, 
            basePriceMonly, 
            false // isBooked: false (ว่างพร้อมจอง)
        ]);

        // 5. หากสำเร็จทั้งหมดให้ Commit
        await client.query("COMMIT");

        res.status(201).json({
            success: true,
            message: "สร้างห้องพักและข้อมูลรายเดือนสำเร็จ",
            roomId: newRoomId
        });

    } catch (error) {
        // 6. หากพังจุดใดจุดหนึ่ง ให้ Rollback (ข้อมูลจะไม่ถูกบันทึกเลย)
        await client.query("ROLLBACK");
        console.error("Error in addRoom Transaction:", error);

        res.status(500).json({
            success: false,
            message: "ไม่สามารถเพิ่มข้อมูลได้",
            error: error.message
        });
    } finally {
        // 7. คืน Client กลับเข้า Pool (สำคัญมาก!)
        client.release();
    }
};
