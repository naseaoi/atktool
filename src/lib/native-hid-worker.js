const { NativeBatteryRuntime } = require('./native-hid');
const { logInfo, logError } = require('./logger');

let disposing = false;

const runtime = new NativeBatteryRuntime({
  onStateChange(nextState) {
    if (typeof process.send === 'function') {
      process.send({
        type: 'event',
        event: 'state',
        payload: nextState,
      });
    }
  },
  async onBindingDetected(binding) {
    if (typeof process.send === 'function') {
      process.send({
        type: 'event',
        event: 'binding',
        payload: binding,
      });
    }
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

process.on('message', async (message) => {
  if (!message || message.type !== 'request') {
    return;
  }

  try {
    const result = await handleRequest(message);
    if (typeof process.send === 'function') {
      process.send({
        type: 'response',
        requestId: message.requestId,
        ok: true,
        result,
      });
    }

    if (message.command === 'dispose') {
      process.exit(0);
    }
  } catch (error) {
    logError('原生 HID 子进程处理命令失败', {
      command: message.command,
      error,
    });
    if (typeof process.send === 'function') {
      process.send({
        type: 'response',
        requestId: message.requestId,
        ok: false,
        error: error.message,
      });
    }
  }
});

process.on('disconnect', async () => {
  if (disposing) {
    return;
  }

  disposing = true;
  await runtime.dispose();
  process.exit(0);
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

logInfo('原生 HID 子进程已启动', {
  pid: process.pid,
});

if (typeof process.send === 'function') {
  process.send({
    type: 'ready',
  });
}
