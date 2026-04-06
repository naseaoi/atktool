const fs = require('fs');
const path = require('path');

function removePath(targetPath) {
  if (!fs.existsSync(targetPath)) {
    return;
  }

  fs.rmSync(targetPath, { recursive: true, force: true });
}

exports.default = async function afterPack(context) {
  const nodeHidRoot = path.join(
    context.appOutDir,
    'resources',
    'app.asar.unpacked',
    'node_modules',
    'node-hid'
  );

  if (!fs.existsSync(nodeHidRoot)) {
    return;
  }

  // 只保留 Windows x64 运行所需的 node-hid 预编译产物，删除源码、文档和其他平台二进制以缩小包体。
  removePath(path.join(nodeHidRoot, 'hidapi'));
  removePath(path.join(nodeHidRoot, 'src'));
  removePath(path.join(nodeHidRoot, 'prebuilds', 'HID-win32-arm64'));
  removePath(path.join(nodeHidRoot, 'prebuilds', 'HID-win32-ia32'));
  removePath(path.join(nodeHidRoot, 'prebuilds', 'HID-darwin-arm64'));
  removePath(path.join(nodeHidRoot, 'prebuilds', 'HID-darwin-x64'));
  removePath(path.join(nodeHidRoot, 'prebuilds', 'HID-linux-arm'));
  removePath(path.join(nodeHidRoot, 'prebuilds', 'HID-linux-arm64'));
  removePath(path.join(nodeHidRoot, 'prebuilds', 'HID-linux-x64'));
  removePath(path.join(nodeHidRoot, 'prebuilds', 'HID-linux-x64-musl'));
  removePath(path.join(nodeHidRoot, 'prebuilds', 'HID_hidraw-linux-arm'));
  removePath(path.join(nodeHidRoot, 'prebuilds', 'HID_hidraw-linux-arm64'));
  removePath(path.join(nodeHidRoot, 'prebuilds', 'HID_hidraw-linux-x64'));
  removePath(path.join(nodeHidRoot, 'prebuilds', 'HID_hidraw-linux-x64-musl'));
  removePath(path.join(nodeHidRoot, 'nodehid.d.ts'));
};
