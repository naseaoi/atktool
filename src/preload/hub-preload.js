const { ipcRenderer } = require('electron');

let observer = null;
let sendTimer = null;
let heartbeatTimer = null;

function isVisible(element) {
  if (!element || !(element instanceof HTMLElement)) {
    return false;
  }

  const style = window.getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
}

function collectPercentCandidates() {
  const elements = Array.from(document.querySelectorAll('body *'));
  const candidates = [];

  for (const element of elements) {
    if (!isVisible(element)) {
      continue;
    }

    const text = element.innerText?.trim();
    if (!text || text.length > 12) {
      continue;
    }

    const match = text.match(/^(\d{1,3})%$/);
    if (!match) {
      continue;
    }

    const value = Number(match[1]);
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      continue;
    }

    // 官网页面没有稳定的数据接口，这里先抓取电量节点周围的文本做上下文推断。
    const contextText = element.parentElement?.innerText
      ?.split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 4) || [];

    candidates.push({
      value,
      text,
      contextText,
    });
  }

  return candidates;
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

function collectState() {
  const bodyText = document.body?.innerText || '';
  const lines = bodyText
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const percentCandidates = collectPercentCandidates();
  const bestCandidate = percentCandidates[0] || null;
  const deviceName = pickDeviceName(bestCandidate?.contextText || lines);
  const hasConnectPrompt = lines.includes('请连接设备') || lines.includes('新增设备');
  const charging = /充电|charging/i.test(bodyText);

  let status = 'loading';
  let message = '正在加载 ATK HUB...';

  if (bestCandidate) {
    status = 'connected';
    message = charging ? '设备已连接，当前正在充电' : '设备已连接，正在读取电量';
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
    batteryPercent: bestCandidate ? bestCandidate.value : null,
    batteryText: bestCandidate ? bestCandidate.text : '--',
    deviceName,
    charging,
    pageTitle: document.title,
    percentCandidates,
    needsUserAction: status === 'waiting',
    sampledAt: new Date().toISOString(),
  };
}

function sendState() {
  ipcRenderer.send('hub:state', collectState());
}

function scheduleSend() {
  window.clearTimeout(sendTimer);
  sendTimer = window.setTimeout(sendState, 120);
}

function boot() {
  // 用 DOM 观察 + 心跳兜底两层策略，尽量在官网改版前保持这个快版原型可用。
  scheduleSend();

  observer = new MutationObserver(() => {
    scheduleSend();
  });

  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
  });

  heartbeatTimer = window.setInterval(sendState, 5000);
}

window.addEventListener('DOMContentLoaded', boot, { once: true });
window.addEventListener('load', scheduleSend);
window.addEventListener('beforeunload', () => {
  observer?.disconnect();
  window.clearTimeout(sendTimer);
  window.clearInterval(heartbeatTimer);
});
