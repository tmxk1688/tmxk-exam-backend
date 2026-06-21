const fs = require('fs');
const path = require('path');
const { ZipArchive } = require('archiver');

const MATERIALS_DIR = path.join(__dirname, '..', '..', '..', '考生素材包');
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);

function ensureMaterialsDir() {
  if (!fs.existsSync(MATERIALS_DIR)) {
    fs.mkdirSync(MATERIALS_DIR, { recursive: true });
  }
}

function isImageFile(name) {
  return IMAGE_EXT.has(path.extname(name).toLowerCase());
}

function formatFileRow(name) {
  const full = path.join(MATERIALS_DIR, name);
  const stat = fs.statSync(full);
  const ext = path.extname(name).toLowerCase();
  return {
    name,
    size: stat.size,
    url: `/materials/${encodeURIComponent(name)}`,
    isImage: isImageFile(name),
    ext: ext.replace('.', '') || 'file'
  };
}

function listMaterials() {
  ensureMaterialsDir();
  const entries = fs.readdirSync(MATERIALS_DIR, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && !e.name.startsWith('.') && e.name !== '考生素材包.zip')
    .map((e) => formatFileRow(e.name))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
}

function getMaterialsInfo() {
  const files = listMaterials();
  const images = files.filter((f) => f.isImage);
  return {
    title: '官方考生素材包',
    description: '官方统一免费提供的内置素材库，含 LOGO、参考图、背景等配套素材，供 PS 合成与 AI 创作使用。可预览后单独下载，或一键打包下载全部。',
    fileCount: files.length,
    imageCount: images.length,
    bundleUrl: files.length > 0 ? '/api/exam/materials/bundle' : null,
    files
  };
}

function sanitizeMaterialName(name) {
  const base = path.basename(String(name || ''));
  return base.replace(/[^\w.\-()\u4e00-\u9fff]/g, '_').slice(0, 180) || '';
}

function deleteMaterialFile(name) {
  const safe = sanitizeMaterialName(name);
  if (!safe) return false;
  const full = path.join(MATERIALS_DIR, safe);
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return false;
  fs.unlinkSync(full);
  return true;
}

function streamMaterialsBundle(res) {
  const files = listMaterials();
  if (files.length === 0) {
    res.status(404).json({ error: '素材包为空' });
    return;
  }

  const filename = encodeURIComponent('考生素材包.zip');
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${filename}`);

  const archive = new ZipArchive({ zlib: { level: 5 } });
  archive.on('error', (err) => {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  });
  archive.pipe(res);

  for (const file of files) {
    archive.file(path.join(MATERIALS_DIR, file.name), { name: file.name });
  }
  archive.finalize();
}

module.exports = {
  MATERIALS_DIR,
  ensureMaterialsDir,
  listMaterials,
  getMaterialsInfo,
  sanitizeMaterialName,
  deleteMaterialFile,
  streamMaterialsBundle,
  isImageFile
};
