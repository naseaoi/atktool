(() => {
  const fullPattern = /full|fully charged|已充满|充满|充电完成/i;
  const chargingPattern = /charging|正在充电|充电中|充电/i;
  let observer;
  let sendTimer;
  let heartbeatTimer;
  let lastFingerprint = '';
  let grantedDevicesCount = 0;
  let hidSupported = 'hid' in navigator;

  function visible(element) {
    if (!(element instanceof HTMLElement)) return false;
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  }

  function candidates() {
    const result = [];
    if (!document.body) return result;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let element = walker.nextNode();
    while (element && result.length < 8) {
      if (element.children.length === 0) {
        const match = element.textContent?.trim().match(/^(\d{1,3})%$/);
        const value = match ? Number(match[1]) : -1;
        if (match && value >= 0 && value <= 100 && visible(element)) {
          const contextText = (element.parentElement?.innerText || '')
            .split('\n').map((line) => line.trim()).filter(Boolean).slice(0, 6);
          const context = contextText.join('\n');
          const score = (/ATK|VXE|mouse|鼠标|F1|X1|R1/i.test(context) ? 10 : 0)
            + (/battery|电量|charging|充电/i.test(context) ? 6 : 0);
          result.push({ value, contextText, score });
        }
      }
      element = walker.nextNode();
    }
    return result.sort((left, right) => right.score - left.score);
  }

  function deviceName(lines) {
    const ignored = new Set(['首页', '新增设备', '退出演示', '退出演示模式', '关闭推荐', '请连接设备', '鼠标异常休眠，点我！']);
    return lines.find((line) => line.length >= 3 && line.length <= 48
      && !ignored.has(line) && !/^\d{1,3}%$/.test(line)
      && /ATK|mouse|鼠标|VXE|F1|X1|R1/i.test(line)) || '';
  }

  function collect() {
    const lines = (document.body?.innerText || '').split('\n').map((line) => line.trim()).filter(Boolean);
    const candidate = candidates()[0] || null;
    const context = candidate?.contextText || [];
    const contextText = context.join('\n');
    let chargeStatus = 'idle';
    if (candidate?.value === 100 && fullPattern.test(contextText)) chargeStatus = 'full';
    else if (chargingPattern.test(contextText)) chargeStatus = 'charging';
    const status = candidate ? 'connected' : hidSupported ? 'waiting' : 'error';
    let message = '页面已加载，等待设备信息出现';
    if (!hidSupported) message = '当前 WebView2 不支持 WebHID';
    else if (candidate) message = '设备已连接，正在读取电量';
    else if (grantedDevicesCount === 0) message = '请点击“新增设备”，在此窗口完成一次设备授权';
    else message = `已找到 ${grantedDevicesCount} 个已授权设备，正在等待官网连接`;
    return {
      status,
      message,
      batteryPercent: candidate?.value ?? null,
      deviceName: deviceName(context) || deviceName(lines),
      chargeStatus,
      grantedDevicesCount,
    };
  }

  async function refreshGrantedDevices() {
    if (!hidSupported) return;
    try {
      grantedDevicesCount = (await navigator.hid.getDevices()).length;
    } catch (_error) {
      hidSupported = false;
    }
    schedule();
  }

  function send(force) {
    const payload = collect();
    const fingerprint = JSON.stringify(payload);
    if (!force && fingerprint === lastFingerprint) return;
    lastFingerprint = fingerprint;
    window.__TAURI__?.core?.invoke('update_fallback_state', { payload }).catch(() => {});
  }

  function schedule() {
    clearTimeout(sendTimer);
    sendTimer = setTimeout(send, 400);
  }

  function boot() {
    refreshGrantedDevices();
    schedule();
    observer = new MutationObserver(schedule);
    observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
    heartbeatTimer = setInterval(() => send(true), 10000);
    navigator.hid?.addEventListener('connect', refreshGrantedDevices);
    navigator.hid?.addEventListener('disconnect', refreshGrantedDevices);
  }

  addEventListener('DOMContentLoaded', boot, { once: true });
  addEventListener('load', schedule);
  addEventListener('beforeunload', () => {
    observer?.disconnect();
    clearTimeout(sendTimer);
    clearInterval(heartbeatTimer);
    navigator.hid?.removeEventListener('connect', refreshGrantedDevices);
    navigator.hid?.removeEventListener('disconnect', refreshGrantedDevices);
  });
})();
