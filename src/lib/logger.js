const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const LOG_FILE_NAME = 'runtime.log';

function getLogDirectory() {
  try {
    return path.join(app.getPath('userData'), 'logs');
  } catch (_error) {
    return path.join(process.cwd(), 'logs');
  }
}

function getLogFilePath() {
  return path.join(getLogDirectory(), LOG_FILE_NAME);
}

function serializeDetail(detail) {
  if (detail === undefined || detail === null) {
    return '';
  }

  if (detail instanceof Error) {
    return [detail.name ? `${detail.name}: ${detail.message}` : detail.message, detail.stack]
      .filter(Boolean)
      .join('\n');
  }

  try {
    return JSON.stringify(detail, (key, value) => {
      if (value instanceof Error) {
        return {
          name: value.name,
          message: value.message,
          stack: value.stack,
        };
      }

      return value;
    }, 2);
  } catch (_error) {
    return String(detail);
  }
}

function writeLog(level, message, detail) {
  const lines = [`[${new Date().toISOString()}] [${level}] ${message}`];
  const serializedDetail = serializeDetail(detail);

  if (serializedDetail) {
    lines.push(serializedDetail);
  }

  const payload = `${lines.join('\n')}\n`;

  try {
    fs.mkdirSync(getLogDirectory(), { recursive: true });
    fs.appendFileSync(getLogFilePath(), payload, 'utf8');
  } catch (_error) {
    // 日志写盘失败时至少保留控制台输出，避免主流程受影响。
  }

  if (level === 'ERROR') {
    console.error(payload.trimEnd());
    return;
  }

  if (level === 'WARN') {
    console.warn(payload.trimEnd());
    return;
  }

  console.info(payload.trimEnd());
}

function logInfo(message, detail) {
  writeLog('INFO', message, detail);
}

function logWarn(message, detail) {
  writeLog('WARN', message, detail);
}

function logError(message, detail) {
  writeLog('ERROR', message, detail);
}

module.exports = {
  getLogFilePath,
  logInfo,
  logWarn,
  logError,
};
