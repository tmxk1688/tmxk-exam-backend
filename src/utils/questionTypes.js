const QUESTION_TYPES = ['single', 'multiple', 'judge', 'fill', 'essay', 'combo', 'practical'];

const TYPE_LABELS = {
  single: '单选',
  multiple: '多选',
  judge: '判断',
  fill: '填空',
  essay: '问答',
  combo: '组合',
  practical: '实操'
};

const TYPE_MAP = {
  single: 'single',
  单选: 'single',
  单选题: 'single',
  multiple: 'multiple',
  多选: 'multiple',
  多选题: 'multiple',
  judge: 'judge',
  判断: 'judge',
  判断题: 'judge',
  fill: 'fill',
  填空: 'fill',
  填空题: 'fill',
  essay: 'essay',
  问答: 'essay',
  问答题: 'essay',
  简答: 'essay',
  简答题: 'essay',
  combo: 'combo',
  组合: 'combo',
  组合题: 'combo',
  阅读: 'combo',
  practical: 'practical',
  实操: 'practical',
  实操题: 'practical'
};

const AUTO_GRADED = new Set(['single', 'multiple', 'judge', 'fill', 'combo']);

function normalizeType(raw) {
  const trimmed = String(raw || '').trim();
  const key = trimmed.toLowerCase();
  return TYPE_MAP[key] || TYPE_MAP[trimmed] || null;
}

function isValidType(type) {
  return QUESTION_TYPES.includes(type);
}

function normalizeJudgeAnswer(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (['true', '1', '对', '正确', '√', '是', 'yes', 't'].includes(v)) return 'true';
  if (['false', '0', '错', '错误', '×', '否', 'no', 'f'].includes(v)) return 'false';
  return null;
}

function normalizeOptionKey(raw) {
  const v = String(raw || '').trim().toUpperCase();
  return /^[A-H]$/.test(v) ? v : null;
}

function normalizeMultipleAnswer(raw) {
  const parts = String(raw || '')
    .split(/[,，、\s|]+/)
    .map((p) => normalizeOptionKey(p))
    .filter(Boolean);
  return [...new Set(parts)].sort().join(',');
}

function parseFillAnswers(raw) {
  if (Array.isArray(raw)) return raw.map((a) => String(a).trim()).filter(Boolean);
  const text = String(raw || '').trim();
  if (!text) return [];
  if (text.startsWith('[')) {
    try {
      const arr = JSON.parse(text);
      if (Array.isArray(arr)) return arr.map((a) => String(a).trim()).filter(Boolean);
    } catch { /* fall through */ }
  }
  return text.split(/[|；;]/).map((a) => a.trim()).filter(Boolean);
}

function countFillBlanks(content) {
  const matches = String(content || '').match(/_{2,}|（\s*）|\(\s*\)|【\s*】|\[\s*\]/g);
  return Math.max(1, matches?.length || 1);
}

function normalizeQuestionPayload(data) {
  const type = normalizeType(data.type) || (isValidType(data.type) ? data.type : null);
  if (!type) return { error: '题型无效' };

  const content = String(data.content || '').trim();
  if (!content) return { error: '题目内容不能为空' };

  const score = data.score != null ? Number(data.score) : 2;
  if (Number.isNaN(score) || score < 0) return { error: '分值无效' };

  const base = { type, content, score };

  if (type === 'judge') {
    const answer = normalizeJudgeAnswer(data.answer);
    if (!answer) return { error: '判断题答案请填 正确/错误' };
    return { data: { ...base, answer, options: [] } };
  }

  if (type === 'single') {
    const options = normalizeOptions(data.options);
    if (!options.length) return { error: '单选题至少需要一个选项' };
    const answer = normalizeOptionKey(data.answer);
    if (!answer || !options.some((o) => o.key === answer)) {
      return { error: '单选题答案请填有效选项字母' };
    }
    return { data: { ...base, answer, options } };
  }

  if (type === 'multiple') {
    const options = normalizeOptions(data.options);
    if (!options.length) return { error: '多选题至少需要一个选项' };
    const answer = normalizeMultipleAnswer(data.answer);
    if (!answer) return { error: '多选题答案请填选项字母，如 A,B,C' };
    const keys = answer.split(',');
    if (!keys.every((k) => options.some((o) => o.key === k))) {
      return { error: '多选题答案包含无效选项' };
    }
    return { data: { ...base, answer, options } };
  }

  if (type === 'fill') {
    const answers = parseFillAnswers(data.answer);
    const blankCount = countFillBlanks(content);
    if (answers.length < blankCount) {
      return { error: `填空题需要 ${blankCount} 个答案，用 | 分隔` };
    }
    return { data: { ...base, answer: JSON.stringify(answers.slice(0, blankCount)), options: [] } };
  }

  if (type === 'essay') {
    const reference = String(data.answer || data.referenceAnswer || '').trim();
    return { data: { ...base, answer: reference, options: [] } };
  }

  if (type === 'combo') {
    const subQuestions = normalizeSubQuestions(data.subQuestions || data.options?.subQuestions || data.options);
    if (!subQuestions.length) return { error: '组合题至少包含一个子题' };
    const totalScore = subQuestions.reduce((s, q) => s + (Number(q.score) || 0), 0);
    return {
      data: {
        ...base,
        score: totalScore || score,
        answer: JSON.stringify(subQuestions.map((q) => q.answer)),
        options: { subQuestions }
      }
    };
  }

  if (type === 'practical') {
    const requirements = Array.isArray(data.requirements)
      ? data.requirements
      : String(data.requirements || data.options?.requirements || '')
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
    const uploadHint = String(data.uploadHint || data.options?.uploadHint || '').trim();
    return {
      data: {
        ...base,
        answer: '',
        options: { requirements, uploadHint }
      }
    };
  }

  return { error: '未知题型' };
}

function normalizeOptions(raw) {
  if (Array.isArray(raw)) {
    return raw
      .map((opt, idx) => {
        if (typeof opt === 'string') {
          const key = OPTION_KEYS[idx] || String.fromCharCode(65 + idx);
          return { key, text: opt.trim() };
        }
        const key = normalizeOptionKey(opt.key) || OPTION_KEYS[idx] || String.fromCharCode(65 + idx);
        return { key, text: String(opt.text || '').trim() };
      })
      .filter((o) => o.text);
  }
  return [];
}

const OPTION_KEYS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

function normalizeSubQuestions(raw) {
  const list = Array.isArray(raw) ? raw : (raw?.subQuestions || []);
  const result = [];
  for (const item of list) {
    const parsed = normalizeQuestionPayload({
      ...item,
      type: item.type,
      content: item.content,
      score: item.score ?? 1
    });
    if (parsed.data) {
      result.push({
        type: parsed.data.type,
        content: parsed.data.content,
        options: parsed.data.options,
        answer: parsed.data.answer,
        score: parsed.data.score
      });
    }
  }
  return result;
}

function parseUserAnswer(raw) {
  if (raw == null) return null;
  if (typeof raw === 'object') return raw;
  const text = String(raw);
  if (text.startsWith('{') || text.startsWith('[')) {
    try { return JSON.parse(text); } catch { return text; }
  }
  return text;
}

function compareFillAnswers(correctRaw, userRaw) {
  const correct = parseFillAnswers(typeof correctRaw === 'string' && correctRaw.startsWith('[')
    ? JSON.parse(correctRaw)
    : correctRaw);
  const user = Array.isArray(userRaw)
    ? userRaw
    : parseFillAnswers(userRaw);
  if (correct.length === 0) return false;
  if (user.length < correct.length) return false;
  return correct.every((ans, idx) => {
    const a = String(ans).trim().toLowerCase();
    const b = String(user[idx] ?? '').trim().toLowerCase();
    return a === b;
  });
}

function scoreAnswer(question, userAnswerRaw) {
  const userAnswer = parseUserAnswer(userAnswerRaw);
  if (userAnswer == null || userAnswer === '') {
    return { correct: false, score: 0, needsReview: false };
  }

  const maxScore = Number(question.score) || 0;

  if (question.type === 'essay' || question.type === 'practical') {
    return { correct: null, score: 0, needsReview: true };
  }

  if (question.type === 'single' || question.type === 'judge') {
    const correct = String(userAnswer) === String(question.answer);
    return { correct, score: correct ? maxScore : 0, needsReview: false };
  }

  if (question.type === 'multiple') {
    const expected = normalizeMultipleAnswer(question.answer);
    const actual = normalizeMultipleAnswer(
      Array.isArray(userAnswer) ? userAnswer.join(',') : userAnswer
    );
    const correct = expected === actual && expected.length > 0;
    return { correct, score: correct ? maxScore : 0, needsReview: false };
  }

  if (question.type === 'fill') {
    const correct = compareFillAnswers(question.answer, userAnswer);
    return { correct, score: correct ? maxScore : 0, needsReview: false };
  }

  if (question.type === 'combo') {
    const subQuestions = question.options?.subQuestions || [];
    let correctAnswers = [];
    try {
      correctAnswers = JSON.parse(question.answer || '[]');
    } catch {
      correctAnswers = [];
    }
    const userMap = typeof userAnswer === 'object' && !Array.isArray(userAnswer) ? userAnswer : {};
    let earned = 0;
    let allCorrect = subQuestions.length > 0;

    subQuestions.forEach((sub, idx) => {
      const subUser = userMap[String(idx)] ?? userMap[idx];
      const subQ = { ...sub, answer: correctAnswers[idx] ?? sub.answer };
      const result = scoreAnswer(subQ, subUser);
      earned += result.score;
      if (!result.correct) allCorrect = false;
    });

    return {
      correct: allCorrect,
      score: Math.round(earned * 10) / 10,
      needsReview: false
    };
  }

  return { correct: false, score: 0, needsReview: false };
}

function formatTypeLabel(type) {
  return TYPE_LABELS[type] || type;
}

module.exports = {
  QUESTION_TYPES,
  TYPE_LABELS,
  TYPE_MAP,
  AUTO_GRADED,
  normalizeType,
  isValidType,
  normalizeQuestionPayload,
  normalizeMultipleAnswer,
  parseFillAnswers,
  countFillBlanks,
  scoreAnswer,
  formatTypeLabel,
  OPTION_KEYS
};
