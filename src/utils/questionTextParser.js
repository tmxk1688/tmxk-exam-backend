const { normalizeType, normalizeQuestionPayload, countFillBlanks } = require('./questionTypes');

const TYPE_HEADER_RE = /^[\[【]?\s*(单选|多选|判断|填空|问答|简答|组合|实操|单选题|多选题|判断题|填空题|问答题|简答题|组合题|实操题)\s*题?\s*[\]】]?/i;
const NUMBERED_RE = /^(\d+)[.、．)\]】]\s*/;
const OPTION_RE = /^([A-Ha-h])[.、．:：)\]】]\s*(.+)$/;
const SUB_OPTION_RE = /^([①②③④⑤⑥⑦⑧]|[（(][1-8][)）])\s*(.+)$/;

function stripNumberPrefix(line) {
  return line.replace(NUMBERED_RE, '').trim();
}

function detectTypeFromLine(line) {
  const m = line.match(TYPE_HEADER_RE);
  if (m) return normalizeType(m[1]);
  if (/^【?多选/.test(line)) return 'multiple';
  if (/^【?单选/.test(line)) return 'single';
  if (/^【?判断/.test(line)) return 'judge';
  if (/^【?填空/.test(line)) return 'fill';
  if (/^【?(问答|简答)/.test(line)) return 'essay';
  if (/^【?组合/.test(line)) return 'combo';
  if (/^【?实操/.test(line)) return 'practical';
  return null;
}

function parseScoreFromLine(line) {
  const m = line.match(/[（(]\s*(\d+(?:\.\d+)?)\s*分\s*[)）]/);
  return m ? Number(m[1]) : null;
}

function splitBlocks(text) {
  const lines = String(text || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  const blocks = [];
  let current = null;

  for (const line of lines) {
    const isNewQuestion =
      TYPE_HEADER_RE.test(line) ||
      (/^\d+[.、．]/.test(line) && detectTypeFromLine(line)) ||
      (/^\d+[.、．]/.test(line) && !current);

    if (isNewQuestion && current?.lines?.length) {
      blocks.push(current);
      current = null;
    }

    if (!current) {
      current = { lines: [] };
    }
    current.lines.push(line);
  }

  if (current?.lines?.length) blocks.push(current);
  return blocks;
}

function parseOptionsFromLines(lines) {
  const options = [];
  for (const line of lines) {
    const m = line.match(OPTION_RE);
    if (m) {
      options.push({ key: m[1].toUpperCase(), text: m[2].trim() });
    }
  }
  return options;
}

function parseAnswerLine(lines) {
  for (const line of lines) {
    const m = line.match(/^(?:答案|正确答案|参考答案)[:：]\s*(.+)$/i);
    if (m) return m[1].trim();
  }
  return '';
}

function parseBlock(block) {
  const lines = block.lines.map(stripNumberPrefix);
  let type = null;
  let contentLines = [];
  const optionLines = [];
  const requirementLines = [];
  let inRequirements = false;

  for (const rawLine of lines) {
    const line = stripNumberPrefix(rawLine);
    const detected = detectTypeFromLine(line);
    if (detected && !type) {
      type = detected;
      const rest = line.replace(TYPE_HEADER_RE, '').trim();
      if (rest) contentLines.push(rest);
      continue;
    }

    if (/^要求[:：]?$/.test(line) || /^任务要求/.test(line)) {
      inRequirements = true;
      continue;
    }

    if (OPTION_RE.test(line)) {
      optionLines.push(line);
      continue;
    }

    if (inRequirements) {
      requirementLines.push(line.replace(/^[-•*]\s*/, ''));
      continue;
    }

    if (/^(答案|正确答案|参考答案)/.test(line)) continue;
    contentLines.push(line);
  }

  const fullText = lines.join('\n');
  if (!type) {
    if (/多选/.test(fullText)) type = 'multiple';
    else if (optionLines.length >= 2) type = 'single';
    else if (/正确|错误|对错|判断/.test(fullText)) type = 'judge';
    else if (/_{2,}|（\s*）|\(\s*\)/.test(fullText)) type = 'fill';
    else if (/简答|问答|阐述|说明/.test(fullText)) type = 'essay';
    else if (/阅读下面|根据材料|组合/.test(fullText)) type = 'combo';
    else if (/实操|上传|作品|文件/.test(fullText)) type = 'practical';
    else type = 'single';
  }

  const score = parseScoreFromLine(fullText) ?? 2;
  let content = contentLines.join('\n').trim();
  content = content.replace(TYPE_HEADER_RE, '').trim();
  const answerRaw = parseAnswerLine(lines);
  const options = parseOptionsFromLines(optionLines);

  if (type === 'multiple' && !answerRaw && options.length) {
    return null;
  }

  if (type === 'combo') {
    return parseComboBlock(content || contentLines.join('\n'), score, lines);
  }

  const payload = {
    type,
    content: content || lines.join('\n'),
    score,
    options,
    answer: answerRaw,
    requirements: requirementLines,
    uploadHint: requirementLines.join('\n')
  };

  if (type === 'fill' && !answerRaw) {
    payload.answer = '';
  }

  if (type === 'judge' && !answerRaw) {
    if (/错误|×|否/.test(fullText)) payload.answer = '错误';
    else if (/正确|√|是/.test(fullText)) payload.answer = '正确';
  }

  if ((type === 'single' || type === 'multiple') && options.length === 0) {
    return null;
  }

  const normalized = normalizeQuestionPayload(payload);
  return normalized.data || null;
}

function parseComboBlock(material, score, lines) {
  const subQuestions = [];
  let currentSub = null;

  for (const line of lines) {
    if (/^材料[:：]/.test(line)) continue;
    const subMatch = line.match(/^[(（]([1-9])[)）][.、．]?\s*(.+)/) || line.match(/^(\d+)[.、．]\s*(.+)/);
    if (subMatch && detectTypeFromLine(subMatch[2])) {
      if (currentSub) subQuestions.push(currentSub);
      currentSub = { lines: [subMatch[2]] };
      continue;
    }
    if (currentSub) currentSub.lines.push(line);
  }
  if (currentSub) subQuestions.push(currentSub);

  const parsedSubs = subQuestions
    .map((sub) => parseBlock({ lines: sub.lines }))
    .filter(Boolean);

  if (!parsedSubs.length) {
    const normalized = normalizeQuestionPayload({
      type: 'essay',
      content: material,
      score,
      answer: parseAnswerLine(lines)
    });
    return normalized.data || null;
  }

  const normalized = normalizeQuestionPayload({
    type: 'combo',
    content: material || '阅读下列材料，回答问题：',
    score,
    subQuestions: parsedSubs
  });
  return normalized.data || null;
}

function parseQuestionText(text) {
  const blocks = splitBlocks(text);
  const questions = [];
  const errors = [];

  if (!blocks.length) {
    const single = parseBlock({ lines: String(text || '').split('\n').map((l) => l.trim()).filter(Boolean) });
    if (single) questions.push(single);
    else errors.push('未能识别有效题目，请检查格式');
    return { questions, errors };
  }

  blocks.forEach((block, index) => {
    const parsed = parseBlock(block);
    if (parsed) questions.push(parsed);
    else errors.push(`第 ${index + 1} 段未能识别为有效题目`);
  });

  return { questions, errors };
}

function parseWordText(rawText) {
  const cleaned = String(rawText || '')
    .replace(/\t/g, ' ')
    .replace(/\u00a0/g, ' ')
    .replace(/\n{3,}/g, '\n\n');
  return parseQuestionText(cleaned);
}

module.exports = {
  parseQuestionText,
  parseWordText,
  splitBlocks,
  detectTypeFromLine
};
