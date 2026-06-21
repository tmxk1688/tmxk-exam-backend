const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

const UPLOADS_ROOT = path.join(__dirname, '..', '..', 'uploads');

function resolveChineseFont() {
  const candidates = [
    path.join(__dirname, '..', 'assets', 'SimHei.ttf'),
    'C:\\Windows\\Fonts\\simhei.ttf',
    'C:\\Windows\\Fonts\\msyh.ttf',
    'C:\\Windows\\Fonts\\simkai.ttf',
    '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc',
    '/System/Library/Fonts/PingFang.ttc'
  ];
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    if (p.endsWith('.ttc')) continue;
    return p;
  }
  return null;
}

function resolveImagePath(urlOrRel) {
  if (!urlOrRel) return null;
  let rel = urlOrRel;
  if (rel.startsWith('/uploads/')) rel = rel.slice('/uploads/'.length);
  const full = path.join(UPLOADS_ROOT, rel.replace(/\//g, path.sep));
  return fs.existsSync(full) ? full : null;
}

function safeImage(doc, imagePath, options = {}) {
  if (!imagePath) return false;
  try {
    doc.image(imagePath, options);
    return true;
  } catch {
    return false;
  }
}

function ensureSpace(doc, needed = 80) {
  if (doc.y + needed > doc.page.height - doc.page.margins.bottom) {
    doc.addPage();
    drawWatermark(doc, doc._watermarkText);
  }
}

function drawWatermark(doc, text) {
  if (!text) return;
  const { width, height } = doc.page;
  doc.save();
  doc.opacity(0.06);
  doc.fillColor('#b91c1c');
  doc.fontSize(22);
  for (let row = 0; row < 5; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      const x = col * (width / 2.5) - 40;
      const y = row * 140 + 60;
      doc.save();
      doc.translate(x, y);
      doc.rotate(-32);
      doc.text(text, 0, 0, { lineBreak: false });
      doc.restore();
    }
  }
  doc.restore();
  doc.opacity(1);
  doc.fillColor('#000');
}

function buildTranscriptPdfBuffer(transcript) {
  if (!transcript) throw new Error('成绩单数据不存在');

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 48, size: 'A4', autoFirstPage: true });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const fontPath = resolveChineseFont();
    if (fontPath) doc.font(fontPath);

    const watermarkText = transcript.watermarkText || '天马行空创意团队 · 正式成绩单';
    doc._watermarkText = watermarkText;
    drawWatermark(doc, watermarkText);

    doc.fontSize(9).fillColor('#475569');
    doc.text(`成绩单编号：${transcript.transcriptNo || '待签发'}`, { continued: true });
    doc.text(`    档案编号：${transcript.archiveNo || '—'}`, { continued: true });
    doc.text(`    核验码：${transcript.verificationCode || '—'}`);
    doc.moveDown(0.6);
    doc.fillColor('#b91c1c');

    doc.fontSize(20).text(transcript.title || '考试成绩单', { align: 'center' });
    doc.moveDown(0.3);
    doc.fontSize(12).fillColor('#333').text(transcript.examName || '', { align: 'center' });
    if (transcript.examSubtitle) {
      doc.fontSize(10).fillColor('#666').text(transcript.examSubtitle, { align: 'center' });
    }
    doc.moveDown(0.8);
    doc.fillColor('#000');

    const avatarPath = resolveImagePath(transcript.avatarUrl);
    if (avatarPath) {
      safeImage(doc, avatarPath, { fit: [72, 90], align: 'left' });
      doc.moveDown(0.5);
    }

    const infoLines = [
      ['姓名', transcript.name],
      ['身份证号', transcript.idNumber || '—'],
      ['准考证号', transcript.ticketNo],
      ['报考职位', transcript.position || '—'],
      ['确认岗位', transcript.adjustedPosition || transcript.position || '—'],
      ['考试时间', transcript.examTime || transcript.submittedAt || '—'],
      ['考点/考场/座位', [transcript.examSite, transcript.examRoom, transcript.seatNo].filter(Boolean).join(' · ') || '—']
    ];

    doc.fontSize(11);
    for (const [label, value] of infoLines) {
      doc.text(`${label}：${value}`);
    }

    doc.moveDown(0.8);
    doc.fontSize(13).text('成绩明细', { underline: true });
    doc.moveDown(0.4);
    doc.fontSize(11);
    doc.text(`客观题：${transcript.objectiveScore ?? '—'} / ${transcript.objectiveMax}`);
    doc.text(`实操题：${transcript.practicalScored
      ? `${transcript.practicalScore} / ${transcript.practicalMax}`
      : `待评分 / ${transcript.practicalMax}`}`);
    if (transcript.practicalScored) {
      doc.text(`总分：${transcript.totalScore} / ${transcript.totalMax}`);
    }
    if (transcript.practicalComment) {
      doc.text(`评语：${transcript.practicalComment}`);
    }

    doc.moveDown(0.8);
    doc.fontSize(13).text('存档信息', { underline: true });
    doc.moveDown(0.4);
    doc.fontSize(10);
    const archiveLines = [
      ['档案类别', transcript.archiveCategory || '考试成绩单及考试过程电子档案'],
      ['成绩单编号', transcript.transcriptNo || '待签发'],
      ['档案编号', transcript.archiveNo || '—'],
      ['核验码', transcript.verificationCode || '—'],
      ['保管期限', transcript.archiveRetention || '长期保存（不少于10年）'],
      ['存档路径', transcript.archivePath || '—'],
      ['存档内容', (transcript.archiveItems || []).join(' · ') || '—'],
      ['记录编号', `REC-${String(transcript.recordId).padStart(6, '0')}`]
    ];
    for (const [label, value] of archiveLines) {
      doc.text(`${label}：${value}`);
    }

    const evidence = [
      { label: '手写签字', path: resolveImagePath(transcript.signatureUrl) },
      { label: '考试页面截图', path: resolveImagePath(transcript.examPageScreenshotUrl) },
      ...(transcript.proctorCaptures || []).map((cap) => ({
        label: cap.label || '考试过程拍摄',
        path: resolveImagePath(cap.url || cap.path)
      }))
    ].filter((item) => item.path);

    if (evidence.length) {
      doc.moveDown(0.8);
      doc.fontSize(13).text('考试过程存档', { underline: true });
      doc.moveDown(0.4);
      for (const item of evidence) {
        ensureSpace(doc, 180);
        doc.fontSize(10).fillColor('#666').text(item.label);
        doc.fillColor('#000');
        safeImage(doc, item.path, { fit: [480, 160], align: 'center' });
        doc.moveDown(0.6);
      }
    }

    doc.moveDown(0.5);
    doc.fontSize(9).fillColor('#666');
    if (transcript.submittedAt) doc.text(`交卷时间：${transcript.submittedAt}`);
    if (transcript.closureCompletedAt) doc.text(`考后确认时间：${transcript.closureCompletedAt}`);
    if (transcript.scoredAt) doc.text(`评分时间：${transcript.scoredAt}`);
    if (transcript.transcriptIssuedAt) doc.text(`成绩单签发：${transcript.transcriptIssuedAt}`);
    doc.text('本成绩单由考试系统自动生成，编号与核验码可用于真伪核验。');

    doc.end();
  });
}

module.exports = {
  buildTranscriptPdfBuffer
};
