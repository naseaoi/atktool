const { ipcRenderer } = require('electron');

let observer = null;
let sendTimer = null;
let heartbeatTimer = null;
let lastStateFingerprint = '';

const FULL_STATUS_PATTERN = /full|fully charged|已充满|充满|充电完成/i;
const CHARGING_STATUS_PATTERN = /charging|正在充电|充电中|充电/i;
const MAX_PERCENT_CANDIDATES = 8;
const STATE_SEND_DELAY_MS = 400;
const STATE_HEARTBEAT_INTERVAL_MS = 10 * 1000;

function isVisible(element) {
  if (!element || !(element instanceof HTMLElement)) {
    return false;
  }

  const style = window.getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
}

function collectPercentCandidates() {
  const candidates = [];
  if (!document.body) {
    return candidates;
  }

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
  let element = walker.nextNode();

  while (element && candidates.length < MAX_PERCENT_CANDIDATES) {
    if (element.children.length > 0) {
      element = walker.nextNode();
      continue;
    }

    const text = element.textContent?.trim();
    const match = text?.match(/^(\d{1,3})%$/);
    if (!match) {
      element = walker.nextNode();
      continue;
    }

    if (!isVisible(element)) {
      element = walker.nextNode();
      continue;
    }

    const value = Number(match[1]);
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      element = walker.nextNode();
      continue;
    }

    const contextText = element.parentElement?.innerText
      ?.split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 6) || [];

    candidates.push({
      value,
      text,
      contextText,
    });

    element = walker.nextNode();
  }

  return candidates;
}

function getCandidateScore(candidate) {
  const contextText = candidate?.contextText?.join('\n') || '';
  let score = 0;

  if (/ATK|VXE|mouse|鼠标|F1|X1|R1/i.test(contextText)) {
    score += 10;
  }

  if (/battery|电量|charging|充电/i.test(contextText)) {
    score += 6;
  }

  return score;
}

function pickDeviceName(lines) {
  const ignored = new Set([
    '首页',
    '新增设备',
    '退出演示',
    '退出演示模式',
    '关闭推荐',
    '请连接设备',
    '鼠标异常休眠，点我！',
  ]);

  return lines.find((line) => {
    if (!line || ignored.has(line)) {
      return false;
    }

    if (/^\d{1,3}%$/.test(line)) {
      return false;
    }

    if (line.length < 3 || line.length > 48) {
      return false;
    }

    return /ATK|mouse|鼠标|VXE|F1|X1|R1/i.test(line);
  }) || '';
}

function getChargeStatus(candidate) {
  if (!candidate) {
    return 'idle';
  }

  const contextText = candidate.contextText.join('\n');

  if (candidate.value === 100 && FULL_STATUS_PATTERN.test(contextText)) {
    return 'full';
  }

  if (CHARGING_STATUS_PATTERN.test(contextText)) {
    return 'charging';
  }

  return 'idle';
}

function collectState() {
  const bodyText = document.body?.innerText || '';
  const lines = bodyText
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const percentCandidates = collectPercentCandidates();
  const bestCandidate = [...percentCandidates]
    .sort((left, right) => getCandidateScore(right) - getCandidateScore(left))[0] || null;
  const deviceNameLines = bestCandidate?.contextText?.length ? bestCandidate.contextText : lines;
  const deviceName = pickDeviceName(deviceNameLines) || pickDeviceName(lines);
  const hasConnectPrompt = lines.includes('请连接设备') || lines.includes('新增设备');
  const chargeStatus = getChargeStatus(bestCandidate);
  const charging = chargeStatus === 'charging';
  const batteryPercent = bestCandidate ? bestCandidate.value : null;
  const batteryText = batteryPercent === null ? '--' : `${batteryPercent}%`;

  let status = 'loading';
  let message = '正在加载 ATK HUB...';

  if (bestCandidate) {
    status = 'connected';
    message = chargeStatus === 'full' ? '设备已连接，当前已充满' : charging ? '设备已连接，当前正在充电' : '设备已连接，正在读取电量';
  } else if (hasConnectPrompt) {
    status = 'waiting';
    message = '需要在连接页里点击“新增设备”并授权';
  } else if (document.readyState === 'complete') {
    status = 'waiting';
    message = '页面已加载，等待设备信息出现';
  }

  return {
    status,
    message,
    batteryPercent,
    batteryText,
    deviceName,
    charging,
    chargeStatus,
    needsUserAction: status === 'waiting',
  };
}

function sendState() {
  const state = collectState();
  const fingerprint = JSON.stringify(state);
  if (fingerprint === lastStateFingerprint) {
    return;
  }

  lastStateFingerprint = fingerprint;
  ipcRenderer.send('hub:state', {
    ...state,
    sampledAt: new Date().toISOString(),
  });
}

function scheduleSend() {
  window.clearTimeout(sendTimer);
  sendTimer = window.setTimeout(sendState, STATE_SEND_DELAY_MS);
}

function boot() {
  scheduleSend();

  observer = new MutationObserver(() => {
    scheduleSend();
  });

  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
  });

  heartbeatTimer = window.setInterval(sendState, STATE_HEARTBEAT_INTERVAL_MS);
}

window.addEventListener('DOMContentLoaded', boot, { once: true });
window.addEventListener('load', scheduleSend);
window.addEventListener('beforeunload', () => {
  observer?.disconnect();
  window.clearTimeout(sendTimer);
  window.clearInterval(heartbeatTimer);
});
