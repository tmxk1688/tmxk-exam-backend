const db = require('../db');
const seedData = require('../data/questions');
const { POSITION_ADJUSTMENT_TEMPLATE } = require('../data/transcriptDefaults');
const { normalizeQuestionPayload, scoreAnswer, formatTypeLabel } = require('./questionTypes');

const PRACTICAL_MAX = seedData.PRACTICAL_MAX;
const PRACTICAL_TASK1_MAX = seedData.PRACTICAL_TASK1_MAX;
const PRACTICAL_TASK2_MAX = seedData.PRACTICAL_TASK2_MAX;

async function initQuestionBank() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS exam_papers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      subtitle TEXT DEFAULT '',
      duration_minutes INTEGER DEFAULT 45,
      rules TEXT DEFAULT '[]',
      practical_section TEXT DEFAULT '{}',
      is_active INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT DEFAULT (datetime('now', 'localtime'))
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS exam_questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      paper_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      options TEXT DEFAULT '[]',
      answer TEXT NOT NULL,
      score REAL DEFAULT 2,
      sort_order INTEGER DEFAULT 0
    )
  `);

  // MongoDB不需要这些迁移，因为是schemaless
  // 但为了保持兼容性，我们检查是否需要初始化数据

  try {
    const count = await db.prepare('SELECT COUNT(*) as c FROM exam_papers').get();
    if (!count || count.c === 0) {
      await seedDefaultPaper(true);
    }
  } catch (e) {
    // Table might not exist yet
    await seedDefaultPaper(true);
  }
}

function shuffleArray(arr) {
  const list = [...arr];
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

const OPTION_KEYS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

function shuffleSingleQuestionOptions(question) {
  if (!['single', 'multiple'].includes(question.type) || !question.options?.length) {
    return { options: question.options || [], answer: question.answer };
  }

  const shuffled = shuffleArray(question.options);
  const keys = OPTION_KEYS.slice(0, shuffled.length);
  const keyMap = {};
  shuffled.forEach((opt, index) => {
    keyMap[opt.key] = keys[index];
  });

  const newOptions = shuffled.map((opt, index) => ({
    key: keys[index],
    text: opt.text
  }));

  let answerKey = question.answer;
  if (question.type === 'multiple') {
    answerKey = String(question.answer || '')
      .split(',')
      .map((k) => keyMap[k.trim()] || k.trim())
      .filter(Boolean)
      .sort()
      .join(',');
  } else {
    answerKey = keyMap[question.answer] || question.answer;
  }

  return { options: newOptions, answer: answerKey };
}

function buildOptionLayoutForQuestions(questions) {
  const layout = {};
  for (const q of questions) {
    if (!['single', 'multiple'].includes(q.type) || !q.options?.length) continue;
    const { options, answer } = shuffleSingleQuestionOptions(q);
    layout[String(q.id)] = { options, answer };
  }
  return layout;
}

function parseOptionLayout(record) {
  if (!record?.question_option_layout) return null;
  try {
    const data = typeof record.question_option_layout === 'string' 
      ? JSON.parse(record.question_option_layout) 
      : record.question_option_layout;
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

function applyOptionLayoutToQuestion(question, layout) {
  const entry = layout?.[String(question.id)];
  if (!entry) return question;
  return {
    ...question,
    options: entry.options,
    answer: entry.answer
  };
}

function isShuffleOptionsEnabled(paperRow) {
  return paperRow?.shuffle_options === 1 || paperRow?.shuffleOptions === true;
}

function parseJson(str, fallback) {
  if (!str) return fallback;
  if (typeof str === 'object') return str;
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

function formatPaperRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    subtitle: row.subtitle || '',
    brandTitle: row.brand_title || row.brandTitle || '天马行空创意团队 · 考试云系统',
    bannerTagline: row.banner_tagline || row.bannerTagline || '在线闭卷笔试 · 云端实操归档 · 统一评分',
    positions: parseJson(row.positions || row.positions, []),
    positionAdjustmentText: row.position_adjustment_text || row.positionAdjustmentText || POSITION_ADJUSTMENT_TEMPLATE,
    durationMinutes: row.duration_minutes || row.durationMinutes,
    rules: parseJson(row.rules || row.rules, []),
    practicalSection: parseJson(row.practical_section || row.practicalSection, {}),
    isActive: row.is_active === 1 || row.isActive === true,
    questionMode: row.question_mode || row.questionMode || 'fixed',
    randomSingleCount: row.random_single_count ?? row.randomSingleCount ?? 15,
    randomJudgeCount: row.random_judge_count ?? row.randomJudgeCount ?? 5,
    shuffleOptions: row.shuffle_options === 1 || row.shuffleOptions === true,
    createdAt: row.created_at || row.createdAt,
    updatedAt: row.updated_at || row.updatedAt
  };
}

function enrichPaperStats(paper) {
  const singles = paper.questions.filter((q) => q.type === 'single');
  const judges = paper.questions.filter((q) => q.type === 'judge');
  const typeCounts = {};
  for (const q of paper.questions) {
    typeCounts[q.type] = (typeCounts[q.type] || 0) + 1;
  }
  paper.poolStats = {
    singleTotal: singles.length,
    judgeTotal: judges.length,
    typeCounts
  };
  if (paper.questionMode === 'random') {
    const nS = Math.min(paper.randomSingleCount || 0, singles.length);
    const nJ = Math.min(paper.randomJudgeCount || 0, judges.length);
    const avgSingle = singles.length
      ? singles.reduce((s, q) => s + Number(q.score) || 0, 0) / singles.length
      : 2;
    const avgJudge = judges.length
      ? judges.reduce((s, q) => s + Number(q.score) || 0, 0) / judges.length
      : 2;
    paper.objectiveMax = Math.round((nS * avgSingle + nJ * avgJudge) * 10) / 10;
    paper.randomDrawNote = `考试时从题库随机抽取单选 ${nS} 题、判断 ${nJ} 题`;
  } else {
    paper.objectiveMax = computeObjectiveMax(paper.questions);
  }
  paper.totalMax = paper.objectiveMax + PRACTICAL_MAX;
  return paper;
}

function formatQuestionRow(row) {
  return {
    id: row.id,
    paperId: row.paper_id || row.paperId,
    type: row.type,
    content: row.content,
    options: parseJson(row.options, []),
    answer: row.answer,
    score: row.score,
    sortOrder: row.sort_order ?? row.sortOrder
  };
}

async function getPaperQuestions(paperId) {
  const rows = await db.prepare(`
    SELECT * FROM exam_questions WHERE paper_id = ? ORDER BY sort_order ASC, id ASC
  `).all(paperId);
  return rows.map(formatQuestionRow);
}

function computeObjectiveMax(questions) {
  return questions.reduce((sum, q) => sum + (Number(q.score) || 0), 0);
}

async function getActivePaperRow() {
  return db.prepare('SELECT * FROM exam_papers WHERE is_active = 1 ORDER BY id DESC LIMIT 1').get();
}

async function getActivePaper() {
  const row = await getActivePaperRow();
  if (!row) return null;
  const paper = formatPaperRow(row);
  paper.questions = await getPaperQuestions(row.id);
  return enrichPaperStats(paper);
}

async function getQuestionsByIds(paperId, ids) {
  if (!ids?.length) return [];
  const all = await getPaperQuestions(paperId);
  const idSet = new Set(ids.map(Number));
  return all
    .filter((q) => idSet.has(q.id))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
}

function drawQuestionSet(paper) {
  if (!paper || paper.questionMode !== 'random') return paper.questions;
  const singles = shuffleArray(paper.questions.filter((q) => q.type === 'single'));
  const judges = shuffleArray(paper.questions.filter((q) => q.type === 'judge'));
  const nS = Math.min(Math.max(0, paper.randomSingleCount || 0), singles.length);
  const nJ = Math.min(Math.max(0, paper.randomJudgeCount || 0), judges.length);
  return [...singles.slice(0, nS), ...judges.slice(0, nJ)];
}

function parseDrawnIds(record) {
  if (!record?.drawn_question_ids && !record?.drawnQuestionIds) return null;
  try {
    const ids = typeof record.drawn_question_ids === 'string' 
      ? JSON.parse(record.drawn_question_ids) 
      : (record.drawnQuestionIds || record.drawn_question_ids);
    return Array.isArray(ids) && ids.length ? ids.map(Number) : null;
  } catch {
    return null;
  }
}

async function ensureRecordOptionLayout(recordId) {
  const record = await db.prepare('SELECT * FROM exam_records WHERE id = ?').get(recordId);
  if (!record?.confirmed_at) return null;

  const activeRow = await getActivePaperRow();
  if (!activeRow || !isShuffleOptionsEnabled(activeRow)) return null;

  const existing = parseOptionLayout(record);
  if (existing && Object.keys(existing).length) return existing;

  const questions = await getRecordQuestionsBase(recordId);
  const layout = buildOptionLayoutForQuestions(questions);
  
  // MongoDB直接存储对象
  await db.prepare('UPDATE exam_records SET question_option_layout = ? WHERE id = ?')
    .run(JSON.stringify(layout), recordId);
  return layout;
}

async function ensureRecordDrawnQuestions(recordId) {
  const record = await db.prepare('SELECT * FROM exam_records WHERE id = ?').get(recordId);
  if (!record) return null;
  if (!record.confirmed_at) return null;

  const activeRow = await getActivePaperRow();
  if (!activeRow) return null;
  const paper = formatPaperRow(activeRow);
  paper.questions = await getPaperQuestions(activeRow.id);

  const existing = parseDrawnIds(record);
  if (existing?.length) {
    const questions = await getQuestionsByIds(paper.id, existing);
    await ensureRecordOptionLayout(recordId);
    return questions;
  }

  const drawn = drawQuestionSet(paper);
  const ids = drawn.map((q) => q.id);
  
  // MongoDB直接存储对象，不需要JSON.stringify
  const drawnToStore = Array.isArray(ids) ? ids : JSON.parse(ids || '[]');
  await db.prepare('UPDATE exam_records SET drawn_question_ids = ? WHERE id = ?')
    .run(JSON.stringify(drawnToStore), recordId);
  
  await ensureRecordOptionLayout(recordId);
  return drawn;
}

async function getRecordQuestionsBase(recordId) {
  const record = await db.prepare('SELECT * FROM exam_records WHERE id = ?').get(recordId);
  if (!record) return [];
  const activeRow = await getActivePaperRow();
  if (!activeRow) return [];

  const ids = parseDrawnIds(record);
  if (ids?.length) return getQuestionsByIds(activeRow.id, ids);

  if (record.status === 'in_progress' && record.confirmed_at) {
    return ensureRecordDrawnQuestions(recordId) || [];
  }

  const paper = formatPaperRow(activeRow);
  paper.questions = await getPaperQuestions(activeRow.id);
  if (paper.questionMode === 'random') {
    return record.status === 'submitted' ? [] : paper.questions;
  }
  return paper.questions;
}

async function getRecordQuestions(recordId) {
  const questions = await getRecordQuestionsBase(recordId);
  const record = await db.prepare('SELECT * FROM exam_records WHERE id = ?').get(recordId);
  const activeRow = await getActivePaperRow();
  if (!activeRow || !isShuffleOptionsEnabled(activeRow)) return questions;

  const layout = parseOptionLayout(record);
  if (!layout || !Object.keys(layout).length) return questions;

  return questions.map((q) => applyOptionLayoutToQuestion(q, layout));
}

async function getPublicQuestionsForRecord(recordId) {
  const questions = await getRecordQuestions(recordId);
  return questions.map(({ answer, ...q }) => q);
}

async function calculateScoreForRecord(recordId, answers) {
  const questions = await getRecordQuestions(recordId);
  let score = 0;
  const details = [];

  for (const q of questions) {
    const userAnswer = answers[String(q.id)];
    const result = scoreAnswer(q, userAnswer);
    score += result.score;
    details.push({
      questionId: q.id,
      userAnswer: userAnswer ?? null,
      correctAnswer: q.answer,
      correct: result.correct,
      needsReview: result.needsReview,
      score: result.score
    });
  }

  return { score: Math.round(score * 10) / 10, maxScore: computeObjectiveMax(questions), details };
}

async function buildAnswerDetailsForRecord(recordId, answers) {
  const { score, maxScore, details } = await calculateScoreForRecord(recordId, answers || {});
  const qMap = {};
  for (const q of await getRecordQuestions(recordId)) qMap[q.id] = q;
  return {
    score,
    maxScore,
    details: details.map((d) => {
      const q = qMap[d.questionId];
      return {
        ...d,
        content: q?.content || '',
        type: q?.type || '',
        maxScore: q?.score || 0,
        options: q?.options || null
      };
    })
  };
}

async function getObjectiveMaxForRecord(recordId) {
  const record = await db.prepare('SELECT * FROM exam_records WHERE id = ?').get(recordId);
  if (!record) return getObjectiveMax();

  const ids = parseDrawnIds(record);
  if (ids?.length) {
    const activeRow = await getActivePaperRow();
    if (activeRow) return computeObjectiveMax(await getQuestionsByIds(activeRow.id, ids));
  }

  const activeRow = await getActivePaperRow();
  if (!activeRow) return getObjectiveMax();
  const paper = formatPaperRow(activeRow);
  paper.questions = await getPaperQuestions(activeRow.id);
  return enrichPaperStats(paper).objectiveMax;
}

async function getPositionAdjustmentText() {
  const row = await getActivePaperRow();
  if (row?.position_adjustment_text || row?.positionAdjustmentText) {
    return row.position_adjustment_text || row.positionAdjustmentText;
  }
  return POSITION_ADJUSTMENT_TEMPLATE;
}

async function getExamInfo() {
  const paper = await getActivePaper();
  if (!paper) {
    return {
      ...seedData.EXAM_INFO,
      brandTitle: '天马行空创意团队 · 考试云系统',
      bannerTagline: '在线闭卷笔试 · 云端实操归档 · 统一评分',
      duration: seedData.EXAM_INFO.duration,
      objectiveMax: seedData.OBJECTIVE_MAX,
      practicalMax: PRACTICAL_MAX
    };
  }
  return {
    brandTitle: paper.brandTitle,
    title: paper.title,
    subtitle: paper.subtitle,
    bannerTagline: paper.bannerTagline,
    duration: paper.durationMinutes,
    totalScore: paper.totalMax,
    objectiveMax: paper.objectiveMax,
    practicalMax: PRACTICAL_MAX,
    positions: paper.positions?.length ? paper.positions : seedData.EXAM_INFO.positions,
    rules: paper.rules.length ? paper.rules : seedData.EXAM_INFO.rules,
    questionMode: paper.questionMode,
    randomDrawNote: paper.randomDrawNote || null,
    shuffleOptions: !!paper.shuffleOptions,
    shuffleOptionsNote: paper.shuffleOptions ? '单选题选项顺序已随机打乱，每位考生互不相同，请以当前页面显示为准。' : null
  };
}

async function getPracticalSection() {
  const paper = await getActivePaper();
  const section = paper?.practicalSection;
  if (section && section.title) return section;
  return seedData.PRACTICAL_SECTION;
}

async function getObjectiveMax() {
  const row = await getActivePaperRow();
  if (!row) return seedData.OBJECTIVE_MAX;
  const paper = formatPaperRow(row);
  paper.questions = await getPaperQuestions(row.id);
  return enrichPaperStats(paper).objectiveMax;
}

async function getTotalMax() {
  return (await getObjectiveMax()) + PRACTICAL_MAX;
}

async function getPublicQuestions() {
  const paper = await getActivePaper();
  const questions = paper?.questions ?? seedData.QUESTIONS.map((q, i) => ({
    id: q.id,
    type: q.type,
    content: q.content,
    options: q.options,
    score: q.score,
    sortOrder: i
  }));
  return questions.map(({ answer, ...q }) => q);
}

async function getQuestionMap() {
  const paper = await getActivePaper();
  const questions = paper?.questions ?? seedData.QUESTIONS.map((q, i) => ({
    id: q.id,
    type: q.type,
    content: q.content,
    options: q.options,
    answer: q.answer,
    score: q.score,
    sortOrder: i
  }));
  const map = {};
  for (const q of questions) map[q.id] = q;
  return map;
}

async function calculateScore(answers) {
  const qMap = await getQuestionMap();
  const questions = Object.values(qMap).sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
  let score = 0;
  const details = [];

  for (const q of questions) {
    const userAnswer = answers[String(q.id)];
    const result = scoreAnswer(q, userAnswer);
    score += result.score;
    details.push({
      questionId: q.id,
      userAnswer: userAnswer ?? null,
      correctAnswer: q.answer,
      correct: result.correct,
      needsReview: result.needsReview,
      score: result.score
    });
  }

  return { score: Math.round(score * 10) / 10, maxScore: computeObjectiveMax(questions), details };
}

async function buildAnswerDetails(answers) {
  const { score, maxScore, details } = await calculateScore(answers || {});
  const qMap = await getQuestionMap();
  return {
    score,
    maxScore,
    details: details.map((d) => {
      const q = qMap[d.questionId];
      return {
        ...d,
        content: q?.content || '',
        type: q?.type || '',
        maxScore: q?.score || 0,
        options: q?.options || null
      };
    })
  };
}

async function seedDefaultPaper(activate = false) {
  const info = seedData.EXAM_INFO;
  const now = new Date().toLocaleString('zh-CN', { hour12: false });
  
  const result = await db.prepare(`
    INSERT INTO exam_papers (
      title, subtitle, brand_title, banner_tagline, positions, position_adjustment_text,
      duration_minutes, rules, practical_section, is_active, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    info.title,
    info.subtitle,
    '天马行空创意团队 · 考试云系统',
    '在线闭卷笔试 · 云端实操归档 · 统一评分',
    JSON.stringify(info.positions),
    POSITION_ADJUSTMENT_TEMPLATE,
    info.duration,
    JSON.stringify(info.rules),
    JSON.stringify(seedData.PRACTICAL_SECTION),
    activate ? 1 : 0,
    now
  );
  
  const paperId = result.lastInsertRowid;
  
  for (let idx = 0; idx < seedData.QUESTIONS.length; idx++) {
    const q = seedData.QUESTIONS[idx];
    await db.prepare(`
      INSERT INTO exam_questions (paper_id, type, content, options, answer, score, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      paperId,
      q.type,
      q.content,
      JSON.stringify(q.options || []),
      q.answer,
      q.score,
      idx
    );
  }
  
  if (activate) {
    await db.prepare('UPDATE exam_papers SET is_active = 0').run();
    await db.prepare('UPDATE exam_papers SET is_active = 1 WHERE id = ?').run(paperId);
  }
  
  return getPaperById(Number(paperId));
}

async function listPapers() {
  const rows = await db.prepare('SELECT * FROM exam_papers ORDER BY is_active DESC, id DESC').all();
  const papers = [];
  for (const row of rows) {
    const paper = formatPaperRow(row);
    paper.questions = await getPaperQuestions(row.id);
    const enriched = enrichPaperStats(paper);
    enriched.questionCount = paper.questions.length;
    papers.push(enriched);
  }
  return papers;
}

async function getPaperById(id) {
  const row = await db.prepare('SELECT * FROM exam_papers WHERE id = ?').get(id);
  if (!row) return null;
  const paper = formatPaperRow(row);
  paper.questions = await getPaperQuestions(id);
  return enrichPaperStats(paper);
}

async function createPaper(data) {
  const info = seedData.EXAM_INFO;
  const now = new Date().toLocaleString('zh-CN', { hour12: false });
  
  const result = await db.prepare(`
    INSERT INTO exam_papers (
      title, subtitle, brand_title, banner_tagline, positions, position_adjustment_text,
      duration_minutes, rules, practical_section, is_active, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
  `).run(
    data.title || '新试卷',
    data.subtitle || '',
    data.brandTitle || '天马行空创意团队 · 考试云系统',
    data.bannerTagline || '在线闭卷笔试 · 云端实操归档 · 统一评分',
    JSON.stringify(data.positions?.length ? data.positions : info.positions),
    data.positionAdjustmentText || POSITION_ADJUSTMENT_TEMPLATE,
    Math.max(1, parseInt(data.durationMinutes, 10) || 45),
    JSON.stringify(data.rules || []),
    JSON.stringify(data.practicalSection || seedData.PRACTICAL_SECTION),
    now
  );
  
  return getPaperById(Number(result.lastInsertRowid));
}

async function updatePaper(id, data) {
  const existing = await db.prepare('SELECT id FROM exam_papers WHERE id = ?').get(id);
  if (!existing) return null;

  const current = await getPaperById(id);
  const questionMode = data.questionMode === 'random' ? 'random' : (data.questionMode === 'fixed' ? 'fixed' : current.questionMode);
  const now = new Date().toLocaleString('zh-CN', { hour12: false });
  
  await db.prepare(`
    UPDATE exam_papers SET
      title = ?, subtitle = ?, brand_title = ?, banner_tagline = ?, positions = ?,
      position_adjustment_text = ?,
      duration_minutes = ?, rules = ?, practical_section = ?,
      question_mode = ?, random_single_count = ?, random_judge_count = ?,
      shuffle_options = ?,
      updated_at = ?
    WHERE id = ?
  `).run(
    data.title ?? current.title,
    data.subtitle ?? current.subtitle,
    data.brandTitle ?? current.brandTitle,
    data.bannerTagline ?? current.bannerTagline,
    JSON.stringify(data.positions ?? current.positions ?? []),
    data.positionAdjustmentText ?? current.positionAdjustmentText,
    data.durationMinutes != null ? Math.max(1, parseInt(data.durationMinutes, 10) || 45) : current.durationMinutes,
    JSON.stringify(data.rules ?? current.rules),
    JSON.stringify(data.practicalSection ?? current.practicalSection),
    questionMode,
    data.randomSingleCount != null ? Math.max(0, parseInt(data.randomSingleCount, 10) || 0) : current.randomSingleCount,
    data.randomJudgeCount != null ? Math.max(0, parseInt(data.randomJudgeCount, 10) || 0) : current.randomJudgeCount,
    data.shuffleOptions != null ? (data.shuffleOptions ? 1 : 0) : (current.shuffleOptions ? 1 : 0),
    now,
    id
  );
  
  return getPaperById(id);
}

async function activatePaper(id) {
  const existing = await db.prepare('SELECT id FROM exam_papers WHERE id = ?').get(id);
  if (!existing) return null;
  
  await db.prepare('UPDATE exam_papers SET is_active = 0').run();
  const now = new Date().toLocaleString('zh-CN', { hour12: false });
  await db.prepare('UPDATE exam_papers SET is_active = 1, updated_at = ? WHERE id = ?').run(now, id);
  
  return getPaperById(id);
}

async function deletePaper(id) {
  const row = await db.prepare('SELECT * FROM exam_papers WHERE id = ?').get(id);
  if (!row) return false;
  
  if (row.is_active === 1) {
    const err = new Error('无法删除当前启用的试卷，请先启用其他试卷');
    err.code = 'ACTIVE_PAPER';
    throw err;
  }
  
  await db.prepare('DELETE FROM exam_papers WHERE id = ?').run(id);
  return true;
}

async function duplicatePaper(id) {
  const source = await getPaperById(id);
  if (!source) return null;
  
  const created = await createPaper({
    title: `${source.title}（副本）`,
    subtitle: source.subtitle,
    brandTitle: source.brandTitle,
    bannerTagline: source.bannerTagline,
    positions: source.positions,
    positionAdjustmentText: source.positionAdjustmentText,
    durationMinutes: source.durationMinutes,
    rules: source.rules,
    practicalSection: source.practicalSection
  });
  
  for (const q of source.questions) {
    await db.prepare(`
      INSERT INTO exam_questions (paper_id, type, content, options, answer, score, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      created.id,
      q.type,
      q.content,
      JSON.stringify(q.options || []),
      q.answer,
      q.score,
      q.sortOrder
    );
  }
  
  return updatePaper(created.id, {
    questionMode: source.questionMode,
    randomSingleCount: source.randomSingleCount,
    randomJudgeCount: source.randomJudgeCount,
    shuffleOptions: source.shuffleOptions
  });
}

function serializeOptions(options) {
  if (!options) return '[]';
  if (Array.isArray(options)) return JSON.stringify(options);
  return JSON.stringify(options);
}

async function addQuestion(paperId, data) {
  const paper = await db.prepare('SELECT id FROM exam_papers WHERE id = ?').get(paperId);
  if (!paper) return null;

  const normalized = normalizeQuestionPayload(data);
  if (normalized.error) {
    const err = new Error(normalized.error);
    err.code = 'INVALID_QUESTION';
    throw err;
  }
  const q = normalized.data;

  const maxOrder = await db.prepare('SELECT MAX(sort_order) as m FROM exam_questions WHERE paper_id = ?').get(paperId);
  const sortOrder = data.sortOrder != null ? data.sortOrder : ((maxOrder?.m ?? -1) + 1);

  const result = await db.prepare(`
    INSERT INTO exam_questions (paper_id, type, content, options, answer, score, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    paperId,
    q.type,
    q.content,
    serializeOptions(q.options),
    String(q.answer ?? '').trim(),
    Number(q.score) || 2,
    sortOrder
  );
  
  const now = new Date().toLocaleString('zh-CN', { hour12: false });
  await db.prepare('UPDATE exam_papers SET updated_at = ? WHERE id = ?').run(now, paperId);
  
  const newQuestion = await db.prepare('SELECT * FROM exam_questions WHERE id = ?').get(result.lastInsertRowid);
  return formatQuestionRow(newQuestion);
}

async function updateQuestion(paperId, questionId, data) {
  const row = await db.prepare('SELECT * FROM exam_questions WHERE id = ? AND paper_id = ?').get(questionId, paperId);
  if (!row) return null;

  const existing = formatQuestionRow(row);
  const merged = {
    type: data.type ?? existing.type,
    content: data.content ?? existing.content,
    options: data.options ?? existing.options,
    answer: data.answer ?? existing.answer,
    score: data.score ?? existing.score,
    subQuestions: data.subQuestions ?? data.options?.subQuestions ?? existing.options?.subQuestions,
    requirements: data.requirements ?? data.options?.requirements ?? existing.options?.requirements,
    uploadHint: data.uploadHint ?? data.options?.uploadHint ?? existing.options?.uploadHint
  };
  const normalized = normalizeQuestionPayload(merged);
  if (normalized.error) {
    const err = new Error(normalized.error);
    err.code = 'INVALID_QUESTION';
    throw err;
  }
  const q = normalized.data;

  await db.prepare(`
    UPDATE exam_questions SET
      type = ?, content = ?, options = ?, answer = ?, score = ?, sort_order = ?
    WHERE id = ? AND paper_id = ?
  `).run(
    q.type,
    q.content,
    serializeOptions(q.options),
    String(q.answer ?? '').trim(),
    Number(q.score) || row.score,
    data.sortOrder != null ? data.sortOrder : row.sort_order,
    questionId,
    paperId
  );
  
  const now = new Date().toLocaleString('zh-CN', { hour12: false });
  await db.prepare('UPDATE exam_papers SET updated_at = ? WHERE id = ?').run(now, paperId);
  
  const updated = await db.prepare('SELECT * FROM exam_questions WHERE id = ?').get(questionId);
  return formatQuestionRow(updated);
}

async function deleteQuestion(paperId, questionId) {
  const result = await db.prepare('DELETE FROM exam_questions WHERE id = ? AND paper_id = ?').run(questionId, paperId);
  if (result.changes > 0) {
    const now = new Date().toLocaleString('zh-CN', { hour12: false });
    await db.prepare('UPDATE exam_papers SET updated_at = ? WHERE id = ?').run(now, paperId);
  }
  return result.changes > 0;
}

async function importQuestions(paperId, questionList) {
  const paper = await db.prepare('SELECT id FROM exam_papers WHERE id = ?').get(paperId);
  if (!paper) return { error: '试卷不存在', imported: 0 };

  const maxOrder = await db.prepare('SELECT MAX(sort_order) as m FROM exam_questions WHERE paper_id = ?').get(paperId);
  let order = (maxOrder?.m ?? -1) + 1;

  let imported = 0;
  for (const item of questionList) {
    const normalized = normalizeQuestionPayload(item);
    if (normalized.error || !normalized.data) continue;
    const q = normalized.data;
    
    await db.prepare(`
      INSERT INTO exam_questions (paper_id, type, content, options, answer, score, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      paperId,
      q.type,
      q.content,
      serializeOptions(q.options),
      String(q.answer ?? '').trim(),
      Number(q.score) || 2,
      order
    );
    
    order += 1;
    imported += 1;
  }

  const now = new Date().toLocaleString('zh-CN', { hour12: false });
  await db.prepare('UPDATE exam_papers SET updated_at = ? WHERE id = ?').run(now, paperId);
  
  const updatedPaper = await getPaperById(paperId);
  return { imported, paper: updatedPaper };
}

// 初始化
initQuestionBank().catch(console.error);

module.exports = {
  PRACTICAL_MAX,
  PRACTICAL_TASK1_MAX,
  PRACTICAL_TASK2_MAX,
  initQuestionBank,
  getActivePaper,
  getExamInfo,
  getPositionAdjustmentText,
  getPracticalSection,
  getObjectiveMax,
  getTotalMax,
  getPublicQuestions,
  calculateScore,
  buildAnswerDetails,
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
  ensureRecordDrawnQuestions,
  ensureRecordOptionLayout,
  getPublicQuestionsForRecord,
  calculateScoreForRecord,
  buildAnswerDetailsForRecord,
  getObjectiveMaxForRecord
};
