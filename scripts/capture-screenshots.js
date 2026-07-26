const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(ROOT_DIR, 'assets', 'screenshots');
const EDGE_PATHS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const SAMPLE_TIME = new Date().toISOString();

const preferredDevice = {
  vendorId: 0x373b,
  productId: 0x11fe,
  productName: 'Wireless mouse 8k NANO dongle-L',
  collectionSignature: '1/65282/2/769/541505796617',
};

const preferences = {
  openAtLogin: true,
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
};

const bridgeSource = `
(() => {
  const preferences = ${JSON.stringify(preferences)};
  const overlayState = ${JSON.stringify(overlayState)};
  const noop = () => () => {};
  window.atkManager = {
    getPreferences: async () => preferences,
    getOverlayState: async () => overlayState,
    setOpenAtLogin: async (enabled) => ({ ...preferences, openAtLogin: Boolean(enabled) }),
    setOverlayVariant: async (overlayVariant) => ({ ...preferences, overlayVariant }),
    requestRefresh: async () => true,
    fitHeight: () => {},
    activateStableSource: async () => true,
    beginHidSelection: async () => false,
    pickHidDevice: async () => preferences,
    cancelHidSelection: async () => true,
    clearDeviceBinding: async () => ({ ...preferences, preferredHidDevice: null }),
    openFallback: async () => true,
    onPreferencesChanged: noop,
    onOverlayStateChanged: noop,
    onHidSelectionChanged: noop,
  };
  window.atkOverlay = {
    getInitialState: async () => overlayState,
    onStateChange: noop,
    requestRefresh: async () => true,
    togglePin: async () => ({ ...overlayState, alwaysOnTop: !overlayState.alwaysOnTop }),
    toggleVariant: async () => ({ ...overlayState, overlayVariant: 'compact' }),
    fitHeight: () => {},
    hideOverlay: () => {},
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

function injectBridge(html, pathname) {
  const marker = '    <script src="./runtime-bridge.js"></script>';
  if (!html.includes(marker)) {
    throw new Error('Screenshot bridge marker not found');
  }
  const withBridge = html.replace(
    marker,
    `    <script src="/__screenshot-bridge.js"></script>\n${marker}`,
  );
  if (pathname !== '/src/renderer/overlay.html') {
    return withBridge;
  }
  return withBridge.replace('</head>', '    <style>html, body { width: 360px; }</style>\n  </head>');
}

async function readAsset(pathname) {
  const relativePath = decodeURIComponent(pathname).replace(/^\/+/, '');
  const absolutePath = path.resolve(ROOT_DIR, relativePath);
  const rootPrefix = `${ROOT_DIR}${path.sep}`;
  if (!absolutePath.startsWith(rootPrefix)) {
    throw new Error('Asset path is outside the project');
  }
  let content = await fs.readFile(absolutePath);
  if (pathname === '/src/renderer/manager.html' || pathname === '/src/renderer/overlay.html') {
    content = Buffer.from(injectBridge(content.toString('utf8'), pathname));
  }
  return {
    content,
    contentType: contentTypes.get(path.extname(absolutePath)) || 'application/octet-stream',
  };
}

async function startServer() {
  const server = http.createServer(async (request, response) => {
    try {
      const { pathname } = new URL(request.url, 'http://127.0.0.1');
      if (pathname === '/__screenshot-bridge.js') {
        response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
        response.end(bridgeSource);
        return;
      }
      const asset = await readAsset(pathname);
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

function cropPng(source, destination, width, height) {
  const script = path.join(ROOT_DIR, 'scripts', 'crop-png.ps1');
  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-File',
    script,
    '-Source',
    source,
    '-Destination',
    destination,
    '-Width',
    String(width),
    '-Height',
    String(height),
  ], { windowsHide: true, stdio: 'inherit' });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`PNG crop failed: ${result.status}`);
  }
}

async function capture(
  edgePath,
  baseUrl,
  page,
  outputName,
  width,
  height,
  transparent = false,
  cropWidth = null,
) {
  const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'atktool-screenshots-'));
  const outputPath = path.join(OUTPUT_DIR, outputName);
  const screenshotPath = cropWidth ? `${outputPath}.uncropped.png` : outputPath;
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
    `--screenshot=${screenshotPath}`,
  ];
  if (transparent) {
    arguments.push('--default-background-color=00000000');
  }
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
    if (cropWidth) {
      cropPng(screenshotPath, outputPath, cropWidth, Math.round(height * 1.25));
      await fs.rm(screenshotPath, { force: true });
    }
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
    await capture(edgePath, baseUrl, 'manager.html', 'manager.png', 880, 759);
    await capture(edgePath, baseUrl, 'overlay.html', 'overlay-full.png', 500, 262, true, 450);
  } finally {
    await closeServer(server);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
