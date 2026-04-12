const path = require('node:path');
const { spawn } = require('node:child_process');
const { app } = require('electron');

const { logInfo, logWarn, logError } = require('./logger');

const WORKER_BOOT_TIMEOUT_MS = 15 * 1000;
const WORKER_RESTART_BASE_DELAY_MS = 1000;
const WORKER_RESTART_MAX_DELAY_MS = 15 * 1000;

function createDeferred() {
  let resolve = null;
  let reject = null;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });

  promise.catch(() => {});

  return {
    promise,
    resolve,
    reject,
  };
}

class NativeBatteryRuntime {
  constructor(options = {}) {
    this.onStateChange = typeof options.onStateChange === 'function' ? options.onStateChange : () => {};
    this.onBindingDetected = typeof options.onBindingDetected === 'function' ? options.onBindingDetected : async () => {};
    this.preferredBinding = null;
    this.overlayVisible = false;
    this.runtimeSuspended = false;
    this.disposed = false;
    this.worker = null;
    this.workerReady = false;
    this.workerDeferred = null;
    this.restartTimer = null;
    this.nextRequestId = 1;
    this.pendingRequests = new Map();
    this.restartCount = 0;
    this.spawnWorker();
  }

  getWorkerScriptPath() {
    return path.join(__dirname, 'native-hid-worker.js');
  }

  spawnWorker() {
    if (this.disposed) {
      return;
    }

    this.clearRestartTimer();
    this.workerReady = false;
    this.workerDeferred = createDeferred();
    const worker = spawn(process.execPath, [this.getWorkerScriptPath()], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      windowsHide: true,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        ATKTOOL_USER_DATA_DIR: app.getPath('userData'),
      },
    });

    this.worker = worker;
    worker.on('message', (message) => {
      this.handleWorkerMessage(worker, message);
    });
    worker.on('error', (error) => {
      logError('原生 HID 子进程启动失败', error);
    });
    worker.on('exit', (code, signal) => {
      this.handleWorkerExit(worker, code, signal);
    });

    logInfo('已拉起原生 HID 子进程', {
      pid: worker.pid,
      script: this.getWorkerScriptPath(),
    });
  }

  clearRestartTimer() {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  handleWorkerMessage(worker, message) {
    if (worker !== this.worker || !message || typeof message !== 'object') {
      return;
    }

    if (message.type === 'ready') {
      this.workerReady = true;
      this.restartCount = 0;
      this.workerDeferred?.resolve(true);
      void this.replayRuntimeState();
      return;
    }

    if (message.type === 'event') {
      if (message.event === 'state') {
        this.onStateChange(message.payload);
        return;
      }

      if (message.event === 'binding') {
        void Promise.resolve(this.onBindingDetected(message.payload)).catch((error) => {
          logWarn('处理原生 HID 绑定事件失败', error);
        });
      }

      return;
    }

    if (message.type !== 'response') {
      return;
    }

    const pending = this.pendingRequests.get(message.requestId);
    if (!pending) {
      return;
    }

    this.pendingRequests.delete(message.requestId);

    if (message.ok) {
      pending.resolve(message.result);
      return;
    }

    pending.reject(new Error(message.error || '原生 HID 子进程返回失败'));
  }

  handleWorkerExit(worker, code, signal) {
    if (worker !== this.worker) {
      return;
    }

    this.worker = null;
    this.workerReady = false;
    const exitError = new Error(`原生 HID 子进程已退出，code=${code ?? 'null'} signal=${signal ?? 'null'}`);
    this.workerDeferred?.reject(exitError);

    for (const pending of this.pendingRequests.values()) {
      pending.reject(exitError);
    }
    this.pendingRequests.clear();

    if (this.disposed && code === 0) {
      logInfo('原生 HID 子进程已正常退出', {
        code,
        signal,
      });
    } else {
      logError('原生 HID 子进程崩溃或退出', {
        code,
        signal,
        disposed: this.disposed,
      });
    }

    if (this.disposed) {
      return;
    }

    this.onStateChange({
      status: 'error',
      message: '原生 HID 子进程异常退出，正在自动恢复...',
      needsUserAction: false,
      sampledAt: new Date().toISOString(),
      mode: 'stable',
    });

    this.restartCount += 1;
    const delay = Math.min(WORKER_RESTART_BASE_DELAY_MS * this.restartCount, WORKER_RESTART_MAX_DELAY_MS);
    this.restartTimer = setTimeout(() => {
      this.spawnWorker();
    }, delay);
  }

  async ensureWorkerReady() {
    if (this.disposed) {
      throw new Error('原生 HID 子进程已释放');
    }

    if (!this.worker) {
      this.spawnWorker();
    }

    if (this.workerReady) {
      return;
    }

    const bootTimeout = new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error('等待原生 HID 子进程启动超时'));
      }, WORKER_BOOT_TIMEOUT_MS);
    });

    await Promise.race([this.workerDeferred.promise, bootTimeout]);
  }

  async replayRuntimeState() {
    try {
      await this.sendCommand('setPreferredBinding', this.preferredBinding);
      await this.sendCommand('setOverlayVisible', this.overlayVisible);
      await this.sendCommand('setSuspended', this.runtimeSuspended);

      if (!this.runtimeSuspended) {
        await this.sendCommand('refreshNow', {
          forceReopen: true,
        });
      }
    } catch (error) {
      logWarn('原生 HID 子进程状态回放失败', error);
    }
  }

  sendCommandNow(command, payload) {
    if (!this.worker) {
      return Promise.reject(new Error('原生 HID 子进程未启动'));
    }

    const requestId = this.nextRequestId;
    this.nextRequestId += 1;

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(requestId, { resolve, reject });

      try {
        this.worker.send({
          type: 'request',
          requestId,
          command,
          payload,
        });
      } catch (error) {
        this.pendingRequests.delete(requestId);
        reject(error);
      }
    });
  }

  async sendCommand(command, payload) {
    await this.ensureWorkerReady();
    return this.sendCommandNow(command, payload);
  }

  setPreferredBinding(binding) {
    this.preferredBinding = binding || null;
    void this.sendCommand('setPreferredBinding', this.preferredBinding).catch((error) => {
      logWarn('同步首选绑定到原生 HID 子进程失败', error);
    });
  }

  setOverlayVisible(visible) {
    this.overlayVisible = Boolean(visible);
    void this.sendCommand('setOverlayVisible', this.overlayVisible).catch((error) => {
      logWarn('同步悬浮窗可见状态到原生 HID 子进程失败', error);
    });
  }

  setSuspended(suspended) {
    this.runtimeSuspended = Boolean(suspended);
    void this.sendCommand('setSuspended', this.runtimeSuspended).catch((error) => {
      logWarn('同步挂起状态到原生 HID 子进程失败', error);
    });
  }

  async listChooserDevices() {
    return this.sendCommand('listChooserDevices');
  }

  async bindDeviceById(deviceId) {
    return this.sendCommand('bindDeviceById', deviceId);
  }

  async refreshNow(options = {}) {
    return this.sendCommand('refreshNow', options);
  }

  async dispose() {
    this.clearRestartTimer();

    if (!this.worker) {
      this.disposed = true;
      return;
    }

    this.disposed = true;

    try {
      if (this.workerReady) {
        await this.sendCommandNow('dispose');
      }
    } catch (_error) {
      // 子进程已经崩溃时这里不再抛出，避免阻断应用退出。
    }

    try {
      this.worker.kill();
    } catch (_error) {
      // ignore
    }
  }
}

module.exports = {
  NativeBatteryRuntime,
};
