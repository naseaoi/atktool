const path = require('node:path');
const fs = require('node:fs');
const zlib = require('node:zlib');
const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  nativeImage,
  ipcMain,
  powerMonitor,
  session,
} = require('electron');

const { getLogFilePath, logInfo, logWarn, logError } = require('./lib/logger');
const { readSettings, writeSettings } = require('./lib/store');
const { NativeBatteryRuntime } = require('./lib/native-hid-host');

const HUB_URL = 'https://hub.atk.pro/';
const HUB_ORIGIN = new URL(HUB_URL).origin;
// Hub 窗口独立 partition:一来与设备管理/悬浮窗的默认 session 隔离,避免外站 cookie/storage 污染主 UI;
// 二来窗口关闭后可精准 clearCache(),释放 hub 网页留下的 ~80-150MB Chromium 缓存。persist: 前缀保留登录态。
const HUB_SESSION_PARTITION = 'persist:atk-hub';
const OVERLAY_VARIANTS = {
  full: {
    width: 404,
    height: 392,
  },
  compact: {
    width: 80,
    height: 80,
  },
};
const MANAGER_MIN_HEIGHT = 560;
const TRAY_ICON_VERSION = 'v4';
const TRAY_ICON_SIZE = 64;
const TRAY_DIGIT_SEGMENTS = {
  0: ['a', 'b', 'c', 'd', 'e', 'f'],
  1: ['b', 'c'],
  2: ['a', 'b', 'd', 'e', 'g'],
  3: ['a', 'b', 'c', 'd', 'g'],
  4: ['b', 'c', 'f', 'g'],
  5: ['a', 'c', 'd', 'f', 'g'],
  6: ['a', 'c', 'd', 'e', 'f', 'g'],
  7: ['a', 'b', 'c'],
  8: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
  9: ['a', 'b', 'c', 'd', 'f', 'g'],
  '-': ['g'],
};
const GENERIC_DEVICE_NAME_PATTERN = /wireless mouse|mouse|dongle|receiver|nano|hid|bluetooth|keyboard/i;

let overlayWindow = null;
let managerWindow = null;
let fallbackHubWindow = null;
let nativeBatteryRuntime = null;
let tray = null;
let isQuitting = false;
let unexpectedShutdownHandled = false;
let activeOverlaySource = 'manager';
let managerWindowReady = false;
let managerWindowPendingInitialShow = false;
let managerWindowShowTimer = null;
let pendingHidSelection = null;
let settings = readSettings();
let overlayState = {
  status: 'loading',
  message: '正在启动悬浮窗...',
  batteryPercent: null,
  batteryText: '--',
  deviceName: '',
  charging: false,
  needsUserAction: true,
  sampledAt: null,
  protocolName: '',
  mode: 'stable',
  alwaysOnTop: settings.alwaysOnTop,
  overlayVariant: settings.overlayVariant === 'compact' ? 'compact' : 'full',
  grantedDevicesCount: 0,
};

app.disableHardwareAcceleration();

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
}

function formatMemoryMegabytes(valueInKilobytes = 0) {
  return `${(valueInKilobytes / 1024).toFixed(1)}MB`;
}

function logMemorySnapshot(label) {
  if (!app.isReady()) {
    return;
  }

  try {
    const metrics = app.getAppMetrics()
      .map((metric) => {
        const memory = metric.memory || {};
        return `${metric.type}:${metric.pid}:${formatMemoryMegabytes(memory.workingSetSize)}`;
      })
      .join(', ');

    logInfo(`[memory] ${label} => ${metrics}`);
  } catch (error) {
    logWarn(`[memory] ${label} => ${error.message}`, error);
  }
}

function sendToWindow(targetWindow, channel, payload, label) {
  if (!targetWindow || targetWindow.isDestroyed()) {
    return;
  }

  try {
    targetWindow.webContents.send(channel, payload);
  } catch (error) {
    logWarn(`${label} 发送失败`, {
      channel,
      error,
    });
  }
}

function isOverlayVisible() {
  return Boolean(overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible());
}

function createCrcTable() {
  const table = new Uint32Array(256);

  for (let index = 0; index < 256; index += 1) {
    let value = index;

    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }

    table[index] = value >>> 0;
  }

  return table;
}

const PNG_CRC_TABLE = createCrcTable();

function crc32(buffer) {
  let value = 0xffffffff;

  for (const byte of buffer) {
    value = PNG_CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  }

  return (value ^ 0xffffffff) >>> 0;
}

function createPngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const lengthBuffer = Buffer.alloc(4);
  const crcBuffer = Buffer.alloc(4);
  const payload = Buffer.concat([typeBuffer, data]);

  lengthBuffer.writeUInt32BE(data.length, 0);
  crcBuffer.writeUInt32BE(crc32(payload), 0);

  return Buffer.concat([lengthBuffer, payload, crcBuffer]);
}

function encodeRgbaToPng(width, height, pixels) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const header = Buffer.alloc(13);
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);

  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * (stride + 1);
    raw[rowOffset] = 0;
    pixels.copy(raw, rowOffset + 1, y * stride, y * stride + stride);
  }

  return Buffer.concat([
    signature,
    createPngChunk('IHDR', header),
    createPngChunk('IDAT', zlib.deflateSync(raw)),
    createPngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function createRgbaCanvas(width, height) {
  return Buffer.alloc(width * height * 4, 0);
}

function blendPixel(pixels, width, x, y, color, alphaScale = 1) {
  if (x < 0 || y < 0 || x >= width || y >= TRAY_ICON_SIZE) {
    return;
  }

  const index = (y * width + x) * 4;
  const sourceAlpha = (color[3] / 255) * alphaScale;
  const targetAlpha = pixels[index + 3] / 255;
  const outputAlpha = sourceAlpha + targetAlpha * (1 - sourceAlpha);

  if (outputAlpha <= 0) {
    return;
  }

  pixels[index] = Math.round((color[0] * sourceAlpha + pixels[index] * targetAlpha * (1 - sourceAlpha)) / outputAlpha);
  pixels[index + 1] = Math.round((color[1] * sourceAlpha + pixels[index + 1] * targetAlpha * (1 - sourceAlpha)) / outputAlpha);
  pixels[index + 2] = Math.round((color[2] * sourceAlpha + pixels[index + 2] * targetAlpha * (1 - sourceAlpha)) / outputAlpha);
  pixels[index + 3] = Math.round(outputAlpha * 255);
}

function isPointInRoundedRect(pointX, pointY, rectX, rectY, rectWidth, rectHeight, radius) {
  const limitX = Math.max(rectX + radius, Math.min(pointX, rectX + rectWidth - radius));
  const limitY = Math.max(rectY + radius, Math.min(pointY, rectY + rectHeight - radius));
  const distanceX = pointX - limitX;
  const distanceY = pointY - limitY;

  return distanceX * distanceX + distanceY * distanceY <= radius * radius;
}

function drawRoundedRect(pixels, width, height, x, y, rectWidth, rectHeight, radius, color) {
  const samplePoints = [
    [0.25, 0.25],
    [0.75, 0.25],
    [0.25, 0.75],
    [0.75, 0.75],
  ];
  const startX = Math.max(0, Math.floor(x));
  const endX = Math.min(width - 1, Math.ceil(x + rectWidth));
  const startY = Math.max(0, Math.floor(y));
  const endY = Math.min(height - 1, Math.ceil(y + rectHeight));

  for (let pixelY = startY; pixelY <= endY; pixelY += 1) {
    for (let pixelX = startX; pixelX <= endX; pixelX += 1) {
      let coverage = 0;

      for (const [offsetX, offsetY] of samplePoints) {
        if (isPointInRoundedRect(pixelX + offsetX, pixelY + offsetY, x, y, rectWidth, rectHeight, radius)) {
          coverage += 1;
        }
      }

      if (coverage > 0) {
        blendPixel(pixels, width, pixelX, pixelY, color, coverage / samplePoints.length);
      }
    }
  }
}

function drawTrayDigit(pixels, width, height, digit, offsetX, offsetY, scale, color) {
  const thickness = 2 * scale;
  const length = 7 * scale;
  const halfLength = 5.5 * scale;
  const rounded = 0.85 * scale;
  const segments = {
    a: { x: offsetX + 2 * scale, y: offsetY, width: length, height: thickness },
    d: { x: offsetX + 2 * scale, y: offsetY + 14 * scale, width: length, height: thickness },
    g: { x: offsetX + 2 * scale, y: offsetY + 7 * scale, width: length, height: thickness },
    f: { x: offsetX, y: offsetY + 1.5 * scale, width: thickness, height: halfLength },
    e: { x: offsetX, y: offsetY + 8 * scale, width: thickness, height: halfLength },
    b: { x: offsetX + 9 * scale, y: offsetY + 1.5 * scale, width: thickness, height: halfLength },
    c: { x: offsetX + 9 * scale, y: offsetY + 8 * scale, width: thickness, height: halfLength },
  };

  for (const segmentName of TRAY_DIGIT_SEGMENTS[digit] || []) {
    const segment = segments[segmentName];
    drawRoundedRect(pixels, width, height, segment.x, segment.y, segment.width, segment.height, rounded, color);
  }
}

function renderTrayIconBuffer(percent = null, charging = false) {
  const pixels = createRgbaCanvas(TRAY_ICON_SIZE, TRAY_ICON_SIZE);
  const text = Number.isFinite(percent) ? String(Math.max(0, Math.min(100, Math.round(percent)))) : '--';
  const scale = text.length >= 3 ? 1.46 : text.length === 2 ? 1.9 : 2.34;
  const digitWidth = 11 * scale;
  const gap = text.length >= 3 ? 2.4 : 4;
  const totalWidth = digitWidth * text.length + gap * Math.max(0, text.length - 1);
  const startX = (TRAY_ICON_SIZE - totalWidth) / 2;
  const startY = text.length >= 3 ? 18 : 15;
  // 充电时用亮绿色数字配合顶部充电指示条，与普通电量一眼可辨。
  const digitColor = charging ? [120, 248, 168, 255] : [244, 251, 250, 255];

  // 托盘图标直接光栅化成 PNG，避免 Win11/Electron 对 SVG 托盘图的透明兼容问题。
  drawRoundedRect(pixels, TRAY_ICON_SIZE, TRAY_ICON_SIZE, 2, 2, 60, 60, 17, [35, 73, 84, 255]);
  drawRoundedRect(pixels, TRAY_ICON_SIZE, TRAY_ICON_SIZE, 3.5, 3.5, 57, 57, 15.5, [13, 32, 40, 255]);
  drawRoundedRect(pixels, TRAY_ICON_SIZE, TRAY_ICON_SIZE, 5, 5, 54, 54, 14, [21, 55, 64, 255]);
  drawRoundedRect(pixels, TRAY_ICON_SIZE, TRAY_ICON_SIZE, 8, 8, 48, 48, 12, [255, 255, 255, 12]);

  text.split('').forEach((digit, index) => {
    const offsetX = startX + index * (digitWidth + gap);
    drawTrayDigit(pixels, TRAY_ICON_SIZE, TRAY_ICON_SIZE, digit, offsetX + 1.2, startY + 1.2, scale, [8, 18, 25, 78]);
    drawTrayDigit(pixels, TRAY_ICON_SIZE, TRAY_ICON_SIZE, digit, offsetX, startY, scale, digitColor);
  });

  if (charging) {
    // 顶部中间画一条绿色指示条，托盘缩到 16/20 像素依然能分辨充电态。
    drawRoundedRect(pixels, TRAY_ICON_SIZE, TRAY_ICON_SIZE, 22, 8, 20, 4, 2, [96, 232, 146, 230]);
  }

  return encodeRgbaToPng(TRAY_ICON_SIZE, TRAY_ICON_SIZE, pixels);
}

function createTrayIcon(percent = null, charging = false) {
  return nativeImage.createFromBuffer(renderTrayIconBuffer(percent, charging));
}

// 托盘/任务栏图标按 (percent, charging) 哈希缓存，避免同一状态下反复渲染与磁盘 IO。
// 任务栏角标与托盘图标使用各自的内存缓存：前者直接从 Buffer 构造 nativeImage，
// 后者保留"首次走文件"的行为以沿用 Windows 托盘更稳定的渲染路径。
const taskbarIconCache = new Map();
const trayIconCache = new Map();

function getTrayIconCacheKey(percent, charging) {
  const normalizedPercent = Number.isFinite(percent)
    ? String(Math.max(0, Math.min(100, Math.round(percent))))
    : 'unknown';
  return `${normalizedPercent}|${charging ? 1 : 0}`;
}

function getOrCreateTaskbarIcon(percent = null, charging = false) {
  const key = getTrayIconCacheKey(percent, charging);
  const cached = taskbarIconCache.get(key);

  if (cached) {
    return cached;
  }

  const icon = createTrayIcon(percent, charging);
  taskbarIconCache.set(key, icon);
  return icon;
}

function setActiveOverlaySource(source) {
  if (source !== 'hub' && fallbackHubWindow && !fallbackHubWindow.isDestroyed()) {
    fallbackHubWindow.destroy();
    fallbackHubWindow = null;
  }

  activeOverlaySource = source === 'hub' ? 'hub' : 'manager';

  if (nativeBatteryRuntime) {
    nativeBatteryRuntime.setSuspended(activeOverlaySource === 'hub');
  }
}

async function activateStableOverlaySource() {
  setActiveOverlaySource('manager');
  await new Promise((resolve) => {
    setTimeout(resolve, 220);
  });

  return true;
}

function normalizeOverlayVariant(value) {
  return value === 'compact' ? 'compact' : 'full';
}

function getOverlayVariant() {
  return normalizeOverlayVariant(settings.overlayVariant);
}

function getOverlayMetrics(variant = getOverlayVariant()) {
  return OVERLAY_VARIANTS[normalizeOverlayVariant(variant)] || OVERLAY_VARIANTS.full;
}

function getOverlayBoundsKey(variant = getOverlayVariant()) {
  return normalizeOverlayVariant(variant) === 'compact' ? 'compactOverlayBounds' : 'overlayBounds';
}

function getStoredOverlayBounds(variant = getOverlayVariant()) {
  return settings[getOverlayBoundsKey(variant)] || null;
}

function saveSettings(patch) {
  settings = {
    ...settings,
    ...patch,
  };
  writeSettings(settings);
}

function normalizeDeviceName(name) {
  return typeof name === 'string' ? name.trim() : '';
}

function getDeviceProductName(device) {
  return normalizeDeviceName(device?.productName || device?.name);
}

function visitCollections(collections, visitor) {
  for (const collection of Array.isArray(collections) ? collections : []) {
    visitor(collection);
    visitCollections(collection.children, visitor);
  }
}

function buildCollectionSignature(device) {
  const signatures = [];

  visitCollections(device?.collections, (collection) => {
    const inputReports = Array.isArray(collection.inputReports)
      ? collection.inputReports.map((report) => report.reportId).sort((left, right) => left - right).join(',')
      : '';
    const outputReports = Array.isArray(collection.outputReports)
      ? collection.outputReports.map((report) => report.reportId).sort((left, right) => left - right).join(',')
      : '';
    const featureReports = Array.isArray(collection.featureReports)
      ? collection.featureReports.map((report) => report.reportId).sort((left, right) => left - right).join(',')
      : '';

    signatures.push([
      collection.usagePage ?? '',
      collection.usage ?? '',
      inputReports,
      outputReports,
      featureReports,
    ].join('/'));
  });

  return signatures.sort().join('|');
}

function normalizeDeviceBinding(device) {
  if (!device || !Number.isFinite(device.vendorId) || !Number.isFinite(device.productId)) {
    return null;
  }

  return {
    vendorId: device.vendorId,
    productId: device.productId,
    productName: getDeviceProductName(device),
    collectionSignature: normalizeDeviceName(device.collectionSignature) || buildCollectionSignature(device),
  };
}

function getDeviceBindingKey(device) {
  const normalized = normalizeDeviceBinding(device);

  if (!normalized) {
    return '';
  }

  return [normalized.vendorId, normalized.productId, normalized.productName, normalized.collectionSignature].join(':');
}

function getLooseDeviceBindingKey(device) {
  const normalized = normalizeDeviceBinding(device);

  if (!normalized) {
    return '';
  }

  return [normalized.vendorId, normalized.productId, normalized.productName].join(':');
}

function getDeviceBindingMatchLevel(left, right) {
  const exactLeft = getDeviceBindingKey(left);
  const exactRight = getDeviceBindingKey(right);

  if (exactLeft && exactLeft === exactRight) {
    return 2;
  }

  const looseLeft = getLooseDeviceBindingKey(left);
  const looseRight = getLooseDeviceBindingKey(right);

  if (looseLeft && looseLeft === looseRight) {
    return 1;
  }

  return 0;
}

function hasRememberedDeviceBinding() {
  return Boolean(normalizeDeviceBinding(settings.preferredHidDevice));
}

function isGenericDeviceName(name) {
  const normalized = normalizeDeviceName(name);
  if (!normalized) {
    return true;
  }

  if (/ATK|VXE/i.test(normalized)) {
    return false;
  }

  return GENERIC_DEVICE_NAME_PATTERN.test(normalized);
}

function getBoundDisplayDeviceName(device = settings.preferredHidDevice) {
  const savedName = normalizeDeviceName(settings.displayDeviceName);
  const binding = settings.displayDeviceNameBinding || settings.preferredHidDevice;

  if (!savedName || isGenericDeviceName(savedName)) {
    return '';
  }

  // 兼容旧版本只记录宽松绑定的情况；若当前还是同一类 HID 接口，则继续复用已识别的型号名。
  if (!getDeviceBindingMatchLevel(binding, device)) {
    return '';
  }

  return savedName;
}

function resolveOverlayDeviceName(name) {
  const normalized = normalizeDeviceName(name);
  const savedName = getBoundDisplayDeviceName();

  if (normalized && !isGenericDeviceName(normalized)) {
    return normalized;
  }

  if (savedName && !isGenericDeviceName(savedName)) {
    return savedName;
  }

  if (normalized) {
    return 'ATK 设备';
  }

  return savedName;
}

function rememberDisplayDeviceName(name, device = settings.preferredHidDevice) {
  const normalized = normalizeDeviceName(name);
  const binding = normalizeDeviceBinding(device);
  const currentBindingKey = getDeviceBindingKey(settings.displayDeviceNameBinding);
  const nextBindingKey = getDeviceBindingKey(binding);

  if (!normalized || isGenericDeviceName(normalized) || !binding) {
    return false;
  }

  if (normalized === settings.displayDeviceName && currentBindingKey === nextBindingKey) {
    return false;
  }

  saveSettings({
    displayDeviceName: normalized,
    displayDeviceNameBinding: binding,
  });

  return true;
}

function getOverlayMessage(nextState) {
  if (nextState.mode === 'fallback') {
    if (nextState.status === 'connected') {
      return '同步官网电量已接管电量读取。';
    }

    if (nextState.status === 'waiting') {
      return '同步官网电量页已打开，等待设备信息出现。';
    }

    return '同步官网电量页可继续完成连接。';
  }

  if (nextState.status === 'connected') {
    return nextState.batteryPercent === null ? '本地直连已建立。' : '本地直连工作中。';
  }

  if (nextState.status === 'unsupported') {
    return nextState.batteryPercent === null ? '直连适配中，可打开设备管理继续处理。' : '本地直连工作中。';
  }

  if (nextState.status === 'waiting') {
    return hasRememberedDeviceBinding()
      ? '当前绑定设备待连接，可在设备管理里刷新当前设备。'
      : '请在设备管理里选择并绑定设备。';
  }

  if (nextState.status === 'error') {
    return '读取异常，请打开设备管理查看详情。';
  }

  return nextState.message || '正在准备 HID 直连采集...';
}

function getStatusLabel(status) {
  switch (status) {
    case 'connected':
      return '已连接';
    case 'unsupported':
      return '待适配';
    case 'waiting':
      return hasRememberedDeviceBinding() ? '待连接' : '待绑定';
    case 'error':
      return '异常';
    default:
      return '加载中';
  }
}

function buildManagerPreferences() {
  return {
    preferredHidDevice: settings.preferredHidDevice || null,
    displayDeviceName: getBoundDisplayDeviceName(),
    alwaysOnTop: settings.alwaysOnTop,
    openAtLogin: Boolean(settings.openAtLogin),
    overlayVariant: getOverlayVariant(),
  };
}

function fitManagerWindowHeight(contentHeight) {
  if (!managerWindow || managerWindow.isDestroyed() || !Number.isFinite(contentHeight)) {
    return;
  }

  if (managerWindow.isMaximized() || managerWindow.isFullScreen()) {
    return;
  }

  const targetHeight = Math.max(MANAGER_MIN_HEIGHT, Math.ceil(contentHeight));
  const currentBounds = managerWindow.getContentBounds();

  if (Math.abs(currentBounds.height - targetHeight) <= 2) {
    scheduleManagerWindowInitialShow();
    return;
  }

  managerWindow.setContentSize(currentBounds.width, targetHeight);
  scheduleManagerWindowInitialShow(120);
}

function clearManagerWindowShowTimer() {
  if (!managerWindowShowTimer) {
    return;
  }

  clearTimeout(managerWindowShowTimer);
  managerWindowShowTimer = null;
}

function scheduleManagerWindowInitialShow(delay = 96) {
  if (
    !managerWindow ||
    managerWindow.isDestroyed() ||
    !managerWindowPendingInitialShow ||
    !managerWindowReady
  ) {
    return;
  }

  clearManagerWindowShowTimer();
  managerWindowShowTimer = setTimeout(() => {
    flushManagerWindowInitialShow();
  }, delay);
  managerWindowShowTimer.unref?.();
}

function flushManagerWindowInitialShow() {
  if (
    !managerWindow ||
    managerWindow.isDestroyed() ||
    !managerWindowPendingInitialShow ||
    !managerWindowReady
  ) {
    return;
  }

  managerWindowPendingInitialShow = false;
  clearManagerWindowShowTimer();
  managerWindow.show();
  managerWindow.focus();
  updateTrayMenu();
  logMemorySnapshot('manager-window-opened');
}

function fitOverlayWindowHeight(contentHeight) {
  if (!overlayWindow || overlayWindow.isDestroyed() || !Number.isFinite(contentHeight)) {
    return;
  }

  if (overlayWindow.isMaximized() || overlayWindow.isFullScreen() || getOverlayVariant() !== 'full') {
    return;
  }

  const metrics = getOverlayMetrics('full');
  const targetHeight = Math.max(340, Math.ceil(contentHeight));
  const currentBounds = overlayWindow.getContentBounds();

  if (Math.abs(currentBounds.height - targetHeight) <= 2) {
    return;
  }

  // 完整版高度由渲染层回传的真实内容高度驱动，避免底部操作区被压缩。
  overlayWindow.setMinimumSize(metrics.width, targetHeight);
  overlayWindow.setMaximumSize(metrics.width, targetHeight);
  overlayWindow.setContentSize(metrics.width, targetHeight);
}

function updateWindowTaskbarIcons() {
  const icon = getOrCreateTaskbarIcon(overlayState.batteryPercent, overlayState.charging);
  const description = overlayState.batteryPercent !== null
    ? `当前电量 ${overlayState.batteryPercent}${overlayState.charging ? '（充电中）' : ''}`
    : '暂无电量';

  if (managerWindow && !managerWindow.isDestroyed()) {
    try {
      managerWindow.setOverlayIcon(icon, description);
    } catch (error) {
      logWarn('设备管理窗口任务栏图标刷新失败', error);
    }
  }

  if (fallbackHubWindow && !fallbackHubWindow.isDestroyed()) {
    try {
      fallbackHubWindow.setOverlayIcon(icon, description);
    } catch (error) {
      logWarn('官网同步窗口任务栏图标刷新失败', error);
    }
  }
}

function getTrayIconDirectory() {
  return path.join(app.getPath('userData'), 'tray-icons');
}

function getTrayIconFilePath(percent = null, charging = false) {
  const text = Number.isFinite(percent) ? String(Math.max(0, Math.min(100, Math.round(percent)))) : 'unknown';
  const suffix = charging ? '-charging' : '';
  const filePath = path.join(getTrayIconDirectory(), `battery-${TRAY_ICON_VERSION}-${text}${suffix}.png`);

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, renderTrayIconBuffer(percent, charging));

  return filePath;
}

function loadTrayIconFromFile(percent = null, charging = false) {
  const key = getTrayIconCacheKey(percent, charging);
  const cached = trayIconCache.get(key);

  if (cached) {
    // 同一电量/充电状态的托盘图标已经生成过，直接复用 nativeImage，跳过写盘+读盘的同步 IO。
    return cached;
  }

  try {
    const filePath = getTrayIconFilePath(percent, charging);
    const image = nativeImage.createFromBuffer(fs.readFileSync(filePath));
    trayIconCache.set(key, image);
    return image;
  } catch (error) {
    // 托盘图标文件写入/读取偶发失败时回退到内存图标，避免主进程被同步 IO 异常带崩。
    logWarn('托盘图标文件读取失败，回退为内存图标', {
      percent,
      charging,
      error,
    });
    const fallback = createTrayIcon(percent, charging);
    trayIconCache.set(key, fallback);
    return fallback;
  }
}

function notifyManagerPreferencesChanged() {
  const preferences = buildManagerPreferences();

  if (managerWindow && !managerWindow.isDestroyed()) {
    sendToWindow(managerWindow, 'manager:preferences', preferences, '设备管理偏好同步');
  }

  if (overlayWindow && !overlayWindow.isDestroyed()) {
    sendToWindow(overlayWindow, 'manager:preferences', preferences, '悬浮窗偏好同步');
  }
}

function notifyManagerOverlayStateChanged() {
  if (!managerWindow || managerWindow.isDestroyed()) {
    return;
  }

  sendToWindow(managerWindow, 'manager:overlay-state', overlayState, '设备管理状态同步');
}

function persistOverlayBounds(bounds, variant = getOverlayVariant()) {
  if (!bounds) {
    return;
  }

  void variant;

  // 两种形态共用同一套锚点，保证移动完整版后切到简略版仍停在同一位置。
  saveSettings({
    overlayBounds: {
      x: bounds.x,
      y: bounds.y,
    },
    compactOverlayBounds: {
      x: bounds.x,
      y: bounds.y,
    },
  });
}

function getLoginItemArgs() {
  return app.isPackaged ? [] : [app.getAppPath()];
}

function setOpenAtLogin(enabled) {
  const nextValue = Boolean(enabled);
  const args = getLoginItemArgs();

  app.setLoginItemSettings({
    openAtLogin: nextValue,
    path: process.execPath,
    args,
  });

  const loginItemState = app.getLoginItemSettings({
    path: process.execPath,
    args,
  });

  saveSettings({
    openAtLogin: Boolean(loginItemState.openAtLogin),
  });
  notifyManagerPreferencesChanged();
  updateTrayMenu();

  return {
    ...buildManagerPreferences(),
  };
}

function setOverlayVariant(nextVariant) {
  const overlayVariant = normalizeOverlayVariant(nextVariant);
  const currentBounds = overlayWindow && !overlayWindow.isDestroyed() ? overlayWindow.getBounds() : null;
  const storedBounds = getStoredOverlayBounds(overlayVariant);
  const fallbackBounds = currentBounds
    ? {
        x: currentBounds.x,
        y: currentBounds.y,
      }
    : null;
  const nextBounds = storedBounds || fallbackBounds;
  const patch = {
    overlayVariant,
  };

  if (nextBounds && !storedBounds) {
    patch[getOverlayBoundsKey(overlayVariant)] = nextBounds;
  }

  saveSettings(patch);

  if (overlayWindow && !overlayWindow.isDestroyed()) {
    const metrics = getOverlayMetrics(overlayVariant);
    overlayWindow.setMinimumSize(metrics.width, metrics.height);
    overlayWindow.setMaximumSize(metrics.width, metrics.height);
    overlayWindow.setSize(metrics.width, metrics.height);

    if (nextBounds) {
      overlayWindow.setPosition(nextBounds.x, nextBounds.y);
    }
  }

  mergeOverlayState({
    overlayVariant,
  });
  notifyManagerPreferencesChanged();

  return {
    ...buildManagerPreferences(),
  };
}

async function applyOverlayVariant(nextVariant, options = {}) {
  void options;
  // 直接切换尺寸和布局，避免隐藏/重显带来的过渡动画。
  return setOverlayVariant(nextVariant);
}

function mergeOverlayState(patch) {
  // 主进程统一维护悬浮窗状态，避免托盘、管理页、同步官网电量页彼此漂移。
  const nextDeviceName = resolveOverlayDeviceName(patch.deviceName ?? overlayState.deviceName);
  const didUpdateDisplayDeviceName = rememberDisplayDeviceName(nextDeviceName);

  overlayState = {
    ...overlayState,
    ...patch,
    deviceName: nextDeviceName,
    alwaysOnTop: settings.alwaysOnTop,
    overlayVariant: getOverlayVariant(),
  };
  overlayState.message = getOverlayMessage(overlayState);

  if (overlayWindow && !overlayWindow.isDestroyed()) {
    sendToWindow(overlayWindow, 'overlay:state-changed', overlayState, '悬浮窗状态同步');
  }

  notifyManagerOverlayStateChanged();

  if (didUpdateDisplayDeviceName) {
    notifyManagerPreferencesChanged();
  }

  updateWindowTaskbarIcons();
  updateTrayMenu();
}

function getDeviceMatchScore(device) {
  const preferred = settings.preferredHidDevice;
  const productName = getDeviceProductName(device);
  const collections = Array.isArray(device.collections) ? device.collections : [];
  const hasMouseCollection = collections.some((collection) => collection.usage === 2);
  const hasKeyboardCollection = collections.some((collection) => collection.usage === 6);
  let score = 0;

  if (/ATK|VXE/i.test(productName)) {
    score += 30;
  }

  if (/mouse|鼠标|F1|X1|R1/i.test(productName)) {
    score += 18;
  }

  if (hasMouseCollection) {
    score += 18;
  }

  if (hasKeyboardCollection) {
    score -= 12;
  }

  if (
    preferred &&
    preferred.vendorId === device.vendorId &&
    preferred.productId === device.productId &&
    preferred.productName === productName
  ) {
    score += 100;
  }

  return score;
}

function chooseHidDevice(deviceList) {
  if (!Array.isArray(deviceList) || deviceList.length === 0) {
    return null;
  }

  return [...deviceList]
    .map((device) => ({ device, score: getDeviceMatchScore(device) }))
    .sort((left, right) => right.score - left.score)[0]?.device || null;
}

function serializeHidChooserDevice(device) {
  const binding = normalizeDeviceBinding(device);

  if (!binding || !device?.deviceId) {
    return null;
  }

  return {
    deviceId: device.deviceId,
    vendorId: binding.vendorId,
    productId: binding.productId,
    productName: binding.productName,
    serialNumber: normalizeDeviceName(device.serialNumber),
    guid: normalizeDeviceName(device.guid),
    collections: Array.isArray(device.collections) ? device.collections : [],
    collectionSignature: binding.collectionSignature,
    score: getDeviceMatchScore(device),
    matchLevel: getDeviceBindingMatchLevel(binding, settings.preferredHidDevice),
  };
}

function buildHidChooserDeviceList(deviceMap) {
  return Array.from(deviceMap.values())
    .map((device) => serializeHidChooserDevice(device))
    .filter(Boolean)
    .sort((left, right) => {
      if (right.matchLevel !== left.matchLevel) {
        return right.matchLevel - left.matchLevel;
      }

      if (right.score !== left.score) {
        return right.score - left.score;
      }

      return left.productName.localeCompare(right.productName, 'zh-CN');
    });
}

function notifyManagerHidSelection(payload) {
  if (!managerWindow || managerWindow.isDestroyed()) {
    return;
  }

  managerWindow.webContents.send('manager:hid-selection', payload);
}

function syncManagerHidSelectionState() {
  if (!pendingHidSelection) {
    notifyManagerHidSelection({ open: false, devices: [] });
    return;
  }

  notifyManagerHidSelection({
    open: true,
    devices: Array.from(pendingHidSelection.deviceMap.values()),
  });
}

function clearPendingHidSelection(callbackDeviceId) {
  void callbackDeviceId;

  if (!pendingHidSelection) {
    return false;
  }

  pendingHidSelection = null;

  notifyManagerHidSelection({ open: false, devices: [] });

  return true;
}

function cancelPendingHidSelection() {
  if (!pendingHidSelection) {
    return false;
  }

  return clearPendingHidSelection();
}

function updatePendingHidSelectionDevices() {
  if (!pendingHidSelection) {
    return;
  }

  syncManagerHidSelectionState();
}

function createOverlayWindow() {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    return overlayWindow;
  }

  const overlayVariant = getOverlayVariant();
  const metrics = getOverlayMetrics(overlayVariant);

  overlayWindow = new BrowserWindow({
    width: metrics.width,
    height: metrics.height,
    minWidth: metrics.width,
    minHeight: metrics.height,
    maxWidth: metrics.width,
    maxHeight: metrics.height,
    frame: false,
    transparent: true,
    resizable: false,
    show: false,
    skipTaskbar: true,
    alwaysOnTop: settings.alwaysOnTop,
    movable: true,
    roundedCorners: true,
    ...(getStoredOverlayBounds(overlayVariant)
      ? { x: getStoredOverlayBounds(overlayVariant).x, y: getStoredOverlayBounds(overlayVariant).y }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload', 'overlay-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  overlayWindow.setMenuBarVisibility(false);
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWindow.loadFile(path.join(__dirname, 'renderer', 'overlay.html'));

  overlayWindow.once('ready-to-show', () => {
    overlayWindow.show();
    mergeOverlayState({ message: '正在准备 HID 直连采集...' });
    nativeBatteryRuntime?.setOverlayVisible(true);
    logMemorySnapshot('overlay-window-ready');
  });

  overlayWindow.on('move', () => {
    if (!overlayWindow || overlayWindow.isDestroyed()) {
      return;
    }

    const bounds = overlayWindow.getBounds();
    persistOverlayBounds(bounds);
  });

  overlayWindow.on('closed', () => {
    overlayWindow = null;
    updateTrayMenu();
    nativeBatteryRuntime?.setOverlayVisible(false);
    logMemorySnapshot('overlay-window-closed');
  });

  return overlayWindow;
}

function createManagerWindow() {
  managerWindowPendingInitialShow = true;
  managerWindowReady = false;
  clearManagerWindowShowTimer();

  managerWindow = new BrowserWindow({
    width: 880,
    height: 720,
    show: false,
    useContentSize: true,
    resizable: true,
    autoHideMenuBar: true,
    backgroundColor: '#081219',
    title: 'ATK 设备管理',
    minWidth: 820,
    minHeight: MANAGER_MIN_HEIGHT,
    webPreferences: {
      preload: path.join(__dirname, 'preload', 'manager-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  managerWindow.loadFile(path.join(__dirname, 'renderer', 'manager.html'));

  managerWindow.once('ready-to-show', () => {
    if (!managerWindow || managerWindow.isDestroyed()) {
      return;
    }

    managerWindowReady = true;
    scheduleManagerWindowInitialShow(180);
  });

  managerWindow.webContents.on('did-finish-load', () => {
    updateWindowTaskbarIcons();
    notifyManagerPreferencesChanged();
    notifyManagerOverlayStateChanged();
    syncManagerHidSelectionState();
  });

  managerWindow.on('close', () => {
    cancelPendingHidSelection();
  });

  managerWindow.on('closed', () => {
    clearManagerWindowShowTimer();
    managerWindowReady = false;
    managerWindowPendingInitialShow = false;
    managerWindow = null;
    updateTrayMenu();
    logMemorySnapshot('manager-window-closed');
  });

  return managerWindow;
}

function createFallbackHubWindow() {
  if (fallbackHubWindow && !fallbackHubWindow.isDestroyed()) {
    return fallbackHubWindow;
  }

  fallbackHubWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    show: false,
    resizable: true,
    autoHideMenuBar: true,
    backgroundColor: '#081219',
    title: 'ATK HUB 同步官网电量',
    webPreferences: {
      preload: path.join(__dirname, 'preload', 'hub-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      partition: HUB_SESSION_PARTITION,
    },
  });

  fallbackHubWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  fallbackHubWindow.loadURL(HUB_URL);
  updateWindowTaskbarIcons();

  fallbackHubWindow.webContents.on('did-start-loading', () => {
    if (activeOverlaySource !== 'hub') {
      return;
    }

    mergeOverlayState({
      status: 'loading',
      message: '同步官网电量页加载中...',
      needsUserAction: true,
      mode: 'fallback',
    });
  });

  fallbackHubWindow.webContents.on('did-finish-load', () => {
    if (activeOverlaySource !== 'hub') {
      return;
    }

    mergeOverlayState({
      status: 'waiting',
      message: '同步官网电量页已打开，如直连失败可在这里手动连接。',
      needsUserAction: true,
      mode: 'fallback',
    });
  });

  fallbackHubWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    if (activeOverlaySource !== 'hub') {
      return;
    }

    mergeOverlayState({
      status: 'error',
      message: `同步官网电量页加载失败：${errorDescription} (${errorCode})`,
      needsUserAction: true,
      mode: 'fallback',
    });
  });

  fallbackHubWindow.on('closed', () => {
    fallbackHubWindow = null;
    updateTrayMenu();
    logMemorySnapshot('fallback-window-closed');

    // 窗口销毁后主动清理 Hub partition 的 HTTP 缓存,把 hub.atk.pro 在磁盘/内存中占用的 Chromium
    // 缓存(约 80-150MB)释放回系统。cookie/localStorage 仍保留在 persist 分区里,用户下次打开无需重登。
    try {
      void session.fromPartition(HUB_SESSION_PARTITION).clearCache().catch((error) => {
        logWarn('同步官网电量窗口缓存清理失败', error);
      });
    } catch (error) {
      logWarn('同步官网电量窗口缓存清理调度失败', error);
    }
  });

  return fallbackHubWindow;
}

function showOverlayWindow() {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    createOverlayWindow();
    return;
  }

  overlayWindow.show();
  overlayWindow.focus();
  nativeBatteryRuntime?.setOverlayVisible(true);
  updateTrayMenu();
}

function hideOverlayWindow() {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    return;
  }

  overlayWindow.close();
}

function toggleOverlayWindow() {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    createOverlayWindow();
    return;
  }

  if (overlayWindow.isVisible()) {
    hideOverlayWindow();
    return;
  }

  showOverlayWindow();
}

function showManagerWindow() {
  if (!managerWindow || managerWindow.isDestroyed()) {
    createManagerWindow();
    return;
  }

  managerWindow.show();
  managerWindow.focus();
  notifyManagerPreferencesChanged();
  syncManagerHidSelectionState();
  notifyManagerOverlayStateChanged();
  updateTrayMenu();
}

function hideManagerWindow() {
  if (!managerWindow || managerWindow.isDestroyed()) {
    return;
  }

  cancelPendingHidSelection();
  managerWindow.close();
}

function toggleManagerWindow() {
  if (!managerWindow || managerWindow.isDestroyed()) {
    return;
  }

  if (managerWindow.isVisible()) {
    hideManagerWindow();
    return;
  }

  showManagerWindow();
}

function refreshManagerWindow() {
  setActiveOverlaySource('manager');
  mergeOverlayState({
    status: 'loading',
    message: '正在刷新 HID 直连状态...',
    needsUserAction: false,
    sampledAt: new Date().toISOString(),
    mode: 'stable',
  });

  void nativeBatteryRuntime?.refreshNow({ forceReopen: true });
}

function showFallbackHubWindow() {
  setActiveOverlaySource('hub');
  const hubWindow = createFallbackHubWindow();
  hubWindow.show();
  hubWindow.focus();
  updateTrayMenu();
  logMemorySnapshot('fallback-window-opened');
}

function hideFallbackHubWindow() {
  if (!fallbackHubWindow || fallbackHubWindow.isDestroyed()) {
    return;
  }

  fallbackHubWindow.close();
}

function toggleFallbackHubWindow() {
  if (fallbackHubWindow && !fallbackHubWindow.isDestroyed() && fallbackHubWindow.isVisible()) {
    hideFallbackHubWindow();
    return;
  }

  showFallbackHubWindow();
}

function isWindowVisible(targetWindow) {
  return Boolean(targetWindow && !targetWindow.isDestroyed() && targetWindow.isVisible());
}

function updateTrayMenu() {
  if (!tray) {
    return;
  }

  const overlayVisible = isWindowVisible(overlayWindow);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: overlayVisible ? '隐藏悬浮窗' : '显示悬浮窗',
      click: () => toggleOverlayWindow(),
    },
    {
      label: '打开设备管理',
      click: () => showManagerWindow(),
    },
    { type: 'separator' },
    {
      label: '刷新直连状态',
      click: () => refreshManagerWindow(),
    },
    { type: 'separator' },
    {
      label: overlayState.status === 'connected' ? '连接状态：已连接' : `连接状态：${getStatusLabel(overlayState.status)}`,
      enabled: false,
    },
    {
      label: overlayState.batteryPercent !== null
        ? `当前电量：${overlayState.batteryPercent}%${overlayState.charging ? '（充电中）' : ''}`
        : '当前电量：--',
      enabled: false,
    },
    {
      label: `设备：${overlayState.deviceName || '尚未识别到设备'}`,
      enabled: false,
    },
    {
      label: `协议：${overlayState.protocolName || '尚未建立稳定直连'}`,
      enabled: false,
    },
    { type: 'separator' },
    {
      label: '保持置顶',
      type: 'checkbox',
      checked: Boolean(settings.alwaysOnTop),
      click: () => togglePinState(),
    },
    {
      label: '简略悬浮窗',
      type: 'checkbox',
      checked: getOverlayVariant() === 'compact',
      click: (menuItem) => {
        void applyOverlayVariant(menuItem.checked ? 'compact' : 'full', { hardSwitch: true });
      },
    },
    {
      label: '开机启动',
      type: 'checkbox',
      checked: Boolean(settings.openAtLogin),
      click: (menuItem) => {
        setOpenAtLogin(menuItem.checked);
      },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  try {
    tray.setContextMenu(contextMenu);
    tray.setImage(loadTrayIconFromFile(overlayState.batteryPercent, overlayState.charging));
    tray.setToolTip(
      overlayState.batteryPercent !== null
        ? `ATK 电量 ${overlayState.batteryPercent}%${overlayState.charging ? '（充电中）' : ''}`
        : 'ATK 电量悬浮窗'
    );
  } catch (error) {
    logError('托盘菜单刷新失败', {
      status: overlayState.status,
      batteryPercent: overlayState.batteryPercent,
      charging: overlayState.charging,
      error,
    });
  }
}

function createTray() {
  try {
    tray = new Tray(loadTrayIconFromFile());
    tray.on('click', () => toggleOverlayWindow());
    updateTrayMenu();
  } catch (error) {
    logError('创建托盘失败', error);
    throw error;
  }
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

function registerRuntimeDiagnostics() {
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

function registerPowerMonitor() {
  powerMonitor.on('suspend', () => {
    logInfo('系统即将挂起');
  });

  powerMonitor.on('resume', () => {
    logInfo('系统恢复运行，触发 HID 重连刷新');
    void nativeBatteryRuntime?.refreshNow({ forceReopen: true });
  });
}

function togglePinState() {
  settings = {
    ...settings,
    alwaysOnTop: !settings.alwaysOnTop,
  };
  writeSettings(settings);

  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.setAlwaysOnTop(settings.alwaysOnTop, 'screen-saver');
  }

  mergeOverlayState({});
  return overlayState;
}

function rememberPreferredDevice(device) {
  const normalized = normalizeDeviceBinding(device);

  if (!normalized) {
    return;
  }

  nativeBatteryRuntime?.setPreferredBinding(normalized);

  const currentKey = getDeviceBindingKey(settings.preferredHidDevice);
  const nextKey = getDeviceBindingKey(normalized);
  const currentDisplayBindingKey = getDeviceBindingKey(settings.displayDeviceNameBinding);
  const patch = {
    preferredHidDevice: normalized,
  };

  if (!isGenericDeviceName(normalized.productName)) {
    patch.displayDeviceName = normalized.productName;
    patch.displayDeviceNameBinding = normalized;
  } else if (currentKey !== nextKey || currentDisplayBindingKey !== nextKey) {
    patch.displayDeviceName = '';
    patch.displayDeviceNameBinding = null;
  }

  saveSettings(patch);

  if (currentKey !== nextKey || Object.prototype.hasOwnProperty.call(patch, 'displayDeviceName')) {
    notifyManagerPreferencesChanged();
  }
}

function clearPreferredDeviceBinding() {
  saveSettings({
    preferredHidDevice: null,
    displayDeviceName: '',
    displayDeviceNameBinding: null,
  });
  notifyManagerPreferencesChanged();

  if (overlayState.mode !== 'fallback') {
    mergeOverlayState({
      status: 'waiting',
      batteryPercent: null,
      batteryText: '--',
      deviceName: '',
      charging: false,
      needsUserAction: true,
      sampledAt: new Date().toISOString(),
      protocolName: '',
      mode: 'stable',
    });
  }

  return {
    ...buildManagerPreferences(),
  };
}

function registerIpc() {
  ipcMain.handle('overlay:get-state', () => overlayState);
  ipcMain.handle('overlay:toggle-pin', () => togglePinState());
  ipcMain.handle('overlay:toggle-variant', async () => {
    const nextVariant = getOverlayVariant() === 'compact' ? 'full' : 'compact';
    await applyOverlayVariant(nextVariant, { hardSwitch: true });
    return overlayState;
  });
  ipcMain.handle('manager:get-preferences', () => buildManagerPreferences());
  ipcMain.handle('manager:get-overlay-state', () => overlayState);
  ipcMain.handle('manager:request-refresh', () => {
    refreshManagerWindow();
    return true;
  });
  ipcMain.handle('manager:begin-hid-selection', async () => {
    const devices = await nativeBatteryRuntime.listChooserDevices();
    pendingHidSelection = {
      deviceMap: new Map(devices.map((device) => [device.deviceId, device])),
    };
    syncManagerHidSelectionState();
    return devices.length > 0;
  });
  ipcMain.handle('manager:end-hid-selection', () => clearPendingHidSelection());
  ipcMain.handle('manager:pick-hid-device', async (_event, deviceId) => {
    if (!pendingHidSelection || !pendingHidSelection.deviceMap.has(deviceId)) {
      return false;
    }

    const binding = await nativeBatteryRuntime.bindDeviceById(deviceId);
    if (!binding) {
      return false;
    }

    rememberPreferredDevice(binding);
    clearPendingHidSelection();
    refreshManagerWindow();
    return true;
  });
  ipcMain.handle('manager:cancel-hid-selection', () => cancelPendingHidSelection());
  ipcMain.handle('manager:clear-device-binding', async () => {
    nativeBatteryRuntime?.setPreferredBinding(null);
    return clearPreferredDeviceBinding();
  });
  ipcMain.handle('manager:set-open-at-login', (_event, enabled) => setOpenAtLogin(enabled));
  ipcMain.handle('manager:set-overlay-variant', async (_event, overlayVariant) => applyOverlayVariant(overlayVariant, { hardSwitch: true }));
  ipcMain.on('manager:fit-height', (_event, contentHeight) => {
    fitManagerWindowHeight(contentHeight);
  });
  ipcMain.on('overlay:fit-height', (_event, contentHeight) => {
    fitOverlayWindowHeight(contentHeight);
  });
  ipcMain.handle('manager:activate-stable-source', async () => activateStableOverlaySource());

  ipcMain.on('overlay:open-hub-window', () => {
    showManagerWindow();
  });

  ipcMain.on('overlay:hide', () => {
    hideOverlayWindow();
  });

  ipcMain.on('manager:open-fallback', () => {
    showFallbackHubWindow();
  });

  ipcMain.on('hub:state', (_event, hubState) => {
    if (activeOverlaySource !== 'hub') {
      return;
    }

    mergeOverlayState({
      ...hubState,
      mode: 'fallback',
      protocolName: hubState.protocolName || '官网同步电量',
    });

    if (hubState.batteryPercent !== null && fallbackHubWindow && fallbackHubWindow.isVisible()) {
      fallbackHubWindow.setTitle(`${hubState.deviceName || 'ATK 设备'} ${hubState.batteryPercent}%`);
    }
  });
}

function boot() {
  app.setAppUserModelId('atk.overlay.prototype');
  setOpenAtLogin(Boolean(settings.openAtLogin));
  nativeBatteryRuntime = new NativeBatteryRuntime({
    onStateChange(nextState) {
      if (activeOverlaySource !== 'manager') {
        return;
      }

      mergeOverlayState({
        ...nextState,
        mode: nextState.mode || 'stable',
      });
    },
    async onBindingDetected(binding) {
      rememberPreferredDevice(binding);
    },
  });
  nativeBatteryRuntime.setPreferredBinding(settings.preferredHidDevice);
  nativeBatteryRuntime.setOverlayVisible(isOverlayVisible());
  registerPowerMonitor();
  registerIpc();
  createOverlayWindow();
  createTray();
  void nativeBatteryRuntime.refreshNow();
  logInfo('应用启动完成', {
    logFile: getLogFilePath(),
    openAtLogin: Boolean(settings.openAtLogin),
    overlayVariant: getOverlayVariant(),
  });
  logMemorySnapshot('app-boot');
}

registerRuntimeDiagnostics();

if (hasSingleInstanceLock) {
  app.whenReady().then(boot).catch((error) => {
    relaunchAfterUnexpectedFailure('boot', error);
  });
}

app.on('second-instance', () => {
  showOverlayWindow();
});

app.on('before-quit', () => {
  isQuitting = true;
  void nativeBatteryRuntime?.dispose();
});

app.on('window-all-closed', (event) => {
  event.preventDefault();
});

app.on('activate', () => {
  showOverlayWindow();
});
