const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(ROOT_DIR, 'assets', 'screenshots');
const EDGE_PATHS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const SAMPLE_TIME = new Date().toISOString();
// 与管理页实际内容高度一致，内容变化时同步调整。
const MANAGER_HEIGHT = 542;

const preferredDevice = {
  vendorId: 0x373b,
  productId: 0x11fe,
  productName: 'Wireless mouse 8k NANO dongle-L',
  collectionSignature: '1/65282/2/769/541505796617',
};

const preferences = {
  openAtLogin: true,
  overlaySize: 'medium', overlayOpacity: 100, positionLocked: false,
  smartDisplay: false, edgeAutoHide: false, hideInFullscreen: true, lowBatteryNotify: true,
  displayDeviceName: 'ATK A9 Ultra Max',
  overlayVariant: 'full',
  preferredHidDevice: preferredDevice,
  hubSync: true,
};

const overlayState = {
  status: 'connected',
  message: '设备已连接，正在读取电量',
  batteryPercent: 90,
  batteryText: '90%',
  deviceName: 'ATK A9 Ultra Max',
  charging: false,
  chargeStatus: 'idle',
  needsUserAction: false,
  sampledAt: SAMPLE_TIME,
  protocolName: '官网同步电量',
  mode: 'fallback',
  grantedDevicesCount: 1,
  overlayVariant: 'full',
  alwaysOnTop: true,
  overlaySize: 'medium',
  overlayOpacity: 100,
  positionLocked: false,
  lastBatteryPercent: 90,
  lastSampledAt: SAMPLE_TIME,
  estimateMinutes: 2280,
};

function galleryPage(scheme) {
  const now = Date.now();
  const ago = (minutes) => new Date(now - minutes * 60000).toISOString();
  const states = [
    ['正常', { batteryPercent: 90, estimateMinutes: 2280 }],
    ['充电', { batteryPercent: 64, charging: true, chargeStatus: 'charging', estimateMinutes: 42, sampledAt: ago(2) }],
    ['已充满', { batteryPercent: 100, chargeStatus: 'full' }],
    ['低电量', { batteryPercent: 18, estimateMinutes: 200, sampledAt: ago(3) }],
    ['极低', { batteryPercent: 7, estimateMinutes: 50 }],
    ['离线', { status: 'waiting', lastBatteryPercent: 72, lastSampledAt: ago(12), message: '未找到已绑定设备，插入接收器后会自动重连。' }],
    ['异常', { status: 'error', message: '原生 HID 读取异常：设备拒绝访问。正在自动重试...' }],
    ['连接中', { status: 'loading', deviceName: '', message: '正在准备原生 HID 直连器...' }],
  ];
  const renderGroup = (variant) => states.map(([label, patch]) => {
    const state = {
      status: 'connected', deviceName: overlayState.deviceName, overlayVariant: variant,
      overlaySize: 'medium', overlayOpacity: 100, charging: false, chargeStatus: 'idle',
      batteryPercent: null, sampledAt: patch.status ? null : ago(0), ...patch,
    };
    const query = new URLSearchParams({ scheme, state: JSON.stringify(state) });
    return `<figure><iframe title="${label}" src="overlay.html?${query}"></iframe><figcaption>${label}</figcaption></figure>`;
  }).join('');
  const dark = scheme === 'dark';
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>悬浮窗全状态总览</title>
    <style>
      :root { color-scheme: ${scheme}; }
      body { margin: 0; padding: 16px; min-height: 100vh; box-sizing: border-box;
        background: linear-gradient(135deg,${dark ? '#1d3557,#2a2f45 50%,#3d2c4a' : '#cfe3f5,#e9e4f2 50%,#f5e6dc'});
        color: ${dark ? '#edf1f7' : '#303946'}; font: 12px/18px 'Segoe UI', 'Microsoft YaHei UI', sans-serif; }
      h2 { margin: 0 8px 4px; font-size: 14px; }
      section { display: grid; grid-template-columns: repeat(4, 1fr); row-gap: 12px; }
      section + h2 { margin-top: 20px; }
      figure { display: grid; justify-items: center; margin: 0; }
      iframe { border: 0; width: 300px; height: 160px; }
      .compact { grid-template-columns: repeat(8, 1fr); }
      .compact iframe { width: 116px; height: 56px; }
    </style><h2>完整版</h2><section>${renderGroup('full')}</section>
    <h2>简略版</h2><section class="compact">${renderGroup('compact')}</section></html>`;
}

const bridgeSource = `
(() => {
  const preferences = ${JSON.stringify(preferences)};
  const stateQuery = location.pathname === '/src/renderer/overlay.html' && new URLSearchParams(location.search).get('state');
  const overlayState = stateQuery ? JSON.parse(stateQuery) : ${JSON.stringify(overlayState)};
  const noop = () => () => {};
  let notifyPreferences = () => {};
  const updatePreferences = async (patch) => {
    Object.assign(preferences, patch);
    notifyPreferences(preferences);
    return preferences;
  };
  const updateState = { currentVersion: ${JSON.stringify(require('../package.json').version)}, checking: false, checkedAt: '2026-01-01T00:00:00Z', latestVersion: null, releaseUrl: null, error: null };
  window.atkManager = {
    getUpdateState: async () => updateState,
    checkUpdate: async () => updateState,
    openReleasePage: async () => {},
    openRepository: async () => {},
    onUpdateStateChanged: noop,
    updatePreferences,
    getPreferences: async () => preferences,
    getOverlayState: async () => overlayState,
    setOpenAtLogin: (enabled) => updatePreferences({ openAtLogin: Boolean(enabled) }),
    setOverlayVariant: (overlayVariant) => updatePreferences({ overlayVariant }),
    requestRefresh: async () => true,
    fitHeight: () => {},
    activateStableSource: async () => true,
    beginHidSelection: async () => false,
    pickHidDevice: async () => preferences,
    cancelHidSelection: async () => true,
    clearDeviceBinding: async () => ({ ...preferences, preferredHidDevice: null }),
    openFallback: async () => true,
    onPreferencesChanged: (callback) => { notifyPreferences = callback; },
    onOverlayStateChanged: noop,
    onHidSelectionChanged: noop,
  };
  window.atkOverlay = {
    getInitialState: async () => overlayState,
    onStateChange: noop,
    requestRefresh: async () => true,
    togglePin: async () => ({ ...overlayState, alwaysOnTop: !overlayState.alwaysOnTop }),
    toggleVariant: async () => ({ ...overlayState, overlayVariant: 'compact' }),
    fitSize: () => {},
    hideOverlay: () => {},
    showMenu: () => {},
    openManager: () => {},
    startDragging: async () => {},
  };
})();
`;

const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
]);

async function findEdge() {
  for (const candidate of EDGE_PATHS) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch (_error) {
    }
  }
  throw new Error('Microsoft Edge not found');
}

function injectBridge(html, scheme) {
  const marker = '    <script src="./runtime-bridge.js"></script>';
  if (!html.includes(marker)) {
    throw new Error('Screenshot bridge marker not found');
  }
  const withBridge = html.replace(
    marker,
    `    <script src="/__screenshot-bridge.js"></script>\n${marker}`,
  );
  if (scheme) {
    return withBridge.replace(/\.\/(\w+)\.css/, `./$1.css?scheme=${scheme}`);
  }
  return withBridge;
}

async function readAsset(pathname, scheme) {
  const relativePath = decodeURIComponent(pathname).replace(/^\/+/, '');
  const absolutePath = path.resolve(ROOT_DIR, relativePath);
  const rootPrefix = `${ROOT_DIR}${path.sep}`;
  if (!absolutePath.startsWith(rootPrefix)) {
    throw new Error('Asset path is outside the project');
  }
  let content = await fs.readFile(absolutePath);
  if (pathname === '/src/renderer/manager.html' || pathname === '/src/renderer/overlay.html') {
    content = Buffer.from(injectBridge(content.toString('utf8'), scheme));
  } else if (pathname.endsWith('.css') && scheme) {
    content = content.toString('utf8').replaceAll('(prefers-color-scheme: light)', scheme === 'light' ? 'all' : 'not all');
  }
  return {
    content,
    contentType: contentTypes.get(path.extname(absolutePath)) || 'application/octet-stream',
  };
}

async function startServer() {
  const server = http.createServer(async (request, response) => {
    try {
      const { pathname, searchParams } = new URL(request.url, 'http://127.0.0.1');
      const requestedScheme = searchParams.get('scheme');
      const scheme = ['light', 'dark'].includes(requestedScheme) ? requestedScheme : null;
      if (pathname === '/src/renderer/gallery.html' && scheme) {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(galleryPage(scheme));
        return;
      }
      if (pathname === '/__screenshot-bridge.js') {
        response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
        response.end(bridgeSource);
        return;
      }
      const asset = await readAsset(pathname, scheme);
      response.writeHead(200, { 'Content-Type': asset.contentType });
      response.end(asset.content);
    } catch (_error) {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server;
}

async function capture(
  edgePath,
  baseUrl,
  page,
  outputName,
  width,
  height,
) {
  const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'atktool-screenshots-'));
  const outputPath = path.join(OUTPUT_DIR, outputName);
  const arguments = [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-gpu-compositing',
    '--disable-features=VizDisplayCompositor',
    '--hide-scrollbars',
    '--no-first-run',
    '--disable-default-apps',
    '--run-all-compositor-stages-before-draw',
    '--force-device-scale-factor=1.25',
    `--window-size=${width},${height}`,
    '--virtual-time-budget=2000',
    `--user-data-dir=${profileDir}`,
    `--screenshot=${outputPath}`,
  ];
  arguments.push(`${baseUrl}/src/renderer/${page}`);
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(edgePath, arguments, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      let errorOutput = '';
      child.stderr.on('data', (chunk) => {
        errorOutput += chunk.toString();
      });
      child.once('error', reject);
      child.once('exit', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Edge screenshot failed (${code}): ${errorOutput.trim()}`));
        }
      });
    });
  } finally {
    await fs.rm(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function closeServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function main() {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const edgePath = await findEdge();
  const server = await startServer();
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    for (const scheme of ['dark', 'light']) {
      await capture(edgePath, baseUrl, `manager.html?scheme=${scheme}`, `manager-${scheme}.png`, 780, MANAGER_HEIGHT);
      await capture(edgePath, baseUrl, `gallery.html?scheme=${scheme}`, `overlay-states-${scheme}.png`, 1280, 540);
    }
  } finally {
    await closeServer(server);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
