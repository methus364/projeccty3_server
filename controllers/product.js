const pool = require("../config/db");

// ==========================================
// M9 — Products & Sales / ขายของหอพัก
// products: CRUD สินค้า · sales: บันทึกการขาย (ตัด stock ใน transaction)
// ==========================================

// ==========================================
// 1. ดูสินค้าทั้งหมด (getProducts)
//    GET /products  — ผู้ใช้ที่ล็อกอินดูได้ (เผื่อ mobile ให้ผู้เช่า browse)
// ==========================================
exports.getProducts = async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT product_id, product_name, price, stock, created_at
             FROM products
             ORDER BY product_name`
        );
        res.json({ success: true, count: result.rows.length, data: result.rows });
    } catch (error) {
        console.error("getProducts Error:", error.message);
        res.status(500).json({ success: false, message: "เกิดข้อผิดพลาดในการดึงรายการสินค้า" });
    }
};

// ==========================================
// 2. เพิ่มสินค้า (createProduct) — Admin
//    POST /products  body: { product_name, price, stock? }
// ==========================================
exports.createProduct = async (req, res) => {
    const { product_name, price, stock } = req.body;

    // ตรวจ input ที่จำเป็น
    if (!product_name || price == null) {
        return res.status(400).json({ success: false, message: "กรุณาระบุชื่อสินค้าและราคา" });
    }
    if (Number(price) < 0 || (stock != null && Number(stock) < 0)) {
        return res.status(400).json({ success: false, message: "ราคาและจำนวนคงเหลือต้องไม่ติดลบ" });
    }

    try {
        const result = await pool.query(
            `INSERT INTO products (product_name, price, stock)
             VALUES ($1, $2, $3)
             RETURNING product_id, product_name, price, stock, created_at`,
            [product_name, price, stock != null ? stock : 0]
        );
        res.status(201).json({ success: true, data: result.rows[0], message: "เพิ่มสินค้าสำเร็จ" });
    } catch (error) {
        console.error("createProduct Error:", error.message);
        res.status(500).json({ success: false, message: "เกิดข้อผิดพลาดในการเพิ่มสินค้า" });
    }
};

// ==========================================
// 3. แก้ไขสินค้า (updateProduct) — Admin
//    PUT /products/:id  body: { product_name?, price?, stock? }
//    แก้เฉพาะ field ที่ส่งมา (COALESCE)
// ==========================================
exports.updateProduct = async (req, res) => {
    const { id } = req.params;
    const { product_name, price, stock } = req.body;

    if (price != null && Number(price) < 0) {
        return res.status(400).json({ success: false, message: "ราคาต้องไม่ติดลบ" });
    }
    if (stock != null && Number(stock) < 0) {
        return res.status(400).json({ success: false, message: "จำนวนคงเหลือต้องไม่ติดลบ" });
    }

    try {
        const result = await pool.query(
            `UPDATE products SET
                product_name = COALESCE($1, product_name),
                price        = COALESCE($2, price),
                stock        = COALESCE($3, stock)
             WHERE product_id = $4
             RETURNING product_id, product_name, price, stock, created_at`,
            [product_name ?? null, price ?? null, stock ?? null, id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: "ไม่พบสินค้าที่ระบุ" });
        }
        res.json({ success: true, data: result.rows[0], message: "แก้ไขสินค้าสำเร็จ" });
    } catch (error) {
        console.error("updateProduct Error:", error.message);
        res.status(500).json({ success: false, message: "เกิดข้อผิดพลาดในการแก้ไขสินค้า" });
    }
};

// ==========================================
// 4. ลบสินค้า (deleteProduct) — Admin
//    DELETE /products/:id
//    ลบไม่ได้ถ้ามีประวัติการขาย (FK ON DELETE RESTRICT)
// ==========================================
exports.deleteProduct = async (req, res) => {
    const { id } = req.params;

    try {
        // กันลบสินค้าที่เคยขายไปแล้ว (รักษาประวัติการขาย)
        const saleRes = await pool.query(
            `SELECT 1 FROM sales WHERE product_id = $1 LIMIT 1`,
            [id]
        );
        if (saleRes.rows.length > 0) {
            return res.status(400).json({ success: false, message: "ลบไม่ได้ — สินค้านี้มีประวัติการขายแล้ว" });
        }

        const result = await pool.query(
            `DELETE FROM products WHERE product_id = $1 RETURNING product_id`,
            [id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: "ไม่พบสินค้าที่ระบุ" });
        }
        res.json({ success: true, message: "ลบสินค้าสำเร็จ" });
    } catch (error) {
        console.error("deleteProduct Error:", error.message);
        res.status(500).json({ success: false, message: "เกิดข้อผิดพลาดในการลบสินค้า" });
    }
};

// ==========================================
// 5. บันทึกการขาย (createSale) — Admin
//    POST /sale  body: { product_id, quantity, member_id? }
//    transaction: ตัด stock + insert sales พร้อมกัน · กันขายเกิน stock
//    total_price คำนวณฝั่ง server จาก products.price เสมอ
// ==========================================
exports.createSale = async (req, res) => {
    const client = await pool.connect();
    const { product_id, member_id } = req.body;
    const quantity = parseInt(req.body.quantity, 10);

    // ตรวจ input
    if (!product_id || !quantity || quantity <= 0) {
        client.release();
        return res.status(400).json({ success: false, message: "กรุณาระบุสินค้าและจำนวนที่ขาย (มากกว่า 0)" });
    }

    try {
        await client.query("BEGIN");

        // 1. ล็อกแถวสินค้าไว้กันแย่ง stock พร้อมกัน (FOR UPDATE)
        const prodRes = await client.query(
            `SELECT product_id, product_name, price, stock
             FROM products WHERE product_id = $1 FOR UPDATE`,
            [product_id]
        );
        if (prodRes.rows.length === 0) throw new Error("ไม่พบสินค้าที่ระบุ");
        const product = prodRes.rows[0];

        // 2. กันขายเกินจำนวนคงเหลือ
        if (product.stock < quantity) {
            throw new Error(`สินค้าคงเหลือไม่พอ (เหลือ ${product.stock} ชิ้น)`);
        }

        // 3. คำนวณยอดรวมจากราคาในฐานข้อมูล (ไม่เชื่อค่าจาก client)
        const totalPrice = Number(product.price) * quantity;

        // 4. ตัด stock
        await client.query(
            `UPDATE products SET stock = stock - $1 WHERE product_id = $2`,
            [quantity, product_id]
        );

        // 5. บันทึกการขาย (sold_by = admin ที่ล็อกอิน)
        const saleRes = await client.query(
            `INSERT INTO sales (product_id, member_id, quantity, total_price, sold_by)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING sale_id, product_id, member_id, quantity, total_price, sale_date, sold_by`,
            [product_id, member_id || null, quantity, totalPrice, req.user.id]
        );

        await client.query("COMMIT");

        const sale = saleRes.rows[0];
        sale.product_name = product.product_name;
        sale.remaining_stock = product.stock - quantity;

        res.status(201).json({ success: true, data: sale, message: "บันทึกการขายสำเร็จ" });
    } catch (error) {
        await client.query("ROLLBACK");
        console.error("createSale Error:", error.message);
        res.status(400).json({ success: false, message: error.message });
    } finally {
        client.release();
    }
};

// ==========================================
// 6. ดูประวัติการขาย (getSales) — Admin
//    GET /sales?month=YYYY-MM  — filter ตามเดือน (optional)
// ==========================================
exports.getSales = async (req, res) => {
    const { month } = req.query;

    try {
        // กรองตามเดือนถ้าส่งมา
        const params = [];
        let where = "";
        if (month) {
            params.push(month);
            where = `WHERE to_char(s.sale_date, 'YYYY-MM') = $1`;
        }

        const result = await pool.query(
            `SELECT
                s.sale_id, s.product_id, s.quantity, s.total_price, s.sale_date,
                p.product_name,
                buyer.full_name  AS buyer_name,
                seller.full_name AS seller_name
             FROM sales s
             JOIN products p ON s.product_id = p.product_id
             LEFT JOIN members buyer  ON s.member_id = buyer.member_id
             LEFT JOIN members seller ON s.sold_by   = seller.member_id
             ${where}
             ORDER BY s.sale_date DESC, s.sale_id DESC`,
            params
        );

        res.json({ success: true, count: result.rows.length, data: result.rows });
    } catch (error) {
        console.error("getSales Error:", error.message);
        res.status(500).json({ success: false, message: "เกิดข้อผิดพลาดในการดึงประวัติการขาย" });
    }
};
