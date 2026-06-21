const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { createCaptcha, verifyCaptcha } = require('../utils/captcha');
const { formatCandidate } = require('../utils/candidate');
const {
  getExamInfo,
  getPracticalSection,
  getObjectiveMax,
  getTotalMax,
  PRACTICAL_MAX,
  ensureRecordDrawnQuestions,
  ensureRecordOptionLayout,
  getPublicQuestionsForRecord,
  calculateScoreForRecord,
  buildAnswerDetailsForRecord,
  getObjectiveMaxForRecord
} = require('../utils/questionBank');
const { getSettings, checkExamAccess } = require('../utils/settings');
const { getMaterialsInfo, streamMaterialsBundle } = require('../utils/materials');
const { getActiveAnnouncements } = require('../utils/announcements');
const { getPracticalDeadlineInfo } = require('../utils/deadline');
const { getSubmissionByRecordId, buildPracticalScoreInfo } = require('../utils/practical');
const {
  saveExamCaptures,
  submitClosure,
  getClosureStatus,
  buildTranscript
} = require('../utils/transcript');
const { createPracticalToken } = require('../routes/practical');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'tmxk-aigc-exam-secret-2026';

function examAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: '未登录，请先验证准考证号' });
  try {
    req.exam = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: '登录已过期，请重新验证' });
  }
}

function parseAnswers(str) {
  if (!str) return {};
  try {
    return JSON.parse(str);
  } catch {
    return {};
  }
}

function parseMarked(str) {
  if (!str) return [];
  try {
    const arr = JSON.parse(str);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function buildTotalScoreInfo(objectiveScore, recordId) {
  const submission = recordId ? getSubmissionByRecordId(recordId) : null;
  const practicalInfo = buildPracticalScoreInfo(submission);
  const objective = objectiveScore ?? 0;
  const objectiveMax = recordId ? getObjectiveMaxForRecord(recordId) : getObjectiveMax();
  const totalMax = objectiveMax + PRACTICAL_MAX;

  return {
    objective,
    objectiveMax,
    practicalMax: PRACTICAL_MAX,
    otherMax: 0,
    totalMax,
    ...practicalInfo,
    totalScore: practicalInfo.practicalScored ? objective + (practicalInfo.practicalScore ?? 0) : null,
    practicalNote: practicalInfo.practicalScored
      ? `实操题已评分，合计 ${practicalInfo.practicalScore} 分`
      : '实操题（第二部分）未评分请等待',
    practicalPendingText: practicalInfo.practicalScored ? null : '未评分请等待'
  };
}

function buildSubmittedPayload(record, candidate) {
  const settings = getSettings();
  const answers = parseAnswers(record.answers);
  const maxScore = getObjectiveMaxForRecord(record.id);
  const payload = {
    submitted: true,
    score: record.objective_score,
    maxScore,
    submittedAt: record.submitted_at,
    durationSeconds: record.duration_seconds,
    practicalSection: getPracticalSection(),
    candidate: formatCandidate(candidate),
    totalScoreInfo: buildTotalScoreInfo(record.objective_score, record.id),
    showAnswerReview: settings.showAnswerReview,
    practicalDeadline: getPracticalDeadlineInfo(settings),
    uploadEnabled: settings.practicalUploadEnabled !== false,
    practicalToken: createPracticalToken({
      candidateId: candidate.id,
      recordId: record.id,
      ticketNo: candidate.ticket_no,
      name: candidate.name
    })
  };
  if (settings.showAnswerReview) {
    payload.answerReview = buildAnswerDetailsForRecord(record.id, answers);
  }
  return payload;
}

function buildStatusOverview(candidate) {
  const settings = getSettings();

  const submittedRecord = db.prepare(`
    SELECT * FROM exam_records
    WHERE candidate_id = ? AND status = 'submitted'
    ORDER BY submitted_at DESC LIMIT 1
  `).findOne(candidate.id);

  const inProgressRecord = db.prepare(`
    SELECT * FROM exam_records
    WHERE candidate_id = ? AND status = 'in_progress'
    ORDER BY _id DESC LIMIT 1
  `).findOne(candidate.id);

  const pendingMax = getObjectiveMax();
  let objective = {
    status: candidate.status === 'submitted' ? 'submitted' : (candidate.status === 'in_progress' ? 'in_progress' : 'pending'),
    score: null,
    maxScore: pendingMax,
    submittedAt: null,
    label: '待考试'
  };

  if (submittedRecord) {
    objective = {
      status: 'submitted',
      score: submittedRecord.objective_score,
      maxScore: getObjectiveMaxForRecord(submittedRecord.id),
      submittedAt: submittedRecord.submitted_at,
      label: '已交卷'
    };
  } else if (inProgressRecord || candidate.status === 'in_progress') {
    const maxScore = inProgressRecord ? getObjectiveMaxForRecord(inProgressRecord.id) : pendingMax;
    objective = {
      status: 'in_progress',
      score: inProgressRecord?.objective_score ?? null,
      maxScore,
      submittedAt: null,
      label: '考试中'
    };
  }

  let practical = {
    status: 'none',
    label: '未开始',
    fileCount: 0,
    finalizedAt: null,
    practicalScored: false,
    practicalScore: null,
    practicalMax: PRACTICAL_MAX
  };

  let totalScoreInfo = null;

  if (submittedRecord) {
    const submission = getSubmissionByRecordId(submittedRecord.id);
    const practicalInfo = buildPracticalScoreInfo(submission);
    totalScoreInfo = buildTotalScoreInfo(submittedRecord.objective_score, submittedRecord.id);

    const statusLabels = {
      none: '待上传',
      open: '待上传',
      uploading: '上传中',
      submitted: '已提交待评',
      scored: '已评分'
    };

    practical = {
      status: practicalInfo.practicalStatus || 'none',
      label: statusLabels[practicalInfo.practicalStatus] || '待上传',
      fileCount: practicalInfo.fileCount || 0,
      finalizedAt: submission?.finalized_at || null,
      practicalScored: practicalInfo.practicalScored,
      practicalScore: practicalInfo.practicalScore,
      task1Score: practicalInfo.task1Score,
      task2Score: practicalInfo.task2Score,
      practicalMax: PRACTICAL_MAX,
      comment: practicalInfo.practicalComment || ''
    };
  }

  const nextSteps = [];

  if (objective.status !== 'submitted') {
    nextSteps.push({
      key: 'objective',
      label: '完成第一部分客观题并交卷',
      done: false,
      path: '/',
      action: '进入考试'
    });
  } else {
    nextSteps.push({
      key: 'objective',
      label: `客观题已交卷（${objective.score ?? 0} / ${objective.maxScore} 分）`,
      done: true,
      path: '/result',
      action: '查看结果'
    });

    const uploadDone = ['submitted', 'scored'].includes(practical.status);
    nextSteps.push({
      key: 'practical',
      label: uploadDone
        ? (practical.status === 'scored' ? `实操已评分（${practical.practicalScore} / ${PRACTICAL_MAX} 分）` : '实操作品已提交，等待评分')
        : '上传两个实操文件至云端归档并确认提交',
      done: uploadDone,
      path: '/practical',
      action: uploadDone ? '查看归档' : '去上传'
    });

    nextSteps.push({
      key: 'score',
      label: practical.practicalScored
        ? `总分 ${totalScoreInfo?.totalScore} / ${getTotalMax()} 分`
        : '考核结束后查询总分（第二部分未评分请等待）',
      done: practical.practicalScored,
      path: '/score',
      action: '查询成绩'
    });
  }

  return {
    candidate: formatCandidate(candidate),
    objective,
    practical,
    totalScoreInfo,
    nextSteps,
    practicalDeadline: getPracticalDeadlineInfo(settings),
    uploadEnabled: settings.practicalUploadEnabled !== false
  };
}

function verifyTicketCaptcha(req, res) {
  const { captchaId, captchaCode } = req.body;
  const captchaResult = verifyCaptcha(captchaId, captchaCode);
  if (!captchaResult.ok) {
    res.status(400).json({ error: captchaResult.error });
    return null;
  }
  return true;
}

const transcriptDownloadTokens = new Map();
const TRANSCRIPT_TOKEN_TTL_MS = 15 * 60 * 1000;

function issueTranscriptDownloadToken(recordId) {
  const token = crypto.randomBytes(24).toString('hex');
  transcriptDownloadTokens.set(token, {
    recordId,
    expiresAt: Date.now() + TRANSCRIPT_TOKEN_TTL_MS
  });
  return token;
}

function resolveTranscriptRecordId(req) {
  const { downloadToken } = req.body;
  if (downloadToken) {
    const item = transcriptDownloadTokens.get(downloadToken);
    if (!item || Date.now() > item.expiresAt) {
      transcriptDownloadTokens.delete(downloadToken);
      return { error: '下载凭证已失效，请重新查询成绩单' };
    }
    return { recordId: item.recordId };
  }
  return null;
}

router.get('/captcha', (req, res) => {
  res.json(createCaptcha());
});

router.get('/access', (req, res) => {
  const access = checkExamAccess();
  const settings = getSettings();
  res.json({
    accessible: access.ok,
    waiting: access.waiting || false,
    openAt: access.openAt || settings.openAt || '',
    openTimestamp: access.openTimestamp || null,
    message: access.error || '',
    ...settings,
    examInfo: getExamInfo(),
    practicalDeadlineInfo: getPracticalDeadlineInfo(settings)
  });
});

router.get('/announcements', (req, res) => {
  res.json(getActiveAnnouncements());
});

router.get('/materials', (req, res) => {
  res.json(getMaterialsInfo());
});

router.get('/materials/bundle', (req, res) => {
  streamMaterialsBundle(res);
});

router.post('/ticket-preview', (req, res) => {
  if (!verifyTicketCaptcha(req, res)) return;

  const { ticket_no } = req.body;
  if (!ticket_no || !ticket_no.trim()) {
    return res.status(400).json({ error: '请输入准考证号' });
  }

  const candidate = db.prepare('SELECT * FROM candidates WHERE ticket_no = ?').findOne(ticket_no.trim());
  if (!candidate) {
    return res.status(404).json({ error: '准考证号不存在，请核对后重试' });
  }

  res.json({ candidate: formatCandidate(candidate) });
});

router.post('/score-query', (req, res) => {
  if (!verifyTicketCaptcha(req, res)) return;

  const { ticket_no } = req.body;
  if (!ticket_no || !ticket_no.trim()) {
    return res.status(400).json({ error: '请输入准考证号' });
  }

  const candidate = db.prepare('SELECT * FROM candidates WHERE ticket_no = ?').findOne(ticket_no.trim());
  if (!candidate) {
    return res.status(404).json({ error: '准考证号不存在，请核对后重试' });
  }

  if (candidate.status !== 'submitted') {
    return res.status(400).json({ error: '您尚未交卷，暂无成绩可查' });
  }

  const record = db.prepare(`
    SELECT * FROM exam_records
    WHERE candidate_id = ? AND status = 'submitted'
    ORDER BY submitted_at DESC LIMIT 1
  `).findOne(candidate.id);

  if (!record) {
    return res.status(404).json({ error: '未找到交卷记录' });
  }

  const payload = buildSubmittedPayload(record, candidate);
  payload.queriedAt = new Date().toLocaleString('zh-CN', { hour12: false });
  res.json(payload);
});

router.post('/status-overview', (req, res) => {
  if (!verifyTicketCaptcha(req, res)) return;

  const { ticket_no } = req.body;
  if (!ticket_no || !ticket_no.trim()) {
    return res.status(400).json({ error: '请输入准考证号' });
  }

  const candidate = db.prepare('SELECT * FROM candidates WHERE ticket_no = ?').findOne(ticket_no.trim());
  if (!candidate) {
    return res.status(404).json({ error: '准考证号不存在，请核对后重试' });
  }

  res.json({
    ...buildStatusOverview(candidate),
    queriedAt: new Date().toLocaleString('zh-CN', { hour12: false })
  });
});

router.post('/verify', (req, res) => {
  const { ticket_no, captchaId, captchaCode } = req.body;

  const captchaResult = verifyCaptcha(captchaId, captchaCode);
  if (!captchaResult.ok) {
    return res.status(400).json({ error: captchaResult.error });
  }

  if (!ticket_no || !ticket_no.trim()) {
    return res.status(400).json({ error: '请输入准考证号' });
  }

  const candidate = db.prepare('SELECT * FROM candidates WHERE ticket_no = ?').findOne(ticket_no.trim());
  if (!candidate) {
    return res.status(404).json({ error: '准考证号不存在，请核对后重试' });
  }

  if (candidate.status === 'submitted') {
    const record = db.prepare(`
      SELECT * FROM exam_records
      WHERE candidate_id = ? AND status = 'submitted'
      ORDER BY submitted_at DESC LIMIT 1
    `).findOne(candidate.id);
    if (!record) {
      return res.status(404).json({ error: '未找到交卷记录' });
    }
    return res.json(buildSubmittedPayload(record, candidate));
  }

  const inProgressRecord = db.prepare(`
    SELECT _id FROM exam_records WHERE candidate_id = ? AND status = 'in_progress' LIMIT 1
  `).findOne(candidate.id);

  if (!inProgressRecord && candidate.status !== 'in_progress') {
    const access = checkExamAccess();
    if (!access.ok) {
      return res.status(403).json({ error: access.error, waiting: access.waiting, openAt: access.openAt });
    }
  }

  let record = db.prepare(`
    SELECT * FROM exam_records WHERE candidate_id = ? AND status = 'in_progress'
    ORDER BY started_at DESC LIMIT 1
  `).findOne(candidate.id);

  if (!record) {
    const result = db.prepare(`
      INSERT INTO exam_records (candidate_id, ticket_no, name, status)
      VALUES (?, ?, ?, 'in_progress')
    `).run(candidate.id, candidate.ticket_no, candidate.name);

    db.prepare("UPDATE candidates SET status = 'in_progress' WHERE _id = ?").run(candidate.id);

    record = db.prepare('SELECT * FROM exam_records WHERE _id = ?').findOne(result.insertedId);
  }

  const token = jwt.sign({
    candidateId: candidate.id,
    recordId: record.id,
    ticketNo: candidate.ticket_no,
    name: candidate.name
  }, JWT_SECRET, { expiresIn: '3h' });

  const savedAnswers = parseAnswers(record.answers);
  const needsConfirm = !record.confirmed_at;

  res.json({
    token,
    candidate: formatCandidate(candidate),
    examInfo: getExamInfo(),
    record: {
      id: record.id,
      startedAt: record.started_at,
      answers: savedAnswers,
      markedQuestions: parseMarked(record.marked_questions),
      confirmed: !!record.confirmed_at
    },
    needsConfirm
  });
});

router.get('/profile', examAuth, (req, res) => {
  const candidate = db.prepare('SELECT * FROM candidates WHERE _id = ?').findOne(req.exam.candidateId);
  if (!candidate) return res.status(404).json({ error: '考生不存在' });
  res.json({ candidate: formatCandidate(candidate), examInfo: getExamInfo() });
});

router.post('/confirm', examAuth, (req, res) => {
  const record = db.prepare('SELECT * FROM exam_records WHERE _id = ?').findOne(req.exam.recordId);
  if (!record || record.status !== 'in_progress') {
    return res.status(400).json({ error: '当前无法确认开考' });
  }

  if (!record.confirmed_at) {
    const now = new Date().toLocaleString('zh-CN', { hour12: false });
    db.prepare(`
      UPDATE exam_records SET confirmed_at = ?, started_at = COALESCE(started_at, ?) WHERE _id = ?
    `).run(now, now, req.exam.recordId);
    ensureRecordDrawnQuestions(req.exam.recordId);
    ensureRecordOptionLayout(req.exam.recordId);
  }

  const updated = db.prepare('SELECT confirmed_at, started_at FROM exam_records WHERE _id = ?').findOne(req.exam.recordId);
  res.json({
    message: '已确认，可以开始考试',
    confirmedAt: updated.confirmed_at,
    startedAt: updated.started_at
  });
});

router.get('/info', examAuth, (req, res) => {
  const candidate = db.prepare('SELECT * FROM candidates WHERE _id = ?').findOne(req.exam.candidateId);
  const record = db.prepare('SELECT * FROM exam_records WHERE _id = ?').findOne(req.exam.recordId);
  if (!record || record.status !== 'in_progress') {
    return res.status(400).json({ error: '考试已结束或未开始', submitted: record?.status === 'submitted' });
  }

  const settings = getSettings();
  const extraMinutes = record.extra_minutes || 0;
  const durationSeconds = (settings.durationMinutes + extraMinutes) * 60;

  let remainingSeconds = durationSeconds;
  if (record.started_at) {
    const elapsed = Math.floor((Date.now() - new Date(record.started_at).getTime()) / 1000);
    remainingSeconds = Math.max(0, durationSeconds - elapsed);
  } else if (!record.confirmed_at) {
    remainingSeconds = durationSeconds;
  }

  if (record.confirmed_at) {
    ensureRecordDrawnQuestions(req.exam.recordId);
    ensureRecordOptionLayout(req.exam.recordId);
  }

  res.json({
    examInfo: getExamInfo(),
    practicalSection: getPracticalSection(),
    questions: record.confirmed_at ? getPublicQuestionsForRecord(req.exam.recordId) : [],
    objectiveMax: getObjectiveMaxForRecord(req.exam.recordId),
    candidate: formatCandidate(candidate),
    settings: {
      durationMinutes: settings.durationMinutes,
      durationSeconds,
      remainingSeconds,
      showAnswerReview: settings.showAnswerReview,
      proctorEnabled: settings.proctorEnabled,
      proctorScreenRequired: settings.proctorScreenRequired,
      proctorCameraRequired: settings.proctorCameraRequired
    },
    record: {
      id: record.id,
      startedAt: record.started_at,
      confirmed: !!record.confirmed_at,
      markedQuestions: parseMarked(record.marked_questions),
      focusEvents: record.focus_events || 0,
      extraMinutes: record.extra_minutes || 0
    }
  });
});

router.post('/save', examAuth, (req, res) => {
  const { answers, markedQuestions } = req.body;
  if (!answers || typeof answers !== 'object') {
    return res.status(400).json({ error: '答案格式错误' });
  }

  const marked = markedQuestions !== undefined ? markedQuestions : null;
  if (marked !== null) {
    db.prepare(`
      UPDATE exam_records SET answers = ?, marked_questions = ? WHERE _id = ? AND status = 'in_progress'
    `).run(answers, marked, req.exam.recordId);
  } else {
    db.prepare(`
      UPDATE exam_records SET answers = ? WHERE _id = ? AND status = 'in_progress'
    `).run(answers, req.exam.recordId);
  }

  res.json({ message: '保存成功' });
});

router.post('/events', examAuth, (req, res) => {
  const { type } = req.body;
  const record = db.prepare('SELECT * FROM exam_records WHERE _id = ?').findOne(req.exam.recordId);
  if (!record || record.status !== 'in_progress') {
    return res.status(400).json({ error: '考试已结束' });
  }

  db.prepare('UPDATE exam_records SET focus_events = focus_events + 1 WHERE _id = ?').run(req.exam.recordId);
  const count = db.prepare('SELECT focus_events FROM exam_records WHERE _id = ?').findOne(req.exam.recordId).focus_events;

  res.json({ ok: true, type: type || 'unknown', focusEvents: count });
});

router.post('/submit', examAuth, (req, res) => {
  const { answers, examPageScreenshot, proctorScreen, proctorCamera } = req.body;
  if (!answers || typeof answers !== 'object') {
    return res.status(400).json({ error: '答案格式错误' });
  }

  const record = db.prepare('SELECT * FROM exam_records WHERE _id = ?').findOne(req.exam.recordId);
  if (!record) {
    return res.status(400).json({ error: '考试记录不存在' });
  }
  if (record.status === 'submitted') {
    const candidate = db.prepare('SELECT * FROM candidates WHERE _id = ?').findOne(req.exam.candidateId);
    if (candidate?.status !== 'submitted') {
      db.prepare("UPDATE candidates SET status = 'submitted' WHERE _id = ?").run(req.exam.candidateId);
    }
    return res.json(buildSubmittedPayload(record, candidate));
  }

  ensureRecordDrawnQuestions(req.exam.recordId);
  const { score, maxScore, details } = calculateScoreForRecord(req.exam.recordId, answers);
  const now = new Date().toLocaleString('zh-CN', { hour12: false });
  const settings = getSettings();

  let durationSeconds = 0;
  if (record.started_at) {
    durationSeconds = Math.floor((Date.now() - new Date(record.started_at).getTime()) / 1000);
  }

  db.prepare(`
    UPDATE exam_records
    SET answers = ?, objective_score = ?, submitted_at = ?, duration_seconds = ?, status = 'submitted'
    WHERE _id = ?
  `).run(answers, score, now, durationSeconds, req.exam.recordId);

  try {
    saveExamCaptures(req.exam.recordId, { examPageScreenshot, proctorScreen, proctorCamera });
  } catch (err) {
    console.error('saveExamCaptures failed:', err.message);
  }

  db.prepare("UPDATE candidates SET status = 'submitted' WHERE _id = ?").run(req.exam.candidateId);

  const candidate = db.prepare('SELECT * FROM candidates WHERE _id = ?').findOne(req.exam.candidateId);

  const response = {
    message: '交卷成功',
    score,
    maxScore,
    details,
    submittedAt: now,
    durationSeconds,
    practicalSection: getPracticalSection(),
    candidate: formatCandidate(candidate),
    totalScoreInfo: buildTotalScoreInfo(score, req.exam.recordId),
    focusEvents: record.focus_events || 0,
    showAnswerReview: settings.showAnswerReview,
    practicalDeadline: getPracticalDeadlineInfo(settings),
    uploadEnabled: settings.practicalUploadEnabled !== false,
    practicalToken: createPracticalToken({
      candidateId: req.exam.candidateId,
      recordId: req.exam.recordId,
      ticketNo: candidate.ticket_no,
      name: candidate.name
    })
  };

  if (settings.showAnswerReview) {
    response.answerReview = buildAnswerDetailsForRecord(req.exam.recordId, answers);
  }

  res.json(response);
});

router.post('/transcript-query', (req, res) => {
  if (!verifyTicketCaptcha(req, res)) return;

  const { ticket_no } = req.body;
  if (!ticket_no || !ticket_no.trim()) {
    return res.status(400).json({ error: '请输入准考证号' });
  }

  const candidate = db.prepare('SELECT * FROM candidates WHERE ticket_no = ?').findOne(ticket_no.trim());
  if (!candidate) return res.status(404).json({ error: '准考证号不存在' });

  const record = db.prepare(`
    SELECT * FROM exam_records WHERE candidate_id = ? AND status = 'submitted'
    ORDER BY submitted_at DESC LIMIT 1
  `).findOne(candidate.id);

  if (!record) return res.status(404).json({ error: '未找到交卷记录' });

  const transcript = buildTranscript(record.id);
  if (!transcript) return res.status(404).json({ error: '成绩单不存在' });

  res.json({
    transcript,
    downloadToken: issueTranscriptDownloadToken(record.id),
    queriedAt: new Date().toLocaleString('zh-CN', { hour12: false })
  });
});

router.post('/transcript-pdf', async (req, res) => {
  let record = null;

  const tokenResult = resolveTranscriptRecordId(req);
  if (tokenResult?.error) {
    return res.status(400).json({ error: tokenResult.error });
  }
  if (tokenResult?.recordId) {
    record = db.prepare('SELECT * FROM exam_records WHERE _id = ?').findOne(tokenResult.recordId);
  } else {
    if (!verifyTicketCaptcha(req, res)) return;

    const { ticket_no } = req.body;
    if (!ticket_no || !ticket_no.trim()) {
      return res.status(400).json({ error: '请输入准考证号' });
    }

    const candidate = db.prepare('SELECT * FROM candidates WHERE ticket_no = ?').findOne(ticket_no.trim());
    if (!candidate) return res.status(404).json({ error: '准考证号不存在' });

    record = db.prepare(`
      SELECT * FROM exam_records WHERE candidate_id = ? AND status = 'submitted'
      ORDER BY submitted_at DESC LIMIT 1
    `).findOne(candidate.id);
  }

  if (!record) return res.status(404).json({ error: '未找到交卷记录' });

  const transcript = buildTranscript(record.id);
  if (!transcript) return res.status(404).json({ error: '成绩单不存在' });
  if (!transcript.canPrint) {
    return res.status(400).json({ error: transcript.printBlockedReason || '暂不可导出成绩单' });
  }

  try {
    const { buildTranscriptPdfBuffer } = require('../utils/transcriptPdf');
    const buf = await buildTranscriptPdfBuffer(transcript);
    const filename = encodeURIComponent(`${transcript.name || '考生'}_成绩单.pdf`);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${filename}`);
    res.send(buf);
  } catch (err) {
    res.status(500).json({ error: err.message || 'PDF 生成失败' });
  }
});

router.get('/status', examAuth, (req, res) => {
  const record = db.prepare('SELECT * FROM exam_records WHERE _id = ?').findOne(req.exam.recordId);
  if (!record) return res.status(404).json({ error: '考试记录不存在' });

  res.json({
    status: record.status,
    startedAt: record.started_at,
    submittedAt: record.submitted_at,
    score: record.objective_score,
    answers: parseAnswers(record.answers),
    markedQuestions: parseMarked(record.marked_questions),
    focusEvents: record.focus_events || 0,
    confirmed: !!record.confirmed_at
  });
});

module.exports = router;
