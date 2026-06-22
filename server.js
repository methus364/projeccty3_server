const express = require('express');
const app = express();
const port = 5000;
const morgan = require('morgan');
const { readdirSync } = require('fs');
const cors = require('cors');

// middleware
app.use(morgan('dev'));
app.use(express.json());
app.use(cors());

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
});
