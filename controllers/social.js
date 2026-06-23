const pool = require("../config/db");
const jwt = require("jsonwebtoken");
const SECRET = require("../config/secret");

// ==========================================
// M10c — Social Login (Google / Facebook / LINE)
// หลักการ: **backend ตรวจ token กับ provider เอง** ไม่เชื่อโปรไฟล์ที่ client ส่งมาตรงๆ
//   (กัน client ปลอม email/provider_id แล้วสวมบัญชีคนอื่นผ่าน auto-link)
//   - Google  : client ส่ง id_token → ตรวจที่ tokeninfo → ได้ sub/email/name
//   - Facebook: client ส่ง access_token → ตรวจที่ Graph /me + debug_token
//   - LINE    : redirect flow → client ส่ง code → backend แลก id_token แล้วตรวจ HS256
// env (server/.env): GOOGLE_CLIENT_ID, FACEBOOK_APP_ID/SECRET, LINE_CHANNEL_ID/SECRET
// ==========================================

// สร้าง JWT แบบเดียวกับ login ปกติ
function signToken(member) {
    const payload = { id: member.member_id, username: member.username, role: member.user_role };
    const token = jwt.sign(payload, SECRET, { expiresIn: "1d" });
    return { payload, token };
}

// ---------- ตรวจ token กับแต่ละ provider → คืน { provider_id, email, full_name } ----------

// Google: ตรวจ id_token ที่ tokeninfo endpoint + เช็ค audience ตรง client id ของเรา
async function verifyGoogle(idToken) {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) throw new Error("ยังไม่ได้ตั้งค่า GOOGLE_CLIENT_ID ใน server/.env");

    const r = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
    const data = await r.json();
    if (!data.sub) throw new Error("id_token ของ Google ไม่ถูกต้อง");
    if (data.aud !== clientId) throw new Error("token นี้ไม่ได้ออกให้แอปนี้ (audience ไม่ตรง)");

    return { provider_id: data.sub, email: data.email, full_name: data.name };
}

// Facebook: ตรวจ access_token ว่าเป็นของแอปเรา (debug_token) แล้วดึงโปรไฟล์ (/me)
async function verifyFacebook(accessToken) {
    const appId = process.env.FACEBOOK_APP_ID;
    const appSecret = process.env.FACEBOOK_APP_SECRET;
    if (!appId || !appSecret) throw new Error("ยังไม่ได้ตั้งค่า FACEBOOK_APP_ID/SECRET ใน server/.env");

    // 1. ยืนยันว่า token เป็นของแอปเราและยังใช้ได้
    const dbg = await fetch(
        `https://graph.facebook.com/debug_token?input_token=${encodeURIComponent(accessToken)}&access_token=${appId}|${appSecret}`
    );
    const dbgData = (await dbg.json()).data || {};
    if (!dbgData.is_valid || String(dbgData.app_id) !== String(appId)) {
        throw new Error("access_token ของ Facebook ไม่ถูกต้องหรือไม่ใช่ของแอปนี้");
    }

    // 2. ดึงโปรไฟล์
    const me = await fetch(`https://graph.facebook.com/me?fields=id,name,email&access_token=${encodeURIComponent(accessToken)}`);
    const profile = await me.json();
    if (!profile.id) throw new Error("ดึงโปรไฟล์ Facebook ไม่สำเร็จ");

    return { provider_id: profile.id, email: profile.email, full_name: profile.name };
}

// LINE: แลก authorization code → id_token แล้วตรวจ HS256 ด้วย channel secret
async function verifyLine(code, redirectUri) {
    const channelId = process.env.LINE_CHANNEL_ID;
    const channelSecret = process.env.LINE_CHANNEL_SECRET;
    if (!channelId || !channelSecret) throw new Error("ยังไม่ได้ตั้งค่า LINE_CHANNEL_ID/SECRET ใน server/.env");

    const tokenRes = await fetch("https://api.line.me/oauth2/v2.1/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            redirect_uri: redirectUri,
            client_id: channelId,
            client_secret: channelSecret,
        }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.id_token) throw new Error(tokenData.error_description || "แลก token กับ LINE ไม่สำเร็จ");

    // LINE เซ็น id_token แบบ HS256 ด้วย channel secret → ตรวจลายเซ็น+aud+iss
    const profile = jwt.verify(tokenData.id_token, channelSecret, {
        algorithms: ["HS256"],
        audience: channelId,
        issuer: "https://access.line.me",
    });
    return { provider_id: profile.sub, email: profile.email, full_name: profile.name };
}

// ==========================================
// Core: หา/ผูก/สร้าง member จากโปรไฟล์ที่ "ตรวจแล้ว" (ใช้ร่วมทุก provider)
//   db = client ที่อยู่ใน transaction · คืน { member, isNewUser, linked }
// ==========================================
async function findOrCreateMember(db, provider, { provider_id, email, full_name }) {
    // 1. เจอบัญชี social เดิม → ใช้เลย
    const socialRes = await db.query(
        `SELECT m.* FROM social_accounts s
         JOIN members m ON s.member_id = m.member_id
         WHERE s.provider = $1 AND s.provider_id = $2`,
        [provider, provider_id]
    );
    if (socialRes.rows.length > 0) {
        return { member: socialRes.rows[0], isNewUser: false, linked: false };
    }

    let member = null;
    let linked = false;
    let isNewUser = false;

    // 2. อีเมลตรงสมาชิกเดิม → auto-link
    if (email) {
        const byEmail = await db.query(`SELECT * FROM members WHERE email = $1 LIMIT 1`, [email]);
        if (byEmail.rows.length > 0) {
            member = byEmail.rows[0];
            linked = true;
        }
    }

    // 3. ไม่เจอเลย → สมัครใหม่ (password NULL, role Daily_Tenant ห้าม escalate)
    if (!member) {
        const username = `${provider}_${provider_id}`;
        const displayName = full_name || email || `ผู้ใช้ ${provider}`;
        const insRes = await db.query(
            `INSERT INTO members (username, full_name, email, user_role)
             VALUES ($1, $2, $3, 'Daily_Tenant')
             RETURNING *`,
            [username, displayName, email || null]
        );
        member = insRes.rows[0];
        isNewUser = true;
    }

    await db.query(
        `INSERT INTO social_accounts (member_id, provider, provider_id) VALUES ($1, $2, $3)`,
        [member.member_id, provider, provider_id]
    );
    return { member, isNewUser, linked };
}

// บันทึก member + ออก JWT ใน transaction (ใช้ร่วมทุก endpoint)
async function loginWithProfile(res, provider, profile) {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const result = await findOrCreateMember(client, provider, profile);
        await client.query("COMMIT");
        const { payload, token } = signToken(result.member);
        res.json({
            success: true, payload, token,
            isNewUser: result.isNewUser, linked: result.linked,
            message: result.isNewUser ? "สมัครสมาชิกผ่าน social สำเร็จ"
                : (result.linked ? "ผูกบัญชี social กับสมาชิกเดิมแล้ว" : "เข้าสู่ระบบสำเร็จ"),
        });
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
}

// ==========================================
// POST /auth/social — Google / Facebook
//   body: { provider: 'google'|'facebook', token }  (token = id_token/access_token จาก SDK)
// ==========================================
exports.socialLogin = async (req, res) => {
    const { provider, token } = req.body;
    try {
        let profile;
        if (provider === "google") {
            profile = await verifyGoogle(token);
        } else if (provider === "facebook") {
            profile = await verifyFacebook(token);
        } else {
            return res.status(400).json({ success: false, message: "provider ต้องเป็น google หรือ facebook (LINE ใช้ /auth/line/exchange)" });
        }
        if (!token) return res.status(400).json({ success: false, message: "กรุณาส่ง token" });

        await loginWithProfile(res, provider, profile);
    } catch (error) {
        console.error("socialLogin Error:", error.message);
        res.status(400).json({ success: false, message: error.message });
    }
};

// ==========================================
// POST /auth/line/exchange — LINE (redirect flow)
//   body: { code, redirect_uri }
// ==========================================
exports.lineExchange = async (req, res) => {
    const { code, redirect_uri } = req.body;
    if (!code || !redirect_uri) {
        return res.status(400).json({ success: false, message: "กรุณาส่ง code และ redirect_uri" });
    }
    try {
        const profile = await verifyLine(code, redirect_uri);
        await loginWithProfile(res, "line", profile);
    } catch (error) {
        console.error("lineExchange Error:", error.message);
        res.status(400).json({ success: false, message: error.message });
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

// export core ให้ unit test เรียกตรง (เลี่ยงการ mock provider network)
exports._findOrCreateMember = findOrCreateMember;
