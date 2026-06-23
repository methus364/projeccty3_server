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
// ==========================================
exports.recordMeter = async (req, res) => {
    const { room_id, record_month, water_current_unit, elec_current_unit } = req.body;
    const recordedBy = req.user.id;

    // ตรวจ field ที่จำเป็น
    if (!room_id || !record_month || water_current_unit == null || elec_current_unit == null) {
        return res.status(400).json({
            success: false,
            message: 'กรุณาระบุ room_id, record_month, water_current_unit และ elec_current_unit'
        });
    }

    if (!/^\d{4}-\d{2}$/.test(record_month)) {
        return res.status(400).json({ success: false, message: 'record_month ต้องอยู่ในรูปแบบ YYYY-MM' });
    }

    if (water_current_unit < 0 || elec_current_unit < 0) {
        return res.status(400).json({ success: false, message: 'หน่วยมิเตอร์ต้องเป็นตัวเลขที่ไม่ติดลบ' });
    }

    try {
        // เช็คว่าเลขมิเตอร์ปัจจุบันน้อยกว่าเดือนก่อน (อาจกรอกผิดหรือมิเตอร์รีเซ็ต)
        // ถ้ามิเตอร์รีเซ็ตจริง admin ส่ง override:true มาเพื่อบายพาสการเช็คนี้
        const prevMonth = getPrevMonth(record_month);
        const prevRes = await pool.query(
            `SELECT water_current_unit, elec_current_unit FROM utility_meters
             WHERE room_id = $1 AND record_month = $2`,
            [room_id, prevMonth]
        );

        if (prevRes.rows.length > 0) {
            const prev = prevRes.rows[0];
            const override = req.body.override === true;

            if (Number(water_current_unit) < Number(prev.water_current_unit) && !override) {
                return res.status(400).json({
                    success: false,
                    message: `เลขมิเตอร์น้ำ (${water_current_unit}) น้อยกว่าเดือนก่อน (${prev.water_current_unit}) — ตรวจสอบอีกครั้ง หรือส่ง override:true ถ้ามิเตอร์รีเซ็ตจริง`,
                    prevWater: Number(prev.water_current_unit),
                    prevElec:  Number(prev.elec_current_unit),
                });
            }

            if (Number(elec_current_unit) < Number(prev.elec_current_unit) && !override) {
                return res.status(400).json({
                    success: false,
                    message: `เลขมิเตอร์ไฟ (${elec_current_unit}) น้อยกว่าเดือนก่อน (${prev.elec_current_unit}) — ตรวจสอบอีกครั้ง หรือส่ง override:true ถ้ามิเตอร์รีเซ็ตจริง`,
                    prevWater: Number(prev.water_current_unit),
                    prevElec:  Number(prev.elec_current_unit),
                });
            }
        }

        // UPSERT — 1 ห้อง บันทึกได้ 1 ครั้ง/เดือน; ถ้าบันทึกซ้ำให้ override
        const result = await pool.query(
            `INSERT INTO utility_meters
                 (room_id, record_month, water_current_unit, elec_current_unit, recorded_by)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (room_id, record_month)
             DO UPDATE SET
                 water_current_unit = EXCLUDED.water_current_unit,
                 elec_current_unit  = EXCLUDED.elec_current_unit,
                 recorded_by        = EXCLUDED.recorded_by,
                 recorded_at        = CURRENT_TIMESTAMP
             RETURNING *`,
            [room_id, record_month, water_current_unit, elec_current_unit, recordedBy]
        );

        res.status(201).json({ success: true, data: result.rows[0], message: 'บันทึกมิเตอร์สำเร็จ' });

    } catch (error) {
        console.error('recordMeter Error:', error.message);
        res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการบันทึกมิเตอร์' });
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
            water_cost:       diffWater != null ? diffWater * WATER_RATE : null,
            elec_cost:        diffElec  != null ? diffElec  * ELEC_RATE  : null,
            recorded_at:      row.recorded_at,
            recorded_by_name: row.recorded_by_name,
            water_rate:       WATER_RATE,
            elec_rate:        ELEC_RATE,
        };
    });

    res.json({ success: true, count: rows.length, data: rows });
};
