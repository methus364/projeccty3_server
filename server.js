const express = require('express');
const app = express();
const port = 5000;
const morgan = require('morgan');
const { readdirSync } = require('fs');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { startMonthlyBillingCron, startHoldExpiryCron, startRenewalReminderCron, startMeterReminderCron } = require('./utils/scheduler');

// CORS — อนุญาต web frontend และ mobile app (React Native ไม่ส่ง origin header)
const allowedOrigins = [
  process.env.CLIENT_ORIGIN,
  'http://localhost:5173',
  'http://localhost:8080',
].filter(Boolean);

// dev: อนุญาต localhost/127.0.0.1 ทุกพอร์ต (Vite อาจเด้งพอร์ต 5174 ถ้า 5173 ไม่ว่าง)
const isLocalhostOrigin = (origin) =>
  /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);

const corsOptions = {
  origin: (origin, callback) => {
    // origin = undefined หมายถึง mobile app หรือ server-to-server → อนุญาต
    if (!origin || isLocalhostOrigin(origin) || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
};

// Rate limit สำหรับ auth endpoint — กัน brute force
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 นาที
  max: 30,                   // สูงสุด 30 ครั้ง/15 นาที/IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'ลองใหม่ในอีก 15 นาที (ส่งคำขอถี่เกินไป)' },
});

// middleware
app.use(morgan('dev'));
app.use(express.json());
app.use(cors(corsOptions));

// API เป็นข้อมูลสดที่เปลี่ยนตลอด (การจอง/บิล/สลิป ฯลฯ) ห้าม browser cache ไว้แล้วได้ข้อมูลเก่า
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// ใช้ rate limit กับ auth route
app.use('/api/login', authLimiter);
app.use('/api/register', authLimiter);

app.get('/', (req, res) => {
  res.send('Hello World');
});

// auto-mount ทุก route ในโฟลเดอร์ /routes ไว้ใต้ /api
readdirSync('./routes').map((c) => app.use('/api', require('./routes/' + c)));

// 404 handler — endpoint ที่ไม่มีอยู่จริง
app.use((req, res) => {
  res.status(404).json({ success: false, message: 'ไม่พบ endpoint ที่ร้องขอ' });
});

// error handler กลาง — ดักทุก error ที่หลุดมาจาก controller
app.use((err, req, res, next) => {
  console.error('Unhandled Error:', err);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'เกิดข้อผิดพลาดภายในเซิร์ฟเวอร์',
  });
});

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
  startMonthlyBillingCron();
  startHoldExpiryCron();
  startRenewalReminderCron();
  startMeterReminderCron();
});
