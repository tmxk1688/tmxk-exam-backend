const db = require('../db');

async function initAnnouncements() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS announcements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      pinned INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT DEFAULT (datetime('now', 'localtime'))
    )
  `);
}

initAnnouncements();

function formatRow(row) {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    enabled: row.enabled === 1,
    pinned: row.pinned === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function getActiveAnnouncements() {
  const rows = await db.prepare(`
    SELECT * FROM announcements
    WHERE enabled = 1
    ORDER BY pinned DESC, updated_at DESC, id DESC
  `).all();
  return rows.map(formatRow);
}

async function getAllAnnouncements() {
  const rows = await db.prepare(`
    SELECT * FROM announcements ORDER BY pinned DESC, updated_at DESC, id DESC
  `).all();
  return rows.map(formatRow);
}

async function getAnnouncementById(id) {
  const row = await db.prepare('SELECT * FROM announcements WHERE id = ?').get(id);
  return row ? formatRow(row) : null;
}

async function createAnnouncement({ title, content, enabled = true, pinned = false }) {
  const now = new Date().toLocaleString('zh-CN', { hour12: false });
  const result = await db.prepare(`
    INSERT INTO announcements (title, content, enabled, pinned, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    title || '考场公告',
    content || '',
    enabled ? 1 : 0,
    pinned ? 1 : 0,
    now,
    now
  );
  return getAnnouncementById(result.lastInsertRowid);
}

async function updateAnnouncement(id, { title, content, enabled, pinned }) {
  const existing = await db.prepare('SELECT * FROM announcements WHERE id = ?').get(id);
  if (!existing) return null;

  const now = new Date().toLocaleString('zh-CN', { hour12: false });
  await db.prepare(`
    UPDATE announcements
    SET title = ?, content = ?, enabled = ?, pinned = ?, updated_at = ?
    WHERE id = ?
  `).run(
    title !== undefined ? (title || '考场公告') : existing.title,
    content !== undefined ? content : existing.content,
    enabled !== undefined ? (enabled ? 1 : 0) : existing.enabled,
    pinned !== undefined ? (pinned ? 1 : 0) : existing.pinned,
    now,
    id
  );
  return getAnnouncementById(id);
}

async function deleteAnnouncement(id) {
  const result = await db.prepare('DELETE FROM announcements WHERE id = ?').run(id);
  return result.changes > 0;
}

module.exports = {
  getActiveAnnouncements,
  getAllAnnouncements,
  getAnnouncementById,
  createAnnouncement,
  updateAnnouncement,
  deleteAnnouncement
};
