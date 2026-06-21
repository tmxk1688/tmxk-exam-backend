const XLSX = require('xlsx');
const {
  normalizeType,
  normalizeQuestionPayload,
  formatTypeLabel,
  QUESTION_TYPES
} = require('./questionTypes');
const { parseWordText } = require('./questionTextParser');

function pickField(row, keys) {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null && String(row[key]).trim() !== '') {
      return String(row[key]).trim();
    }
  }
  return '';
}

function pickOptionFields(row) {
  const options = [];
  for (const key of ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', '选项A', '选项B', '选项C', '选项D', '选项E', '选项F']) {
    const text = pickField(row, [key, `option${key}`, `选项${key}`]);
    if (text) {
      const letter = key.length === 1 ? key : key.replace('选项', '');
      options.push({ key: letter.toUpperCase(), text });
    }
  }
  if (options.length) return options;

  for (let i = 0; i < 8; i += 1) {
    const letter = String.fromCharCode(65 + i);
    const text = pickField(row, [letter, `option${letter}`, `选项${letter}`]);
    if (text) options.push({ key: letter, text });
  }
  return options;
}

function parseQuestionRow(row, index) {
  const typeRaw = pickField(row, ['题型', 'type', '题目类型']);
  const type = normalizeType(typeRaw);
  const content = pickField(row, ['题目', '题目内容', 'content', '题干']);
  const scoreRaw = pickField(row, ['分值', '分数', 'score']);
  const score = scoreRaw ? Number(scoreRaw) : 2;
  const answer = pickField(row, ['答案', '正确答案', 'answer', '参考答案']);
  const requirements = pickField(row, ['要求', '任务要求', 'requirements']);
  const uploadHint = pickField(row, ['上传说明', 'uploadHint']);

  if (!type) {
    return { error: `第 ${index + 1} 行：题型无效（支持：${QUESTION_TYPES.map(formatTypeLabel).join('、')}）` };
  }
  if (!content) {
    return { error: `第 ${index + 1} 行：题目内容不能为空` };
  }

  const payload = {
    type,
    content,
    score,
    answer,
    options: pickOptionFields(row),
    requirements: requirements ? requirements.split(/[|；;\n]/).map((s) => s.trim()).filter(Boolean) : [],
    uploadHint
  };

  const normalized = normalizeQuestionPayload(payload);
  if (normalized.error) {
    return { error: `第 ${index + 1} 行：${normalized.error}` };
  }
  return { data: normalized.data };
}

function parseQuestionSheet(rows) {
  const questions = [];
  const errors = [];

  rows.forEach((row, index) => {
    const hasContent = pickField(row, ['题目', '题目内容', 'content', '题干']);
    if (!hasContent) return;
    const result = parseQuestionRow(row, index);
    if (result.error) errors.push(result.error);
    else if (result.data) questions.push(result.data);
  });

  return { questions, errors };
}

function parseQuestionFile(buffer, filename = '') {
  const ext = (filename || '').toLowerCase();

  if (ext.endsWith('.docx')) {
    return parseWordFile(buffer);
  }

  if (ext.endsWith('.csv')) {
    const text = buffer.toString('utf8');
    const wb = XLSX.read(text, { type: 'string' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    return Promise.resolve(parseQuestionSheet(rows));
  }

  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  return Promise.resolve(parseQuestionSheet(rows));
}

async function parseWordFile(buffer) {
  let mammoth;
  try {
    mammoth = require('mammoth');
  } catch {
    return { questions: [], errors: ['Word 导入需要 mammoth 依赖，请在后端目录执行 npm install'] };
  }

  try {
    const result = await mammoth.extractRawText({ buffer });
    return parseWordText(result.value || '');
  } catch (err) {
    return { questions: [], errors: [`Word 文档解析失败：${err.message}`] };
  }
}

function buildImportTemplateSheet() {
  return [
    {
      题型: '单选',
      题目: '示例单选题题干',
      分值: 2,
      答案: 'A',
      A: '选项A内容',
      B: '选项B内容',
      C: '选项C内容',
      D: '选项D内容'
    },
    {
      题型: '多选',
      题目: '示例多选题题干（多选）',
      分值: 3,
      答案: 'A,C',
      A: '选项A',
      B: '选项B',
      C: '选项C',
      D: '选项D'
    },
    {
      题型: '判断',
      题目: '示例判断题题干',
      分值: 2,
      答案: '正确'
    },
    {
      题型: '填空',
      题目: '中国的首都是___，最大城市是___',
      分值: 4,
      答案: '北京|上海'
    },
    {
      题型: '问答',
      题目: '简述 AIGC 在创意设计中的应用',
      分值: 10,
      答案: '参考答案（供阅卷参考）'
    },
    {
      题型: '组合',
      题目: '阅读材料：……（组合题材料）',
      分值: 6,
      答案: ''
    },
    {
      题型: '实操',
      题目: '使用 PS 完成海报设计并上传',
      分值: 0,
      答案: '',
      要求: '尺寸1920x1080|格式PSD|含图层'
    }
  ];
}

function buildImportTemplateBuffer() {
  const ws = XLSX.utils.json_to_sheet(buildImportTemplateSheet());
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '试题导入模板');
  ws['!cols'] = [
    { wch: 8 }, { wch: 48 }, { wch: 6 }, { wch: 16 },
    { wch: 18 }, { wch: 18 }, { wch: 18 }, { wch: 18 }, { wch: 24 }
  ];
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = {
  parseQuestionFile,
  parseWordFile,
  buildImportTemplateBuffer,
  buildImportTemplateSheet,
  parseQuestionSheet
};
