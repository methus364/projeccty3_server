const pool = require("../config/db");
const { WATER_RATE, ELEC_RATE } = require("../config/utility_rates");

// คำนวณเดือนก่อนหน้าจาก 'YYYY-MM'
function getPrevMonth(yyyyMM) {
    const [year, month] = yyyyMM.split('-').map(Number);
    if (month === 1) return `${year - 1}-12`;
    return `${year}-${String(month - 1).padStart(2, '0')}`;
}

// ==========================================
// 1. Admin บันทึก/แก้ไขมิเตอร์ (recordMeter)
//    รับน้ำ+ไฟพร้อมกัน หรือส่งมาแค่ฝั่งเดียวก็ได้ (หน้าตารางกริดจดทีละช่อง)
//    - ฝั่งที่ไม่ได้ส่งมา = คงค่าเดิมไว้ (ไม่ทับเป็น NULL)
// ==========================================
exports.recordMeter = async (req, res) => {
    const { room_id, record_month } = req.body;
    const recordedBy = req.user.id;

    // แปลงหน่วยที่ส่งมาเป็นตัวเลข (ฝั่งที่ไม่ส่ง/ว่าง = null = ไม่แตะฝั่งนั้น)
    const hasWater = req.body.water_current_unit != null && req.body.water_current_unit !== '';
    const hasElec  = req.body.elec_current_unit  != null && req.body.elec_current_unit  !== '';
    const waterUnit = hasWater ? Number(req.body.water_current_unit) : null;
    const elecUnit  = hasElec  ? Number(req.body.elec_current_unit)  : null;

    // ตรวจ field ที่จำเป็น — ต้องมีน้ำหรือไฟอย่างน้อยหนึ่งอย่าง
    if (!room_id || !record_month) {
        return res.status(400).json({ success: false, message: 'กรุณาระบุ room_id และ record_month' });
    }
    if (!hasWater && !hasElec) {
        return res.status(400).json({ success: false, message: 'กรุณาระบุหน่วยน้ำหรือหน่วยไฟอย่างน้อยหนึ่งอย่าง' });
    }
    if (!/^\d{4}-\d{2}$/.test(record_month)) {
        return res.status(400).json({ success: false, message: 'record_month ต้องอยู่ในรูปแบบ YYYY-MM' });
    }
    if ((hasWater && (isNaN(waterUnit) || waterUnit < 0)) || (hasElec && (isNaN(elecUnit) || elecUnit < 0))) {
        return res.status(400).json({ success: false, message: 'หน่วยมิเตอร์ต้องเป็นตัวเลขที่ไม่ติดลบ' });
    }

    try {
        // เช็คว่าเลขมิเตอร์ปัจจุบันน้อยกว่าเดือนก่อน (อาจกรอกผิดหรือมิเตอร์รีเซ็ต)
        // เช็คเฉพาะฝั่งที่ส่งมา และเทียบกับเดือนก่อนเฉพาะที่มีค่า (ไม่ null)
        // ถ้ามิเตอร์รีเซ็ตจริง admin ส่ง override:true มาเพื่อบายพาสการเช็คนี้
        const prevMonth = getPrevMonth(record_month);
        const prevRes = await pool.query(
            `SELECT water_current_unit, elec_current_unit FROM utility_meters
             WHERE room_id = $1 AND record_month = $2`,
            [room_id, prevMonth]
        );
        const override = req.body.override === true;

        if (prevRes.rows.length > 0) {
            const prev = prevRes.rows[0];

            if (hasWater && prev.water_current_unit != null && waterUnit < Number(prev.water_current_unit) && !override) {
                return res.status(400).json({
                    success: false,
                    message: `เลขมิเตอร์น้ำ (${waterUnit}) น้อยกว่าเดือนก่อน (${prev.water_current_unit}) — ตรวจสอบอีกครั้ง หรือส่ง override:true ถ้ามิเตอร์รีเซ็ตจริง`,
                    prevWater: Number(prev.water_current_unit),
                });
            }

            if (hasElec && prev.elec_current_unit != null && elecUnit < Number(prev.elec_current_unit) && !override) {
                return res.status(400).json({
                    success: false,
                    message: `เลขมิเตอร์ไฟ (${elecUnit}) น้อยกว่าเดือนก่อน (${prev.elec_current_unit}) — ตรวจสอบอีกครั้ง หรือส่ง override:true ถ้ามิเตอร์รีเซ็ตจริง`,
                    prevElec: Number(prev.elec_current_unit),
                });
            }
        }

        // UPSERT — 1 ห้อง 1 แถว/เดือน; ฝั่งที่ส่ง null มาจะคงค่าเดิมไว้ (COALESCE)
        const result = await pool.query(
            `INSERT INTO utility_meters
                 (room_id, record_month, water_current_unit, elec_current_unit, recorded_by)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (room_id, record_month)
             DO UPDATE SET
                 water_current_unit = COALESCE(EXCLUDED.water_current_unit, utility_meters.water_current_unit),
                 elec_current_unit  = COALESCE(EXCLUDED.elec_current_unit,  utility_meters.elec_current_unit),
                 recorded_by        = EXCLUDED.recorded_by,
                 recorded_at        = CURRENT_TIMESTAMP
             RETURNING *`,
            [room_id, record_month, waterUnit, elecUnit, recordedBy]
        );

        res.status(201).json({ success: true, data: result.rows[0], message: 'บันทึกมิเตอร์สำเร็จ' });

    } catch (error) {
        console.error('recordMeter Error:', error.message);
        res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการบันทึกมิเตอร์' });
    }
};

// ==========================================
// 3. Admin ดูมิเตอร์ทั้งปีแบบตาราง (getMeterYear)
//    GET /meters/year?year=YYYY  (ค.ศ.)
//    คืนทุกห้อง (ยกเว้นปิดปรับปรุง) พร้อมเลขมิเตอร์สะสมราย 12 เดือน — สำหรับหน้าตารางกริด
// ==========================================
exports.getMeterYear = async (req, res) => {
    const { year } = req.query; // 'YYYY' ค.ศ.

    if (!year || !/^\d{4}$/.test(year)) {
        return res.status(400).json({ success: false, message: 'กรุณาระบุ year ในรูปแบบ YYYY (ค.ศ.)' });
    }

    try {
        // ดึงทุกห้อง LEFT JOIN มิเตอร์ทุกเดือนของปีนั้น (record_month ขึ้นต้นด้วย 'YYYY-')
        const result = await pool.query(
            `SELECT r.room_id, r.room_number, r.room_status,
                    um.record_month, um.water_current_unit, um.elec_current_unit, um.meter_id
             FROM rooms r
             LEFT JOIN utility_meters um
                ON um.room_id = r.room_id AND um.record_month LIKE $1
             WHERE r.room_status != 'ปิดปรับปรุง'
             ORDER BY r.room_number DESC, um.record_month`,
            [`${year}-%`]
        );

        // pivot: รวมหลายแถว (รายเดือน) ของห้องเดียวกันให้เป็น readings ต่อห้อง
        const roomsMap = new Map();
        for (const row of result.rows) {
            if (!roomsMap.has(row.room_id)) {
                roomsMap.set(row.room_id, {
                    room_id: row.room_id,
                    room_number: row.room_number,
                    room_status: row.room_status,
                    readings: {}, // { 'YYYY-MM': { water, elec, meter_id } }
                });
            }
            if (row.record_month) {
                roomsMap.get(row.room_id).readings[row.record_month] = {
                    water: row.water_current_unit,
                    elec: row.elec_current_unit,
                    meter_id: row.meter_id,
                };
            }
        }

        // รายชื่อ 12 เดือนของปี (ให้ frontend ทำหัวตารางได้ตรงลำดับ)
        const months = [];
        for (let m = 1; m <= 12; m++) {
            months.push(`${year}-${String(m).padStart(2, '0')}`);
        }

        const rooms = Array.from(roomsMap.values());
        res.json({
            success: true,
            year: Number(year),
            months,
            water_rate: WATER_RATE,
            elec_rate: ELEC_RATE,
            count: rooms.length,
            data: rooms,
        });
    } catch (error) {
        console.error('getMeterYear Error:', error.message);
        res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการดึงมิเตอร์รายปี' });
    }
};

// ==========================================
// 2. Admin ดูรายการมิเตอร์ทุกห้องในเดือนที่เลือก (getMeters)
//    พร้อม diff จากเดือนก่อน + ค่าใช้จ่ายประมาณ
// ==========================================
exports.getMeters = async (req, res) => {
    const { month } = req.query; // YYYY-MM

    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
        return res.status(400).json({ success: false, message: 'กรุณาระบุ month ในรูปแบบ YYYY-MM' });
    }

    const prevMonth = getPrevMonth(month);

    // ดึงห้องทั้งหมด (ยกเว้นปิดปรับปรุง) พร้อม JOIN มิเตอร์เดือนปัจจุบันและเดือนก่อน
    const result = await pool.query(
        `SELECT
            r.room_id,
            r.room_number,
            r.room_status,
            curr.meter_id,
            curr.water_current_unit,
            curr.elec_current_unit,
            curr.recorded_at,
            prev.water_current_unit AS prev_water_unit,
            prev.elec_current_unit  AS prev_elec_unit,
            m.full_name             AS recorded_by_name
         FROM rooms r
         LEFT JOIN utility_meters curr
            ON curr.room_id = r.room_id AND curr.record_month = $1
         LEFT JOIN utility_meters prev
            ON prev.room_id = r.room_id AND prev.record_month = $2
         LEFT JOIN members m ON curr.recorded_by = m.member_id
         WHERE r.room_status != 'ปิดปรับปรุง'
         ORDER BY r.room_number`,
        [month, prevMonth]
    );

    // คำนวณ diff และค่าใช้จ่ายฝั่ง server (ไม่เชื่อค่าจาก client)
    const rows = result.rows.map(row => {
        const hasCurrent = row.water_current_unit != null;
        const hasPrev    = row.prev_water_unit    != null;

        const diffWater = hasCurrent && hasPrev
            ? row.water_current_unit - row.prev_water_unit
            : null;
        const diffElec  = hasCurrent && hasPrev
            ? row.elec_current_unit  - row.prev_elec_unit
            : null;

        return {
            room_id:          row.room_id,
            room_number:      row.room_number,
            room_status:      row.room_status,
            meter_id:         row.meter_id,
            water_current:    row.water_current_unit,
            elec_current:     row.elec_current_unit,
            prev_water:       row.prev_water_unit,
            prev_elec:        row.prev_elec_unit,
            diff_water:       diffWater,
            diff_elec:        diffElec,
            // กันติดลบตอนคิดเงิน (มิเตอร์ถูกรีเซ็ต/override) — แต่ diff_water/diff_elec ข้างบนโชว์ค่าจริงไว้ให้แอดมินสังเกต
            water_cost:       diffWater != null ? Math.max(0, diffWater) * WATER_RATE : null,
            elec_cost:        diffElec  != null ? Math.max(0, diffElec)  * ELEC_RATE  : null,
            recorded_at:      row.recorded_at,
            recorded_by_name: row.recorded_by_name,
            water_rate:       WATER_RATE,
            elec_rate:        ELEC_RATE,
        };
    });

    res.json({ success: true, count: rows.length, data: rows });
};
