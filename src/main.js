const { app } = require('electron');
const { logInfo, getLogFilePath } = require('./utils/logger');
const { NativeBatteryRuntime } = require('./hid/native-hid-host');

const settingsStore = require('./core/settings-store');
const overlayState = require('./core/overlay-state');
const overlaySource = require('./core/overlay-source');
const batteryRuntime = require('./core/battery-runtime');
const { rememberPreferredDevice } = require('./core/device-actions');

const overlayWindow = require('./windows/overlay-window');
const managerWindow = require('./windows/manager-window');
const hubWindow = require('./windows/hub-window');

const tray = require('./tray/tray');
const ipc = require('./ipc');

const loginItem = require('./system/login-item');
const powerMonitorSystem = require('./system/power-monitor');
const runtimeDiagnostics = require('./system/runtime-diagnostics');

const { logMemorySnapshot } = require('./utils/memory-log');

// 应用入口。仅负责:
// 1) 单例锁 + 硬件加速关闭;
// 2) 按依赖顺序初始化各模块;
// 3) 绑定 app 生命周期事件。
// 具体业务全部下沉到对应模块,本文件不再出现业务逻辑。

app.disableHardwareAcceleration();

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
}

function createBatteryRuntime() {
  const runtime = new NativeBatteryRuntime({
    onStateChange(nextState) {
      // 官网同步模式下状态由 hub-ipc 接管,忽略本地直连 runtime 推送。
      if (overlaySource.get() !== 'manager') {
        return;
      }

      overlayState.merge({
        ...nextState,
        mode: nextState.mode || 'stable',
      });
    },
    async onBindingDetected(binding) {
      rememberPreferredDevice(binding);
    },
  });

  batteryRuntime.set(runtime);
  runtime.setPreferredBinding(settingsStore.get().preferredHidDevice);
  runtime.setOverlayVisible(overlayWindow.isVisible());

  // overlaySource 切换会改变 runtime 的挂起状态:切到 hub 时挂起节省唤醒,切回 manager 时恢复。
  overlaySource.on('changed', (source) => {
    runtime.setSuspended(source === 'hub');
  });

  return runtime;
}

function boot() {
  app.setAppUserModelId('atk.overlay.prototype');
  loginItem.setOpenAtLogin(Boolean(settingsStore.get().openAtLogin));

  // 各模块的事件订阅必须在窗口/托盘创建之前注册,避免错过首次状态广播。
  overlayWindow.init();
  managerWindow.init();
  hubWindow.init();
  tray.init();

  createBatteryRuntime();

  powerMonitorSystem.register();
  ipc.register();

  if (settingsStore.get().overlayVisible !== false) {
    // 仅在用户上次未显式关闭时恢复悬浮窗,保持"关闭即持久"的语义。
    overlayWindow.create();
  }

  tray.create();
  void batteryRuntime.get().refreshNow();

  logInfo('应用启动完成', {
    logFile: getLogFilePath(),
    openAtLogin: Boolean(settingsStore.get().openAtLogin),
    overlayVariant: overlayState.getOverlayVariant(),
  });
  logMemorySnapshot('app-boot');
}

runtimeDiagnostics.register();

if (hasSingleInstanceLock) {
  app.whenReady().then(boot).catch((error) => {
    runtimeDiagnostics.relaunchAfterUnexpectedFailure('boot', error);
  });
}

app.on('second-instance', () => {
  overlayWindow.show();
});

app.on('before-quit', () => {
  runtimeDiagnostics.markQuitting();
  void batteryRuntime.get()?.dispose();
});

app.on('window-all-closed', (event) => {
  event.preventDefault();
});

app.on('activate', () => {
  overlayWindow.show();
});
