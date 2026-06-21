const db = require('../db');
const {
  PRACTICAL_TASK1_MAX,
  PRACTICAL_TASK2_MAX
} = require('../utils/questionBank');
const {
  getSubmissionFiles,
  formatSubmissionRow
} = require('./practical');

function parseScore(value, max, label) {
  if (value === '' || value === null || value === undefined) return 0;
  const n = Number(value);
  if (Number.isNaN(n) || n < 0 || n > max) {
    const err = new Error(`${label}须在 0～${max} 分之间`);
    err.code = 'INVALID_SCORE';
    throw err;
  }
  return n;
}

async function scoreSubmission(submissionId, { task1Score, task2Score, comment }, scoredBy) {
  const sub = await db.prepare('SELECT * FROM practical_submissions WHERE id = ?').get(submissionId);
  if (!sub) return null;

  const t1 = parseScore(task1Score, PRACTICAL_TASK1_MAX, '第1题得分');
  const t2 = parseScore(task2Score, PRACTICAL_TASK2_MAX, '第2题得分');
  const practicalScore = t1 + t2;
  const now = new Date().toLocaleString('zh-CN', { hour12: false });

  await db.prepare(`
    UPDATE practical_submissions
    SET task1_score = ?, task2_score = ?, practical_score = ?,
        comment = ?, status = 'scored', scored_at = ?, scored_by = ?
    WHERE id = ?
  `).run(t1, t2, practicalScore, comment || '', now, scoredBy || 'admin', sub.id);

  return db.prepare('SELECT * FROM practical_submissions WHERE id = ?').get(sub.id);
}

async function batchScoreSubmissions(ids, payload, scoredBy) {
  const list = [...new Set((ids || []).map(Number).filter((id) => id > 0))];
  if (list.length === 0) return { error: '请选择至少一条实操记录', scored: 0, failed: [] };

  const scored = [];
  const failed = [];

  for (const id of list) {
    try {
      const sub = await db.prepare('SELECT id, ticket_no, name, status FROM practical_submissions WHERE id = ?').get(id);
      if (!sub) {
        failed.push({ id, error: '记录不存在' });
        continue;
      }
      if (sub.status !== 'submitted' && sub.status !== 'scored') {
        failed.push({ id, ticketNo: sub.ticket_no, name: sub.name, error: '仅待评分或已评分记录可批量打分' });
        continue;
      }
      await scoreSubmission(id, payload, scoredBy);
      scored.push({ id, ticketNo: sub.ticket_no, name: sub.name });
    } catch (err) {
      failed.push({ id, error: err.message });
    }
  }

  return {
    scored: scored.length,
    failed,
    message: failed.length
      ? `成功评分 ${scored.length} 人，${failed.length} 人失败`
      : `已成功为 ${scored.length} 名考生保存实操评分`
  };
}

async function reopenPracticalSubmission(submissionId, { clearScores = true } = {}) {
  const sub = await db.prepare('SELECT * FROM practical_submissions WHERE id = ?').get(submissionId);
  if (!sub) return null;

  const files = await getSubmissionFiles(sub.id);
  const nextStatus = files.length > 0 ? 'uploading' : 'open';

  if (clearScores) {
    await db.prepare(`
      UPDATE practical_submissions
      SET status = ?, finalized_at = NULL,
          task1_score = NULL, task2_score = NULL, practical_score = NULL,
          comment = '', scored_at = NULL, scored_by = ''
      WHERE id = ?
    `).run(nextStatus, sub.id);
  } else {
    await db.prepare(`
      UPDATE practical_submissions
      SET status = ?, finalized_at = NULL
      WHERE id = ?
    `).run(nextStatus, sub.id);
  }

  const updated = await db.prepare('SELECT * FROM practical_submissions WHERE id = ?').get(sub.id);
  return formatSubmissionRow(updated, files);
}

module.exports = {
  scoreSubmission,
  batchScoreSubmissions,
  reopenPracticalSubmission
};
