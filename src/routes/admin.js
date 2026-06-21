const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const db = require('../db');
const { createCaptcha, verifyCaptcha } = require('../utils/captcha');
const { formatCandidate, pickCandidateFields } = require('../utils/candidate');
const { uploadFile: cloudUpload, deleteFile: cloudDelete } = require('../utils/cloudinary');
const {
  listPapers,
  getPaperById,
  createPaper,
  updatePaper,
  activatePaper,
  deletePaper,
  duplicatePaper,
  seedDefaultPaper,
  addQuestion,
  updateQuestion,
  deleteQuestion,
  importQuestions,
  buildAnswerDetailsForRecord
} = require('../utils/questionBank');
const { parseQuestionFile, buildImportTemplateBuffer } = require('../utils/questionImport');
const { parseQuestionText } = require('../utils/questionTextParser');
const { getSettings, updateSettings } = require('../utils/settings');
const { writeLog, getLogs, getActionOptions, logOperation, getClientIp } = require('../utils/auditLog');
const { getLiveSessions, getSummary } = require('../proctoring');
const { getProctorEvents } = require('../utils/proctorEvents');
const { clearExamRecordsForCandidates, clearAllExamRecords, deleteExamRecordById } = require('../utils/practical');
const {
  MATERIALS_DIR,
  ensureMaterialsDir,
  getMaterialsInfo,
  sanitizeMaterialName,
  deleteMaterialFile
} = require('../utils/materials');

const {
  getAllAnnouncements,
  getAnnouncementById,
  createAnnouncement,
  updateAnnouncement,
  deleteAnnouncement
} = require('../utils/announcements');
const {
  getDashboardOverview,
  queryComprehensiveScores,
  getComprehensiveScoresSummary
} = require('../utils/adminDashboard');
const {
  queryAbnormalCandidates,
  applyAbnormalAction
} = require('../utils/abnormalCandidates');
const { listTranscripts, buildTranscript } = require('../utils/transcript');
const { getCacheOverview, clearSystemCache } = require('../utils/systemCache');

ensureMaterialsDir();

const uploadsDir = path.join(__dirname, '..', '..', 'uploads');
const avatarsDir = path.join(uploadsDir, 'avatars');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
if (!fs.existsSync(avatarsDir)) fs.mkdirSync(avatarsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, avatarsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `candidate_${req.params.id}_${Date.now()}${ext}`);
  }
});

const avatarUpload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\/(jpeg|png|jpg|webp)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('仅支持 JPG/PNG/WebP 图片'));
  }
});

const upload = multer({ dest: uploadsDir, limits: { fileSize: 5 * 1024 * 1024 } });
const questionImportUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }
});

const materialStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, MATERIALS_DIR),
  filename: (req, file, cb) => {
    const safe = sanitizeMaterialName(file.originalname) || `material_${Date.now()}`;
    cb(null, safe);
  }
});

const materialUpload = multer({
  storage: materialStorage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const allowed = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.psd', '.zip', '.pdf', '.txt'];
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error('不支持的文件类型'));
  }
});

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'tmxk-aigc-exam-secret-2026';

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: '未登录' });
  try {
    req.admin = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: '登录已过期，请重新登录' });
  }
}

router.get('/captcha', (req, res) => {
  res.json(createCaptcha());
});

router.post('/login', async (req, res) => {
  const { username, password, captchaId, captchaCode } = req.body;

  const captchaResult = verifyCaptcha(captchaId, captchaCode);
  if (!captchaResult.ok) {
    return res.status(400).json({ error: captchaResult.error });
  }

  if (!username || !password) {
    return res.status(400).json({ error: '请输入用户名和密码' });
  }

  const admin = await db.admins.findOne({ username });
  if (!admin || !bcrypt.compareSync(password, admin.password)) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }

  const token = jwt.sign({ id: admin._id.toString(), username: admin.username }, JWT_SECRET, { expiresIn: '8h' });
  logOperation({
    adminId: admin._id.toString(),
    adminUsername: admin.username,
    action: 'login',
    detail: '登录成功',
    ip: getClientIp(req)
  });
  res.json({ token, username: admin.username });
});

router.get('/candidates', authMiddleware, async (req, res) => {
  const { search, status, position, exam_site } = req.query;

  const filter = {};

  if (search) {
    filter.$or = [
      { ticket_no: { $regex: search, $options: 'i' } },
      { name: { $regex: search, $options: 'i' } }
    ];
  }
  if (status) {
    filter.status = status;
  }
  if (position) {
    filter.position = { $regex: position, $options: 'i' };
  }
  if (exam_site) {
    filter.exam_site = { $regex: exam_site, $options: 'i' };
  }

  let candidates;
  try {
    candidates = await db.candidates.find(filter).sort({ created_at: -1 }).toArray();
  } catch (e) {
    candidates = [];
  }

  if (!candidates.length) {
    return res.json([]);
  }

  const candidateIds = candidates.map(c => c._id);
  const latestRecords = {};
  const recordsCursor = await db.exam_records.find({
    candidate_id: { $in: candidateIds }
  }).sort({ id: -1 }).toArray();

  for (const rec of recordsCursor) {
    if (!latestRecords[rec.candidate_id]) {
      latestRecords[rec.candidate_id] = rec;
    }
  }

  const result = candidates.map(c => {
    const er = latestRecords[c._id];
    return {
      ...c,
      objective_score: er ? er.objective_score : undefined,
      submitted_at: er ? er.submitted_at : undefined,
      record_id: er ? er.id : undefined,
      record_status: er ? er.status : undefined
    };
  });

  res.json(result);
});

router.get('/candidates/filters', authMiddleware, async (req, res) => {
  const positions = await db.candidates.distinct('position', { position: { $ne: '' } });
  const examSites = await db.candidates.distinct('exam_site', { exam_site: { $ne: '' } });
  res.json({ positions: positions.sort(), examSites: examSites.sort() });
});

router.post('/candidates/batch-action', authMiddleware, async (req, res) => {
  const { ids, action, exam_room, seat_prefix } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: '请选择至少一名考生' });
  }

  if (action === 'delete') {
    const list = await db.candidates.find({ _id: { $in: ids } }).project({ ticket_no: 1, name: 1, avatar: 1 }).toArray();
    for (const c of list) {
      if (c.avatar) {
        const p = path.join(avatarsDir, c.avatar);
        if (fs.existsSync(p)) fs.unlinkSync(p);
      }
    }
    clearExamRecordsForCandidates(ids);
    await db.candidates.deleteMany({ _id: { $in: ids } });
    const names = list.slice(0, 5).map((c) => `${c.name}(${c.ticket_no})`).join('、');
    writeLog(req, 'batch_delete', {
      targetType: 'candidate',
      detail: `删除 ${ids.length} 名考生${names ? `：${names}${list.length > 5 ? ' 等' : ''}` : ''}`
    });
    return res.json({ message: `已删除 ${ids.length} 名考生` });
  }

  if (action === 'reset') {
    clearExamRecordsForCandidates(ids);
    await db.candidates.updateMany({ _id: { $in: ids } }, { $set: { status: 'pending' } });
    writeLog(req, 'batch_reset', {
      targetType: 'candidate',
      detail: `重置 ${ids.length} 名考生的考试`
    });
    return res.json({ message: `已重置 ${ids.length} 名考生的考试` });
  }

  if (action === 'assign') {
    const room = String(exam_room || '').trim();
    const prefix = String(seat_prefix || '').trim();
    if (!room) return res.status(400).json({ error: '请填写考场号' });

    const cursor = db.candidates.find({ _id: { $in: ids } });
    const bulkOps = [];
    let index = 0;
    for await (const c of cursor) {
      const seat = prefix ? `${prefix}${String(index + 1).padStart(2, '0')}` : String(index + 1).padStart(2, '0');
      bulkOps.push({
        updateOne: {
          filter: { _id: c._id },
          update: { $set: { exam_room: room, seat_no: seat } }
        }
      });
      index++;
    }
    if (bulkOps.length > 0) {
      await db.candidates.bulkWrite(bulkOps);
    }
    writeLog(req, 'batch_assign', {
      targetType: 'candidate',
      detail: `为 ${ids.length} 名考生分配考场 ${room}${prefix ? `，座位前缀 ${prefix}` : ''}`
    });
    return res.json({ message: `已为 ${ids.length} 名考生分配考场与座位号` });
  }

  res.status(400).json({ error: '未知批量操作' });
});

router.get('/abnormal-candidates', authMiddleware, (req, res) => {
  const { type, q } = req.query;
  res.json(queryAbnormalCandidates({ type: type || 'all', q: q || '' }));
});

router.post('/abnormal-candidates/action', authMiddleware, (req, res) => {
  const { action, candidateIds, recordIds, submissionIds, note, extraMinutes } = req.body || {};
  if (!action) return res.status(400).json({ error: '请指定操作类型' });

  if (['reopen_practical'].includes(action)) {
    const settings = getSettings();
    if (settings.scoresLocked) {
      return res.status(403).json({ error: '成绩已锁定，请先解锁后再开放实操重传' });
    }
  }

  const result = applyAbnormalAction(action, {
    candidateIds,
    recordIds,
    submissionIds,
    note,
    extraMinutes
  });

  if (result.error) return res.status(400).json({ error: result.error });

  const logActions = {
    mark: 'mark_abnormal',
    clear_mark: 'clear_abnormal',
    extend_time: 'extend_exam_time',
    set_note: 'set_admin_note',
    reset_exam: 'reset_exam',
    reopen_practical: 'reopen_practical'
  };
  writeLog(req, logActions[action] || 'abnormal_action', {
    detail: result.message
  });

  res.json(result);
});

router.get('/settings', authMiddleware, (req, res) => {
  res.json(getSettings());
});

router.put('/settings', authMiddleware, (req, res) => {
  const settings = updateSettings(req.body);
  const parts = [];
  if (req.body.examEnabled !== undefined) parts.push(`开关：${req.body.examEnabled ? '开启' : '关闭'}`);
  if (req.body.durationMinutes !== undefined) parts.push(`时长：${settings.durationMinutes} 分钟`);
  if (req.body.openAt !== undefined && req.body.openAt) parts.push(`开始：${settings.openAt || req.body.openAt}`);
  if (req.body.closeAt !== undefined && req.body.closeAt) parts.push(`截止：${settings.closeAt || req.body.closeAt}`);
  if (req.body.proctorEnabled !== undefined) parts.push(`实时监考：${req.body.proctorEnabled ? '开启' : '关闭'}`);
  if (req.body.proctorScreenRequired !== undefined) parts.push(`屏幕共享：${req.body.proctorScreenRequired ? '强制' : '可选'}`);
  if (req.body.proctorCameraRequired !== undefined) parts.push(`摄像头：${req.body.proctorCameraRequired ? '强制' : '可选'}`);
  if (req.body.showAnswerReview !== undefined) parts.push(`答案查看：${req.body.showAnswerReview ? '开放' : '关闭'}`);
  if (req.body.practicalUploadEnabled !== undefined) parts.push(`实操上传：${req.body.practicalUploadEnabled ? '开放' : '关闭'}`);
  if (req.body.practicalMaxFileMb !== undefined) parts.push(`实操单文件上限：${settings.practicalMaxFileMb}MB`);
  if (req.body.practicalDeadline !== undefined && req.body.practicalDeadline) parts.push(`实操截止：${settings.practicalDeadline}`);
  writeLog(req, 'update_settings', { detail: parts.join('；') || '更新考试设置' });
  res.json({ message: '考试设置已保存', settings });
});

router.get('/system/cache', authMiddleware, (req, res) => {
  const parsed = parseInt(req.query.retainLogDays, 10);
  const days = Number.isNaN(parsed) ? 90 : Math.max(0, parsed);
  res.json({ overview: getCacheOverview(days), retainLogDays: days });
});

router.post('/system/cache/clear', authMiddleware, (req, res) => {
  const body = req.body || {};
  const options = {
    uploadTemp: !!body.uploadTemp,
    captcha: !!body.captcha,
    proctorSessions: !!body.proctorSessions,
    operationLogs: !!body.operationLogs,
    operationLogsDays: body.operationLogsDays
  };

  if (!options.uploadTemp && !options.captcha && !options.proctorSessions && !options.operationLogs) {
    return res.status(400).json({ error: '请至少选择一项要清理的缓存' });
  }

  const cleared = clearSystemCache(options);
  const parsedDays = parseInt(options.operationLogsDays, 10);
  const overviewDays = Number.isNaN(parsedDays) ? 90 : Math.max(0, parsedDays);
  const parts = [];
  if (cleared.uploadTemp != null) parts.push(`临时文件 ${cleared.uploadTemp.removed} 个`);
  if (cleared.captcha != null) parts.push(`验证码 ${cleared.captcha.removed} 条`);
  if (cleared.proctorSessions != null) parts.push(`监考会话 ${cleared.proctorSessions.removed} 条`);
  if (cleared.operationLogs != null) parts.push(`操作日志 ${cleared.operationLogs.removed} 条`);

  const summary = parts.join('，');
  const allZero = parts.length > 0 && parts.every((p) => / 0 (个|条)/.test(p));
  const message = !summary
    ? '未执行任何清理'
    : allZero
      ? `清理完成：${summary}（所选项目暂无可清理数据）`
      : `清理完成：${summary}`;

  writeLog(req, 'clear_system_cache', { detail: summary || '清理系统缓存' });
  res.json({
    message,
    cleared,
    overview: getCacheOverview(overviewDays)
  });
});

router.post('/change-password', authMiddleware, async (req, res) => {
  const { oldPassword, newPassword, confirmPassword } = req.body;
  if (!oldPassword || !newPassword) {
    return res.status(400).json({ error: '请填写完整密码信息' });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: '新密码至少 6 位' });
  }
  if (newPassword !== confirmPassword) {
    return res.status(400).json({ error: '两次输入的新密码不一致' });
  }

  const admin = await db.admins.findOne({ _id: req.admin.id });
  if (!admin || !bcrypt.compareSync(oldPassword, admin.password)) {
    return res.status(400).json({ error: '原密码错误' });
  }

  const hash = bcrypt.hashSync(newPassword, 10);
  await db.admins.updateOne({ _id: req.admin.id }, { $set: { password: hash } });
  writeLog(req, 'change_password', { detail: '管理员密码已修改' });
  res.json({ message: '密码修改成功，请重新登录' });
});

router.post('/candidates', authMiddleware, async (req, res) => {
  const fields = pickCandidateFields(req.body);
  if (!fields.ticket_no || !fields.name) {
    return res.status(400).json({ error: '准考证号和姓名不能为空' });
  }

  try {
    const doc = await db.candidates.insertOne({
      ticket_no: fields.ticket_no,
      name: fields.name,
      id_number: fields.id_number || '',
      position: fields.position || '',
      exam_site: fields.exam_site || '',
      exam_room: fields.exam_room || '',
      seat_no: fields.seat_no || '',
      exam_time: fields.exam_time || '',
      department: fields.department || '',
      phone: fields.phone || '',
      status: 'pending',
      created_at: new Date().toISOString()
    });

    const insertedId = doc.insertedId.toString();

    writeLog(req, 'add_candidate', {
      targetType: 'candidate',
      targetId: insertedId,
      detail: `添加考生 ${fields.name}（${fields.ticket_no}）`
    });

    res.json({ id: insertedId, message: '添加成功' });
  } catch (e) {
    if (e.message.includes('UNIQUE') || e.code === 11000) {
      return res.status(400).json({ error: '该准考证号已存在' });
    }
    res.status(500).json({ error: '添加失败' });
  }
});

router.put('/candidates/:id', authMiddleware, async (req, res) => {
  const id = req.params.id;
  const fields = pickCandidateFields(req.body);
  const existing = await db.candidates.findOne({ _id: id });
  if (!existing) return res.status(404).json({ error: '考生不存在' });

  await db.candidates.updateOne(
    { _id: id },
    { $set: {
      ticket_no: fields.ticket_no || existing.ticket_no,
      name: fields.name || existing.name,
      id_number: fields.id_number,
      position: fields.position,
      exam_site: fields.exam_site,
      exam_room: fields.exam_room,
      seat_no: fields.seat_no,
      exam_time: fields.exam_time,
      department: fields.department,
      phone: fields.phone
    }}
  );

  const updated = await db.candidates.findOne({ _id: id });

  writeLog(req, 'update_candidate', {
    targetType: 'candidate',
    targetId: id,
    detail: `编辑考生 ${fields.name || existing.name}（${fields.ticket_no || existing.ticket_no}）`
  });

  res.json({ message: '更新成功', candidate: formatCandidate(updated) });
});

router.get('/candidates/:id', authMiddleware, async (req, res) => {
  const candidate = await db.candidates.findOne({ _id: req.params.id });
  if (!candidate) return res.status(404).json({ error: '考生不存在' });
  res.json(formatCandidate(candidate));
});

router.post('/candidates/:id/reset', authMiddleware, async (req, res) => {
  const id = req.params.id;
  const candidate = await db.candidates.findOne({ _id: id });
  if (!candidate) return res.status(404).json({ error: '考生不存在' });

  clearExamRecordsForCandidates(id);
  await db.candidates.updateOne({ _id: id }, { $set: { status: 'pending' } });
  writeLog(req, 'reset_exam', {
    targetType: 'candidate',
    targetId: id,
    detail: `重置考试：${candidate.name}（${candidate.ticket_no}）`
  });
  res.json({ message: '已重置考试，考生可重新登录作答' });
});

router.post('/candidates/:id/avatar', authMiddleware, avatarUpload.single('avatar'), async (req, res) => {
  const id = req.params.id;
  const candidate = await db.candidates.findOne({ _id: id });
  if (!candidate) return res.status(404).json({ error: '考生不存在' });
  if (!req.file) return res.status(400).json({ error: '请上传头像图片' });

  let avatarUrl = `/uploads/avatars/${req.file.filename}`;
  
  if (process.env.CLOUDINARY_CLOUD_NAME) {
    const cloudUrl = await cloudUpload(req.file.buffer, 'avatars', req.file.filename);
    if (cloudUrl) {
      avatarUrl = cloudUrl;
      fs.unlinkSync(req.file.path);
    }
  }

  if (candidate.avatar && candidate.avatar.startsWith('https://res.cloudinary.com')) {
    const publicId = candidate.avatar.match(/\/v\d+\/([^\/]+)$/);
    if (publicId) await cloudDelete(publicId[1]);
  } else if (candidate.avatar) {
    const oldPath = path.join(avatarsDir, candidate.avatar);
    if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
  }

  await db.candidates.updateOne({ _id: id }, { $set: { avatar: avatarUrl } });
  writeLog(req, 'upload_avatar', {
    targetType: 'candidate',
    targetId: id,
    detail: `上传头像：${candidate.name}（${candidate.ticket_no}）`
  });
  res.json({ message: '头像上传成功', avatarUrl });
});

router.post('/candidates/batch', authMiddleware, async (req, res) => {
  const { candidates } = req.body;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return res.status(400).json({ error: '考生数据不能为空' });
  }

  let success = 0;
  let skipped = 0;

  for (const c of candidates) {
    const f = pickCandidateFields(c);
    if (!f.ticket_no || !f.name) { skipped++; continue; }
    try {
      await db.candidates.insertOne({
        ticket_no: f.ticket_no,
        name: f.name,
        id_number: f.id_number || '',
        position: f.position || '',
        exam_site: f.exam_site || '',
        exam_room: f.exam_room || '',
        seat_no: f.seat_no || '',
        exam_time: f.exam_time || '',
        department: f.department || '',
        phone: f.phone || '',
        status: 'pending',
        created_at: new Date().toISOString()
      });
      success++;
    } catch (e) {
      if (e.code === 11000) {
        skipped++;
      } else {
        skipped++;
      }
    }
  }

  writeLog(req, 'batch_import', {
    targetType: 'candidate',
    detail: `导入 ${candidates.length} 条，成功 ${success} 条，跳过 ${skipped} 条`
  });
  res.json({ success, skipped, total: candidates.length, message: `成功导入 ${success} 条，跳过 ${skipped} 条` });
});

router.delete('/candidates/:id', authMiddleware, async (req, res) => {
  const id = req.params.id;
  const candidate = await db.candidates.findOne({ _id: id });
  if (!candidate) return res.status(404).json({ error: '考生不存在' });

  if (candidate.avatar) {
    const avatarPath = path.join(avatarsDir, candidate.avatar);
    if (fs.existsSync(avatarPath)) fs.unlinkSync(avatarPath);
  }

  clearExamRecordsForCandidates(id);
  await db.candidates.deleteOne({ _id: id });
  writeLog(req, 'delete_candidate', {
    targetType: 'candidate',
    targetId: id,
    detail: `删除考生 ${candidate.name}（${candidate.ticket_no}）`
  });
  res.json({ message: '删除成功' });
});

router.delete('/candidates', authMiddleware, async (req, res) => {
  const total = await db.candidates.countDocuments();
  clearAllExamRecords();
  await db.candidates.deleteMany({});
  writeLog(req, 'clear_all', { detail: `清空全部考生，共 ${total} 名` });
  res.json({ message: '已清空全部考生' });
});

router.get('/papers', authMiddleware, (req, res) => {
  res.json(listPapers());
});

router.get('/papers/:id', authMiddleware, (req, res) => {
  const paper = getPaperById(Number(req.params.id));
  if (!paper) return res.status(404).json({ error: '试卷不存在' });
  res.json(paper);
});

router.post('/papers', authMiddleware, (req, res) => {
  const paper = createPaper(req.body || {});
  writeLog(req, 'create_paper', { detail: `创建试卷：${paper.title}` });
  res.json({ message: '试卷已创建', paper });
});

router.put('/papers/:id', authMiddleware, (req, res) => {
  const paper = updatePaper(Number(req.params.id), req.body || {});
  if (!paper) return res.status(404).json({ error: '试卷不存在' });
  writeLog(req, 'update_paper', { detail: `更新试卷：${paper.title}` });
  res.json({ message: '试卷已更新', paper });
});

router.post('/papers/:id/activate', authMiddleware, (req, res) => {
  const paper = activatePaper(Number(req.params.id));
  if (!paper) return res.status(404).json({ error: '试卷不存在' });
  writeLog(req, 'activate_paper', { detail: `启用试卷：${paper.title}（${paper.questions?.length ?? 0} 题）` });
  res.json({ message: '试卷已设为当前考试用卷', paper });
});

router.post('/papers/:id/duplicate', authMiddleware, (req, res) => {
  const paper = duplicatePaper(Number(req.params.id));
  if (!paper) return res.status(404).json({ error: '试卷不存在' });
  writeLog(req, 'duplicate_paper', { detail: `复制试卷：${paper.title}` });
  res.json({ message: '试卷已复制', paper });
});

router.post('/papers/seed-default', authMiddleware, (req, res) => {
  const paper = seedDefaultPaper(false);
  writeLog(req, 'seed_default_paper', { detail: `从内置题库导入：${paper.title}` });
  res.json({ message: '已导入默认试卷', paper });
});

router.delete('/papers/:id', authMiddleware, (req, res) => {
  try {
    const paper = getPaperById(Number(req.params.id));
    if (!paper) return res.status(404).json({ error: '试卷不存在' });
    deletePaper(Number(req.params.id));
    writeLog(req, 'delete_paper', { detail: `删除试卷：${paper.title}` });
    res.json({ message: '试卷已删除' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/papers/:id/questions', authMiddleware, (req, res) => {
  const paperId = Number(req.params.id);
  if (!getPaperById(paperId)) return res.status(404).json({ error: '试卷不存在' });
  if (!req.body?.content?.trim()) return res.status(400).json({ error: '请填写题目内容' });
  try {
    const question = addQuestion(paperId, req.body);
    writeLog(req, 'add_question', { detail: `试卷 ${paperId} 添加试题` });
    res.json({ message: '试题已添加', question, paper: getPaperById(paperId) });
  } catch (err) {
    res.status(400).json({ error: err.message || '试题格式无效' });
  }
});

router.put('/papers/:paperId/questions/:questionId', authMiddleware, (req, res) => {
  try {
    const question = updateQuestion(Number(req.params.paperId), Number(req.params.questionId), req.body || {});
    if (!question) return res.status(404).json({ error: '试题不存在' });
    writeLog(req, 'update_question', { detail: `更新试题 ID ${question.id}` });
    res.json({ message: '试题已更新', question, paper: getPaperById(Number(req.params.paperId)) });
  } catch (err) {
    res.status(400).json({ error: err.message || '试题格式无效' });
  }
});

router.delete('/papers/:paperId/questions/:questionId', authMiddleware, (req, res) => {
  const ok = deleteQuestion(Number(req.params.paperId), Number(req.params.questionId));
  if (!ok) return res.status(404).json({ error: '试题不存在' });
  writeLog(req, 'delete_question', { detail: `删除试题 ID ${req.params.questionId}` });
  res.json({ message: '试题已删除', paper: getPaperById(Number(req.params.paperId)) });
});

router.get('/papers/:id/questions/template', authMiddleware, (req, res) => {
  const paper = getPaperById(Number(req.params.id));
  if (!paper) return res.status(404).json({ error: '试卷不存在' });
  const buf = buildImportTemplateBuffer();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="question-import-template.xlsx"');
  res.send(buf);
});

router.post('/papers/:id/questions/import', authMiddleware, questionImportUpload.single('file'), async (req, res) => {
  const paperId = Number(req.params.id);
  const paper = getPaperById(paperId);
  if (!paper) return res.status(404).json({ error: '试卷不存在' });
  if (!req.file) return res.status(400).json({ error: '请上传 Excel、CSV 或 Word 文件' });

  const ext = (req.file.originalname || '').toLowerCase();
  if (!ext.endsWith('.xlsx') && !ext.endsWith('.xls') && !ext.endsWith('.csv') && !ext.endsWith('.docx')) {
    return res.status(400).json({ error: '支持 .xlsx、.xls、.csv、.docx 格式' });
  }

  try {
    const { questions, errors } = await parseQuestionFile(req.file.buffer, req.file.originalname);
    if (errors?.length) {
      return res.status(400).json({ error: errors.slice(0, 5).join('；'), errors });
    }
    if (!questions?.length) {
      return res.status(400).json({ error: '未解析到有效试题，请检查文件格式' });
    }

    const result = importQuestions(paperId, questions);
    if (result.error) return res.status(400).json({ error: result.error });

    const source = ext.endsWith('.docx') ? 'Word' : 'Excel';
    writeLog(req, 'import_questions', {
      detail: `试卷「${paper.title}」${source} 导入 ${result.imported} 道试题`
    });
    res.json({
      message: `成功导入 ${result.imported} 道试题`,
      imported: result.imported,
      paper: result.paper
    });
  } catch (err) {
    res.status(400).json({ error: err.message || '导入失败' });
  }
});

router.post('/papers/:id/questions/ai-parse', authMiddleware, (req, res) => {
  const paper = getPaperById(Number(req.params.id));
  if (!paper) return res.status(404).json({ error: '试卷不存在' });

  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: '请粘贴或输入题目文本' });

  const { questions, errors } = parseQuestionText(text);
  res.json({
    message: questions.length ? `识别到 ${questions.length} 道题目` : '未能识别有效题目',
    questions,
    errors: errors.slice(0, 10),
    count: questions.length
  });
});

router.post('/papers/:id/questions/ai-import', authMiddleware, (req, res) => {
  const paperId = Number(req.params.id);
  const paper = getPaperById(paperId);
  if (!paper) return res.status(404).json({ error: '试卷不存在' });

  let questions = req.body?.questions;
  if (!Array.isArray(questions) || !questions.length) {
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: '请提供题目文本或识别结果' });
    const parsed = parseQuestionText(text);
    questions = parsed.questions;
    if (!questions.length) {
      return res.status(400).json({
        error: parsed.errors[0] || '未能识别有效题目',
        errors: parsed.errors
      });
    }
  }

  const result = importQuestions(paperId, questions);
  if (result.error) return res.status(400).json({ error: result.error });

  writeLog(req, 'import_questions', {
    detail: `试卷「${paper.title}」AI 录题导入 ${result.imported} 道试题`
  });
  res.json({
    message: `AI 录题成功，已导入 ${result.imported} 道试题`,
    imported: result.imported,
    paper: result.paper
  });
});

router.get('/dashboard/overview', authMiddleware, (req, res) => {
  res.json(getDashboardOverview());
});

router.get('/transcripts', authMiddleware, (req, res) => {
  const { q, status } = req.query;
  res.json(listTranscripts({ q: q || '', status: status || 'all' }));
});

router.get('/transcripts/:recordId', authMiddleware, (req, res) => {
  const transcript = buildTranscript(Number(req.params.recordId));
  if (!transcript) return res.status(404).json({ error: '成绩单不存在' });
  res.json({ transcript });
});

router.get('/transcripts/:recordId/pdf', authMiddleware, async (req, res) => {
  try {
    const { buildTranscriptPdfBuffer } = require('../utils/transcriptPdf');
    const transcript = buildTranscript(Number(req.params.recordId));
    if (!transcript) return res.status(404).json({ error: '成绩单不存在' });
    const buf = await buildTranscriptPdfBuffer(transcript);
    const filename = encodeURIComponent(`${transcript.name || '考生'}_成绩单.pdf`);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${filename}`);
    res.send(buf);
  } catch (err) {
    res.status(500).json({ error: err.message || 'PDF 生成失败' });
  }
});

router.get('/scores', authMiddleware, (req, res) => {
  const { q, position, exam_site, status } = req.query;
  const rows = queryComprehensiveScores({
    q,
    position,
    exam_site,
    status
  });
  res.json({
    rows,
    summary: getComprehensiveScoresSummary(rows),
    scoresLocked: getSettings().scoresLocked
  });
});

router.get('/scores/export', authMiddleware, (req, res) => {
  const { q, position, exam_site, status } = req.query;
  const rows = queryComprehensiveScores({
    q,
    position,
    exam_site,
    status
  });

  const exportRows = rows.map((r) => ({
    '准考证号': r.ticketNo,
    '姓名': r.name,
    '报考职位': r.position,
    '考点': r.examSite,
    '考场': r.examRoom,
    '座位号': r.seatNo,
    '考生状态': r.candidateStatus === 'submitted' ? '已交卷' : r.candidateStatus === 'in_progress' ? '考试中' : '待考',
    '客观题得分': r.objectiveScore ?? '',
    '客观题满分': r.objectiveMax,
    '实操第1题': r.task1Score ?? '',
    '实操第2题': r.task2Score ?? '',
    '实操合计': r.practicalScore ?? '',
    '实操满分': r.practicalMax,
    '总分': r.totalScore ?? '',
    '试卷满分': r.totalMax,
    '实操状态': r.practicalStatus === 'none' ? '未提交' : r.practicalStatus === 'open' ? '待上传' : r.practicalStatus === 'submitted' ? '待评分' : r.practicalStatus === 'scored' ? '已评分' : r.practicalStatus,
    '交卷时间': r.submittedAt || '',
    '实操提交时间': r.practicalFinalizedAt || '',
    '评分时间': r.practicalScoredAt || ''
  }));

  const ws = XLSX.utils.json_to_sheet(exportRows.length ? exportRows : [{ '提示': '暂无成绩数据' }]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '综合成绩');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  const filename = encodeURIComponent(`综合成绩_${new Date().toISOString().slice(0, 10)}.xlsx`);
  writeLog(req, 'export_comprehensive_scores', { detail: `导出综合成绩 Excel，共 ${rows.length} 条` });
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${filename}`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

router.put('/scores/lock', authMiddleware, (req, res) => {
  const { locked } = req.body;
  const settings = updateSettings({ scoresLocked: !!locked });
  writeLog(req, locked ? 'lock_scores' : 'unlock_scores', {
    detail: locked ? '已锁定成绩，禁止修改实操评分' : '已解锁成绩，可继续评分'
  });
  res.json({
    message: locked ? '成绩已锁定' : '成绩已解锁',
    scoresLocked: settings.scoresLocked
  });
});

router.get('/stats', authMiddleware, async (req, res) => {
  const total = await db.candidates.countDocuments();
  const pending = await db.candidates.countDocuments({ status: 'pending' });
  const inProgress = await db.candidates.countDocuments({ status: 'in_progress' });
  const submitted = await db.candidates.countDocuments({ status: 'submitted' });
  const avgResult = await db.exam_records.aggregate([
    { $match: { status: 'submitted' } },
    { $group: { _id: null, avg: { $avg: '$objective_score' } } }
  ]).toArray();
  const avgScore = avgResult.length > 0 ? avgResult[0].avg : 0;

  res.json({ total, pending, inProgress, submitted, avgScore: avgScore ? Math.round(avgScore * 10) / 10 : 0 });
});

router.get('/records', authMiddleware, async (req, res) => {
  const records = await db.exam_records.find({ status: 'submitted' }).sort({ submitted_at: -1 }).toArray();
  if (!records.length) return res.json([]);

  const candidateIds = records.map(r => r.candidate_id);
  const candidates = await db.candidates.find({ _id: { $in: candidateIds } }).toArray();
  const candidateMap = {};
  for (const c of candidates) {
    candidateMap[c._id] = c;
  }

  const result = records.map(er => {
    const c = candidateMap[er.candidate_id] || {};
    return {
      ...er,
      position: c.position || '',
      department: c.department || '',
      id_number: c.id_number || '',
      exam_site: c.exam_site || ''
    };
  });

  res.json(result);
});

router.get('/records/export', authMiddleware, async (req, res) => {
  const records = await db.exam_records.find({ status: 'submitted' }).sort({ submitted_at: -1 }).toArray();

  if (!records.length) {
    const ws = XLSX.utils.json_to_sheet([{ '提示': '暂无交卷记录' }]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '成绩汇总');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const filename = encodeURIComponent(`AIGC专项考核成绩_${new Date().toISOString().slice(0, 10)}.xlsx`);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${filename}`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    return res.send(buf);
  }

  const recordIds = records.map(r => r.id);
  const candidateIds = records.map(r => r.candidate_id);

  const candidates = await db.candidates.find({ _id: { $in: candidateIds } }).toArray();
  const candidateMap = {};
  for (const c of candidates) {
    candidateMap[c._id] = c;
  }

  const practicalSubmissions = await db.practical_submissions.find({ record_id: { $in: recordIds } }).toArray();
  const practicalMap = {};
  for (const ps of practicalSubmissions) {
    practicalMap[ps.record_id] = ps;
  }

  const rows = records.map((er) => {
    const c = candidateMap[er.candidate_id] || {};
    const ps = practicalMap[er.id] || {};
    return {
      '准考证号': er.ticket_no,
      '姓名': er.name,
      '身份证号': c.id_number || '',
      '报考职位': c.position || '',
      '考点名称': c.exam_site || '',
      '考场号': c.exam_room || '',
      '座位号': c.seat_no || '',
      '客观题得分': er.objective_score,
      '客观题满分': 40,
      '实操第1题': ps.task1_score ?? '',
      '实操第2题': ps.task2_score ?? '',
      '实操合计': ps.practical_score ?? '',
      '实操满分': 60,
      '总分': ps.practical_score != null ? (er.objective_score ?? 0) + ps.practical_score : '',
      '试卷满分': 100,
      '实操状态': ps.status || '未提交',
      '用时(分钟)': er.duration_seconds ? Math.floor(er.duration_seconds / 60) : '',
      '开始时间': er.started_at || '',
      '交卷时间': er.submitted_at || ''
    };
  });

  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '成绩汇总');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  const filename = encodeURIComponent(`AIGC专项考核成绩_${new Date().toISOString().slice(0, 10)}.xlsx`);
  writeLog(req, 'export_records', { detail: `导出成绩 Excel，共 ${records.length} 条记录` });
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${filename}`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

router.get('/records/:id', authMiddleware, async (req, res) => {
  const record = await db.exam_records.findOne({ _id: req.params.id });

  if (!record) return res.status(404).json({ error: '记录不存在' });

  const candidate = await db.candidates.findOne({ _id: record.candidate_id });

  let answers = {};
  if (record.answers) {
    if (typeof record.answers === 'object') {
      answers = record.answers;
    } else {
      try { answers = JSON.parse(record.answers); } catch { answers = {}; }
    }
  }

  const analysis = buildAnswerDetailsForRecord(record.id, answers);

  res.json({
    record: {
      id: record.id,
      ticketNo: record.ticket_no,
      name: record.name,
      position: candidate?.position || '',
      idNumber: candidate?.id_number || '',
      examSite: candidate?.exam_site || '',
      objectiveScore: record.objective_score,
      startedAt: record.started_at,
      submittedAt: record.submitted_at,
      durationSeconds: record.duration_seconds,
      status: record.status
    },
    answers,
    analysis
  });
});

router.delete('/records/:id', authMiddleware, (req, res) => {
  const record = deleteExamRecordById(Number(req.params.id));
  if (!record) return res.status(404).json({ error: '成绩记录不存在' });

  writeLog(req, 'delete_record', {
    targetType: 'exam_record',
    targetId: String(record.id),
    detail: `删除成绩记录：${record.name}（${record.ticket_no}），客观题 ${record.objective_score ?? 0} 分`
  });
  res.json({ message: '成绩记录已删除' });
});

router.post('/upload', authMiddleware, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '请上传文件' });

  try {
    const workbook = XLSX.readFile(req.file.path);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

    const candidates = rows.map((row) => ({
      ticket_no: String(row['准考证号'] || row['ticket_no'] || row['考号'] || '').trim(),
      name: String(row['姓名'] || row['name'] || '').trim(),
      id_number: String(row['身份证号'] || row['id_number'] || '').trim(),
      position: String(row['报考职位'] || row['岗位'] || row['position'] || '').trim(),
      exam_site: String(row['考点名称'] || row['exam_site'] || '').trim(),
      exam_room: String(row['考场号'] || row['exam_room'] || '').trim(),
      seat_no: String(row['座位号'] || row['seat_no'] || '').trim(),
      exam_time: String(row['考试时间'] || row['exam_time'] || '').trim(),
      department: String(row['部门'] || row['department'] || '').trim(),
      phone: String(row['电话'] || row['phone'] || row['手机号'] || '').trim()
    })).filter(c => c.ticket_no && c.name);

    fs.unlinkSync(req.file.path);

    if (candidates.length === 0) {
      return res.status(400).json({ error: '未解析到有效考生数据，请检查Excel列名（准考证号、姓名）' });
    }

    res.json({ candidates, count: candidates.length });
  } catch {
    if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(400).json({ error: '文件解析失败，请上传标准Excel/CSV文件' });
  }
});

router.get('/proctor/live', authMiddleware, (req, res) => {
  res.json({
    sessions: getLiveSessions(),
    summary: getSummary(),
    settings: getSettings()
  });
});

router.get('/proctor/events', authMiddleware, (req, res) => {
  const { limit, level, ticket_no } = req.query;
  res.json(getProctorEvents({
    limit: parseInt(limit, 10) || 200,
    level,
    ticketNo: ticket_no
  }));
});

router.get('/proctor/report/export', authMiddleware, (req, res) => {
  const events = getProctorEvents({ limit: 2000 });
  const live = getLiveSessions();
  const summary = getSummary();
  const now = new Date().toLocaleString('zh-CN', { hour12: false });

  const eventRows = events.map((e) => ({
    '时间': e.createdAt,
    '准考证号': e.ticketNo,
    '姓名': e.name,
    '级别': e.level === 'alert' ? '异常' : e.level === 'warning' ? '注意' : '信息',
    '事件类型': e.eventType,
    '描述': e.message,
    '详情': e.detail
  }));

  const liveRows = live.map((s) => ({
    '准考证号': s.ticketNo,
    '姓名': s.name,
    '考点': s.examSite || '',
    '考场': s.examRoom || '',
    '座位': s.seatNo || '',
    '状态': s.status === 'alert' ? '异常' : s.status === 'warning' ? '注意' : s.status === 'offline' ? '离线' : '正常',
    '答题进度': `${s.answeredCount}/${s.totalQuestions}`,
    '剩余(秒)': s.timeLeft,
    '切屏次数': s.focusEvents || 0,
    '屏幕共享': s.screenSharing ? '是' : '否',
    '摄像头': s.cameraActive ? '是' : '否',
    '页面可见': s.pageVisible ? '是' : '否',
    '最近事件': s.lastEvent || '',
    '接入时间': s.connectedAt || ''
  }));

  const summaryRows = [
    { '项目': '导出时间', '数值': now },
    { '项目': '在考人数', '数值': summary.total },
    { '项目': '正常', '数值': summary.normal },
    { '项目': '注意', '数值': summary.warning },
    { '项目': '异常', '数值': summary.alert },
    { '项目': '离线', '数值': summary.offline },
    { '项目': '告警记录数', '数值': events.length }
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summaryRows), '监考概览');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(liveRows.length ? liveRows : [{ '提示': '当前无在考考生' }]), '在考快照');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(eventRows.length ? eventRows : [{ '提示': '暂无告警记录' }]), '告警事件');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  writeLog(req, 'export_proctor_report', { detail: `导出监考报告，在考 ${live.length} 人，告警 ${events.length} 条` });

  const filename = encodeURIComponent(`监考报告_${new Date().toISOString().slice(0, 10)}.xlsx`);
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${filename}`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

router.get('/logs/actions', authMiddleware, (req, res) => {
  res.json(getActionOptions());
});

router.get('/logs', authMiddleware, (req, res) => {
  const { page, limit, action, search, admin_username } = req.query;
  res.json(getLogs({
    page,
    limit,
    action,
    search,
    adminUsername: admin_username
  }));
});

router.get('/materials', authMiddleware, (req, res) => {
  res.json(getMaterialsInfo());
});

router.post('/materials/upload', authMiddleware, materialUpload.array('files', 20), (req, res) => {
  if (!req.files?.length) {
    return res.status(400).json({ error: '请选择要上传的素材文件' });
  }
  const names = req.files.map((f) => f.filename).join('、');
  writeLog(req, 'upload_material', { detail: `上传考生素材 ${req.files.length} 个：${names}` });
  res.json({
    message: `已上传 ${req.files.length} 个素材文件`,
    materials: getMaterialsInfo()
  });
});

router.delete('/materials/:name', authMiddleware, (req, res) => {
  const name = decodeURIComponent(req.params.name);
  if (!deleteMaterialFile(name)) {
    return res.status(404).json({ error: '素材文件不存在' });
  }
  writeLog(req, 'delete_material', { detail: `删除考生素材：${name}` });
  res.json({ message: '素材已删除', materials: getMaterialsInfo() });
});

router.get('/announcements', authMiddleware, (req, res) => {
  res.json(getAllAnnouncements());
});

router.post('/announcements', authMiddleware, (req, res) => {
  const { title, content, enabled, pinned } = req.body;
  if (!content || !String(content).trim()) {
    return res.status(400).json({ error: '请填写公告内容' });
  }
  const item = createAnnouncement({ title, content: String(content).trim(), enabled, pinned });
  writeLog(req, 'add_announcement', { detail: `发布公告：${item.title}` });
  res.json({ message: '公告已发布', announcement: item });
});

router.put('/announcements/:id', authMiddleware, (req, res) => {
  const item = updateAnnouncement(Number(req.params.id), req.body);
  if (!item) return res.status(404).json({ error: '公告不存在' });
  writeLog(req, 'update_announcement', { detail: `更新公告：${item.title}` });
  res.json({ message: '公告已更新', announcement: item });
});

router.delete('/announcements/:id', authMiddleware, (req, res) => {
  const existing = getAnnouncementById(Number(req.params.id));
  if (!existing) return res.status(404).json({ error: '公告不存在' });
  deleteAnnouncement(existing.id);
  writeLog(req, 'delete_announcement', { detail: `删除公告：${existing.title}` });
  res.json({ message: '公告已删除' });
});

module.exports = router;
