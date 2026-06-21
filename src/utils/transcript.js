const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db');
const { formatCandidate } = require('./candidate');
const { getExamInfo, getObjectiveMaxForRecord, PRACTICAL_MAX, getPositionAdjustmentText } = require('./questionBank');
const { getSubmissionByRecordId, buildPracticalScoreInfo } = require('./practical');

const TRANSCRIPT_ROOT = path.join(__dirname, '..', '..', 'uploads', 'transcripts');

function initTranscriptStorage() {
  if (!fs.existsSync(TRANSCRIPT_ROOT)) {
    fs.mkdirSync(TRANSCRIPT_ROOT, { recursive: true });
  }
  // MongoDB是schemaless，不需要ALTER TABLE迁移
}

initTranscriptStorage();

function parseJson(str, fallback) {
  if (!str) return fallback;
  if (typeof str === 'object') return str;
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

function recordDir(recordId) {
  const dir = path.join(TRANSCRIPT_ROOT, String(recordId));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function saveDataUrlImage(recordId, filename, dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
    return null;
  }
  const match = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
  if (!match) return null;
  const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
  const buf = Buffer.from(match[2], 'base64');
  if (buf.length > 8 * 1024 * 1024) return null;

  const safeName = filename.replace(/[^\w.-]/g, '_');
  recordDir(recordId);
  const rel = path.join(String(recordId), `${safeName}.${ext}`);
  const full = path.join(TRANSCRIPT_ROOT, rel);
  fs.writeFileSync(full, buf);
  return rel.replace(/\\/g, '/');
}

function publicUrl(relativePath) {
  if (!relativePath) return null;
  return `/uploads/transcripts/${relativePath.replace(/\\/g, '/')}`;
}

function buildVerificationCode(recordId, ticketNo, submittedAt) {
  return crypto
    .createHash('sha256')
    .update(`${recordId}|${ticketNo}|${submittedAt || ''}|tmxk-transcript`)
    .digest('hex')
    .slice(0, 8)
    .toUpperCase();
}

function formatDocDate(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

function generateTranscriptNo(recordId, issuedAt) {
  const seq = String(recordId).padStart(6, '0');
  const datePart = formatDocDate(issuedAt ? new Date(issuedAt) : new Date());
  return `TMXK-CJD-${datePart}-${seq}`;
}

function generateArchiveNo(recordId, issuedAt) {
  const seq = String(recordId).padStart(6, '0');
  const year = (issuedAt ? new Date(issuedAt) : new Date()).getFullYear();
  return `TMXK-DA-${year}-${seq}`;
}

function listArchiveItems(row, proctorCaptures) {
  const items = ['考生基本信息', '客观题成绩记录', '实操题成绩记录'];
  if (row.signature_path) items.push('考后手写签字');
  if (row.exam_page_screenshot) items.push('考试页面截图');
  if (proctorCaptures.length) items.push(`考试过程影像（${proctorCaptures.length} 项）`);
  if (row.closure_completed_at) items.push('岗位调剂确认记录');
  return items;
}

async function ensureTranscriptDocument(recordId, row, canPrint) {
  if (!canPrint) {
    return {
      transcriptNo: '',
      archiveNo: '',
      verificationCode: buildVerificationCode(recordId, row.ticket_no, row.submitted_at),
      transcriptIssuedAt: '',
      archivePath: `/uploads/transcripts/${recordId}/`,
      archiveCategory: '考试成绩单及考试过程电子档案',
      archiveItems: listArchiveItems(row, parseJson(row.proctor_captures, [])),
      archiveRetention: '长期保存（不少于10年）',
      watermarkText: '天马行空创意团队 · 正式成绩单'
    };
  }

  let transcriptNo = row.transcript_no;
  let transcriptIssuedAt = row.transcript_issued_at;

  if (!transcriptNo) {
    const issuedAt = new Date().toLocaleString('zh-CN', { hour12: false });
    transcriptNo = generateTranscriptNo(recordId, issuedAt);
    transcriptIssuedAt = issuedAt;
    await db.prepare(`
      UPDATE exam_records SET transcript_no = ?, transcript_issued_at = ? WHERE id = ?
    `).run(transcriptNo, transcriptIssuedAt, recordId);
  }

  const verificationCode = buildVerificationCode(recordId, row.ticket_no, row.submitted_at);
  const archiveNo = generateArchiveNo(recordId, transcriptIssuedAt);
  const proctorCaptures = parseJson(row.proctor_captures, []);

  return {
    transcriptNo,
    archiveNo,
    verificationCode,
    transcriptIssuedAt,
    archivePath: `/uploads/transcripts/${recordId}/`,
    archiveCategory: '考试成绩单及考试过程电子档案',
    archiveItems: listArchiveItems(row, proctorCaptures),
    archiveRetention: '长期保存（不少于10年）',
    watermarkText: `天马行空创意团队 · ${transcriptNo}`
  };
}

async function saveExamCaptures(recordId, { examPageScreenshot, proctorScreen, proctorCamera, proctorPhotos } = {}) {
  const updates = {};
  if (examPageScreenshot) {
    const p = saveDataUrlImage(recordId, 'exam_page', examPageScreenshot);
    if (p) updates.exam_page_screenshot = p;
  }

  const captures = [];
  const screenPath = proctorScreen ? saveDataUrlImage(recordId, 'proctor_screen', proctorScreen) : null;
  if (screenPath) captures.push({ type: 'screen', label: '考试屏幕截图', path: screenPath });

  const cameraPath = proctorCamera ? saveDataUrlImage(recordId, 'proctor_camera', proctorCamera) : null;
  if (cameraPath) captures.push({ type: 'camera', label: '考试过程拍摄', path: cameraPath });

  if (Array.isArray(proctorPhotos)) {
    proctorPhotos.forEach((photo, idx) => {
      const p = saveDataUrlImage(recordId, `proctor_${idx + 1}`, photo);
      if (p) captures.push({ type: 'camera', label: `考试过程拍摄 ${idx + 1}`, path: p });
    });
  }

  if (captures.length) {
    const existingRecord = await db.prepare('SELECT proctor_captures FROM exam_records WHERE id = ?').get(recordId);
    const existing = parseJson(existingRecord?.proctor_captures, []);
    const merged = [...existing];
    for (const c of captures) {
      if (!merged.some((m) => m.path === c.path)) merged.push(c);
    }
    updates.proctor_captures = JSON.stringify(merged.slice(-8));
  }

  if (Object.keys(updates).length) {
    const sets = Object.keys(updates).map((k) => `${k} = ?`).join(', ');
    await db.prepare(`UPDATE exam_records SET ${sets} WHERE id = ?`).run(...Object.values(updates), recordId);
  }

  return updates;
}

async function submitClosure(recordId, { signature, adjustedPosition, positionNote, agree }) {
  const record = await db.prepare(`
    SELECT er.*, c.position as candidate_position
    FROM exam_records er
    JOIN candidates c ON c.id = er.candidate_id
    WHERE er.id = ? AND er.status = 'submitted'
  `).get(recordId);

  if (!record) return { error: '未找到交卷记录' };
  if (!agree) return { error: '请先阅读并确认岗位调剂书' };
  if (!signature) return { error: '请完成手写签字' };

  const sigPath = saveDataUrlImage(recordId, 'signature', signature);
  if (!sigPath) return { error: '签字图片无效，请重新签字' };

  const now = new Date().toLocaleString('zh-CN', { hour12: false });
  const adjPos = String(adjustedPosition || record.candidate_position || '').trim();

  await db.prepare(`
    UPDATE exam_records SET
      signature_path = ?,
      adjusted_position = ?,
      position_adjustment_note = ?,
      position_confirmed_at = ?,
      closure_completed_at = ?
    WHERE id = ?
  `).run(sigPath, adjPos, String(positionNote || '').trim(), now, now, recordId);

  return { message: '考后确认已提交，请等待阅卷评分完成后打印成绩单', closureCompletedAt: now };
}

async function getClosureStatus(recordId) {
  const record = await db.prepare('SELECT * FROM exam_records WHERE id = ?').get(recordId);
  if (!record || record.status !== 'submitted') {
    return { ready: false, error: '尚未完成客观题交卷' };
  }

  const submission = await getSubmissionByRecordId(recordId);
  const practicalInfo = await buildPracticalScoreInfo(submission);
  const practicalSubmitted = submission && ['submitted', 'scored'].includes(submission.status);

  return {
    ready: true,
    closureCompleted: !!record.closure_completed_at,
    closureCompletedAt: record.closure_completed_at,
    positionConfirmedAt: record.position_confirmed_at,
    practicalSubmitted,
    practicalScored: practicalInfo.practicalScored,
    canPrint: !!record.closure_completed_at && practicalInfo.practicalScored,
    positionAdjustmentText: getPositionAdjustmentText()
  };
}

async function buildTranscript(recordId) {
  const row = await db.prepare(`
    SELECT er.*, c.*
    FROM exam_records er
    JOIN candidates c ON c.id = er.candidate_id
    WHERE er.id = ?
  `).get(recordId);

  if (!row) return null;

  const examInfo = await getExamInfo();
  const submission = await getSubmissionByRecordId(recordId);
  const practicalInfo = await buildPracticalScoreInfo(submission);
  const objectiveMax = await getObjectiveMaxForRecord(recordId);
  const proctorCaptures = parseJson(row.proctor_captures, []).map((c) => ({
    ...c,
    url: publicUrl(c.path)
  }));

  const totalScore = practicalInfo.practicalScored
    ? (row.objective_score ?? 0) + (practicalInfo.practicalScore ?? 0)
    : null;

  const canPrint = !!row.closure_completed_at && practicalInfo.practicalScored;
  const documentInfo = await ensureTranscriptDocument(recordId, row, canPrint);

  return {
    recordId: row.id,
    title: `${row.name}考试成绩单`,
    examName: examInfo.title,
    examSubtitle: examInfo.subtitle,
    name: row.name,
    ticketNo: row.ticket_no,
    idNumber: row.id_number || '',
    position: row.position || '',
    adjustedPosition: row.adjusted_position || row.position || '',
    positionNote: row.position_adjustment_note || '',
    examTime: row.exam_time || '',
    examSite: row.exam_site || '',
    examRoom: row.exam_room || '',
    seatNo: row.seat_no || '',
    avatarUrl: row.avatar ? `/uploads/avatars/${row.avatar}` : null,
    startedAt: row.started_at,
    submittedAt: row.submitted_at,
    durationSeconds: row.duration_seconds,
    objectiveScore: row.objective_score,
    objectiveMax,
    task1Score: practicalInfo.task1Score,
    task2Score: practicalInfo.task2Score,
    practicalScore: practicalInfo.practicalScore,
    practicalMax: PRACTICAL_MAX,
    practicalScored: practicalInfo.practicalScored,
    practicalComment: practicalInfo.practicalComment || '',
    totalScore,
    totalMax: objectiveMax + PRACTICAL_MAX,
    signatureUrl: publicUrl(row.signature_path),
    examPageScreenshotUrl: publicUrl(row.exam_page_screenshot),
    proctorCaptures,
    closureCompletedAt: row.closure_completed_at,
    positionConfirmedAt: row.position_confirmed_at,
    practicalFinalizedAt: submission?.finalized_at || '',
    scoredAt: submission?.scored_at || '',
    canPrint,
    printBlockedReason: !row.closure_completed_at
      ? '请先完成考后签字与岗位调剂确认'
      : (!practicalInfo.practicalScored ? '实操题尚未评分，请等待管理员阅卷' : null),
    ...documentInfo
  };
}

async function listTranscripts({ q = '', status = 'all' } = {}) {
  const rows = await db.prepare(`
    SELECT er.id as record_id, er.ticket_no, er.name, er.submitted_at, er.objective_score,
           er.closure_completed_at, er.signature_path,
           c.position, c.exam_time, c.avatar,
           ps.status as practical_status, ps.practical_score, ps.scored_at, ps.finalized_at
    FROM exam_records er
    JOIN candidates c ON c.id = er.candidate_id
    LEFT JOIN practical_submissions ps ON ps.record_id = er.id
    WHERE er.status = 'submitted'
    ORDER BY er.submitted_at DESC
  `).all();

  const results = [];
  for (const row of rows) {
    if (q && q.trim()) {
      const like = q.trim().toLowerCase();
      if (!row.ticket_no.toLowerCase().includes(like) && !row.name.toLowerCase().includes(like)) {
        continue;
      }
    }
    
    const closureDone = !!row.closure_completed_at;
    const scored = row.practical_status === 'scored';
    
    if (status === 'pending_closure' && !closureDone) {
      results.push(row);
    } else if (status === 'pending_score' && closureDone && !scored) {
      results.push(row);
    } else if (status === 'ready' && closureDone && scored) {
      results.push(row);
    } else if (status === 'all') {
      results.push(row);
    }
  }

  const transcripts = [];
  for (const row of results) {
    const t = await buildTranscript(row.record_id);
    transcripts.push({
      recordId: row.record_id,
      ticketNo: row.ticket_no,
      name: row.name,
      position: row.position,
      submittedAt: row.submitted_at,
      closureCompleted: !!row.closure_completed_at,
      practicalStatus: row.practical_status || 'none',
      practicalScored: row.practical_status === 'scored',
      objectiveScore: row.objective_score,
      practicalScore: row.practical_score,
      totalScore: t?.totalScore,
      canPrint: t?.canPrint,
      transcriptNo: t?.transcriptNo || '',
      avatarUrl: row.avatar ? `/uploads/avatars/${row.avatar}` : null
    });
  }
  
  return transcripts;
}

module.exports = {
  saveExamCaptures,
  submitClosure,
  getClosureStatus,
  buildTranscript,
  listTranscripts,
  publicUrl
};
