const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveWindowPosition } = require('../src/utils/window-bounds');

const primary = { x: 0, y: 0, width: 1920, height: 1040 };
const secondary = { x: 1920, y: 0, width: 1280, height: 984 };

test('resolveWindowPosition keeps a visible window on its display', () => {
  assert.deepEqual(
    resolveWindowPosition({ x: 2200, y: 100 }, { width: 404, height: 392 }, [primary, secondary], primary),
    { x: 2200, y: 100 }
  );
});

test('resolveWindowPosition restores an offscreen window to the primary display', () => {
  assert.deepEqual(
    resolveWindowPosition({ x: 5000, y: 4000 }, { width: 404, height: 392 }, [primary], primary),
    { x: 758, y: 324 }
  );
});

test('resolveWindowPosition clamps a partially visible window', () => {
  assert.deepEqual(
    resolveWindowPosition({ x: 1800, y: 900 }, { width: 404, height: 392 }, [primary], primary),
    { x: 1516, y: 648 }
  );
});
