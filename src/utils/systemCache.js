const fs = require('fs');
const path = require('path');
const { clearCaptchaStore, getCaptchaStoreStats } = require('./captcha');
const { clearStaleProctorSessions, getProctorCacheStats } = require('../proctoring');
const { clearOldOperationLogs, getOperationLogStats } = require('./auditLog');

const UPLOADS_ROOT = path.join(__dirname, '..', '..', 'uploads');
const UPLOAD_SUBDIRS = new Set(['avatars', 'practical', 'transcripts', 'materials']);

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size < 10 && unit > 0 ? size.toFixed(1) : Math.round(size)} ${units[unit]}`;
}

function scanUploadTempFiles() {
  if (!fs.existsSync(UPLOADS_ROOT)) {
    return { count: 0, bytes: 0, files: [] };
  }

  const files = [];
  let bytes = 0;

  for (const name of fs.readdirSync(UPLOADS_ROOT)) {
    const full = path.join(UPLOADS_ROOT, name);
    if (UPLOAD_SUBDIRS.has(name)) continue;
    try {
      const stat = fs.statSync(full);
      if (stat.isFile()) {
        files.push({ name, bytes: stat.size });
        bytes += stat.size;
      }
    } catch { /* skip */ }
  }

  return { count: files.length, bytes, files };
}

function clearUploadTempFiles() {
  const scanned = scanUploadTempFiles();
  let removed = 0;
  let freedBytes = 0;

  for (const file of scanned.files) {
    try {
      fs.unlinkSync(path.join(UPLOADS_ROOT, file.name));
      removed += 1;
      freedBytes += file.bytes;
    } catch { /* skip */ }
  }

  return { removed, freedBytes };
}

async function getCacheOverview(retainLogDays = 90) {
  const uploadTemp = scanUploadTempFiles();
  const captcha = getCaptchaStoreStats();
  const proctor = getProctorCacheStats();
  const logStats = await getOperationLogStats(retainLogDays);
  const retainDays = logStats.retainDays;

  return {
    uploadTemp: {
      label: '上传临时文件',
      description: '上传过程中残留的临时文件（不含头像、实操、成绩单等业务文件）',
      count: uploadTemp.count,
      cleanable: uploadTemp.count,
      bytes: uploadTemp.bytes,
      sizeLabel: uploadTemp.count > 0
        ? `${uploadTemp.count} 个文件，共 ${formatBytes(uploadTemp.bytes)}`
        : '0 个文件'
    },
    captcha: {
      label: '验证码缓存',
      description: '内存中的图形验证码（清理后未提交的验证码需刷新页面重新获取）',
      count: captcha.total,
      cleanable: captcha.total,
      expiredCount: captcha.expired,
      activeCount: captcha.active,
      bytes: 0,
      sizeLabel: captcha.total > 0
        ? `共 ${captcha.total} 条（含有效 ${captcha.active} 条，均可清理）`
        : '0 条'
    },
    proctorSessions: {
      label: '监考内存会话',
      description: '已离线或超时的监考连接缓存（进行中的考试会话不会清理）',
      count: proctor.total,
      cleanable: proctor.stale,
      staleCount: proctor.stale,
      activeCount: proctor.active,
      bytes: 0,
      sizeLabel: proctor.stale > 0
        ? `共 ${proctor.total} 条，可清理 ${proctor.stale} 条（离线/超时）`
        : proctor.total > 0
          ? `共 ${proctor.total} 条，均在考中（暂无可清理）`
          : '0 条'
    },
    operationLogs: {
      label: '历史操作日志',
      description: retainDays === 0
        ? '将删除全部管理员操作日志（不影响考生与成绩数据）'
        : `保留最近 ${retainDays} 天内的日志，更早的记录可清理以减小数据库体积`,
      totalCount: logStats.total,
      count: logStats.cleanable,
      cleanable: logStats.cleanable,
      retainDays,
      retainCount: logStats.retainCount,
      bytes: 0,
      sizeLabel: logStats.total === 0
        ? '0 条'
        : logStats.cleanable > 0
          ? `共 ${logStats.total} 条，可清理 ${logStats.cleanable} 条`
          : retainDays === 0
            ? `共 ${logStats.total} 条，可全部清理`
            : `共 ${logStats.total} 条，暂无可清理（保留 ${retainDays} 天内）`
    }
  };
}

async function clearSystemCache(options = {}) {
  const result = {
    uploadTemp: null,
    captcha: null,
    proctorSessions: null,
    operationLogs: null
  };

  if (options.uploadTemp) {
    result.uploadTemp = clearUploadTempFiles();
  }

  if (options.captcha) {
    result.captcha = clearCaptchaStore({ expiredOnly: false });
  }

  if (options.proctorSessions) {
    result.proctorSessions = clearStaleProctorSessions();
  }

  if (options.operationLogs) {
    const days = options.operationLogsDays != null
      ? normalizeRetainDays(options.operationLogsDays, 90)
      : 90;
    result.operationLogs = await clearOldOperationLogs(days);
  }

  return result;
}

function normalizeRetainDays(days, fallback = 90) {
  const parsed = parseInt(days, 10);
  return Number.isNaN(parsed) ? fallback : Math.max(0, parsed);
}

module.exports = {
  getCacheOverview,
  clearSystemCache,
  formatBytes
};
