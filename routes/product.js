const express = require("express");
const router = express.Router();

const {
    getProducts,
    createProduct,
    updateProduct,
    deleteProduct,
    createSale,
    getSales,
} = require("../controllers/product");
const { authCheck, adminCheck } = require("../middleweres/authCheck");

// การขายสินค้า (Admin) — วางก่อน path สินค้าเพื่อความชัดเจน
router.post("/sale", authCheck, adminCheck, createSale);
router.get("/sales", authCheck, adminCheck, getSales);

// รายการสินค้า — ผู้ใช้ที่ล็อกอินดูได้, จัดการเฉพาะ Admin
router.get("/products", authCheck, getProducts);
router.post("/products", authCheck, adminCheck, createProduct);
router.put("/products/:id", authCheck, adminCheck, updateProduct);
router.delete("/products/:id", authCheck, adminCheck, deleteProduct);

module.exports = router;
