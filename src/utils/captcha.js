const crypto = require('crypto');

const store = new Map();
const CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const EXPIRE_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;

function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randColor(min = 30, max = 160) {
  const r = rand(min, max);
  const g = rand(min, max);
  const b = rand(min, max);
  return `rgb(${r},${g},${b})`;
}

function generateCode(length = 5) {
  let code = '';
  for (let i = 0; i < length; i++) {
    code += CHARSET[rand(0, CHARSET.length - 1)];
  }
  return code;
}

function generateSvg(code) {
  const width = 180;
  const height = 60;
  const parts = [];

  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`);
  parts.push('<defs>');
  parts.push('<filter id="noise"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/></filter>');
  parts.push('</defs>');

  parts.push(`<rect width="100%" height="100%" fill="#eef3f8"/>`);
  parts.push(`<rect width="100%" height="100%" filter="url(#noise)" opacity="0.08"/>`);

  for (let i = 0; i < 18; i++) {
    const x1 = rand(0, width);
    const y1 = rand(0, height);
    const x2 = rand(0, width);
    const y2 = rand(0, height);
    parts.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${randColor(100, 200)}" stroke-width="${rand(1, 2)}" opacity="0.5"/>`);
  }

  for (let i = 0; i < 6; i++) {
    const cx = rand(0, width);
    const cy = rand(0, height);
    const rx = rand(20, 60);
    const ry = rand(8, 25);
    parts.push(`<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="none" stroke="${randColor(80, 180)}" stroke-width="1" opacity="0.35"/>`);
  }

  for (let i = 0; i < 90; i++) {
    parts.push(`<circle cx="${rand(0, width)}" cy="${rand(0, height)}" r="${rand(1, 2)}" fill="${randColor(50, 200)}" opacity="${(rand(20, 70) / 100).toFixed(2)}"/>`);
  }

  const charWidth = width / (code.length + 1);
  for (let i = 0; i < code.length; i++) {
    const x = charWidth * (i + 0.8) + rand(-4, 4);
    const y = height / 2 + rand(6, 12);
    const rotate = rand(-32, 32);
    const fontSize = rand(26, 34);
    const char = code[i];
    parts.push(
      `<text x="${x}" y="${y}" font-family="Arial,Helvetica,sans-serif" font-size="${fontSize}" font-weight="bold" fill="${randColor(20, 120)}" transform="rotate(${rotate} ${x} ${y})" opacity="0.92">${char}</text>`
    );
    parts.push(
      `<text x="${x + rand(-2, 2)}" y="${y + rand(-2, 2)}" font-family="Arial,Helvetica,sans-serif" font-size="${fontSize}" font-weight="bold" fill="${randColor(100, 180)}" transform="rotate(${rotate + rand(-5, 5)} ${x} ${y})" opacity="0.25">${char}</text>`
    );
  }

  for (let i = 0; i < 4; i++) {
    const d = `M ${rand(0, 40)} ${rand(0, height)} Q ${rand(40, 140)} ${rand(0, height)} ${rand(140, width)} ${rand(0, height)}`;
    parts.push(`<path d="${d}" fill="none" stroke="${randColor(60, 160)}" stroke-width="${rand(1, 2)}" opacity="0.45"/>`);
  }

  parts.push('</svg>');
  return parts.join('');
}

function cleanup() {
  const now = Date.now();
  for (const [id, item] of store.entries()) {
    if (now > item.expiresAt) store.delete(id);
  }
}

function createCaptcha() {
  cleanup();
  const code = generateCode(5);
  const id = crypto.randomUUID();
  store.set(id, {
    answer: code,
    expiresAt: Date.now() + EXPIRE_MS,
    attempts: 0
  });
  return { captchaId: id, svg: generateSvg(code) };
}

function verifyCaptcha(captchaId, captchaCode) {
  if (!captchaId || !captchaCode) {
    return { ok: false, error: '请输入验证码' };
  }

  const item = store.get(captchaId);
  if (!item) {
    return { ok: false, error: '验证码已失效，请刷新后重试' };
  }

  if (Date.now() > item.expiresAt) {
    store.delete(captchaId);
    return { ok: false, error: '验证码已过期，请刷新后重试' };
  }

  item.attempts += 1;
  if (item.attempts > MAX_ATTEMPTS) {
    store.delete(captchaId);
    return { ok: false, error: '验证码错误次数过多，请刷新后重试' };
  }

  const input = String(captchaCode).trim().toUpperCase().replace(/\s/g, '');
  if (input !== item.answer) {
    if (item.attempts >= MAX_ATTEMPTS) store.delete(captchaId);
    return { ok: false, error: '验证码错误，请重新输入' };
  }

  store.delete(captchaId);
  return { ok: true };
}

function getCaptchaStoreStats() {
  cleanup();
  const now = Date.now();
  let expired = 0;
  for (const item of store.values()) {
    if (now > item.expiresAt) expired += 1;
  }
  return { total: store.size, expired, active: store.size - expired };
}

function clearCaptchaStore({ expiredOnly = true } = {}) {
  cleanup();
  const now = Date.now();
  let removed = 0;

  if (expiredOnly) {
    for (const [id, item] of store.entries()) {
      if (now > item.expiresAt) {
        store.delete(id);
        removed += 1;
      }
    }
  } else {
    removed = store.size;
    store.clear();
  }

  return { removed, remaining: store.size };
}

module.exports = { createCaptcha, verifyCaptcha, getCaptchaStoreStats, clearCaptchaStore };
