const pool = require("../config/db");
const jwt = require("jsonwebtoken");
const SECRET = require("../config/secret");

const ALLOWED_PROVIDERS = ["google", "facebook", "line"];

// ==========================================
// M10c — Social Login (Google / Facebook / LINE)
// Flow: ฝั่ง client ล็อกอินกับ provider แล้วส่งโปรไฟล์ที่ได้มาที่ endpoint นี้
//       backend จัดการ auto-link (อีเมลตรง) / auto-register (รายใหม่) แล้วคืน JWT
// ==========================================

// สร้าง JWT แบบเดียวกับ login ปกติ (payload = id/username/role)
function signToken(member) {
    const payload = {
        id: member.member_id,
        username: member.username,
        role: member.user_role,
    };
    const token = jwt.sign(payload, SECRET, { expiresIn: "1d" });
    return { payload, token };
}

// ==========================================
// POST /auth/social
//   body: { provider, provider_id, email?, full_name? }
//   - provider/provider_id มาจาก SDK ฝั่ง client หลังผู้ใช้ยืนยันตัวตนกับ provider แล้ว
//   - ลำดับ: เจอบัญชี social เดิม → ใช้เลย · อีเมลตรง member เดิม → ผูกบัญชี · ไม่เจอ → สมัครใหม่
//   - บัญชีใหม่ role = 'Daily_Tenant' เสมอ (ห้าม escalate เป็น Admin อัตโนมัติ)
// ==========================================
exports.socialLogin = async (req, res) => {
    const client = await pool.connect();
    const { provider, provider_id, email, full_name } = req.body;

    // ตรวจ input
    if (!provider || !ALLOWED_PROVIDERS.includes(provider)) {
        client.release();
        return res.status(400).json({ success: false, message: "provider ต้องเป็น google / facebook / line" });
    }
    if (!provider_id) {
        client.release();
        return res.status(400).json({ success: false, message: "กรุณาระบุ provider_id" });
    }

    try {
        await client.query("BEGIN");

        let member = null;
        let isNewUser = false;
        let linked = false;

        // 1. หาบัญชี social เดิม (provider + provider_id)
        const socialRes = await client.query(
            `SELECT m.* FROM social_accounts s
             JOIN members m ON s.member_id = m.member_id
             WHERE s.provider = $1 AND s.provider_id = $2`,
            [provider, provider_id]
        );

        if (socialRes.rows.length > 0) {
            member = socialRes.rows[0];
        } else {
            // 2. ยังไม่เคยผูก — ถ้าอีเมลตรงกับสมาชิกเดิม → ผูกบัญชี (auto-link)
            if (email) {
                const byEmail = await client.query(
                    `SELECT * FROM members WHERE email = $1 LIMIT 1`,
                    [email]
                );
                if (byEmail.rows.length > 0) {
                    member = byEmail.rows[0];
                    linked = true;
                }
            }

            // 3. ไม่เจอเลย → สมัครสมาชิกใหม่ (password = NULL, role = Daily_Tenant)
            if (!member) {
                // username ต้อง unique — ใช้ provider+provider_id กันชน
                const username = `${provider}_${provider_id}`;
                // full_name ห้าม null — fallback เป็นอีเมล/ชื่อ provider
                const displayName = full_name || email || `ผู้ใช้ ${provider}`;

                const insRes = await client.query(
                    `INSERT INTO members (username, full_name, email, user_role)
                     VALUES ($1, $2, $3, 'Daily_Tenant')
                     RETURNING *`,
                    [username, displayName, email || null]
                );
                member = insRes.rows[0];
                isNewUser = true;
            }

            // ผูกบัญชี social เข้ากับ member (ทั้งกรณี link และ register)
            await client.query(
                `INSERT INTO social_accounts (member_id, provider, provider_id)
                 VALUES ($1, $2, $3)`,
                [member.member_id, provider, provider_id]
            );
        }

        await client.query("COMMIT");

        const { payload, token } = signToken(member);
        res.json({
            success: true,
            payload,
            token,
            isNewUser,
            linked,
            message: isNewUser ? "สมัครสมาชิกผ่าน social สำเร็จ" : (linked ? "ผูกบัญชี social กับสมาชิกเดิมแล้ว" : "เข้าสู่ระบบสำเร็จ"),
        });

    } catch (error) {
        await client.query("ROLLBACK");
        console.error("socialLogin Error:", error.message);
        res.status(400).json({ success: false, message: error.message });
    } finally {
        client.release();
    }
};

// ==========================================
// GET /my-social-accounts — ดูบัญชี social ที่ผูกไว้ (ผู้ล็อกอิน)
// ==========================================
exports.getMySocialAccounts = async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT social_id, provider, created_at
             FROM social_accounts WHERE member_id = $1 ORDER BY social_id`,
            [req.user.id]
        );
        res.json({ success: true, count: result.rows.length, data: result.rows });
    } catch (error) {
        console.error("getMySocialAccounts Error:", error.message);
        res.status(500).json({ success: false, message: "เกิดข้อผิดพลาดในการดึงบัญชี social" });
    }
};
