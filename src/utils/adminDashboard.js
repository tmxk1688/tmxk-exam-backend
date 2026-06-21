const db = require('../db');
const { getObjectiveMax, getTotalMax, PRACTICAL_MAX } = require('./questionBank');
const { getSettings } = require('./settings');
const { getPracticalDeadlineInfo } = require('./deadline');
const { getSummary } = require('../proctoring');

function isPracticalScored(sub) {
  if (!sub) return false;
  return sub.status === 'scored'
    || (sub.practical_score !== null && sub.practical_score !== undefined);
}

function buildScoreRow(candidate, record, practical) {
  const objective = record?.objective_score ?? null;
  const practicalScored = isPracticalScored(practical);
  const practicalScore = practical?.practical_score ?? null;
  const totalScore = practicalScored && objective != null
    ? (objective ?? 0) + (practicalScore ?? 0)
    : null;

  return {
    recordId: record?.id ?? null,
    candidateId: candidate.id,
    ticketNo: candidate.ticket_no,
    name: candidate.name,
    position: candidate.position || '',
    examSite: candidate.exam_site || '',
    examRoom: candidate.exam_room || '',
    seatNo: candidate.seat_no || '',
    candidateStatus: candidate.status,
    objectiveScore: objective,
    objectiveMax: getObjectiveMax(),
    task1Score: practical?.task1_score ?? null,
    task2Score: practical?.task2_score ?? null,
    practicalScore,
    practicalMax: PRACTICAL_MAX,
    totalScore,
    totalMax: getTotalMax(),
    practicalScored,
    practicalStatus: practical?.status || 'none',
    practicalFileCount: practical ? Number(practical.file_count || 0) : 0,
    practicalFinalizedAt: practical?.finalized_at || '',
    practicalScoredAt: practical?.scored_at || '',
    submittedAt: record?.submitted_at || '',
    durationSeconds: record?.duration_seconds ?? null,
    practicalSubmissionId: practical?.id ?? null
  };
}

function getScoreBucket(score) {
  if (score == null || Number.isNaN(score)) return null;
  if (score < 60) return '0-59';
  if (score < 70) return '60-69';
  if (score < 80) return '70-79';
  if (score < 90) return '80-89';
  return '90-100';
}

async function getDashboardOverview() {
  const settings = await getSettings();
  
  const totalResult = await db.prepare('SELECT COUNT(*) as c FROM candidates').get();
  const total = totalResult?.c || 0;
  
  const pendingResult = await db.prepare("SELECT COUNT(*) as c FROM candidates WHERE status = 'pending'").get();
  const pending = pendingResult?.c || 0;
  
  const inProgressResult = await db.prepare("SELECT COUNT(*) as c FROM candidates WHERE status = 'in_progress'").get();
  const inProgress = inProgressResult?.c || 0;
  
  const submittedResult = await db.prepare("SELECT COUNT(*) as c FROM candidates WHERE status = 'submitted'").get();
  const submitted = submittedResult?.c || 0;

  const avgObjectiveResult = await db.prepare(`
    SELECT AVG(objective_score) as avg FROM exam_records WHERE status = 'submitted'
  `).get();
  const avgObjective = avgObjectiveResult?.avg || 0;

  const practicalOpenResult = await db.prepare(`
    SELECT COUNT(*) as c FROM practical_submissions WHERE status = 'open'
  `).get();
  const practicalOpen = practicalOpenResult?.c || 0;
  
  const practicalSubmittedResult = await db.prepare(`
    SELECT COUNT(*) as c FROM practical_submissions WHERE status = 'submitted'
  `).get();
  const practicalSubmitted = practicalSubmittedResult?.c || 0;
  
  const practicalScoredResult = await db.prepare(`
    SELECT COUNT(*) as c FROM practical_submissions WHERE status = 'scored'
  `).get();
  const practicalScored = practicalScoredResult?.c || 0;

  // 查询已交卷但没有实操记录的考生
  const submittedNoPracticalResult = await db.prepare(`
    SELECT COUNT(*) as c FROM candidates c
    WHERE c.status = 'submitted' 
    AND NOT EXISTS (SELECT 1 FROM exam_records er WHERE er.candidate_id = c.id AND er.status = 'submitted')
  `).get();
  const submittedNoPractical = submittedNoPracticalResult?.c || 0;

  const avgTotalResult = await db.prepare(`
    SELECT AVG(er.objective_score + ps.practical_score) as avg
    FROM exam_records er
    INNER JOIN practical_submissions ps ON ps.record_id = er.id AND ps.status = 'scored'
    WHERE er.status = 'submitted'
  `).get();
  const avgTotal = avgTotalResult?.avg || 0;

  const distributionBuckets = [
    { key: '0-59', label: '60分以下', count: 0 },
    { key: '60-69', label: '60–69分', count: 0 },
    { key: '70-79', label: '70–79分', count: 0 },
    { key: '80-89', label: '80–89分', count: 0 },
    { key: '90-100', label: '90–100分', count: 0 }
  ];

  const scoredTotals = await db.prepare(`
    SELECT er.objective_score + ps.practical_score as total
    FROM exam_records er
    INNER JOIN practical_submissions ps ON ps.record_id = er.id AND ps.status = 'scored'
    WHERE er.status = 'submitted'
  `).all();

  for (const row of scoredTotals) {
    const bucket = getScoreBucket(row.total);
    const item = distributionBuckets.find((b) => b.key === bucket);
    if (item) item.count += 1;
  }

  const todoNotSubmitted = await db.prepare(`
    SELECT ticket_no, name, position FROM candidates
    WHERE status IN ('pending', 'in_progress')
    ORDER BY ticket_no LIMIT 12
  `).all();
  const todoNotSubmittedList = todoNotSubmitted.map((r) => ({ 
    ticketNo: r.ticket_no, 
    name: r.name, 
    position: r.position || '' 
  }));

  // 查询已交卷但没有实操或实操未完成的考生
  const candidatesWithRecords = await db.prepare(`
    SELECT c.ticket_no, c.name, er.submitted_at
    FROM candidates c
    INNER JOIN exam_records er ON er.candidate_id = c.id AND er.status = 'submitted'
    WHERE NOT EXISTS (SELECT 1 FROM practical_submissions ps WHERE ps.record_id = er.id)
       OR EXISTS (SELECT 1 FROM practical_submissions ps WHERE ps.record_id = er.id AND ps.status = 'open')
    ORDER BY er.submitted_at DESC LIMIT 12
  `).all();
  const todoNoPractical = candidatesWithRecords.map((r) => ({
    ticketNo: r.ticket_no,
    name: r.name,
    submittedAt: r.submitted_at
  }));

  const todoPendingScore = await db.prepare(`
    SELECT ps.id as submissionId, ps.ticket_no, ps.name, ps.finalized_at
    FROM practical_submissions ps
    WHERE ps.status = 'submitted'
    ORDER BY ps.finalized_at DESC LIMIT 12
  `).all();
  const todoPendingScoreList = todoPendingScore.map((r) => ({
    submissionId: r.submissionId,
    ticketNo: r.ticket_no,
    name: r.name,
    finalizedAt: r.finalized_at
  }));

  const submissionRate = total > 0 ? Math.round((submitted / total) * 100) : 0;
  const finalizeTarget = submitted;
  const finalizedCount = practicalSubmitted + practicalScored;
  const finalizeRate = finalizeTarget > 0 ? Math.round((finalizedCount / finalizeTarget) * 100) : 0;
  const scoreRate = finalizedCount > 0 ? Math.round((practicalScored / finalizedCount) * 100) : 0;

  return {
    generatedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
    scoresLocked: settings.scoresLocked,
    candidates: { total, pending, inProgress, submitted },
    objective: {
      avgScore: avgObjective ? Math.round(avgObjective * 10) / 10 : 0,
      maxScore: getObjectiveMax()
    },
    practical: {
      notStarted: submittedNoPractical + practicalOpen,
      uploading: practicalOpen,
      pendingScore: practicalSubmitted,
      scored: practicalScored,
      maxScore: PRACTICAL_MAX
    },
    totals: {
      complete: practicalScored,
      pending: practicalSubmitted,
      avgTotal: avgTotal ? Math.round(avgTotal * 10) / 10 : 0,
      maxScore: getTotalMax()
    },
    progress: {
      submissionRate,
      finalizeRate,
      scoreRate,
      finalizedCount,
      finalizeTarget
    },
    scoreDistribution: distributionBuckets,
    practicalDeadline: getPracticalDeadlineInfo(settings),
    proctor: getSummary(),
    todos: {
      notSubmitted: todoNotSubmittedList,
      noPractical: todoNoPractical,
      pendingScore: todoPendingScoreList
    }
  };
}

async function queryComprehensiveScores(filters = {}) {
  const { q, position, exam_site, status } = filters;
  
  // 首先获取所有考生
  let candidateQuery = 'SELECT * FROM candidates WHERE 1=1';
  const candidateParams = [];
  
  if (q && q.trim()) {
    candidateQuery += ' AND (ticket_no LIKE ? OR name LIKE ?)';
    const kw = `%${q.trim()}%`;
    candidateParams.push(kw, kw);
  }
  if (position) {
    candidateQuery += ' AND position = ?';
    candidateParams.push(position);
  }
  if (exam_site) {
    candidateQuery += ' AND exam_site = ?';
    candidateParams.push(exam_site);
  }
  
  const candidates = await db.prepare(candidateQuery).all(...candidateParams);
  
  // 为每个考生获取考试记录和实操记录
  const results = [];
  for (const candidate of candidates) {
    // 获取该考生的最新考试记录
    const recordQuery = `
      SELECT * FROM exam_records 
      WHERE candidate_id = ? AND status = 'submitted'
      ORDER BY id DESC LIMIT 1
    `;
    const record = await db.prepare(recordQuery).get(candidate.id);
    
    // 获取实操提交
    let practical = null;
    let fileCount = 0;
    if (record) {
      const practicalQuery = `SELECT * FROM practical_submissions WHERE record_id = ?`;
      practical = await db.prepare(practicalQuery).get(record.id);
      
      if (practical) {
        const countResult = await db.prepare(
          'SELECT COUNT(*) as c FROM practical_files WHERE submission_id = ?'
        ).get(practical.id);
        fileCount = countResult?.c || 0;
      }
    }
    
    // 根据status过滤
    let include = true;
    if (status === 'total_ready') {
      include = practical && practical.status === 'scored';
    } else if (status === 'pending_practical') {
      include = !practical || ['open', 'submitted'].includes(practical.status);
    } else if (status === 'not_finalized') {
      include = !practical || practical.status === 'open';
    } else if (status === 'not_submitted') {
      include = candidate.status === 'pending' || candidate.status === 'in_progress';
    }
    
    if (!include) continue;
    
    const scoreRow = buildScoreRow(candidate, record, practical ? { ...practical, file_count: fileCount } : null);
    results.push(scoreRow);
  }
  
  // 排序
  results.sort((a, b) => {
    // 先按总分降序
    if (a.totalScore !== b.totalScore) {
      if (a.totalScore === null) return 1;
      if (b.totalScore === null) return -1;
      return b.totalScore - a.totalScore;
    }
    // 然后按交卷时间降序
    if (a.submittedAt !== b.submittedAt) {
      if (!a.submittedAt) return 1;
      if (!b.submittedAt) return -1;
      return b.submittedAt.localeCompare(a.submittedAt);
    }
    // 按准考证号升序
    return a.ticketNo.localeCompare(b.ticketNo);
  });
  
  return results;
}

async function getComprehensiveScoresSummary(rows) {
  const total = rows.length;
  const submitted = rows.filter((r) => r.candidateStatus === 'submitted').length;
  const totalReady = rows.filter((r) => r.practicalScored).length;
  const pendingTotal = submitted - totalReady;
  const withTotal = rows.filter((r) => r.totalScore != null);
  const avgTotal = withTotal.length
    ? Math.round(withTotal.reduce((s, r) => s + r.totalScore, 0) / withTotal.length * 10) / 10
    : 0;

  return { total, submitted, totalReady, pendingTotal, avgTotal };
}

module.exports = {
  getDashboardOverview,
  queryComprehensiveScores,
  getComprehensiveScoresSummary,
  buildScoreRow,
  isPracticalScored,
  getObjectiveMax,
  PRACTICAL_MAX,
  getTotalMax
};
