const path = require('node:path');
const fs = require('node:fs');
const { app, nativeImage } = require('electron');
const { logWarn } = require('../utils/logger');
const { renderTrayIconBuffer } = require('./png-encoder');
const { TRAY_ICON_VERSION } = require('../core/constants');

// 托盘/任务栏图标按 (percent, charging) 哈希缓存,避免同一状态下反复渲染与磁盘 IO。
// 任务栏角标与托盘图标使用各自的内存缓存:前者直接从 Buffer 构造 nativeImage,
// 后者保留"首次走文件"的行为以沿用 Windows 托盘更稳定的渲染路径。

const taskbarIconCache = new Map();
const trayIconCache = new Map();

function getTrayIconCacheKey(percent, charging) {
  const normalizedPercent = Number.isFinite(percent)
    ? String(Math.max(0, Math.min(100, Math.round(percent))))
    : 'unknown';
  return `${normalizedPercent}|${charging ? 1 : 0}`;
}

function createTrayIcon(percent = null, charging = false) {
  return nativeImage.createFromBuffer(renderTrayIconBuffer(percent, charging));
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
    // 同一电量/充电状态的托盘图标已经生成过,直接复用 nativeImage,跳过写盘+读盘的同步 IO。
    return cached;
  }

  try {
    const filePath = getTrayIconFilePath(percent, charging);
    const image = nativeImage.createFromBuffer(fs.readFileSync(filePath));
    trayIconCache.set(key, image);
    return image;
  } catch (error) {
    // 托盘图标文件写入/读取偶发失败时回退到内存图标,避免主进程被同步 IO 异常带崩。
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

module.exports = {
  createTrayIcon,
  getOrCreateTaskbarIcon,
  loadTrayIconFromFile,
};
