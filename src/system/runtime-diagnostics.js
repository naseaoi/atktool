const { app } = require('electron');
const { logError, logWarn } = require('../utils/logger');

// 主进程崩溃兜底:uncaughtException 触发后尝试自重启,让用户无感恢复。
// isQuitting 标志被托盘退出菜单/before-quit 事件设置,避免正常退出路径被误判为异常。

let isQuitting = false;
let unexpectedShutdownHandled = false;

function markQuitting() {
  isQuitting = true;
}

function isQuittingNow() {
  return isQuitting;
}

function relaunchAfterUnexpectedFailure(reason, detail) {
  if (unexpectedShutdownHandled || isQuitting) {
    return;
  }

  unexpectedShutdownHandled = true;
  logError(`主进程发生未恢复异常，准备重启应用（${reason}）`, detail);

  try {
    if (app.isReady()) {
      app.relaunch();
    }
  } catch (error) {
    logError('调用 app.relaunch 失败', error);
  }

  setTimeout(() => {
    try {
      app.exit(1);
    } catch (error) {
      logError('调用 app.exit 失败，回退到 process.exit', error);
      process.exit(1);
    }
  }, 120);
}

function register() {
  process.on('uncaughtException', (error) => {
    relaunchAfterUnexpectedFailure('uncaughtException', error);
  });

  process.on('unhandledRejection', (reason) => {
    logError('主进程出现未处理 Promise 拒绝', reason);
  });

  process.on('warning', (warning) => {
    logWarn('主进程 warning', warning);
  });

  app.on('render-process-gone', (_event, webContents, details) => {
    logWarn('渲染进程退出', {
      reason: details.reason,
      exitCode: details.exitCode,
      url: typeof webContents.getURL === 'function' ? webContents.getURL() : '',
    });
  });

  app.on('child-process-gone', (_event, details) => {
    logWarn('Electron 子进程退出', details);
  });
}

module.exports = {
  register,
  markQuitting,
  isQuittingNow,
  relaunchAfterUnexpectedFailure,
};
