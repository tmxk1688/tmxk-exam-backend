function parseLocalDate(str) {
  if (!str) return null;
  const normalized = str.includes('T') ? str : str.replace(' ', 'T');
  const d = new Date(normalized);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatRemaining(ms) {
  if (ms <= 0) return '已截止';
  const totalMin = Math.ceil(ms / 60000);
  if (totalMin < 60) return `剩余 ${totalMin} 分钟`;
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (hours < 24) return mins > 0 ? `剩余 ${hours} 小时 ${mins} 分钟` : `剩余 ${hours} 小时`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `剩余 ${days} 天 ${remHours} 小时` : `剩余 ${days} 天`;
}

function getPracticalDeadlineInfo(settings) {
  const deadline = settings?.practicalDeadline || '';
  if (!deadline) {
    return {
      hasDeadline: false,
      deadline: '',
      expired: false,
      urgent: false,
      remainingMs: null,
      remainingText: '',
      message: ''
    };
  }

  const date = parseLocalDate(deadline);
  if (!date) {
    return {
      hasDeadline: false,
      deadline,
      expired: false,
      urgent: false,
      remainingMs: null,
      remainingText: '',
      message: ''
    };
  }

  const remainingMs = date.getTime() - Date.now();
  const expired = remainingMs <= 0;
  const urgent = !expired && remainingMs < 3600000;
  const remainingText = formatRemaining(remainingMs);

  let message = '';
  if (expired) {
    message = `实操上传已于 ${deadline} 截止`;
  } else if (urgent) {
    message = `实操上传即将截止（${deadline}），${remainingText}，请尽快完成上传`;
  } else {
    message = `实操上传截止时间：${deadline}（${remainingText}）`;
  }

  return {
    hasDeadline: true,
    deadline,
    deadlineTimestamp: date.getTime(),
    expired,
    urgent,
    remainingMs: Math.max(0, remainingMs),
    remainingText,
    message
  };
}

module.exports = { getPracticalDeadlineInfo, formatRemaining, parseLocalDate };
