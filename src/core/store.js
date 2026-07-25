const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');
const { getDefaultSettings, normalizeSettings } = require('./settings-schema');

const STORE_FILE = 'settings.json';

function getStorePath() {
  return path.join(app.getPath('userData'), STORE_FILE);
}

function readSettings() {
  const filePath = getStorePath();

  try {
    if (!fs.existsSync(filePath)) {
      return getDefaultSettings();
    }

    const raw = fs.readFileSync(filePath, 'utf8');
    return normalizeSettings(JSON.parse(raw));
  } catch (error) {
    return getDefaultSettings();
  }
}

function writeSettings(nextSettings) {
  const filePath = getStorePath();
  const payload = normalizeSettings(nextSettings);
  const temporaryPath = `${filePath}.tmp`;

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(temporaryPath, filePath);
}

module.exports = {
  readSettings,
  writeSettings,
};
