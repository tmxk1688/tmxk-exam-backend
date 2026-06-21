const db = require('../db');

const DEFAULTS = {
  exam_enabled: '1',
  exam_duration_minutes: '45',
  exam_open_at: '',
  exam_close_at: '',
  closed_message: '考试尚未开放，请稍后再试',
  show_answer_review: '0',
  proctor_enabled: '1',
  proctor_screen_required: '0',
  proctor_camera_required: '0',
  practical_upload_enabled: '1',
  practical_max_file_mb: '50',
  practical_deadline: '',
  scores_locked: '0'
};

async function initSettings() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS exam_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
  
  for (const [key, value] of Object.entries(DEFAULTS)) {
    try {
      await db.prepare('INSERT OR IGNORE INTO exam_settings (key, value) VALUES (?, ?)').run(key, value);
    } catch (e) {
      // Ignore errors
    }
  }
}

initSettings();

async function getRawSettings() {
  const rows = await db.prepare('SELECT key, value FROM exam_settings').all();
  const map = { ...DEFAULTS };
  for (const r of rows) map[r.key] = r.value;
  return map;
}

async function getSettings() {
  const raw = await getRawSettings();
  return {
    examEnabled: raw.exam_enabled !== '0',
    durationMinutes: Math.max(1, parseInt(raw.exam_duration_minutes || '45', 10) || 45),
    openAt: raw.exam_open_at || '',
    closeAt: raw.exam_close_at || '',
    closedMessage: raw.closed_message || DEFAULTS.closed_message,
    showAnswerReview: raw.show_answer_review === '1',
    proctorEnabled: raw.proctor_enabled !== '0',
    proctorScreenRequired: raw.proctor_screen_required === '1',
    proctorCameraRequired: raw.proctor_camera_required === '1',
    practicalUploadEnabled: raw.practical_upload_enabled !== '0',
    practicalMaxFileMb: Math.max(1, parseInt(raw.practical_max_file_mb || '50', 10) || 50),
    practicalDeadline: raw.practical_deadline || '',
    scoresLocked: raw.scores_locked === '1'
  };
}

async function updateSettings(data) {
  const upsertKey = async (key, value) => {
    const existing = await db.prepare('SELECT key FROM exam_settings WHERE key = ?').get(key);
    if (existing) {
      await db.prepare('UPDATE exam_settings SET value = ? WHERE key = ?').run(value, key);
    } else {
      await db.prepare('INSERT INTO exam_settings (key, value) VALUES (?, ?)').run(key, value);
    }
  };

  if (data.examEnabled !== undefined) {
    await upsertKey('exam_enabled', data.examEnabled ? '1' : '0');
  }
  if (data.durationMinutes !== undefined) {
    await upsertKey('exam_duration_minutes', String(Math.max(1, parseInt(data.durationMinutes, 10) || 45)));
  }
  if (data.openAt !== undefined) await upsertKey('exam_open_at', data.openAt || '');
  if (data.closeAt !== undefined) await upsertKey('exam_close_at', data.closeAt || '');
  if (data.closedMessage !== undefined) await upsertKey('closed_message', data.closedMessage || DEFAULTS.closed_message);
  if (data.showAnswerReview !== undefined) await upsertKey('show_answer_review', data.showAnswerReview ? '1' : '0');
  if (data.proctorEnabled !== undefined) await upsertKey('proctor_enabled', data.proctorEnabled ? '1' : '0');
  if (data.proctorScreenRequired !== undefined) await upsertKey('proctor_screen_required', data.proctorScreenRequired ? '1' : '0');
  if (data.proctorCameraRequired !== undefined) await upsertKey('proctor_camera_required', data.proctorCameraRequired ? '1' : '0');
  if (data.practicalUploadEnabled !== undefined) await upsertKey('practical_upload_enabled', data.practicalUploadEnabled ? '1' : '0');
  if (data.practicalMaxFileMb !== undefined) {
    await upsertKey('practical_max_file_mb', String(Math.max(1, parseInt(data.practicalMaxFileMb, 10) || 50)));
  }
  if (data.practicalDeadline !== undefined) await upsertKey('practical_deadline', data.practicalDeadline || '');
  if (data.scoresLocked !== undefined) await upsertKey('scores_locked', data.scoresLocked ? '1' : '0');

  return getSettings();
}

function parseLocalDate(str) {
  if (!str) return null;
  const normalized = str.includes('T') ? str : str.replace(' ', 'T');
  const d = new Date(normalized);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function checkExamAccess() {
  const settings = await getSettings();

  if (!settings.examEnabled) {
    return { ok: false, error: settings.closedMessage, waiting: false };
  }

  const now = Date.now();

  if (settings.openAt) {
    const open = parseLocalDate(settings.openAt);
    if (open && now < open.getTime()) {
      return {
        ok: false,
        waiting: true,
        openAt: settings.openAt,
        openTimestamp: open.getTime(),
        error: `考试尚未开始，开放时间：${settings.openAt}`
      };
    }
  }

  if (settings.closeAt) {
    const close = parseLocalDate(settings.closeAt);
    if (close && now > close.getTime()) {
      return { ok: false, error: '考试已结束，无法进入', waiting: false };
    }
  }

  return { ok: true, settings, waiting: false };
}

module.exports = { getSettings, updateSettings, checkExamAccess };
