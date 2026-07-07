// สร้างไฟล์ PDF ใบแจ้งหนี้/ใบเสร็จจากข้อมูล invoice (gen สดจาก DB ทุกครั้ง)
// ใช้ pdfmake ฝั่ง server (PdfPrinter) + ฟอนต์ไทย Sarabun
// reuse ได้ทั้งตอนแนบอีเมล (M6) และ endpoint stream PDF
const path = require("path");
const PdfPrinter = require("pdfmake");
const bahtText = require("thai-baht-text");

// ลงทะเบียนฟอนต์ไทย Sarabun (ไฟล์อยู่ใน server/assets/fonts)
const fontsDir = path.join(__dirname, "..", "assets", "fonts");
const fonts = {
    Sarabun: {
        normal:      path.join(fontsDir, "Sarabun-Regular.ttf"),
        bold:        path.join(fontsDir, "Sarabun-Bold.ttf"),
        // Sarabun ไม่มีไฟล์ตัวเอียง — ชี้ italics ไปที่ไฟล์ปกติ/หนา กัน pdfmake error
        italics:     path.join(fontsDir, "Sarabun-Regular.ttf"),
        bolditalics: path.join(fontsDir, "Sarabun-Bold.ttf"),
    },
};
const printer = new PdfPrinter(fonts);

// แปลงตัวเลขเป็นรูปแบบเงินบาท เช่น 1234.5 -> "1,234.50"
function money(value) {
    const n = Number(value) || 0;
    return n.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// แปลงวันที่ (Date หรือ 'YYYY-MM-DD') เป็นรูปแบบไทยอ่านง่าย เช่น 23/06/2569
function thaiDate(value) {
    if (!value) return "-";
    const d = new Date(value);
    const day   = String(d.getDate()).padStart(2, "0");
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const year  = d.getFullYear() + 543; // พ.ศ.
    return `${day}/${month}/${year}`;
}

// ==========================================
// สร้าง PDF จากข้อมูล invoice
// invoice: { invoice_id, invoice_date, due_date, total_amount, invoice_status,
//            guest_name, room_number, details: [{item_name, quantity, unit_price, subtotal}] }
// mode: 'invoice' (ใบแจ้งหนี้) หรือ 'receipt' (ใบเสร็จ) — ใช้ template ฐานเดียวกัน
// โหมด receipt อ่านข้อมูลการชำระเพิ่มจาก: payment_id, payment_method, payment_date (M7)
//   เลขที่ใบเสร็จอ้างอิง payment_id; ถ้าไม่ส่ง payment_id มาจะใช้ invoice_id แทน
// คืนค่าเป็น Promise<Buffer>
// ==========================================
function buildInvoicePdf(invoice, mode = "invoice") {
    const isReceipt = mode === "receipt";

    // 1. หัวเอกสาร + เลขที่
    const year = new Date(invoice.invoice_date || Date.now()).getFullYear();
    // ชื่อเอกสารใบเสร็จ: ใช้ชื่อเฉพาะที่ส่งมา (receipt_title) ถ้ามี ไม่งั้นใช้ค่ากลาง
    // เช่น "ใบเสร็จจองห้องรายวัน" / "ใบเสร็จมัดจำการเช่าห้องพักรายเดือน" / "ใบเสร็จจ่ายค่าห้องรายเดือน" (USER_FLOWS)
    const docTitle = isReceipt ? (invoice.receipt_title || "ใบเสร็จรับเงิน") : "ใบแจ้งหนี้";
    // ใบเสร็จใช้เลข payment_id (ถ้ามี), ใบแจ้งหนี้ใช้ invoice_id
    const receiptRefId = invoice.payment_id || invoice.invoice_id;
    const docNumber = isReceipt
        ? `REC-${year}-${String(receiptRefId).padStart(4, "0")}`
        : `INV-${year}-${String(invoice.invoice_id).padStart(4, "0")}`;

    // 2. แถวรายการในตาราง (ค่าห้อง/น้ำ/ไฟ)
    const detailRows = (invoice.details || []).map((d, i) => [
        { text: String(i + 1), alignment: "center" },
        { text: d.item_name },
        { text: String(d.quantity), alignment: "center" },
        { text: money(d.unit_price), alignment: "right" },
        { text: money(d.subtotal), alignment: "right" },
    ]);

    // 3. ป้ายสถานะ (ใบเสร็จ = เขียว "ชำระแล้ว", ใบแจ้งหนี้ = เหลืองตามสถานะจริง)
    const statusText = isReceipt ? "ชำระแล้ว" : invoice.invoice_status;
    const statusColor = isReceipt ? "#16a34a" : "#ca8a04";

    const docDefinition = {
        defaultStyle: { font: "Sarabun", fontSize: 11 },
        pageSize: "A4",
        pageMargins: [40, 50, 40, 50],
        content: [
            // หัวหอพัก
            { text: "หอพัก Around Loei", style: "brand" },
            { text: "อ.เมือง จ.เลย  โทร. 042-000-000", style: "brandSub" },

            // ชื่อเอกสาร + เลขที่ + สถานะ
            {
                columns: [
                    { text: docTitle, style: "docTitle" },
                    {
                        stack: [
                            { text: `เลขที่: ${docNumber}`, alignment: "right" },
                            {
                                text: `วันที่: ${thaiDate(isReceipt ? (invoice.payment_date || invoice.invoice_date) : invoice.invoice_date)}`,
                                alignment: "right",
                            },
                            // ใบแจ้งหนี้แสดงวันครบกำหนด · ใบเสร็จแสดงวิธีชำระเงิน
                            !isReceipt
                                ? { text: `ครบกำหนด: ${thaiDate(invoice.due_date)}`, alignment: "right" }
                                : { text: `วิธีชำระ: ${invoice.payment_method || "-"}`, alignment: "right" },
                        ],
                    },
                ],
                margin: [0, 15, 0, 10],
            },

            // ข้อมูลผู้เช่า/ห้อง + ป้ายสถานะ
            {
                columns: [
                    {
                        stack: [
                            { text: `ผู้เช่า: ${invoice.guest_name || "-"}` },
                            { text: `ห้อง: ${invoice.room_number || "-"}` },
                        ],
                    },
                    {
                        text: statusText,
                        color: "white",
                        background: statusColor,
                        alignment: "center",
                        bold: true,
                        margin: [0, 4, 0, 0],
                        width: 120,
                    },
                ],
                margin: [0, 0, 0, 15],
            },

            // ตารางรายการ
            {
                table: {
                    headerRows: 1,
                    widths: [25, "*", 40, 70, 70],
                    body: [
                        [
                            { text: "#", style: "th", alignment: "center" },
                            { text: "รายการ", style: "th" },
                            { text: "จำนวน", style: "th", alignment: "center" },
                            { text: "ราคา/หน่วย", style: "th", alignment: "right" },
                            { text: "รวม (บาท)", style: "th", alignment: "right" },
                        ],
                        ...detailRows,
                    ],
                },
                layout: "lightHorizontalLines",
            },

            // ยอดรวม
            {
                columns: [
                    { text: "" },
                    {
                        width: 200,
                        table: {
                            widths: ["*", 90],
                            body: [
                                [
                                    { text: "ยอดรวมทั้งสิ้น", bold: true, alignment: "right", border: [false, false, false, false] },
                                    { text: money(invoice.total_amount) + " บาท", bold: true, alignment: "right", border: [false, false, false, false] },
                                ],
                            ],
                        },
                    },
                ],
                margin: [0, 10, 0, 0],
            },

            // จำนวนเงินเป็นตัวอักษร "บาทถ้วน"
            {
                text: `(${bahtText(Number(invoice.total_amount) || 0)})`,
                alignment: "right",
                italics: true,
                margin: [0, 4, 0, 20],
            },

            // ส่วนท้ายเฉพาะใบเสร็จ
            isReceipt
                ? {
                    stack: [
                        { text: "ได้รับเงินจำนวนข้างต้นไว้เรียบร้อยแล้ว", margin: [0, 10, 0, 0] },
                        { text: "ผู้รับเงิน: หอพัก Around Loei", margin: [0, 4, 0, 0] },
                    ],
                }
                : { text: "กรุณาชำระเงินภายในวันที่ครบกำหนด ขอบคุณค่ะ", margin: [0, 10, 0, 0] },
        ],
        styles: {
            brand:    { fontSize: 18, bold: true },
            brandSub: { fontSize: 10, color: "#666" },
            docTitle: { fontSize: 16, bold: true },
            th:       { bold: true, fillColor: "#f3f4f6" },
        },
    };

    // สร้าง PDF แล้วรวบ chunks เป็น Buffer เดียว
    return new Promise((resolve, reject) => {
        const pdfDoc = printer.createPdfKitDocument(docDefinition);
        const chunks = [];
        pdfDoc.on("data", (chunk) => chunks.push(chunk));
        pdfDoc.on("end", () => resolve(Buffer.concat(chunks)));
        pdfDoc.on("error", reject);
        pdfDoc.end();
    });
}

module.exports = { buildInvoicePdf };
