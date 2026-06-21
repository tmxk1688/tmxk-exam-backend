const express = require('express');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../db');
const { verifyCaptcha } = require('../utils/captcha');
const { getSettings } = require('../utils/settings');
const { getMaterialsInfo } = require('../utils/materials');
const { getPracticalDeadlineInfo } = require('../utils/deadline');
const { writeLog } = require('../utils/auditLog');
const {
  getPracticalSection,
  PRACTICAL_MAX,
  PRACTICAL_TASK1_MAX,
  PRACTICAL_TASK2_MAX
} = require('../utils/questionBank');
const {
  PRACTICAL_ROOT,
  sanitizeFilename,
  isAllowedFile,
  getFolderByKey,
  getCandidateFolderPath,
  getOrCreateSubmission,
  getSubmissionByRecordId,
  getSubmissionFiles,
  formatSubmissionRow,
  checkPracticalUploadAccess,
  deleteFileFromDisk,
  deletePracticalSubmissionById
} = require('../utils/practical');
const { scoreSubmission, batchScoreSubmissions } = require('../utils/practicalAdmin');
const {
  getClosureStatus,
  submitClosure,
  buildTranscript
} = require('../utils/transcript');

const JWT_SECRET = process.env.JWT_SECRET || 'tmxk-aigc-exam-secret-2026';

function createPracticalToken(payload) {
  return jwt.sign({ type: 'practical', ...payload }, JWT_SECRET, { expiresIn: '7d' });
}

function practicalAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: '请先验证准考证号' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.type !== 'practical') {
      return res.status(401).json({ error: '无效的实操访问凭证' });
    }
    req.practical = decoded;
    next();
  } catch {
    res.status(401).json({ error: '登录已过期，请重新验证' });
  }
}

function adminAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: '未登录' });
  try {
    req.admin = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: '登录已过期' });
  }
}

function resolveWritableSubmission(req, res, next) {
  const record = db.prepare(`
    SELECT * FROM exam_records WHERE id = ? AND status = 'submitted'
  `).get(req.practical.recordId);

  if (!record) {
    return res.status(400).json({ error: '未找到已交卷记录，无法上传实操文件' });
  }

  const submission = getOrCreateSubmission(record.id);
  if (!submission) {
    return res.status(400).json({ error: '无法创建实操归档记录' });
  }

  if (submission.status === 'scored') {
    return res.status(400).json({ error: '实操题已评分，无法再修改文件' });
  }

  if (submission.status === 'submitted') {
    return res.status(400).json({ error: '实操作品已提交，考核结束前无法修改' });
  }

  req.practicalSubmission = submission;
  next();
}

const uploadStorage = multer.diskStorage({
  destination(req, file, cb) {
    const folderKey = req.body.folderKey || req.query.folderKey;
    const entry = getFolderByKey(folderKey);
    if (!entry) {
      return cb(new Error('无效的文件夹'));
    }
    const dest = getCandidateFolderPath(req.practicalSubmission.ticket_no, folderKey);
    fs.mkdirSync(dest, { recursive: true });
    cb(null, dest);
  },
  filename(req, file, cb) {
    const safe = sanitizeFilename(file.originalname);
    const unique = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${safe}`;
    cb(null, unique);
  }
});

const upload = multer({
  storage: uploadStorage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    if (!isAllowedFile(file.originalname)) {
      return cb(new Error('不支持的文件类型，允许：jpg、png、psd、zip、gif、webp、pdf'));
    }
    cb(null, true);
  }
});

function runUpload(req, res, next) {
  const settings = getSettings();
  const uploader = multer({
    storage: uploadStorage,
    limits: { fileSize: settings.practicalMaxFileMb * 1024 * 1024 },
    fileFilter(req, file, cb) {
      if (!isAllowedFile(file.originalname)) {
        return cb(new Error('不支持的文件类型，允许：jpg、png、psd、zip、gif、webp、pdf'));
      }
      cb(null, true);
    }
  });
  uploader.single('file')(req, res, (err) => handleUploadError(err, req, res, next));
}

function handleUploadError(err, req, res, next) {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      const settings = getSettings();
      return res.status(400).json({ error: `文件过大，单文件上限 ${settings.practicalMaxFileMb}MB` });
    }
    return res.status(400).json({ error: err.message });
  }
  if (err) {
    return res.status(400).json({ error: err.message });
  }
  next();
}

function buildExamRouter() {
  const router = express.Router();

  router.post('/access', (req, res) => {
    const { ticket_no, captchaId, captchaCode } = req.body;
    const captchaResult = verifyCaptcha(captchaId, captchaCode);
    if (!captchaResult.ok) {
      return res.status(400).json({ error: captchaResult.error });
    }

    if (!ticket_no || !ticket_no.trim()) {
      return res.status(400).json({ error: '请输入准考证号' });
    }

    const settings = getSettings();
    const access = checkPracticalUploadAccess(settings);
    if (!access.ok) {
      return res.status(403).json({ error: access.error });
    }

    const candidate = db.prepare('SELECT * FROM candidates WHERE ticket_no = ?').get(ticket_no.trim());
    if (!candidate) {
      return res.status(404).json({ error: '准考证号不存在' });
    }

    if (candidate.status !== 'submitted') {
      return res.status(400).json({ error: '请先完成客观题交卷后再上传实操作品' });
    }

    const record = db.prepare(`
      SELECT * FROM exam_records
      WHERE candidate_id = ? AND status = 'submitted'
      ORDER BY submitted_at DESC LIMIT 1
    `).get(candidate.id);

    if (!record) {
      return res.status(404).json({ error: '未找到交卷记录' });
    }

    getOrCreateSubmission(record.id);

    const token = createPracticalToken({
      candidateId: candidate.id,
      recordId: record.id,
      ticketNo: candidate.ticket_no,
      name: candidate.name
    });

    res.json({
      token,
      candidate: { ticketNo: candidate.ticket_no, name: candidate.name }
    });
  });

  router.get('/info', practicalAuth, (req, res) => {
    const settings = getSettings();
    const submission = getOrCreateSubmission(req.practical.recordId);
    if (!submission) {
      return res.status(404).json({ error: '未找到交卷记录' });
    }

    const files = getSubmissionFiles(submission.id);
    res.json({
      practicalSection: getPracticalSection(),
      practicalMax: PRACTICAL_MAX,
      submission: formatSubmissionRow(submission, files),
      materialLibrary: getMaterialsInfo(),
      settings: {
        uploadEnabled: settings.practicalUploadEnabled !== false,
        maxFileMb: settings.practicalMaxFileMb,
        deadline: settings.practicalDeadline || '',
        deadlineInfo: getPracticalDeadlineInfo(settings),
        allowedExtensions: ['jpg', 'jpeg', 'png', 'psd', 'zip', 'gif', 'webp', 'pdf']
      }
    });
  });

  router.post('/upload', practicalAuth, resolveWritableSubmission, (req, res, next) => {
    const settings = getSettings();
    const access = checkPracticalUploadAccess(settings);
    if (!access.ok) {
      return res.status(403).json({ error: access.error });
    }
    runUpload(req, res, next);
  }, (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: '请选择要上传的文件' });
    }

    const folderKey = req.body.folderKey || req.query.folderKey;
    const entry = getFolderByKey(folderKey);
    if (!entry) {
      if (req.file?.path) {
        try { fs.unlinkSync(req.file.path); } catch { /* ignore */ }
      }
      return res.status(400).json({ error: '无效的文件夹类型' });
    }

    const taskId = Number(entry[0]);
    const relativePath = path.join(req.practicalSubmission.ticket_no, folderKey, req.file.filename);

    const result = db.prepare(`
      INSERT INTO practical_files
      (submission_id, task_id, folder_key, original_name, stored_name, relative_path, file_size, mime_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      req.practicalSubmission.id,
      taskId,
      folderKey,
      req.file.originalname,
      req.file.filename,
      relativePath,
      req.file.size,
      req.file.mimetype || ''
    );

    if (req.practicalSubmission.status === 'open') {
      db.prepare("UPDATE practical_submissions SET status = 'uploading' WHERE id = ?")
        .run(req.practicalSubmission.id);
    }

    const file = db.prepare('SELECT * FROM practical_files WHERE id = ?').get(result.lastInsertRowid);
    res.json({
      message: '上传成功',
      file: {
        id: file.id,
        taskId: file.task_id,
        folderKey: file.folder_key,
        originalName: file.original_name,
        fileSize: file.file_size,
        uploadedAt: file.uploaded_at,
        url: `/uploads/practical/${relativePath.replace(/\\/g, '/')}`
      }
    });
  });

  router.delete('/files/:id', practicalAuth, resolveWritableSubmission, (req, res) => {
    const file = db.prepare(`
      SELECT * FROM practical_files WHERE id = ? AND submission_id = ?
    `).get(req.params.id, req.practicalSubmission.id);

    if (!file) {
      return res.status(404).json({ error: '文件不存在' });
    }

    deleteFileFromDisk(file.relative_path);
    db.prepare('DELETE FROM practical_files WHERE id = ?').run(file.id);

    res.json({ message: '已删除' });
  });

  router.post('/finalize', practicalAuth, resolveWritableSubmission, (req, res) => {
    const files = getSubmissionFiles(req.practicalSubmission.id);
    const folders = formatSubmissionRow(req.practicalSubmission, files).folders;
    const missing = folders.filter((f) => f.files.length === 0);

    if (missing.length > 0) {
      return res.status(400).json({
        error: '请在两个云端文件夹中各上传 1 个文件后再提交',
        missingFolders: missing.map((f) => f.folderName)
      });
    }

    const now = new Date().toLocaleString('zh-CN', { hour12: false });
    db.prepare(`
      UPDATE practical_submissions SET status = 'submitted', finalized_at = ? WHERE id = ?
    `).run(now, req.practicalSubmission.id);

    const updated = db.prepare('SELECT * FROM practical_submissions WHERE id = ?').get(req.practicalSubmission.id);
    res.json({
      message: '实操作品已提交，请完成考后签字确认',
      waitingHint: getPracticalSection().waitingHint,
      submission: formatSubmissionRow(updated, files),
      nextStep: 'closure'
    });
  });

  router.get('/closure/status', practicalAuth, (req, res) => {
    res.json(getClosureStatus(req.practical.recordId));
  });

  router.post('/closure/submit', practicalAuth, (req, res) => {
    const submission = getSubmissionByRecordId(req.practical.recordId);
    if (!submission || !['submitted', 'scored'].includes(submission.status)) {
      return res.status(400).json({ error: '请先提交实操作品后再进行考后确认' });
    }

    const result = submitClosure(req.practical.recordId, req.body || {});
    if (result.error) return res.status(400).json({ error: result.error });

    res.json({
      ...result,
      transcript: buildTranscript(req.practical.recordId)
    });
  });

  router.get('/transcript', practicalAuth, (req, res) => {
    const transcript = buildTranscript(req.practical.recordId);
    if (!transcript) return res.status(404).json({ error: '成绩单不存在' });
    res.json({ transcript });
  });

  router.get('/transcript/pdf', practicalAuth, async (req, res) => {
    try {
      const { buildTranscriptPdfBuffer } = require('../utils/transcriptPdf');
      const transcript = buildTranscript(req.practical.recordId);
      if (!transcript) return res.status(404).json({ error: '成绩单不存在' });
      if (!transcript.canPrint) {
        return res.status(400).json({ error: transcript.printBlockedReason || '暂不可导出成绩单' });
      }
      const buf = await buildTranscriptPdfBuffer(transcript);
      const filename = encodeURIComponent(`${transcript.name || '考生'}_成绩单.pdf`);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${filename}`);
      res.send(buf);
    } catch (err) {
      res.status(500).json({ error: err.message || 'PDF 生成失败' });
    }
  });

  return router;
}

function buildAdminRouter() {
  const router = express.Router();

  router.get('/submissions', adminAuth, (req, res) => {
    const { status, q } = req.query;
    let sql = `
      SELECT ps.*, er.objective_score, er.submitted_at as exam_submitted_at,
        (SELECT COUNT(*) FROM practical_files pf WHERE pf.submission_id = ps.id) as file_count
      FROM practical_submissions ps
      JOIN exam_records er ON er.id = ps.record_id
      WHERE 1=1
    `;
    const params = [];

    if (status && status !== 'all') {
      sql += ' AND ps.status = ?';
      params.push(status);
    }

    if (q && q.trim()) {
      sql += ' AND (ps.ticket_no LIKE ? OR ps.name LIKE ?)';
      const like = `%${q.trim()}%`;
      params.push(like, like);
    }

    sql += ' ORDER BY ps.created_at DESC';

    const rows = db.prepare(sql).all(...params);
    res.json(rows.map((r) => ({
      id: r.id,
      recordId: r.record_id,
      ticketNo: r.ticket_no,
      name: r.name,
      status: r.status,
      fileCount: r.file_count,
      task1Score: r.task1_score,
      task2Score: r.task2_score,
      practicalScore: r.practical_score,
      objectiveScore: r.objective_score,
      examSubmittedAt: r.exam_submitted_at,
      finalizedAt: r.finalized_at,
      scoredAt: r.scored_at
    })));
  });

  router.get('/submissions/:id', adminAuth, (req, res) => {
    const sub = db.prepare('SELECT * FROM practical_submissions WHERE id = ?').get(req.params.id);
    if (!sub) return res.status(404).json({ error: '记录不存在' });

    const record = db.prepare(`
      SELECT er.*, c.position, c.exam_site, c.exam_room, c.seat_no
      FROM exam_records er
      JOIN candidates c ON c.id = er.candidate_id
      WHERE er.id = ?
    `).get(sub.record_id);

    const files = getSubmissionFiles(sub.id);
    res.json({
      submission: formatSubmissionRow(sub, files),
      record: record ? {
        id: record.id,
        objectiveScore: record.objective_score,
        submittedAt: record.submitted_at,
        position: record.position,
        examSite: record.exam_site,
        examRoom: record.exam_room,
        seatNo: record.seat_no
      } : null,
      practicalSection: getPracticalSection()
    });
  });

  router.put('/submissions/:id/score', adminAuth, (req, res) => {
    const settings = getSettings();
    if (settings.scoresLocked) {
      return res.status(403).json({ error: '成绩已锁定，无法修改实操评分。请在「综合成绩」页解锁后再操作。' });
    }

    const sub = db.prepare('SELECT * FROM practical_submissions WHERE id = ?').get(req.params.id);
    if (!sub) return res.status(404).json({ error: '记录不存在' });

    try {
      const updated = scoreSubmission(Number(req.params.id), req.body, req.admin.username);
      const files = getSubmissionFiles(updated.id);

      writeLog(req, 'score_practical', {
        targetType: 'practical_submission',
        targetId: String(sub.id),
        detail: `评分 ${sub.ticket_no} ${sub.name}：第1题 ${updated.task1_score ?? 0} 分，第2题 ${updated.task2_score ?? 0} 分，合计 ${updated.practical_score} 分`
      });

      res.json({
        message: '评分已保存',
        submission: formatSubmissionRow(updated, files)
      });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/submissions/batch-score', adminAuth, (req, res) => {
    const settings = getSettings();
    if (settings.scoresLocked) {
      return res.status(403).json({ error: '成绩已锁定，无法批量评分。请在「综合成绩」页解锁后再操作。' });
    }

    const { ids, task1Score, task2Score, comment } = req.body || {};
    const result = batchScoreSubmissions(ids, { task1Score, task2Score, comment }, req.admin.username);
    if (result.error && result.scored === 0) {
      return res.status(400).json({ error: result.error, failed: result.failed });
    }

    writeLog(req, 'batch_score_practical', {
      detail: `${result.message}（第1题 ${task1Score ?? 0}，第2题 ${task2Score ?? 0}）`
    });

    res.json(result);
  });

  router.get('/files/:id/download', adminAuth, (req, res) => {
    const file = db.prepare('SELECT * FROM practical_files WHERE id = ?').get(req.params.id);
    if (!file) return res.status(404).json({ error: '文件不存在' });

    const fullPath = path.join(PRACTICAL_ROOT, file.relative_path);
    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ error: '文件已丢失' });
    }

    res.download(fullPath, file.original_name);
  });

  router.delete('/submissions/:id', adminAuth, (req, res) => {
    const sub = deletePracticalSubmissionById(Number(req.params.id));
    if (!sub) return res.status(404).json({ error: '实操归档记录不存在' });

    writeLog(req, 'delete_practical_submission', {
      targetType: 'practical_submission',
      targetId: String(sub.id),
      detail: `删除实操归档：${sub.name}（${sub.ticket_no}）`
    });
    res.json({ message: '实操归档已删除' });
  });

  return router;
}

module.exports = {
  createPracticalToken,
  buildExamRouter,
  buildAdminRouter
};
