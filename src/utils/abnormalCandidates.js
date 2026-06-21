const db = require('../db');
const { getSettings } = require('./settings');
const { clearExamRecordsForCandidates } = require('./practical');
const { reopenPracticalSubmission } = require('./practicalAdmin');

const FOCUS_THRESHOLD = 3;

async function queryAbnormalCandidates({ type = 'all', q = '' } = {}) {
  const settings = await getSettings();
  const durationMs = settings.durationMinutes * 60 * 1000;

  // 获取所有考生
  let candidateQuery = 'SELECT * FROM candidates WHERE 1=1';
  const params = [];

  if (q && q.trim()) {
    candidateQuery += ' AND (ticket_no LIKE ? OR name LIKE ?)';
    const like = `%${q.trim()}%`;
    params.push(like, like);
  }

  const candidates = await db.prepare(candidateQuery).all(...params);

  const now = Date.now();
  const results = [];

  for (const c of candidates) {
    // 获取该考生的最新考试记录
    const record = await db.prepare(`
      SELECT * FROM exam_records WHERE candidate_id = ? ORDER BY id DESC LIMIT 1
    `).get(c.id);

    // 获取实操提交
    let submission = null;
    if (record) {
      submission = await db.prepare(`
        SELECT * FROM practical_submissions WHERE record_id = ?
      `).get(record.id);
    }

    // 获取告警和警告计数
    let alertCount = 0;
    let warningCount = 0;
    if (record) {
      const alertResult = await db.prepare(`
        SELECT COUNT(*) as c FROM proctor_events WHERE record_id = ? AND level = 'alert'
      `).get(record.id);
      alertCount = alertResult?.c || 0;

      const warningResult = await db.prepare(`
        SELECT COUNT(*) as c FROM proctor_events WHERE record_id = ? AND level = 'warning'
      `).get(record.id);
      warningCount = warningResult?.c || 0;
    }

    const reasons = [];

    if (c.abnormal_flag === 1) {
      reasons.push({ code: 'marked', label: '已标记异常' });
    }
    if (record && record.focus_events >= FOCUS_THRESHOLD) {
      reasons.push({ code: 'focus_high', label: `切屏 ${record.focus_events} 次` });
    }
    if (alertCount > 0) {
      reasons.push({ code: 'proctor_alert', label: `监考告警 ${alertCount} 次` });
    }
    if (warningCount >= 5) {
      reasons.push({ code: 'proctor_warning', label: `监考注意 ${warningCount} 次` });
    }

    if (record) {
      if (record.status === 'in_progress' && record.started_at) {
        const extraMs = (record.extra_minutes || 0) * 60 * 1000;
        const started = new Date(record.started_at.replace(' ', 'T')).getTime();
        if (!Number.isNaN(started) && now > started + durationMs + extraMs) {
          reasons.push({ code: 'overtime', label: '考试已超时未交卷' });
        }
      }

      if (record.status === 'submitted') {
        if (!submission || ['open', 'uploading'].includes(submission.status)) {
          reasons.push({ code: 'practical_missing', label: '已交卷但未提交实操' });
        } else if (submission.status === 'submitted') {
          reasons.push({ code: 'practical_pending', label: '实操待评分' });
        }
      }
    }

    if (reasons.length === 0) continue;

    if (type === 'marked' && !reasons.some((r) => r.code === 'marked')) continue;
    if (type === 'focus' && !reasons.some((r) => r.code === 'focus_high')) continue;
    if (type === 'proctor' && !reasons.some((r) => r.code.startsWith('proctor'))) continue;
    if (type === 'overtime' && !reasons.some((r) => r.code === 'overtime')) continue;
    if (type === 'practical' && !reasons.some((r) => r.code.startsWith('practical'))) continue;

    results.push({
      candidateId: c.id,
      ticketNo: c.ticket_no,
      name: c.name,
      position: c.position || '',
      examSite: c.exam_site || '',
      examRoom: c.exam_room || '',
      candidateStatus: c.status,
      recordId: record?.id || null,
      recordStatus: record?.status || null,
      objectiveScore: record?.objective_score,
      startedAt: record?.started_at,
      submittedAt: record?.submitted_at,
      focusEvents: record?.focus_events || 0,
      extraMinutes: record?.extra_minutes || 0,
      adminNote: record?.admin_note || '',
      abnormalFlag: c.abnormal_flag === 1,
      abnormalNote: c.abnormal_note || '',
      submissionId: submission?.id,
      practicalStatus: submission?.status || 'none',
      practicalScore: submission?.practical_score,
      alertCount,
      warningCount,
      reasons
    });
  }

  return results.sort((a, b) => {
    const aMarked = a.abnormalFlag ? 1 : 0;
    const bMarked = b.abnormalFlag ? 1 : 0;
    if (bMarked !== aMarked) return bMarked - aMarked;
    return (b.focusEvents || 0) - (a.focusEvents || 0);
  });
}

async function applyAbnormalAction(action, { candidateIds, recordIds, submissionIds, note, extraMinutes }) {
  const ids = (candidateIds || []).map(Number).filter((id) => id > 0);
  const recIds = (recordIds || []).map(Number).filter((id) => id > 0);
  const subIds = (submissionIds || []).map(Number).filter((id) => id > 0);

  if (action === 'mark') {
    if (ids.length === 0) return { error: '请选择考生' };
    for (const id of ids) {
      await db.prepare(`
        UPDATE candidates SET abnormal_flag = 1, abnormal_note = ? WHERE id = ?
      `).run(note || '管理员标记为异常', id);
    }
    return { affected: ids.length, message: `已标记 ${ids.length} 名异常考生` };
  }

  if (action === 'clear_mark') {
    if (ids.length === 0) return { error: '请选择考生' };
    const placeholders = ids.map(() => '?').join(',');
    await db.prepare(`
      UPDATE candidates SET abnormal_flag = 0, abnormal_note = '' WHERE id IN (${placeholders})
    `).run(...ids);
    return { affected: ids.length, message: `已清除 ${ids.length} 名考生的异常标记` };
  }

  if (action === 'extend_time') {
    const mins = Math.max(1, parseInt(extraMinutes, 10) || 15);
    if (recIds.length === 0) return { error: '请选择有考试记录的考生' };
    let count = 0;
    for (const rid of recIds) {
      const r = await db.prepare(`
        UPDATE exam_records SET extra_minutes = COALESCE(extra_minutes, 0) + ? WHERE id = ? AND status = 'in_progress'
      `).run(mins, rid);
      count += r.changes;
    }
    return { affected: count, message: `已为 ${count} 场考试延长 ${mins} 分钟` };
  }

  if (action === 'set_note') {
    if (recIds.length === 0) return { error: '请选择考试记录' };
    for (const rid of recIds) {
      await db.prepare('UPDATE exam_records SET admin_note = ? WHERE id = ?').run(note || '', rid);
    }
    return { affected: recIds.length, message: '备注已保存' };
  }

  if (action === 'reset_exam') {
    if (ids.length === 0) return { error: '请选择考生' };
    await clearExamRecordsForCandidates(ids);
    const placeholders = ids.map(() => '?').join(',');
    await db.prepare(`
      UPDATE candidates SET status = 'pending', abnormal_flag = 0, abnormal_note = '' WHERE id IN (${placeholders})
    `).run(...ids);
    return { affected: ids.length, message: `已重置 ${ids.length} 名考生的考试` };
  }

  if (action === 'reopen_practical') {
    if (subIds.length === 0) return { error: '请选择实操归档记录' };
    let count = 0;
    for (const sid of subIds) {
      const result = await reopenPracticalSubmission(sid, { clearScores: true });
      if (result) count += 1;
    }
    return { affected: count, message: `已开放 ${count} 名考生重新上传实操` };
  }

  return { error: '未知操作' };
}

module.exports = {
  FOCUS_THRESHOLD,
  queryAbnormalCandidates,
  applyAbnormalAction
};
