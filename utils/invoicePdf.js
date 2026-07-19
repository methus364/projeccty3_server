// สร้างไฟล์ PDF ใบแจ้งหนี้/ใบเสร็จจากข้อมูล invoice (gen สดจาก DB ทุกครั้ง)
// ใช้ pdfmake ฝั่ง server (PdfPrinter) + ฟอนต์ไทย Sarabun
// reuse ได้ทั้งตอนแนบอีเมล (M6) และ endpoint stream PDF
// ฟอร์แมตตามใบแจ้งหนี้จริงของหอพัก (ดู docs/PROJECT_PLAN.md)
const path = require("path");
const PdfPrinter = require("pdfmake");
const bahtText = require("thai-baht-text");
const { buildPromptpayQr } = require("./promptpayQr");

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

// ข้อมูลหอพัก — แก้ตรงนี้จุดเดียวถ้าต้องเปลี่ยนที่อยู่/บัญชีธนาคาร
const DORM_NAME = "หอพัก Around Loei";
const DORM_ADDRESS = "579 ซ.หนองหล่ม ต.เมืองเลย อ.เมือง จ.เลย";
const BANK_ACCOUNT_NOTE = "กรุณาชำระผ่านบัญชีธนาคารกรุงไทย เลขที่ 986-0-76842-0";

const THAI_MONTH_NAMES = [
    "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
    "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม",
];

// แปลงตัวเลขเป็นรูปแบบเงินบาท เช่น 1234.5 -> "1,234.50"
function money(value) {
    const n = Number(value) || 0;
    return n.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ตัวเลขในตารางรายการ: 0 โชว์เป็น "-" (เช่น รายการที่ไม่มีจำนวน/ราคาจริง), นอกนั้นโชว์ 2 ตำแหน่งทศนิยม
function moneyOrDash(value) {
    const n = Number(value) || 0;
    return n === 0 ? "-" : money(n);
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

// แปลงวันที่เป็นรูปแบบไทยสะกดชื่อเดือน เช่น "30 เมษายน 2568"
function thaiDateFull(value) {
    if (!value) return "-";
    const d = new Date(value);
    return `${d.getDate()} ${THAI_MONTH_NAMES[d.getMonth()]} ${d.getFullYear() + 543}`;
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
async function buildInvoicePdf(invoice, mode = "invoice") {
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

    // 2. แถวรายการในตาราง (ค่าห้อง/น้ำ/ไฟ) — 0 โชว์เป็น "-" ตามฟอร์แมตใบแจ้งหนี้จริง
    const detailRows = (invoice.details || []).map((d, i) => [
        { text: String(i + 1), alignment: "center" },
        { text: d.item_name },
        { text: moneyOrDash(d.quantity), alignment: "center" },
        { text: moneyOrDash(d.unit_price), alignment: "right" },
        { text: moneyOrDash(d.subtotal), alignment: "right" },
    ]);

    // 3. ป้ายสถานะ (ใบเสร็จ = เขียว "ชำระแล้ว", ใบแจ้งหนี้ = เหลืองตามสถานะจริง)
    const statusText = isReceipt ? "ชำระแล้ว" : invoice.invoice_status;
    const statusColor = isReceipt ? "#16a34a" : "#ca8a04";

    // 4. QR PromptPay ให้ลูกค้าสแกนจ่าย — เฉพาะใบแจ้งหนี้ที่ยังไม่ปิดยอด, ล้มเหลวได้ไม่ต้องพังทั้ง PDF (best-effort)
    let qrImage = null;
    if (!isReceipt && invoice.invoice_status !== "ชำระแล้ว" && invoice.invoice_status !== "ยกเลิก") {
        try {
            const qr = await buildPromptpayQr(invoice.total_amount);
            qrImage = qr.dataUrl;
        } catch (err) {
            console.error("สร้าง QR PromptPay ในใบแจ้งหนี้ไม่สำเร็จ:", err.message);
        }
    }

    const docDefinition = {
        defaultStyle: { font: "Sarabun", fontSize: 11 },
        pageSize: "A4",
        pageMargins: [40, 50, 40, 50],
        content: [
            // หัวหอพัก + ป้าย "ไม่ใช่ใบกำกับภาษี"
            {
                columns: [
                    {
                        stack: [
                            { text: DORM_NAME, style: "brand" },
                            { text: DORM_ADDRESS, style: "brandSub" },
                        ],
                    },
                    {
                        width: 130,
                        table: { widths: ["*"], body: [[{ text: "ไม่ใช่ใบกำกับภาษี", color: "#dc2626", alignment: "center", fontSize: 9 }]] },
                        layout: { hLineColor: "#dc2626", vLineColor: "#dc2626" },
                    },
                ],
            },

            // ชื่อเอกสารในกรอบ กึ่งกลาง
            {
                table: { widths: ["*"], body: [[{ text: docTitle, style: "docTitle", alignment: "center" }]] },
                layout: { hLineColor: "#000", vLineColor: "#000" },
                margin: [0, 15, 0, 10],
            },

            // ข้อมูลลูกค้า (ซ้าย) + เลขที่/วันที่ (ขวา)
            {
                columns: [
                    {
                        stack: [
                            { text: `นามลูกค้า  ห้อง ${invoice.room_number || "-"}` },
                            { text: "ที่อยู่" },
                        ],
                    },
                    {
                        stack: [
                            { text: `เลขที่: ${docNumber}`, alignment: "right" },
                            {
                                text: `วันที่: ${thaiDateFull(isReceipt ? (invoice.payment_date || invoice.invoice_date) : invoice.invoice_date)}`,
                                alignment: "right",
                            },
                        ],
                    },
                ],
                margin: [0, 0, 0, 8],
            },

            // ผู้เช่า + ป้ายสถานะ
            {
                columns: [
                    { text: `ผู้เช่า: ${invoice.guest_name || "-"}` },
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
                    widths: [25, "*", 45, 65, 70],
                    body: [
                        [
                            { text: "ลำดับ", style: "th", alignment: "center" },
                            { text: "รายการ", style: "th" },
                            { text: "จำนวน", style: "th", alignment: "center" },
                            { text: "ราคา/หน่วย", style: "th", alignment: "right" },
                            { text: "จำนวนเงิน", style: "th", alignment: "right" },
                        ],
                        ...detailRows,
                        // แถวสรุปยอดรวม — ตัวสะกดไทยพื้นชมพู + ยอดรวมทางขวา
                        [
                            { text: `(${bahtText(Number(invoice.total_amount) || 0)})`, colSpan: 3, italics: true, fillColor: "#fce7f3" },
                            {}, {},
                            { text: "รวมเงิน", bold: true, alignment: "right" },
                            { text: money(invoice.total_amount), bold: true, alignment: "right" },
                        ],
                    ],
                },
                layout: "lightHorizontalLines",
            },

            // ส่วนท้ายเฉพาะใบแจ้งหนี้: ค่าปรับจ่ายช้า + วิธีชำระ
            !isReceipt
                ? {
                    stack: [
                        {
                            text: `**ชำระภายในวันที่ครบกำหนด (${thaiDate(invoice.due_date)}) ถ้าเกินกำหนดปรับวันละ 50 บาท`,
                            color: "#dc2626",
                            margin: [0, 10, 0, 0],
                        },
                        { text: "ชำระแล้ว ส่งหลักฐานมายัง QR Code ด้านล่าง เท่านั้น", color: "#dc2626" },
                        {
                            table: { widths: ["*"], body: [[{ text: BANK_ACCOUNT_NOTE, alignment: "center", bold: true }]] },
                            layout: { hLineColor: "#facc15", vLineColor: "#facc15", fillColor: () => "#fef9c3" },
                            margin: [0, 8, 0, 0],
                        },
                        qrImage ? { image: qrImage, width: 120, alignment: "center", margin: [0, 10, 0, 0] } : null,
                    ].filter(Boolean),
                }
                : {
                    stack: [
                        { text: "ได้รับเงินจำนวนข้างต้นไว้เรียบร้อยแล้ว", margin: [0, 10, 0, 0] },
                        { text: `ผู้รับเงิน: ${DORM_NAME}`, margin: [0, 4, 0, 0] },
                    ],
                },
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
