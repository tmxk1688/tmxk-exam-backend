const jwt = require('jsonwebtoken');
const db = require('./db');
const { getSettings } = require('./utils/settings');
const { logProctorEvent, EVENT_LEVELS } = require('./utils/proctorEvents');

const JWT_SECRET = process.env.JWT_SECRET || 'tmxk-aigc-exam-secret-2026';
const OFFLINE_MS = 20000;
const ALERT_COOLDOWN_MS = 15000;

/** @type {Map<number, object>} */
const sessions = new Map();
const previousStatus = new Map();
const alertCooldown = new Map();

function verifyExamToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

function verifyAdminToken(token) {
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (!payload.username) return null;
    return payload;
  } catch {
    return null;
  }
}

function computeStatus(session) {
  const settings = getSettings();
  const stale = Date.now() - session.lastHeartbeat > OFFLINE_MS;
  if (stale) return 'offline';
  if (session.focusEvents >= 3 || !session.pageVisible) return 'alert';
  if (session.focusEvents > 0 || !session.fullscreen || !session.screenSharing) return 'warning';
  if (settings.proctorCameraRequired && !session.cameraActive) return 'warning';
  return 'normal';
}

function buildSessionPayload(session) {
  return {
    ...session,
    status: computeStatus(session),
    screenPreview: session.screenPreview || null,
    cameraPreview: session.cameraPreview || null
  };
}

function getLiveSessions() {
  const list = [];
  for (const session of sessions.values()) {
    list.push(buildSessionPayload(session));
  }
  return list.sort((a, b) => {
    const order = { alert: 0, offline: 1, warning: 2, normal: 3 };
    return (order[computeStatus(a)] ?? 9) - (order[computeStatus(b)] ?? 9);
  });
}

function getSummary() {
  const list = getLiveSessions();
  return {
    total: list.length,
    normal: list.filter((s) => s.status === 'normal').length,
    warning: list.filter((s) => s.status === 'warning').length,
    alert: list.filter((s) => s.status === 'alert').length,
    offline: list.filter((s) => s.status === 'offline').length
  };
}

function upsertSession(recordId, patch) {
  const existing = sessions.get(recordId) || {};
  const merged = {
    ...existing,
    ...patch,
    recordId,
    lastHeartbeat: Date.now()
  };
  merged.status = computeStatus(merged);
  sessions.set(recordId, merged);
  return merged;
}

function removeSession(recordId) {
  sessions.delete(recordId);
  previousStatus.delete(recordId);
}

function shouldEmitAlert(recordId, key) {
  const id = `${recordId}:${key}`;
  const last = alertCooldown.get(id) || 0;
  if (Date.now() - last < ALERT_COOLDOWN_MS) return false;
  alertCooldown.set(id, Date.now());
  return true;
}

function emitProctorAlert(io, session, eventType, extra = {}) {
  const level = extra.level || EVENT_LEVELS[eventType] || 'info';

  const event = logProctorEvent({
    recordId: session.recordId,
    candidateId: session.candidateId,
    ticketNo: session.ticketNo,
    name: session.name,
    eventType,
    level,
    message: extra.message,
    detail: extra.detail || ''
  });

  if ((level === 'warning' || level === 'alert') && shouldEmitAlert(session.recordId, eventType)) {
    io.to('admins').emit('proctor:alert', {
      ...event,
      session: buildSessionPayload(session)
    });
  }

  return event;
}

function processAlerts(io, session, data = {}) {
  const settings = getSettings();
  if (!settings.proctorEnabled) return;

  if (data.eventType && data.eventType !== 'connected') {
    emitProctorAlert(io, session, data.eventType, {
      detail: JSON.stringify({
        focusEvents: session.focusEvents,
        pageVisible: session.pageVisible,
        screenSharing: session.screenSharing,
        cameraActive: session.cameraActive
      })
    });
  }

  if (session.focusEvents >= 3 && data.eventType === 'page_hidden') {
    emitProctorAlert(io, session, 'focus_threshold', {
      message: `切屏次数已达 ${session.focusEvents} 次`,
      detail: `考生 ${session.name}（${session.ticketNo}）`
    });
  }

  const status = computeStatus(session);
  const prev = previousStatus.get(session.recordId);
  if (prev && prev !== status) {
    if (status === 'warning') {
      emitProctorAlert(io, session, 'status_warning', {
        message: `考生状态变为「注意」`,
        detail: `${session.name}（${session.ticketNo}）`
      });
    } else if (status === 'alert') {
      emitProctorAlert(io, session, 'status_alert', {
        message: `考生状态变为「异常」`,
        detail: `${session.name}（${session.ticketNo}）· 切屏 ${session.focusEvents} 次`
      });
    } else if (status === 'offline') {
      emitProctorAlert(io, session, 'status_offline', {
        message: '考生监考连接离线',
        detail: `${session.name}（${session.ticketNo}）`
      });
    }
  }
  previousStatus.set(session.recordId, status);
}

function attachProctoring(io) {
  io.use((socket, next) => {
    const { role, token } = socket.handshake.auth || {};
    if (!token) return next(new Error('缺少认证令牌，请重新登录'));

    if (role === 'admin') {
      const admin = verifyAdminToken(token);
      if (!admin) return next(new Error('管理员认证失败，请重新登录'));
      socket.admin = admin;
      socket.role = 'admin';
      return next();
    }
    if (role === 'candidate') {
      const exam = verifyExamToken(token);
      if (!exam) return next(new Error('考生认证失败，请重新登录'));
      socket.exam = exam;
      socket.role = 'candidate';
      return next();
    }
    next(new Error('无效连接角色'));
  });

  io.on('connection', (socket) => {
    if (socket.role === 'admin') {
      socket.join('admins');
      socket.emit('proctor:init', {
        sessions: getLiveSessions(),
        summary: getSummary(),
        settings: getSettings()
      });

      socket.on('proctor:refresh', () => {
        socket.emit('proctor:init', {
          sessions: getLiveSessions(),
          summary: getSummary(),
          settings: getSettings()
        });
      });

      return;
    }

    if (socket.role === 'candidate') {
      const { candidateId, recordId, ticketNo, name } = socket.exam;

      const candidate = db.prepare('SELECT * FROM candidates WHERE _id = ?').get(candidateId);
      const record = db.prepare('SELECT * FROM exam_records WHERE _id = ?').get(recordId);

      if (!candidate || !record || record.status !== 'in_progress') {
        socket.disconnect(true);
        return;
      }

      upsertSession(recordId, {
        candidateId,
        ticketNo: ticketNo || candidate.ticketNo,
        name: name || candidate.name,
        position: candidate.position || '',
        examSite: candidate.examSite || '',
        examRoom: candidate.examRoom || '',
        seatNo: candidate.seatNo || '',
        focusEvents: record.focusEvents || 0,
        currentQ: 0,
        answeredCount: 0,
        totalQuestions: 20,
        timeLeft: 0,
        markedCount: 0,
        pageVisible: true,
        fullscreen: false,
        screenSharing: false,
        cameraActive: false,
        screenPreview: null,
        cameraPreview: null,
        connectedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
        socketId: socket.id
      });

      broadcastToAdmins(io);

      socket.on('proctor:heartbeat', (data = {}) => {
        const rec = db.prepare('SELECT focusEvents, status FROM exam_records WHERE _id = ?').get(recordId);
        if (!rec || rec.status !== 'in_progress') {
          removeSession(recordId);
          broadcastToAdmins(io);
          socket.disconnect(true);
          return;
        }

        const patch = {
          candidateId,
          ticketNo: ticketNo || candidate.ticketNo,
          name: name || candidate.name,
          position: candidate.position || '',
          examSite: candidate.examSite || '',
          examRoom: candidate.examRoom || '',
          seatNo: candidate.seatNo || '',
          focusEvents: data.focusEvents ?? rec.focusEvents ?? 0,
          currentQ: data.currentQ ?? 0,
          answeredCount: data.answeredCount ?? 0,
          totalQuestions: data.totalQuestions ?? 20,
          timeLeft: data.timeLeft ?? 0,
          markedCount: data.markedCount ?? 0,
          pageVisible: data.pageVisible !== false,
          fullscreen: !!data.fullscreen,
          screenSharing: !!data.screenSharing,
          cameraActive: !!data.cameraActive,
          socketId: socket.id
        };

        if (data.screenPreview?.startsWith?.('data:image/') && data.screenPreview.length < 500000) {
          patch.screenPreview = data.screenPreview;
          patch.screenUpdatedAt = new Date().toLocaleString('zh-CN', { hour12: false });
        }

        if (data.cameraPreview?.startsWith?.('data:image/') && data.cameraPreview.length < 300000) {
          patch.cameraPreview = data.cameraPreview;
          patch.cameraUpdatedAt = new Date().toLocaleString('zh-CN', { hour12: false });
        }

        if (data.eventType) {
          patch.lastEvent = data.eventType;
          patch.lastEventAt = new Date().toLocaleString('zh-CN', { hour12: false });
        }

        const session = upsertSession(recordId, patch);
        processAlerts(io, session, data);
        broadcastToAdmins(io);
      });

      socket.on('disconnect', () => {
        const session = sessions.get(recordId);
        if (session && session.socketId === socket.id) {
          session.lastHeartbeat = Date.now() - OFFLINE_MS - 1000;
          session.status = 'offline';
          processAlerts(io, session, { eventType: 'status_offline' });
          broadcastToAdmins(io);
          setTimeout(() => {
            const current = sessions.get(recordId);
            if (current && current.socketId === socket.id) {
              removeSession(recordId);
              broadcastToAdmins(io);
            }
          }, 60000);
        }
      });
    }
  });

  setInterval(() => {
    if (sessions.size === 0) return;
    broadcastToAdmins(io);
  }, 5000);
}

function broadcastToAdmins(io) {
  io.to('admins').emit('proctor:update', {
    sessions: getLiveSessions(),
    summary: getSummary(),
    updatedAt: new Date().toLocaleString('zh-CN', { hour12: false })
  });
}

function getProctorCacheStats() {
  const now = Date.now();
  let stale = 0;
  for (const session of sessions.values()) {
    if (now - session.lastHeartbeat > OFFLINE_MS) stale += 1;
  }
  return { total: sessions.size, stale, active: sessions.size - stale };
}

function clearStaleProctorSessions() {
  const now = Date.now();
  let removed = 0;

  for (const [recordId, session] of sessions.entries()) {
    if (now - session.lastHeartbeat > OFFLINE_MS) {
      sessions.delete(recordId);
      previousStatus.delete(recordId);
      alertCooldown.delete(recordId);
      removed += 1;
    }
  }

  return { removed, remaining: sessions.size };
}

module.exports = {
  attachProctoring,
  getLiveSessions,
  getSummary,
  getProctorCacheStats,
  clearStaleProctorSessions
};
