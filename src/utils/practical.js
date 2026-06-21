const fs = require('fs');
const path = require('path');
const db = require('../db');

const PRACTICAL_ROOT = path.join(__dirname, '..', '..', 'uploads', 'practical');

const FOLDER_MAP = {
  1: { key: 'ai_materials', labelSuffix: 'AI素材专用文件夹', maxScore: 30 },
  2: { key: 'poster_works', labelSuffix: '海报作品归档文件夹', maxScore: 30 }
};

const ALLOWED_EXT = new Set(['.jpg', '.jpeg', '.png', '.psd', '.zip', '.gif', '.webp', '.pdf']);

async function initPracticalStorage() {
  if (!fs.existsSync(PRACTICAL_ROOT)) {
    fs.mkdirSync(PRACTICAL_ROOT, { recursive: true });
  }

  await db.exec(`
    CREATE TABLE IF NOT EXISTS practical_submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      record_id INTEGER UNIQUE NOT NULL,
      candidate_id INTEGER NOT NULL,
      ticket_no TEXT NOT NULL,
      name TEXT NOT NULL,
      task1_score REAL,
      task2_score REAL,
      practical_score REAL,
      comment TEXT DEFAULT '',
      status TEXT DEFAULT 'open',
      finalized_at TEXT,
      scored_at TEXT,
      scored_by TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS practical_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      submission_id INTEGER NOT NULL,
      task_id INTEGER NOT NULL,
      folder_key TEXT NOT NULL,
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      file_size INTEGER DEFAULT 0,
      mime_type TEXT DEFAULT '',
      uploaded_at TEXT DEFAULT (datetime('now', 'localtime'))
    )
  `);

  await db.exec('CREATE INDEX IF NOT EXISTS idx_practical_submissions_candidate ON practical_submissions(candidate_id)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_practical_files_submission ON practical_files(submission_id)');
}

initPracticalStorage();

function sanitizeFilename(name) {
  const base = path.basename(String(name || 'file'));
  return base.replace(/[^\w.\-()\u4e00-\u9fff]/g, '_').slice(0, 180) || 'file';
}

function isAllowedFile(filename) {
  const ext = path.extname(filename).toLowerCase();
  return ALLOWED_EXT.has(ext);
}

function getFolderInfo(taskId) {
  return FOLDER_MAP[taskId] || null;
}

function getFolderByKey(folderKey) {
  return Object.entries(FOLDER_MAP).find(([, v]) => v.key === folderKey) || null;
}

function getCandidateFolderPath(ticketNo, folderKey) {
  return path.join(PRACTICAL_ROOT, ticketNo, folderKey);
}

async function getOrCreateSubmission(recordId) {
  let sub = await db.prepare('SELECT * FROM practical_submissions WHERE record_id = ?').get(recordId);
  if (sub) return sub;

  const record = await db.prepare(`
    SELECT er.*, c.ticket_no, c.name, c.id as candidate_id
    FROM exam_records er
    JOIN candidates c ON c.id = er.candidate_id
    WHERE er.id = ? AND er.status = 'submitted'
  `).get(recordId);

  if (!record) return null;

  const result = await db.prepare(`
    INSERT INTO practical_submissions (record_id, candidate_id, ticket_no, name)
    VALUES (?, ?, ?, ?)
  `).run(record.id, record.candidate_id, record.ticket_no, record.name);

  return db.prepare('SELECT * FROM practical_submissions WHERE id = ?').get(result.lastInsertRowid);
}

async function getSubmissionByRecordId(recordId) {
  return db.prepare('SELECT * FROM practical_submissions WHERE record_id = ?').get(recordId);
}

async function getSubmissionFiles(submissionId) {
  return db.prepare(`
    SELECT * FROM practical_files WHERE submission_id = ? ORDER BY uploaded_at DESC
  `).all(submissionId);
}

function formatFileRow(file) {
  return {
    id: file.id,
    taskId: file.task_id,
    folderKey: file.folder_key,
    originalName: file.original_name,
    fileSize: file.file_size,
    mimeType: file.mime_type,
    uploadedAt: file.uploaded_at,
    url: `/uploads/practical/${file.relative_path.replace(/\\/g, '/')}`
  };
}

async function formatSubmissionRow(sub, files = []) {
  const ticketNo = sub.ticket_no;
  const folders = Object.entries(FOLDER_MAP).map(([taskId, info]) => ({
    taskId: Number(taskId),
    folderKey: info.key,
    folderName: `【${ticketNo}-${info.labelSuffix}】`,
    maxScore: info.maxScore,
    files: files.filter((f) => f.task_id === Number(taskId)).map(formatFileRow)
  }));

  return {
    id: sub.id,
    recordId: sub.record_id,
    candidateId: sub.candidate_id,
    ticketNo: sub.ticket_no,
    name: sub.name,
    status: sub.status,
    task1Score: sub.task1_score,
    task2Score: sub.task2_score,
    practicalScore: sub.practical_score,
    comment: sub.comment || '',
    finalizedAt: sub.finalized_at,
    scoredAt: sub.scored_at,
    scoredBy: sub.scored_by,
    folders,
    fileCount: files.length
  };
}

async function buildPracticalScoreInfo(submission) {
  const task1Max = FOLDER_MAP[1].maxScore;
  const task2Max = FOLDER_MAP[2].maxScore;

  if (!submission) {
    return {
      task1Score: null,
      task2Score: null,
      task1Max,
      task2Max,
      practicalScore: null,
      practicalScored: false,
      practicalStatus: 'none',
      practicalComment: ''
    };
  }

  const scored = submission.status === 'scored'
    || (submission.practical_score !== null && submission.practical_score !== undefined);

  const files = await getSubmissionFiles(submission.id);

  return {
    task1Score: submission.task1_score,
    task2Score: submission.task2_score,
    task1Max,
    task2Max,
    practicalScore: submission.practical_score,
    practicalScored: scored,
    practicalStatus: submission.status,
    practicalComment: submission.comment || '',
    fileCount: files.length
  };
}

function checkPracticalUploadAccess(settings) {
  if (settings.practicalUploadEnabled === false) {
    return { ok: false, error: '实操归档上传暂未开放，请稍后再试' };
  }

  if (settings.practicalDeadline) {
    const normalized = settings.practicalDeadline.includes('T')
      ? settings.practicalDeadline
      : settings.practicalDeadline.replace(' ', 'T');
    const deadline = new Date(normalized);
    if (!Number.isNaN(deadline.getTime()) && Date.now() > deadline.getTime()) {
      return { ok: false, error: '实操归档上传已截止' };
    }
  }

  return { ok: true };
}

function deleteFileFromDisk(relativePath) {
  const full = path.join(PRACTICAL_ROOT, relativePath);
  if (fs.existsSync(full)) {
    fs.unlinkSync(full);
  }
}

function removePracticalFolder(ticketNo) {
  const folder = path.join(PRACTICAL_ROOT, ticketNo);
  if (fs.existsSync(folder)) {
    fs.rmSync(folder, { recursive: true, force: true });
  }
}

async function syncCandidateStatus(candidateId) {
  const submitted = await db.prepare(`
    SELECT COUNT(*) as c FROM exam_records WHERE candidate_id = ? AND status = 'submitted'
  `).get(candidateId);

  if (submitted && submitted.c > 0) {
    await db.prepare("UPDATE candidates SET status = 'submitted' WHERE id = ?").run(candidateId);
    return;
  }
  
  const inProgress = await db.prepare(`
    SELECT COUNT(*) as c FROM exam_records WHERE candidate_id = ? AND status = 'in_progress'
  `).get(candidateId);

  if (inProgress && inProgress.c > 0) {
    await db.prepare("UPDATE candidates SET status = 'in_progress' WHERE id = ?").run(candidateId);
    return;
  }
  
  await db.prepare("UPDATE candidates SET status = 'pending' WHERE id = ?").run(candidateId);
}

async function deletePracticalSubmissionById(submissionId) {
  const sub = await db.prepare('SELECT * FROM practical_submissions WHERE id = ?').get(submissionId);
  if (!sub) return null;

  const files = await getSubmissionFiles(sub.id);
  for (const file of files) {
    deleteFileFromDisk(file.relative_path);
  }
  
  await db.prepare('DELETE FROM practical_files WHERE submission_id = ?').run(sub.id);
  await db.prepare('DELETE FROM practical_submissions WHERE id = ?').run(sub.id);
  
  removePracticalFolder(sub.ticket_no);
  return sub;
}

async function deleteExamRecordById(recordId) {
  const record = await db.prepare('SELECT * FROM exam_records WHERE id = ?').get(recordId);
  if (!record) return null;

  const submission = await db.prepare('SELECT id FROM practical_submissions WHERE record_id = ?').get(recordId);
  if (submission) {
    await deletePracticalSubmissionById(submission.id);
  }

  await db.prepare('DELETE FROM proctor_events WHERE record_id = ?').run(recordId);
  await db.prepare('DELETE FROM exam_records WHERE id = ?').run(recordId);
  
  await syncCandidateStatus(record.candidate_id);
  return record;
}

async function clearExamRecordsForCandidates(candidateIds) {
  const ids = (Array.isArray(candidateIds) ? candidateIds : [candidateIds])
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0);

  if (ids.length === 0) return { records: 0, submissions: 0 };

  // MongoDB使用 $in 操作符
  const records = await db.prepare(`
    SELECT id, ticket_no FROM exam_records WHERE candidate_id IN (${ids.map(() => '?').join(',')})
  `).all(...ids);

  if (records.length === 0) {
    return { records: 0, submissions: 0 };
  }

  const recordIds = records.map((r) => r.id);
  const recordPlaceholders = recordIds.map(() => '?').join(',');

  const submissions = await db.prepare(`
    SELECT id, ticket_no FROM practical_submissions WHERE record_id IN (${recordPlaceholders})
  `).all(...recordIds);

  const submissionIds = submissions.map((s) => s.id);
  if (submissionIds.length > 0) {
    const subPlaceholders = submissionIds.map(() => '?').join(',');
    await db.prepare(`DELETE FROM practical_files WHERE submission_id IN (${subPlaceholders})`).run(...submissionIds);
    await db.prepare(`DELETE FROM practical_submissions WHERE id IN (${subPlaceholders})`).run(...submissionIds);
  }

  const ticketNos = [...new Set([
    ...records.map((r) => r.ticket_no),
    ...submissions.map((s) => s.ticket_no)
  ].filter(Boolean))];

  await db.prepare(`DELETE FROM exam_records WHERE id IN (${recordPlaceholders})`).run(...recordIds);
  await db.prepare(`DELETE FROM proctor_events WHERE record_id IN (${recordPlaceholders})`).run(...recordIds);

  for (const ticketNo of ticketNos) {
    removePracticalFolder(ticketNo);
  }

  return { records: records.length, submissions: submissions.length };
}

async function clearAllExamRecords() {
  const tickets = await db.prepare(`
    SELECT DISTINCT ticket_no FROM practical_submissions WHERE ticket_no != ''
  `).all();

  const ticketNos = tickets.map((r) => r.ticket_no);

  await db.prepare('DELETE FROM practical_files').run();
  await db.prepare('DELETE FROM practical_submissions').run();
  await db.prepare('DELETE FROM exam_records').run();

  for (const ticketNo of ticketNos) {
    removePracticalFolder(ticketNo);
  }

  if (fs.existsSync(PRACTICAL_ROOT)) {
    for (const entry of fs.readdirSync(PRACTICAL_ROOT)) {
      const full = path.join(PRACTICAL_ROOT, entry);
      if (fs.statSync(full).isDirectory()) {
        fs.rmSync(full, { recursive: true, force: true });
      }
    }
  }
}

module.exports = {
  PRACTICAL_ROOT,
  FOLDER_MAP,
  ALLOWED_EXT,
  sanitizeFilename,
  isAllowedFile,
  getFolderInfo,
  getFolderByKey,
  getCandidateFolderPath,
  getOrCreateSubmission,
  getSubmissionByRecordId,
  getSubmissionFiles,
  formatFileRow,
  formatSubmissionRow,
  buildPracticalScoreInfo,
  checkPracticalUploadAccess,
  deleteFileFromDisk,
  clearExamRecordsForCandidates,
  clearAllExamRecords,
  deleteExamRecordById,
  deletePracticalSubmissionById,
  syncCandidateStatus
};
