const db = require('../db');

const ACTION_LABELS = {
  login: '管理员登录',
  add_candidate: '添加考生',
  update_candidate: '编辑考生',
  delete_candidate: '删除考生',
  batch_import: '批量导入考生',
  batch_delete: '批量删除考生',
  batch_reset: '批量重置考试',
  batch_assign: '批量分配考场',
  reset_exam: '重置考试',
  upload_avatar: '上传考生头像',
  clear_all: '清空全部考生',
  update_settings: '更新考试设置',
  change_password: '修改管理员密码',
  export_records: '导出成绩 Excel',
  export_proctor_report: '导出监考报告',
  score_practical: '实操题评分',
  batch_score_practical: '批量实操评分',
  delete_record: '删除成绩记录',
  mark_abnormal: '标记异常考生',
  clear_abnormal: '清除异常标记',
  extend_exam_time: '延长考试时间',
  set_admin_note: '保存考务备注',
  reopen_practical: '开放实操重传',
  upload_material: '上传考生素材',
  delete_material: '删除考生素材',
  add_announcement: '发布公告',
  update_announcement: '更新公告',
  delete_announcement: '删除公告',
  export_comprehensive_scores: '导出综合成绩',
  lock_scores: '锁定成绩',
  unlock_scores: '解锁成绩',
  create_paper: '创建试卷',
  update_paper: '更新试卷',
  delete_paper: '删除试卷',
  activate_paper: '启用试卷',
  duplicate_paper: '复制试卷',
  add_question: '添加试题',
  update_question: '更新试题',
  delete_question: '删除试题',
  seed_default_paper: '导入默认试卷',
  import_questions: '批量导入试题',
  clear_system_cache: '清理系统缓存'
};

async function initAuditLog() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS operation_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_id INTEGER,
      admin_username TEXT NOT NULL,
      action TEXT NOT NULL,
      target_type TEXT DEFAULT '',
      target_id TEXT DEFAULT '',
      detail TEXT DEFAULT '',
      ip TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    )
  `);
  await db.exec('CREATE INDEX IF NOT EXISTS idx_operation_logs_created ON operation_logs(created_at DESC)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_operation_logs_action ON operation_logs(action)');
}

initAuditLog();

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return String(forwarded).split(',')[0].trim();
  return req.socket?.remoteAddress || '';
}

async function logOperation({ adminId, adminUsername, action, targetType = '', targetId = '', detail = '', ip = '' }) {
  await db.prepare(`
    INSERT INTO operation_logs (admin_id, admin_username, action, target_type, target_id, detail, ip)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    adminId ?? null,
    adminUsername || 'unknown',
    action,
    targetType,
    String(targetId ?? ''),
    detail,
    ip
  );
}

async function writeLog(req, action, opts = {}) {
  await logOperation({
    adminId: req.admin?.id,
    adminUsername: req.admin?.username || opts.username || 'unknown',
    action,
    targetType: opts.targetType || '',
    targetId: opts.targetId ?? '',
    detail: opts.detail || '',
    ip: getClientIp(req)
  });
}

async function getLogs({ page = 1, limit = 20, action, search, adminUsername } = {}) {
  const safeLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const offset = (safePage - 1) * safeLimit;

  const conditions = [];
  const params = [];

  if (action) {
    conditions.push('action = ?');
    params.push(action);
  }
  if (adminUsername) {
    conditions.push('admin_username LIKE ?');
    params.push(`%${adminUsername}%`);
  }
  if (search) {
    conditions.push('(detail LIKE ? OR target_id LIKE ? OR admin_username LIKE ?)');
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }

  const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
  const countResult = await db.prepare(`SELECT COUNT(*) as count FROM operation_logs${where}`).get(...params);
  const total = countResult?.count || 0;

  const rows = await db.prepare(`
    SELECT * FROM operation_logs${where}
    ORDER BY id DESC
    LIMIT ? OFFSET ?
  `).all(...params, safeLimit, offset);

  return {
    logs: rows.map((r) => ({
      id: r.id,
      adminUsername: r.admin_username,
      action: r.action,
      actionLabel: ACTION_LABELS[r.action] || r.action,
      targetType: r.target_type,
      targetId: r.target_id,
      detail: r.detail,
      ip: r.ip,
      createdAt: r.created_at
    })),
    total,
    page: safePage,
    limit: safeLimit,
    totalPages: Math.max(1, Math.ceil(total / safeLimit))
  };
}

function getActionOptions() {
  return Object.entries(ACTION_LABELS).map(([value, label]) => ({ value, label }));
}

function normalizeRetainDays(days, fallback = 90) {
  const parsed = parseInt(days, 10);
  return Number.isNaN(parsed) ? fallback : Math.max(0, parsed);
}

async function countOldOperationLogs(days = 90) {
  return getOperationLogStats(days);
}

async function getOperationLogStats(retainDays = 90) {
  const totalResult = await db.prepare('SELECT COUNT(*) as c FROM operation_logs').get();
  const total = totalResult?.c || 0;
  const safeDays = normalizeRetainDays(retainDays, 90);
  if (safeDays === 0) {
    return { total, cleanable: total, retainDays: 0, retainCount: 0 };
  }

  // MongoDB doesn't support datetime subtraction directly, so we use a date string comparison
  const dateThreshold = new Date();
  dateThreshold.setDate(dateThreshold.getDate() - safeDays);
  const thresholdStr = dateThreshold.toLocaleString('zh-CN', { hour12: false });

  const row = await db.prepare(`
    SELECT COUNT(*) as c FROM operation_logs
    WHERE created_at < ?
  `).get(thresholdStr);

  const cleanable = row?.c || 0;
  return {
    total,
    cleanable,
    retainDays: safeDays,
    retainCount: total - cleanable
  };
}

async function clearOldOperationLogs(days = 90) {
  const safeDays = normalizeRetainDays(days, 90);
  const before = await getOperationLogStats(safeDays);

  if (safeDays === 0) {
    const result = await db.prepare('DELETE FROM operation_logs').run();
    return { removed: result.changes, days: 0, matched: before.cleanable, remaining: 0 };
  }

  const dateThreshold = new Date();
  dateThreshold.setDate(dateThreshold.getDate() - safeDays);
  const thresholdStr = dateThreshold.toLocaleString('zh-CN', { hour12: false });

  const result = await db.prepare(`
    DELETE FROM operation_logs
    WHERE created_at < ?
  `).run(thresholdStr);

  const remainingResult = await db.prepare('SELECT COUNT(*) as c FROM operation_logs').get();
  const remaining = remainingResult?.c || 0;
  return { removed: result.changes, days: safeDays, matched: before.cleanable, remaining };
}

module.exports = {
  ACTION_LABELS,
  getClientIp,
  logOperation,
  writeLog,
  getLogs,
  getActionOptions,
  countOldOperationLogs,
  clearOldOperationLogs,
  getOperationLogStats
};
