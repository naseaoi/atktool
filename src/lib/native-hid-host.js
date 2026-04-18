const path = require('node:path');
const { app, utilityProcess } = require('electron');

const { logInfo, logWarn, logError } = require('./logger');

const WORKER_BOOT_TIMEOUT_MS = 15 * 1000;
const WORKER_RESTART_BASE_DELAY_MS = 1000;
const WORKER_RESTART_MAX_DELAY_MS = 15 * 1000;
// 单条命令最长等待时间：listChooserDevices/refreshNow 内部最多跑两个协议各 ~3s，留出充足余量。
const WORKER_COMMAND_TIMEOUT_MS = 15 * 1000;
// dispose 不能阻塞应用退出，单独给一个更短的超时。
const WORKER_DISPOSE_TIMEOUT_MS = 3 * 1000;
// 心跳间隔与失联判定阈值：
// - 前台（overlay 可见）：5s 心跳 + 15s 阈值，保持及时性。
// - 后台（overlay 隐藏）：30s 心跳 + 90s 阈值，减少 IPC 唤醒，降低闲时 CPU/电源消耗。
const WORKER_HEARTBEAT_FOREGROUND_INTERVAL_MS = 5 * 1000;
const WORKER_HEARTBEAT_FOREGROUND_MAX_SILENCE_MS = 15 * 1000;
const WORKER_HEARTBEAT_BACKGROUND_INTERVAL_MS = 30 * 1000;
const WORKER_HEARTBEAT_BACKGROUND_MAX_SILENCE_MS = 90 * 1000;

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
    this.heartbeatTimer = null;
    this.lastPongAt = 0;
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
    this.clearHeartbeatTimer();
    this.workerReady = false;
    this.workerDeferred = createDeferred();
    // utilityProcess.fork 共享 Electron 主二进制，不会像 ELECTRON_RUN_AS_NODE
    // 那样启动一份完整 Electron 运行时，空闲常驻显著低于独立子进程。
    // allowLoadingUnsignedLibraries 放开：node-hid 的 prebuild .node 未经 Authenticode
    // 签名，Win11 下 utility sandbox 默认会拒绝加载，不开启无法 require('node-hid')。
    const worker = utilityProcess.fork(this.getWorkerScriptPath(), [], {
      stdio: 'ignore',
      allowLoadingUnsignedLibraries: true,
      serviceName: 'atktool.native-hid',
      env: {
        ...process.env,
        ATKTOOL_USER_DATA_DIR: app.getPath('userData'),
      },
    });

    this.worker = worker;
    this.lastPongAt = Date.now();
    worker.on('message', (message) => {
      this.handleWorkerMessage(worker, message);
    });
    worker.on('exit', (code) => {
      this.handleWorkerExit(worker, code);
    });

    this.startHeartbeat();

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

  clearHeartbeatTimer() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  startHeartbeat() {
    this.clearHeartbeatTimer();

    // 定时向 worker 发送 ping，观察 lastPongAt 判断是否失联。
    // 使用独立通道（非 request/response），避免污染 pendingRequests 并保证轻量。
    const interval = this.getHeartbeatIntervalMs();
    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat();
    }, interval);
    this.heartbeatTimer.unref?.();
  }

  getHeartbeatIntervalMs() {
    return this.overlayVisible
      ? WORKER_HEARTBEAT_FOREGROUND_INTERVAL_MS
      : WORKER_HEARTBEAT_BACKGROUND_INTERVAL_MS;
  }

  getHeartbeatSilenceThresholdMs() {
    return this.overlayVisible
      ? WORKER_HEARTBEAT_FOREGROUND_MAX_SILENCE_MS
      : WORKER_HEARTBEAT_BACKGROUND_MAX_SILENCE_MS;
  }

  sendHeartbeat() {
    const worker = this.worker;
    if (!worker || this.disposed) {
      return;
    }

    // 首先检查失联时长。worker 启动后有一次 ready，lastPongAt 初始化为启动时间，
    // 因此 boot 超时场景也会在这里被兜住。
    if (Date.now() - this.lastPongAt > this.getHeartbeatSilenceThresholdMs()) {
      this.markWorkerUnhealthy('心跳连续超时');
      return;
    }

    try {
      worker.postMessage({ type: 'ping' });
    } catch (error) {
      // send 失败通常意味着 IPC 通道已关闭；等 exit 事件接管重启。
      logWarn('原生 HID 子进程心跳发送失败', error);
    }
  }

  markWorkerUnhealthy(reason) {
    const worker = this.worker;
    if (!worker || this.disposed) {
      return;
    }

    logError('原生 HID 子进程判定为不健康，将强制重启', {
      pid: worker.pid,
      reason,
    });

    // kill 会触发 exit 事件，由 handleWorkerExit 走统一的重启逻辑并 reject 所有 pending。
    try {
      worker.kill();
    } catch (error) {
      logWarn('强制终止原生 HID 子进程失败', error);
    }
  }

  handleWorkerMessage(worker, message) {
    if (worker !== this.worker || !message || typeof message !== 'object') {
      return;
    }

    // 所有来自 worker 的消息都视为心跳存活证据，避免高频 state 事件时仍被误判失联。
    this.lastPongAt = Date.now();

    if (message.type === 'pong') {
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

  handleWorkerExit(worker, code) {
    if (worker !== this.worker) {
      return;
    }

    this.clearHeartbeatTimer();
    this.worker = null;
    this.workerReady = false;
    const exitError = new Error(`原生 HID 子进程已退出，code=${code ?? 'null'}`);
    this.workerDeferred?.reject(exitError);

    for (const pending of this.pendingRequests.values()) {
      pending.reject(exitError);
    }
    this.pendingRequests.clear();

    if (this.disposed && code === 0) {
      logInfo('原生 HID 子进程已正常退出', {
        code,
      });
    } else {
      logError('原生 HID 子进程崩溃或退出', {
        code,
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
    const timeoutMs = command === 'dispose' ? WORKER_DISPOSE_TIMEOUT_MS : WORKER_COMMAND_TIMEOUT_MS;

    return new Promise((resolve, reject) => {
      // 每条 pending 单独挂一个超时定时器。超时则清理、reject，并把 worker 判定为不健康强制重启，
      // 避免 node-hid 阻塞调用卡住 IPC 时主进程永远挂着未完成的 Promise。
      const timer = setTimeout(() => {
        if (this.pendingRequests.delete(requestId)) {
          const timeoutError = new Error(`原生 HID 命令 "${command}" 等待 ${timeoutMs}ms 未响应`);
          reject(timeoutError);
          // dispose 超时不再 kill：此时应用正在退出，交给上层继续走关闭流程即可。
          if (command !== 'dispose') {
            this.markWorkerUnhealthy(`命令 ${command} 超时`);
          }
        }
      }, timeoutMs);
      timer.unref?.();

      this.pendingRequests.set(requestId, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });

      try {
        this.worker.postMessage({
          type: 'request',
          requestId,
          command,
          payload,
        });
      } catch (error) {
        clearTimeout(timer);
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
    const nextValue = Boolean(visible);
    const changed = this.overlayVisible !== nextValue;
    this.overlayVisible = nextValue;

    // 可见性切换后立即重建心跳定时器,让前后台差异化间隔真正生效(前台 5s / 后台 30s)。
    // 否则 overlayVisible 初始为 false,定时器会一直按 30s 运行,前台开启后也不会加快。
    if (changed && this.worker && !this.disposed) {
      this.startHeartbeat();
    }

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
