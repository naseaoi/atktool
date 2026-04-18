const { NativeBatteryRuntime } = require('./native-hid');
const { logInfo, logError } = require('./logger');

// utilityProcess 通过 process.parentPort 与主进程通信；标准 Node 子进程的
// process.send/process.on('message') 在此环境下均不可用。
const parentPort = process.parentPort;

function postToParent(message) {
  if (parentPort && typeof parentPort.postMessage === 'function') {
    parentPort.postMessage(message);
  }
}

let disposing = false;

const runtime = new NativeBatteryRuntime({
  onStateChange(nextState) {
    postToParent({
      type: 'event',
      event: 'state',
      payload: nextState,
    });
  },
  async onBindingDetected(binding) {
    postToParent({
      type: 'event',
      event: 'binding',
      payload: binding,
    });
  },
});

const handlers = {
  setPreferredBinding(payload) {
    runtime.setPreferredBinding(payload || null);
    return true;
  },
  setOverlayVisible(payload) {
    runtime.setOverlayVisible(Boolean(payload));
    return true;
  },
  setSuspended(payload) {
    runtime.setSuspended(Boolean(payload));
    return true;
  },
  async listChooserDevices() {
    return runtime.listChooserDevices();
  },
  async bindDeviceById(payload) {
    return runtime.bindDeviceById(payload);
  },
  async refreshNow(payload) {
    await runtime.refreshNow(payload || {});
    return true;
  },
  async dispose() {
    disposing = true;
    await runtime.dispose();
    return true;
  },
};

async function handleRequest(message) {
  const handler = handlers[message.command];
  if (!handler) {
    throw new Error(`未知命令: ${message.command}`);
  }

  return handler(message.payload);
}

parentPort?.on('message', async (event) => {
  // utilityProcess 下 parentPort 收到的是 MessageEvent，真实负载在 event.data。
  const message = event?.data;
  if (!message || typeof message !== 'object') {
    return;
  }

  // 心跳走独立通道，立即同步回复，避免被 HID IO 请求排队阻塞导致主进程误判失联。
  if (message.type === 'ping') {
    postToParent({ type: 'pong' });
    return;
  }

  if (message.type !== 'request') {
    return;
  }

  try {
    const result = await handleRequest(message);
    postToParent({
      type: 'response',
      requestId: message.requestId,
      ok: true,
      result,
    });

    if (message.command === 'dispose') {
      process.exit(0);
    }
  } catch (error) {
    logError('原生 HID 子进程处理命令失败', {
      command: message.command,
      error,
    });
    postToParent({
      type: 'response',
      requestId: message.requestId,
      ok: false,
      error: error.message,
    });
  }
});

process.on('uncaughtException', async (error) => {
  logError('原生 HID 子进程发生未捕获异常', error);
  try {
    await runtime.dispose();
  } catch (_disposeError) {
    // ignore
  }
  process.exit(1);
});

process.on('unhandledRejection', async (reason) => {
  logError('原生 HID 子进程出现未处理 Promise 拒绝', reason);
  try {
    await runtime.dispose();
  } catch (_disposeError) {
    // ignore
  }
  process.exit(1);
});

// utility process 没有 'disconnect' 事件：父进程消失时 Electron 会直接终止
// 子进程，无需手动兜底，保留 disposing 标记给 dispose 命令使用即可。
void disposing;

logInfo('原生 HID 子进程已启动', {
  pid: process.pid,
});

postToParent({
  type: 'ready',
});
