const fs = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');

const ROOT_DIR = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(ROOT_DIR, 'assets', 'screenshots');
const SAMPLE_TIME = '2026-07-26T12:18:36.000Z';

const preferredDevice = {
  vendorId: 0x373b,
  productId: 0x1054,
  productName: 'VXE R1 Pro Max',
  usagePage: 0xff00,
  usage: 1,
};

const preferences = {
  openAtLogin: true,
  displayDeviceName: preferredDevice.productName,
  overlayVariant: 'full',
  preferredHidDevice: preferredDevice,
};

const overlayState = {
  status: 'connected',
  message: '已通过本地 HID 获取设备电量。',
  batteryPercent: 82,
  batteryText: '82%',
  deviceName: preferredDevice.productName,
  charging: false,
  chargeStatus: 'idle',
  needsUserAction: false,
  sampledAt: SAMPLE_TIME,
  protocolName: 'COMPX 直连',
  mode: 'stable',
  grantedDevicesCount: 3,
  overlayVariant: 'full',
  alwaysOnTop: true,
};

function registerIpcMocks() {
  ipcMain.handle('manager:get-preferences', () => preferences);
  ipcMain.handle('manager:get-overlay-state', () => overlayState);
  ipcMain.handle('manager:set-open-at-login', (_event, enabled) => ({
    ...preferences,
    openAtLogin: Boolean(enabled),
  }));
  ipcMain.handle('manager:set-overlay-variant', (_event, overlayVariant) => ({
    ...preferences,
    overlayVariant,
  }));
  ipcMain.handle('manager:request-refresh', () => true);
  ipcMain.handle('manager:activate-stable-source', () => true);
  ipcMain.handle('manager:begin-hid-selection', () => false);
  ipcMain.handle('manager:end-hid-selection', () => true);
  ipcMain.handle('manager:pick-hid-device', () => preferences);
  ipcMain.handle('manager:cancel-hid-selection', () => true);
  ipcMain.handle('manager:clear-device-binding', () => ({
    ...preferences,
    displayDeviceName: '',
    preferredHidDevice: null,
  }));
  ipcMain.handle('overlay:get-state', () => overlayState);
  ipcMain.handle('overlay:toggle-pin', () => ({
    ...overlayState,
    alwaysOnTop: !overlayState.alwaysOnTop,
  }));
  ipcMain.handle('overlay:toggle-variant', () => ({
    ...overlayState,
    overlayVariant: 'compact',
  }));
  ipcMain.on('manager:fit-height', () => {});
  ipcMain.on('manager:open-fallback', () => {});
  ipcMain.on('overlay:fit-height', () => {});
  ipcMain.on('overlay:hide', () => {});
}

async function waitForRenderer(window, readyExpression) {
  await window.webContents.executeJavaScript(`
    new Promise((resolve, reject) => {
      const deadline = Date.now() + 5000;
      const check = () => {
        if (${readyExpression}) {
          document.fonts.ready.then(resolve);
          return;
        }
        if (Date.now() >= deadline) {
          reject(new Error('Renderer readiness timed out'));
          return;
        }
        setTimeout(check, 25);
      };
      check();
    })
  `);
}

async function saveWindowCapture(window, outputName) {
  const image = await window.webContents.capturePage();
  if (image.isEmpty()) {
    throw new Error(`Screenshot is empty: ${outputName}`);
  }
  await fs.writeFile(path.join(OUTPUT_DIR, outputName), image.toPNG());
}

async function captureManager() {
  const window = new BrowserWindow({
    width: 880,
    height: 720,
    useContentSize: true,
    show: false,
    backgroundColor: '#081219',
    webPreferences: {
      preload: path.join(ROOT_DIR, 'src', 'preload', 'manager-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  await window.loadFile(path.join(ROOT_DIR, 'src', 'renderer', 'manager.html'));
  await waitForRenderer(window, "document.body.dataset.ready === 'true'");

  const contentHeight = await window.webContents.executeJavaScript(`
    Math.ceil(document.querySelector('.app-shell').getBoundingClientRect().bottom + 28)
  `);
  window.setContentSize(880, contentHeight);
  await new Promise((resolve) => setTimeout(resolve, 250));
  await saveWindowCapture(window, 'manager.png');
  return window;
}

async function captureOverlay() {
  const window = new BrowserWindow({
    width: 360,
    height: 262,
    useContentSize: true,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(ROOT_DIR, 'src', 'preload', 'overlay-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  await window.loadFile(path.join(ROOT_DIR, 'src', 'renderer', 'overlay.html'));
  await waitForRenderer(window, "document.getElementById('batteryText').textContent === '82%'");
  await new Promise((resolve) => setTimeout(resolve, 1300));
  await saveWindowCapture(window, 'overlay-full.png');
  return window;
}

async function main() {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  registerIpcMocks();
  const windows = [await captureManager(), await captureOverlay()];
  windows.forEach((window) => window.destroy());
}

app.commandLine.appendSwitch('force-device-scale-factor', '1.25');
app.disableHardwareAcceleration();

app.whenReady()
  .then(main)
  .then(() => app.quit())
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
