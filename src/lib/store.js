const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const STORE_FILE = 'settings.json';

function getStorePath() {
  return path.join(app.getPath('userData'), STORE_FILE);
}

function getDefaultSettings() {
  return {
    overlayBounds: null,
    compactOverlayBounds: null,
    preferredHidDevice: null,
    displayDeviceName: '',
    displayDeviceNameBinding: null,
    alwaysOnTop: true,
    openAtLogin: false,
    overlayVariant: 'full',
  };
}

function readSettings() {
  const filePath = getStorePath();

  try {
    if (!fs.existsSync(filePath)) {
      return getDefaultSettings();
    }

    const raw = fs.readFileSync(filePath, 'utf8');
    return {
      ...getDefaultSettings(),
      ...JSON.parse(raw),
    };
  } catch (error) {
    return getDefaultSettings();
  }
}

function writeSettings(nextSettings) {
  const filePath = getStorePath();
  const payload = {
    ...getDefaultSettings(),
    ...nextSettings,
  };

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

module.exports = {
  readSettings,
  writeSettings,
};
