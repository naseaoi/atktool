const path = require('node:path');
const { createLogFileWriter } = require('./log-file-writer');

const LOG_FILE_NAME = 'runtime.log';
const MAX_LOG_FILE_BYTES = 5 * 1024 * 1024;
const MAX_LOG_ARCHIVES = 4;
const MAX_MESSAGE_LENGTH = 4_096;
const MAX_DETAIL_LENGTH = 32_768;
let logFileWriter = null;

function getElectronApp() {
  try {
    return require('electron').app;
  } catch (_error) {
    return null;
  }
}

function getLogDirectory() {
  if (process.env.ATKTOOL_USER_DATA_DIR) {
    return path.join(process.env.ATKTOOL_USER_DATA_DIR, 'logs');
  }

  try {
    const app = getElectronApp();
    if (!app) {
      throw new Error('electron app unavailable');
    }

    return path.join(app.getPath('userData'), 'logs');
  } catch (_error) {
    return path.join(process.cwd(), 'logs');
  }
}

function getLogFilePath() {
  return path.join(getLogDirectory(), LOG_FILE_NAME);
}

function truncateText(value, maxLength) {
  const text = String(value);
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength)}\n...<truncated>`;
}

function getLogFileWriter() {
  const directory = getLogDirectory();
  if (!logFileWriter || path.dirname(logFileWriter.filePath) !== directory) {
    logFileWriter = createLogFileWriter({
      directory,
      fileName: LOG_FILE_NAME,
      maxBytes: MAX_LOG_FILE_BYTES,
      maxArchives: MAX_LOG_ARCHIVES,
    });
  }

  return logFileWriter;
}

function serializeDetail(detail) {
  if (detail === undefined || detail === null) {
    return '';
  }

  if (detail instanceof Error) {
    return truncateText([detail.name ? `${detail.name}: ${detail.message}` : detail.message, detail.stack]
      .filter(Boolean)
      .join('\n'), MAX_DETAIL_LENGTH);
  }

  try {
    return truncateText(JSON.stringify(detail, (key, value) => {
      if (value instanceof Error) {
        return {
          name: value.name,
          message: value.message,
          stack: value.stack,
        };
      }

      return value;
    }, 2), MAX_DETAIL_LENGTH);
  } catch (_error) {
    return truncateText(detail, MAX_DETAIL_LENGTH);
  }
}

function writeLog(level, message, detail) {
  const lines = [`[${new Date().toISOString()}] [${level}] ${truncateText(message, MAX_MESSAGE_LENGTH)}`];
  const serializedDetail = serializeDetail(detail);

  if (serializedDetail) {
    lines.push(serializedDetail);
  }

  const payload = `${lines.join('\n')}\n`;

  void getLogFileWriter().write(payload);

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

function flushLogWrites() {
  return logFileWriter?.flush() || Promise.resolve();
}

module.exports = {
  flushLogWrites,
  getLogFilePath,
  logInfo,
  logWarn,
  logError,
};
