const pool = require("../config/db");
const bcrypt = require("bcryptjs");
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

// ตรวจรูปแบบ username ที่ผู้ใช้ social ตั้งเอง — คืนข้อความ error ถ้าไม่ผ่าน, คืน null ถ้าผ่าน
// กติกา: 4–20 ตัว ใช้ตัวอักษรอังกฤษ ตัวเลข จุด หรือขีดล่างเท่านั้น
function validateUsername(username) {
    if (!username) return "กรุณาตั้งชื่อผู้ใช้ (username)";
    if (!/^[a-zA-Z0-9._]{4,20}$/.test(username)) {
        return "username ต้องยาว 4–20 ตัว ใช้ตัวอักษรอังกฤษ ตัวเลข จุด หรือขีดล่างเท่านั้น";
    }
    return null;
}

// ตรวจรูปแบบเบอร์โทร (บังคับกรอกตอน complete profile) — เบอร์ไทย 9–10 หลัก ขึ้นต้น 0
// คืน { error } ถ้าไม่ผ่าน, คืน { phone } เบอร์ที่ตัดช่องว่าง/ขีดออกแล้วถ้าผ่าน
function validatePhone(phone_number) {
    const clean = String(phone_number || "").replace(/[\s-]/g, "");
    if (!/^0\d{8,9}$/.test(clean)) {
        return { error: "กรุณากรอกเบอร์โทรให้ถูกต้อง (เช่น 08x-xxx-xxxx)" };
    }
    return { phone: clean };
}

// ---------- ตรวจ token กับแต่ละ provider → คืน { provider_id, email, full_name } ----------

// Google: ตรวจ id_token ที่ tokeninfo endpoint + เช็ค audience ตรง client id ของเรา
async function verifyGoogle(idToken) {
    // รับ client id ได้หลายตัว (web + android + ios) — mobile จะได้ id_token ที่ aud เป็น client id ของแพลตฟอร์มนั้น
    // ตั้ง GOOGLE_CLIENT_IDS แบบคั่นด้วย comma ถ้ามีหลายตัว · ถ้าไม่ตั้ง ใช้ GOOGLE_CLIENT_ID (web) ตัวเดียว
    const allowedAudiences = (process.env.GOOGLE_CLIENT_IDS || process.env.GOOGLE_CLIENT_ID || "")
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, "")) // ตัดช่องว่าง + quote ที่เผลอติดมา (เช่นตอนตั้งค่าบน Render)
        .filter(Boolean);
    if (allowedAudiences.length === 0) throw new Error("ยังไม่ได้ตั้งค่า GOOGLE_CLIENT_ID ใน server/.env");

    const r = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
    const data = await r.json();
    if (!data.sub) throw new Error("id_token ของ Google ไม่ถูกต้อง");
    if (!allowedAudiences.includes(data.aud)) {
        // log ให้เห็นค่าจริง (aud ที่ได้ vs ลิสต์ที่รับ) เวลาไล่ปัญหาบน Render
        console.error("Google audience mismatch:", { got: data.aud, allowed: allowedAudiences });
        throw new Error(`token นี้ไม่ได้ออกให้แอปนี้ (audience ไม่ตรง: got ${data.aud})`);
    }

    return { provider_id: data.sub, email: data.email, full_name: data.name };
}

// Google (redirect flow): แลก authorization code → id_token ที่ token endpoint
//   แล้วส่งต่อให้ verifyGoogle ตรวจ audience/sub อีกชั้น (ต้องมี GOOGLE_CLIENT_SECRET)
async function verifyGoogleCode(code, redirectUri) {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
        throw new Error("ยังไม่ได้ตั้งค่า GOOGLE_CLIENT_ID/SECRET ใน server/.env");
    }

    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            redirect_uri: redirectUri,
            client_id: clientId,
            client_secret: clientSecret,
        }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.id_token) throw new Error(tokenData.error_description || "แลก token กับ Google ไม่สำเร็จ");

    return verifyGoogle(tokenData.id_token);
}

// Facebook: ตรวจ access_token ว่าเป็นของแอปเรา (debug_token) แล้วดึงโปรไฟล์ (/me)
async function verifyFacebook(accessToken) {
    const appId = process.env.FACEBOOK_APP_ID;
    const appSecret = process.env.FACEBOOK_APP_SECRET;
    if (!appId || !appSecret) throw new Error("ยังไม่ได้ตั้งค่า FACEBOOK_APP_ID/SECRET ใน server/.env");

    // 1. ยืนยันว่า token เป็นของแอปเราและยังใช้ได้
    //    ส่ง appSecret ผ่าน POST body แทน query string — กัน secret หลุดผ่าน access log/proxy log ที่มักบันทึก URL แบบเต็ม
    const dbg = await fetch("https://graph.facebook.com/debug_token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ input_token: accessToken, access_token: `${appId}|${appSecret}` }),
    });
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
async function findOrCreateMember(db, provider, { provider_id, email, full_name }, { deferCreate = false } = {}) {
    // ล็อกด้วย advisory lock คีย์ตาม provider+provider_id (auto ปลดล็อกตอน COMMIT/ROLLBACK ของ transaction)
    // กันสอง request login พร้อมกันด้วยบัญชี social เดียวกันแล้วผ่านเช็ค "ยังไม่มีบัญชีนี้" ทั้งคู่ → สร้าง member ซ้ำ
    await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`${provider}:${provider_id}`]);

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

    // 3. ไม่เจอเลย → ผู้ใช้ใหม่
    //    - deferCreate (เช่น Google redirect flow): ยังไม่บันทึกลง DB — ให้ชั้นบนออก pending token
    //      ไปยืนยัน/เลือกประเภทผู้เช่าที่หน้า register ก่อน ค่อยสร้าง member จริงตอน /auth/social/complete
    //    - ปกติ: สมัครใหม่ทันที (password NULL, role Daily_Tenant ห้าม escalate)
    if (!member && deferCreate) {
        return { member: null, isNewUser: true, linked: false, pending: true };
    }
    if (!member) {
        const username = `${provider}_${provider_id}`;
        const displayName = full_name || email || `ผู้ใช้ ${provider}`;
        // provider ยืนยันอีเมลให้แล้ว → ถ้ามีอีเมล ถือว่ายืนยันแล้วทันที (ไม่ต้องผ่าน OTP)
        // ถ้า provider ไม่ส่งอีเมลมา (email = NULL) ก็ปล่อย email_verified_at เป็น NULL
        const emailVerifiedAt = email ? new Date() : null;
        const insRes = await db.query(
            `INSERT INTO members (username, full_name, email, user_role, email_verified_at)
             VALUES ($1, $2, $3, 'Daily_Tenant', $4)
             RETURNING *`,
            [username, displayName, email || null, emailVerifiedAt]
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
async function loginWithProfile(res, provider, profile, { deferCreate = false } = {}) {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const result = await findOrCreateMember(client, provider, profile, { deferCreate });
        await client.query("COMMIT");

        // ผู้ใช้ใหม่แบบ deferred (Google): ยังไม่ถูกบันทึกลง DB — ออก token ชั่วคราว (pending)
        // ที่พก provider/provider_id/email/ชื่อ ที่ "ตรวจแล้ว" ไปด้วย เพื่อให้ /auth/social/complete
        // สร้าง member จริงตอนผู้ใช้กดยืนยัน (เลือกประเภทผู้เช่า/ตั้งรหัสผ่านเอง)
        if (result.pending) {
            const pendingToken = jwt.sign(
                {
                    type: "social_pending",
                    provider,
                    provider_id: profile.provider_id,
                    email: profile.email || null,
                    full_name: profile.full_name || null,
                },
                SECRET,
                { expiresIn: "15m" }
            );
            return res.json({
                success: true,
                pending: true,
                isNewUser: true,
                token: pendingToken,
                payload: { username: `${provider}_${profile.provider_id}` },
                profile: { full_name: profile.full_name || "", email: profile.email || "" },
                message: "กรุณายืนยันข้อมูลเพื่อสมัครสมาชิกให้เสร็จสมบูรณ์",
            });
        }

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

        // deferCreate: ผู้ใช้ social ใหม่จะยังไม่ถูกบันทึกลง DB จนกว่าจะกดยืนยันที่หน้า register
        // (บัญชีเดิม/อีเมลตรง ยังเข้าสู่ระบบ/ผูกบัญชีได้ตามปกติ)
        await loginWithProfile(res, provider, profile, { deferCreate: true });
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
        // deferCreate: ผู้ใช้ LINE ใหม่จะยังไม่ถูกบันทึกจนกว่าจะกรอกข้อมูลครบที่หน้า complete-profile
        // (กันปัญหา member ถูกสร้างค้างไว้ทั้งที่กรอกข้อมูลไม่ครบ) · บัญชีเดิม/อีเมลตรง ยังเข้าได้ตามปกติ
        await loginWithProfile(res, "line", profile, { deferCreate: true });
    } catch (error) {
        console.error("lineExchange Error:", error.message);
        res.status(400).json({ success: false, message: error.message });
    }
};

// ==========================================
// GET /auth/line/callback — LINE redirect flow สำหรับ "มือถือ/APK" (แบบ B: server เป็นตัวกลาง)
//   เหตุผล: LINE ไม่ยอมรับ custom scheme (myproject://) เป็น redirect_uri (รับแต่ https)
//   flow: แอปเปิด LINE (redirect_uri = https ของ endpoint นี้) → LINE เด้ง ?code มาที่นี่
//         → server แลก token + หา/สร้าง member → 302 เด้งกลับ deep link ของแอปพร้อม JWT
//   redirect_uri ที่ใช้แลกต้องตรงเป๊ะกับ URL ของ endpoint นี้ (ที่แอปส่งไปตอน authorize)
// ==========================================
const LINE_APP_REDIRECT = process.env.LINE_APP_REDIRECT || "myproject://auth/line/callback";

exports.lineMobileCallback = async (req, res) => {
    const { code, state, error, error_description } = req.query;

    // ประกอบ deep link กลับแอป (แนบ query อย่างปลอดภัย)
    const backToApp = (params) => {
        const url = new URL(LINE_APP_REDIRECT);
        Object.entries(params).forEach(([k, v]) => {
            if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
        });
        return res.redirect(url.toString());
    };

    if (error) return backToApp({ error: error_description || error, state });
    if (!code) return backToApp({ error: "ไม่ได้รับ code จาก LINE", state });

    // redirect_uri ต้องตรงกับที่แอปใช้ตอน authorize = URL เต็มของ endpoint นี้ (บังคับ https เพราะ Render อยู่หลัง proxy)
    const redirectUri = process.env.LINE_MOBILE_CALLBACK
        || `https://${req.get("host")}${req.originalUrl.split("?")[0]}`;

    const client = await pool.connect();
    try {
        const profile = await verifyLine(code, redirectUri);
        await client.query("BEGIN");
        // deferCreate: ผู้ใช้ LINE ใหม่จะยังไม่ถูกบันทึกลง DB จนกว่าจะกดยืนยันที่หน้า register
        const result = await findOrCreateMember(client, "line", profile, { deferCreate: true });
        await client.query("COMMIT");

        // ผู้ใช้ใหม่แบบ deferred — ยังไม่มี member ใน DB → ออก pending token (ไปสร้างจริงตอน /auth/social/complete)
        if (result.pending) {
            const pendingToken = jwt.sign(
                {
                    type: "social_pending",
                    provider: "line",
                    provider_id: profile.provider_id,
                    email: profile.email || null,
                    full_name: profile.full_name || null,
                },
                SECRET,
                { expiresIn: "15m" }
            );
            return backToApp({
                token: pendingToken,
                isNewUser: 1,
                full_name: profile.full_name || "",
                email: profile.email || "",
                username: `line_${profile.provider_id}`,
                state,
            });
        }

        const { token } = signToken(result.member);
        return backToApp({
            token,
            isNewUser: result.isNewUser ? 1 : 0,
            full_name: result.member.full_name || "",
            email: result.member.email || "",
            username: result.member.username || "",
            state,
        });
    } catch (err) {
        try { await client.query("ROLLBACK"); } catch (_) { /* ไม่มี transaction ค้าง */ }
        console.error("lineMobileCallback Error:", err.message);
        return backToApp({ error: err.message, state });
    } finally {
        client.release();
    }
};

// ==========================================
// POST /auth/google/exchange — Google (redirect flow)
//   body: { code, redirect_uri }
// ==========================================
exports.googleExchange = async (req, res) => {
    const { code, redirect_uri } = req.body;
    if (!code || !redirect_uri) {
        return res.status(400).json({ success: false, message: "กรุณาส่ง code และ redirect_uri" });
    }
    try {
        const profile = await verifyGoogleCode(code, redirect_uri);
        // deferCreate: ผู้ใช้ Google ใหม่จะยังไม่ถูกบันทึกจนกว่าจะกดยืนยันที่หน้า register
        // (บัญชีเดิม/อีเมลตรง ยังเข้าสู่ระบบ/ผูกบัญชีได้ตามปกติ)
        await loginWithProfile(res, "google", profile, { deferCreate: true });
    } catch (error) {
        console.error("googleExchange Error:", error.message);
        res.status(400).json({ success: false, message: error.message });
    }
};

// ==========================================
// POST /auth/social/complete — เติมโปรไฟล์ผู้ใช้ใหม่ที่มาจาก social (LINE ฯลฯ)
//   ใช้ token ที่ออกจาก /auth/line/exchange (ผ่าน authCheck) เพื่ออัปเดต member ของตัวเอง
//   body: { full_name?, phone_number?, password?, user_role }
//   - ตั้งรหัสผ่านให้บัญชี social ที่ password เป็น NULL
//   - เลือกประเภทผู้เช่าเองได้ (whitelist Daily/Monthly กัน escalate)
//   - ออก token ใหม่ให้ role ที่อัปเดตมีผลทันที
// ==========================================
exports.completeSocialProfile = async (req, res) => {
    // กรณีผู้ใช้ social ใหม่แบบ deferred (Google): เพิ่งกดยืนยันครั้งแรก ยังไม่มี member ใน DB
    // → สร้าง member จริงตอนนี้ พร้อม role/รหัสผ่าน/เบอร์ ที่ผู้ใช้เลือกเอง
    if (req.pendingSocial) {
        return createMemberFromPending(req, res);
    }
    const memberId = req.user.id;
    const { username, full_name, phone_number, password, user_role } = req.body;
    try {
        // 1. ตรวจ username ที่ผู้ใช้ตั้งเอง (บังคับ)
        const usernameError = validateUsername((username || "").trim());
        if (usernameError) return res.status(400).json({ success: false, message: usernameError });
        const newUsername = username.trim();

        // 2. ชื่อ-นามสกุล (บังคับ)
        const displayName = String(full_name || "").trim();
        if (!displayName) return res.status(400).json({ success: false, message: "กรุณากรอกชื่อ-นามสกุล" });

        // 3. ตรวจเบอร์โทร (บังคับกรอก)
        const phoneCheck = validatePhone(phone_number);
        if (phoneCheck.error) return res.status(400).json({ success: false, message: phoneCheck.error });

        const cur = await pool.query("SELECT * FROM members WHERE member_id = $1 LIMIT 1", [memberId]);
        if (!cur.rows[0]) return res.status(404).json({ success: false, message: "ไม่พบสมาชิก" });
        const c = cur.rows[0];

        // 3. เช็คว่า username ซ้ำกับคนอื่นไหม (ยกเว้นตัวเอง)
        const dup = await pool.query(
            "SELECT 1 FROM members WHERE username = $1 AND member_id <> $2 LIMIT 1",
            [newUsername, memberId]
        );
        if (dup.rows.length > 0) {
            return res.status(400).json({ success: false, message: "ชื่อผู้ใช้นี้ถูกใช้แล้ว กรุณาตั้งชื่ออื่น" });
        }

        // whitelist เฉพาะ role ผู้เช่า — ห้ามรับ Admin/ค่าอื่นจาก client (กัน privilege escalation)
        const finalRole = user_role === "Monthly_Tenant" ? "Monthly_Tenant" : "Daily_Tenant";

        // hash รหัสผ่านถ้าส่งมา (ตั้งรหัสให้บัญชี social ที่ยังไม่มีรหัสผ่าน)
        let hashPassword = c.password;
        if (password) {
            if (String(password).length < 6) {
                return res.status(400).json({ success: false, message: "รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร" });
            }
            hashPassword = await bcrypt.hash(password, 10);
        }

        const updated = await pool.query(
            `UPDATE members SET username = $1, full_name = $2, phone_number = $3, password = $4, user_role = $5
             WHERE member_id = $6 RETURNING *`,
            [newUsername, displayName, phoneCheck.phone, hashPassword, finalRole, memberId]
        );

        const { payload, token } = signToken(updated.rows[0]);
        res.json({ success: true, payload, token, message: "บันทึกข้อมูลสมาชิกเรียบร้อย" });
    } catch (error) {
        // กันชน unique constraint ของ username (เผลอซ้ำจังหวะเดียวกัน)
        if (error.code === "23505") {
            return res.status(400).json({ success: false, message: "ชื่อผู้ใช้นี้ถูกใช้แล้ว กรุณาตั้งชื่ออื่น" });
        }
        console.error("completeSocialProfile Error:", error.message);
        res.status(500).json({ success: false, message: "เกิดข้อผิดพลาดในการบันทึกข้อมูล" });
    }
};

// สร้าง member จริงจาก pending social (Google ใหม่) ตอนกดยืนยัน — ก่อนหน้านี้ยังไม่บันทึกลง DB เลย
async function createMemberFromPending(req, res) {
    const { provider, provider_id, email } = req.pendingSocial;
    const { username, full_name, phone_number, password, user_role } = req.body;

    // 1. username ที่ผู้ใช้ตั้งเอง (บังคับ)
    const usernameError = validateUsername((username || "").trim());
    if (usernameError) return res.status(400).json({ success: false, message: usernameError });
    const newUsername = username.trim();

    // 2. ชื่อ-นามสกุล (บังคับ — ฟอร์ม prefill จาก provider ให้แล้ว แต่ผู้ใช้ต้องยืนยัน/แก้ได้)
    const displayName = String(full_name || "").trim();
    if (!displayName) {
        return res.status(400).json({ success: false, message: "กรุณากรอกชื่อ-นามสกุล" });
    }

    // 3. เบอร์โทร (บังคับกรอก)
    const phoneCheck = validatePhone(phone_number);
    if (phoneCheck.error) return res.status(400).json({ success: false, message: phoneCheck.error });

    // 4. บัญชีใหม่ต้องตั้งรหัสผ่าน (ให้ล็อกอินด้วย username/password ทีหลังได้)
    if (!password || String(password).length < 6) {
        return res.status(400).json({ success: false, message: "รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร" });
    }

    // whitelist เฉพาะ role ผู้เช่า — ห้ามรับ Admin/ค่าอื่นจาก client (กัน privilege escalation)
    const finalRole = user_role === "Monthly_Tenant" ? "Monthly_Tenant" : "Daily_Tenant";

    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        // ล็อกตาม provider+provider_id กันกดยืนยันซ้ำ/สอง request พร้อมกันแล้วสร้าง member ซ้ำ
        await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`${provider}:${provider_id}`]);

        // เผื่อบัญชี social นี้ถูกสร้างไปแล้ว (กดยืนยันซ้ำ) → ใช้ตัวเดิม ไม่สร้างใหม่
        const existing = await client.query(
            `SELECT m.* FROM social_accounts s JOIN members m ON s.member_id = m.member_id
             WHERE s.provider = $1 AND s.provider_id = $2`,
            [provider, provider_id]
        );

        let member;
        if (existing.rows.length > 0) {
            member = existing.rows[0];
        } else {
            // เช็ค username ซ้ำก่อนสร้าง (ให้ error อ่านง่ายกว่ารอชน unique constraint)
            const dup = await client.query("SELECT 1 FROM members WHERE username = $1 LIMIT 1", [newUsername]);
            if (dup.rows.length > 0) {
                await client.query("ROLLBACK");
                return res.status(400).json({ success: false, message: "ชื่อผู้ใช้นี้ถูกใช้แล้ว กรุณาตั้งชื่ออื่น" });
            }

            const hashPassword = await bcrypt.hash(password, 10);
            // มาจาก provider ที่ยืนยันอีเมลแล้ว → ถ้ามีอีเมลถือว่ายืนยันทันที
            const emailVerifiedAt = email ? new Date() : null;
            const insRes = await client.query(
                `INSERT INTO members (username, full_name, email, phone_number, password, user_role, email_verified_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
                [newUsername, displayName, email || null, phoneCheck.phone, hashPassword, finalRole, emailVerifiedAt]
            );
            member = insRes.rows[0];
            await client.query(
                `INSERT INTO social_accounts (member_id, provider, provider_id) VALUES ($1, $2, $3)`,
                [member.member_id, provider, provider_id]
            );
        }

        await client.query("COMMIT");
        const { payload, token } = signToken(member);
        return res.json({ success: true, payload, token, message: "สมัครสมาชิกเรียบร้อย" });
    } catch (error) {
        await client.query("ROLLBACK");
        // กันชน unique constraint ของ username (เผลอซ้ำจังหวะเดียวกัน)
        if (error.code === "23505") {
            return res.status(400).json({ success: false, message: "ชื่อผู้ใช้นี้ถูกใช้แล้ว กรุณาตั้งชื่ออื่น" });
        }
        console.error("createMemberFromPending Error:", error.message);
        return res.status(500).json({ success: false, message: "เกิดข้อผิดพลาดในการสมัครสมาชิก" });
    } finally {
        client.release();
    }
}

// ==========================================
// ผูกบัญชี social เข้ากับสมาชิกที่ล็อกอินอยู่ (ใช้ตอนกดปุ่ม "เชื่อม" ในหน้าโปรไฟล์)
//   คืน { linked } ถ้าผูกใหม่สำเร็จ · { alreadyLinked } ถ้าผูกกับตัวเองอยู่แล้ว
//   · { conflict } ถ้าบัญชี social นี้ถูกผูกกับ "ผู้ใช้อื่น" ไปแล้ว (กันสวมบัญชี)
// ==========================================
async function linkSocialToMember(memberId, provider, provider_id) {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        // ล็อกตาม provider+provider_id กันสอง request เชื่อมพร้อมกันแล้วเกิดแถวซ้ำ
        await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`${provider}:${provider_id}`]);

        // เช็คว่าบัญชี social นี้ถูกผูกไว้แล้วหรือยัง
        const existing = await client.query(
            `SELECT member_id FROM social_accounts WHERE provider = $1 AND provider_id = $2`,
            [provider, provider_id]
        );
        if (existing.rows.length > 0) {
            const ownerId = existing.rows[0].member_id;
            await client.query("COMMIT");
            // ผูกกับตัวเองอยู่แล้ว = ถือว่าสำเร็จ · ผูกกับคนอื่น = ปฏิเสธ
            if (String(ownerId) === String(memberId)) return { alreadyLinked: true };
            return { conflict: true };
        }

        await client.query(
            `INSERT INTO social_accounts (member_id, provider, provider_id) VALUES ($1, $2, $3)`,
            [memberId, provider, provider_id]
        );
        await client.query("COMMIT");
        return { linked: true };
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
}

// ==========================================
// POST /auth/line/link — เชื่อม LINE เข้าบัญชีที่ล็อกอินอยู่ (authCheck)
//   body: { code, redirect_uri } — เหมือน exchange แต่ผูกกับ member ปัจจุบันแทนการ login
// ==========================================
exports.lineLink = async (req, res) => {
    const { code, redirect_uri } = req.body;
    if (!code || !redirect_uri) {
        return res.status(400).json({ success: false, message: "กรุณาส่ง code และ redirect_uri" });
    }
    try {
        const profile = await verifyLine(code, redirect_uri);
        const result = await linkSocialToMember(req.user.id, "line", profile.provider_id);
        if (result.conflict) {
            return res.status(400).json({ success: false, message: "บัญชี LINE นี้ถูกเชื่อมกับผู้ใช้อื่นแล้ว" });
        }
        res.json({ success: true, message: result.alreadyLinked ? "บัญชี LINE นี้เชื่อมอยู่แล้ว" : "เชื่อมบัญชี LINE สำเร็จ" });
    } catch (error) {
        console.error("lineLink Error:", error.message);
        res.status(400).json({ success: false, message: error.message });
    }
};

// ==========================================
// POST /auth/google/link — เชื่อม Google เข้าบัญชีที่ล็อกอินอยู่ (authCheck)
//   body: { code, redirect_uri }
// ==========================================
exports.googleLink = async (req, res) => {
    const { code, redirect_uri } = req.body;
    if (!code || !redirect_uri) {
        return res.status(400).json({ success: false, message: "กรุณาส่ง code และ redirect_uri" });
    }
    try {
        const profile = await verifyGoogleCode(code, redirect_uri);
        const result = await linkSocialToMember(req.user.id, "google", profile.provider_id);
        if (result.conflict) {
            return res.status(400).json({ success: false, message: "บัญชี Google นี้ถูกเชื่อมกับผู้ใช้อื่นแล้ว" });
        }
        res.json({ success: true, message: result.alreadyLinked ? "บัญชี Google นี้เชื่อมอยู่แล้ว" : "เชื่อมบัญชี Google สำเร็จ" });
    } catch (error) {
        console.error("googleLink Error:", error.message);
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
