const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const { createCaptcha } = require('./utils/captcha');

const adminRoutes = require('./routes/admin');
const examRoutes = require('./routes/exam');
const { buildExamRouter, buildAdminRouter } = require('./routes/practical');
const { attachProctoring } = require('./proctoring');
const { MATERIALS_DIR, ensureMaterialsDir } = require('./utils/materials');
const db = require('./db');
const { initQuestionBank } = require('./utils/questionBank');

ensureMaterialsDir();

const app = express();
const server = http.createServer(app);

// CORS 配置：从环境变量读取允许的源，默认允许所有
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const io = new Server(server, {
  cors: { origin: ALLOWED_ORIGIN, methods: ['GET', 'POST'] },
  path: '/socket.io',
  maxHttpBufferSize: 1e6,
  pingTimeout: 60000,
  pingInterval: 25000,
  allowEIO3: true
});

const PORT = process.env.PORT || 3001;

// CORS 中间件
app.use(cors({
  origin: ALLOWED_ORIGIN,
  credentials: true
}));

app.use(express.json({ limit: '5mb' }));
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));
app.use('/materials', express.static(MATERIALS_DIR));

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'TMXK AIGC Exam System', proctoring: true });
});

app.get('/api/captcha', (req, res) => {
  res.json(createCaptcha());
});

app.use('/api/admin', adminRoutes);
app.use('/api/exam', examRoutes);
app.use('/api/exam/practical', buildExamRouter());
app.use('/api/admin/practical', buildAdminRouter());

attachProctoring(io);

app.use((err, req, res, next) => {
  console.error('Unhandled API error:', err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: err.message || '服务器内部错误' });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌ 端口 ${PORT} 已被占用，请先关闭旧的后端进程再启动。\n`);
    process.exit(1);
  }
  console.error('Server error:', err);
  process.exit(1);
});

(async () => {
  try {
    await db.connect();
    await initQuestionBank();

    server.listen(PORT, () => {
      console.log(`\n🚀 天马行空AIGC考试云系统后端已启动`);
      console.log(`   地址: http://localhost:${PORT}`);
      console.log(`   实时监考: WebSocket 已启用`);
      console.log(`   管理端默认账号: admin / admin123\n`);
    });
  } catch (err) {
    console.error('❌ 初始化失败:', err.message);
    process.exit(1);
  }
})();

module.exports = { app, server, io };
