const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const RELEASE_DIR = path.join(ROOT_DIR, 'src-tauri', 'target', 'release');
const mode = process.argv[2];

if (!['bundle', 'unpacked'].includes(mode)) {
  throw new Error('Expected build mode: bundle or unpacked');
}

fs.rmSync(DIST_DIR, { recursive: true, force: true });
fs.mkdirSync(DIST_DIR, { recursive: true });

const runner = path.join(ROOT_DIR, 'scripts', 'run-rust-tool.js');
const arguments = mode === 'bundle'
  ? [runner, 'tauri', 'build']
  : [runner, 'cargo', 'build', '--release', '--manifest-path', 'src-tauri/Cargo.toml'];
const buildStartedAt = Date.now();
const result = spawnSync(process.execPath, arguments, { cwd: ROOT_DIR, stdio: 'inherit' });

if (result.error) {
  throw result.error;
}
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

if (mode === 'bundle') {
  const bundleDir = path.join(RELEASE_DIR, 'bundle', 'nsis');
  const installers = fs.readdirSync(bundleDir).filter((name) => {
    if (!name.endsWith('.exe')) {
      return false;
    }
    return fs.statSync(path.join(bundleDir, name)).mtimeMs >= buildStartedAt;
  });
  if (installers.length === 0) {
    throw new Error('No NSIS installer was produced');
  }
  for (const installer of installers) {
    fs.copyFileSync(path.join(bundleDir, installer), path.join(DIST_DIR, installer));
  }
} else {
  const executable = path.join(RELEASE_DIR, 'atktool.exe');
  if (!fs.existsSync(executable)) {
    throw new Error('Release executable was not produced');
  }
  fs.copyFileSync(executable, path.join(DIST_DIR, 'ATK Battery.exe'));
}
