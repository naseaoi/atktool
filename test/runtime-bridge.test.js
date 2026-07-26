const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const bridgeSource = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'renderer', 'runtime-bridge.js'),
  'utf8'
);

function createDocument() {
  return {
    body: { dataset: {} },
    addEventListener() {},
  };
}

test('runtime bridge does not overwrite preinitialized APIs', () => {
  const atkManager = { getPreferences() {} };
  const context = {
    window: { atkManager },
    document: createDocument(),
    console,
  };

  vm.runInNewContext(bridgeSource, context);

  assert.equal(context.window.atkManager, atkManager);
  assert.equal(context.window.atkOverlay, undefined);
});

test('runtime bridge maps Tauri commands to existing renderer APIs', async () => {
  const calls = [];
  const listeners = new Map();
  const context = {
    window: {
      __TAURI__: {
        core: {
          invoke(command, args) {
            calls.push({ command, args });
            return Promise.resolve(command);
          },
        },
        event: {
          listen(eventName, callback) {
            listeners.set(eventName, callback);
            return Promise.resolve(() => listeners.delete(eventName));
          },
        },
        window: {
          getCurrentWindow() {
            return { startDragging: () => Promise.resolve() };
          },
        },
      },
    },
    document: createDocument(),
    console,
  };

  vm.runInNewContext(bridgeSource, context);

  await context.window.atkManager.setOverlayVariant('compact');
  await context.window.atkOverlay.togglePin();
  const dispose = context.window.atkOverlay.onStateChange(() => {});
  await Promise.resolve();
  dispose();

  assert.equal(calls[0].command, 'set_overlay_variant');
  assert.equal(calls[0].args.overlayVariant, 'compact');
  assert.equal(calls[1].command, 'toggle_pin');
  assert.equal(calls[1].args, undefined);
  assert.equal(listeners.has('overlay:state-changed'), false);
});
