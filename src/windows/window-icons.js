const { logWarn } = require('../utils/logger');
const { getOrCreateTaskbarIcon } = require('../tray/tray-icon-renderer');
const overlayState = require('../core/overlay-state');

// 根据 overlayState 构造任务栏角标,并应用到指定窗口。
// manager/hub 窗口各自订阅 overlayState.changed 调用此工具,不集中维护窗口引用。

function buildTaskbarIcon() {
  const state = overlayState.get();
  const chargeSuffix = state.chargeStatus === 'full'
    ? '（充电完成）'
    : state.charging
      ? '（充电中）'
      : '';

  return {
    icon: getOrCreateTaskbarIcon(state.batteryPercent, state.charging),
    description: state.batteryPercent !== null
      ? `当前电量 ${state.batteryPercent}${chargeSuffix}`
      : '暂无电量',
  };
}

function applyTo(targetWindow, label) {
  if (!targetWindow || targetWindow.isDestroyed()) {
    return;
  }

  const { icon, description } = buildTaskbarIcon();

  try {
    targetWindow.setOverlayIcon(icon, description);
  } catch (error) {
    logWarn(`${label} 任务栏图标刷新失败`, error);
  }
}

module.exports = {
  buildTaskbarIcon,
  applyTo,
};
