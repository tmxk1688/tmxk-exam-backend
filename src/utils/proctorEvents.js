const db = require('../db');

const EVENT_LABELS = {
  connected: '考生接入监考',
  page_hidden: '切出考试页面',
  page_visible: '返回考试页面',
  screen_share_started: '开启屏幕共享',
  screen_share_ended: '停止屏幕共享',
  camera_started: '开启摄像头',
  camera_stopped: '关闭摄像头',
  status_warning: '状态变为注意',
  status_alert: '状态变为异常',
  status_offline: '考生离线',
  focus_threshold: '切屏次数过多'
};

const EVENT_LEVELS = {
  connected: 'info',
  page_visible: 'info',
  screen_share_started: 'info',
  camera_started: 'info',
  page_hidden: 'alert',
  screen_share_ended: 'warning',
  camera_stopped: 'warning',
  status_warning: 'warning',
  status_alert: 'alert',
  status_offline: 'alert',
  focus_threshold: 'alert'
};

async function initProctorEvents() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS proctor_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      record_id INTEGER,
      candidate_id INTEGER,
      ticket_no TEXT,
      name TEXT,
      event_type TEXT NOT NULL,
      level TEXT DEFAULT 'info',
      message TEXT,
      detail TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    )
  `);
  await db.exec('CREATE INDEX IF NOT EXISTS idx_proctor_events_created ON proctor_events(created_at DESC)');
}

initProctorEvents();

async function logProctorEvent({ recordId, candidateId, ticketNo, name, eventType, level, message, detail }) {
  const resolvedLevel = level || EVENT_LEVELS[eventType] || 'info';
  const resolvedMessage = message || EVENT_LABELS[eventType] || eventType;
  const now = new Date().toLocaleString('zh-CN', { hour12: false });

  const result = await db.prepare(`
    INSERT INTO proctor_events (record_id, candidate_id, ticket_no, name, event_type, level, message, detail, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    recordId ?? null,
    candidateId ?? null,
    ticketNo || '',
    name || '',
    eventType,
    resolvedLevel,
    resolvedMessage,
    detail || '',
    now
  );

  return {
    id: result.lastInsertRowid,
    recordId,
    candidateId,
    ticketNo,
    name,
    eventType,
    level: resolvedLevel,
    message: resolvedMessage,
    detail: detail || '',
    createdAt: now
  };
}

async function getProctorEvents({ limit = 500, level, ticketNo } = {}) {
  const conditions = [];
  const params = [];
  if (level) {
    conditions.push('level = ?');
    params.push(level);
  }
  if (ticketNo) {
    conditions.push('ticket_no LIKE ?');
    params.push(`%${ticketNo}%`);
  }
  const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
  const safeLimit = Math.min(2000, limit);

  const rows = await db.prepare(`
    SELECT * FROM proctor_events${where}
    ORDER BY id DESC
    LIMIT ?
  `).all(...params, safeLimit);

  return rows.map((r) => ({
    id: r.id,
    recordId: r.record_id,
    candidateId: r.candidate_id,
    ticketNo: r.ticket_no,
    name: r.name,
    eventType: r.event_type,
    level: r.level,
    message: r.message,
    detail: r.detail,
    createdAt: r.created_at
  }));
}

function getEventLabel(type) {
  return EVENT_LABELS[type] || type;
}

module.exports = {
  logProctorEvent,
  getProctorEvents,
  getEventLabel,
  EVENT_LABELS,
  EVENT_LEVELS
};
