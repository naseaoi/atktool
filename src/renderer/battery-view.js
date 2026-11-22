// 悬浮窗与管理页共用的电量展示规则，保证两处阈值和文案一致。
(() => {
  function normalizePercent(value) {
    if (!Number.isFinite(value)) {
      return null;
    }
    return Math.max(0, Math.min(100, Math.round(value)));
  }

  function getChargeStatus(state) {
    if (state.chargeStatus === 'full') {
      return 'full';
    }
    if (state.charging || state.chargeStatus === 'charging') {
      return 'charging';
    }
    return 'idle';
  }

  function formatAgo(isoTime) {
    const time = isoTime ? new Date(isoTime).getTime() : Number.NaN;
    if (Number.isNaN(time)) {
      return '';
    }
    const minutes = Math.floor(Math.max(0, Date.now() - time) / 60000);
    if (minutes < 1) {
      return '刚刚';
    }
    if (minutes < 60) {
      return `${minutes} 分钟前`;
    }
    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
      return `${hours} 小时前`;
    }
    return `${Math.floor(hours / 24)} 天前`;
  }

  function formatDuration(totalMinutes) {
    const minutes = Math.round(totalMinutes);
    if (minutes < 60) {
      return `${Math.max(1, minutes)} 分钟`;
    }
    const hours = Math.floor(minutes / 60);
    if (hours < 10) {
      const rest = Math.round((minutes % 60) / 10) * 10;
      return rest > 0 && rest < 60 ? `${hours} 小时 ${rest} 分` : `${hours} 小时`;
    }
    if (hours < 72) {
      return `${Math.round(minutes / 60)} 小时`;
    }
    return `${Math.round(minutes / 1440)} 天`;
  }

  function getTone(percent, offline) {
    if (offline || percent === null) {
      return 'idle';
    }
    if (percent <= 10) {
      return 'critical';
    }
    if (percent <= 20) {
      return 'low';
    }
    return 'normal';
  }

  // 在线时用实时电量，断连时退回最后一次读数并标记为离线。
  function describeBattery(state) {
    const status = state.status || 'loading';
    const livePercent = normalizePercent(state.batteryPercent);
    const online = status === 'connected' && livePercent !== null;
    const percent = online ? livePercent : normalizePercent(state.lastBatteryPercent);
    const chargeStatus = online ? getChargeStatus(state) : 'idle';
    const estimate = online && Number.isFinite(state.estimateMinutes) ? formatDuration(state.estimateMinutes) : '';
    const tone = chargeStatus === 'charging' ? 'normal' : getTone(percent, !online);
    let estimateText = '';
    if (estimate && chargeStatus === 'charging') {
      estimateText = `约 ${estimate}充满`;
    } else if (estimate && chargeStatus === 'idle') {
      estimateText = `剩余约 ${estimate}`;
    }
    return { status, online, percent, chargeStatus, estimateText, tone };
  }

  window.AtkBatteryView = { describeBattery, formatAgo };
})();
