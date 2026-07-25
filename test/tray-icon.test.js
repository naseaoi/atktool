const test = require('node:test');
const assert = require('node:assert/strict');
const { renderTrayIconPixels } = require('../src/tray/png-encoder');

const ICON_SIZE = 70;

function getPixel(pixels, x, y) {
  const offset = (y * ICON_SIZE + x) * 4;
  return Array.from(pixels.subarray(offset, offset + 4));
}

function hasPixel(pixels, expected) {
  for (let offset = 0; offset < pixels.length; offset += 4) {
    if (expected.every((value, index) => pixels[offset + index] === value)) {
      return true;
    }
  }
  return false;
}

test('taskbar icon uses a square translucent background and thin white border', () => {
  const pixels = renderTrayIconPixels(50, false);

  assert.deepEqual(getPixel(pixels, 0, 0), [0, 0, 0, 0]);
  assert.deepEqual(getPixel(pixels, 5, 5), [0, 0, 0, 51]);
  const borderPixel = getPixel(pixels, 2, 2);
  assert.ok(borderPixel[0] > 240 && borderPixel[1] > 240 && borderPixel[2] > 240);
  assert.ok(borderPixel[3] > 230);
});

test('taskbar icon applies charging and low battery digit colors', () => {
  assert.equal(hasPixel(renderTrayIconPixels(50, false), [255, 255, 255, 255]), true);
  assert.equal(hasPixel(renderTrayIconPixels(50, true), [126, 230, 168, 255]), true);
  assert.equal(hasPixel(renderTrayIconPixels(19, false), [255, 166, 70, 255]), true);
  assert.equal(hasPixel(renderTrayIconPixels(20, false), [255, 255, 255, 255]), true);
});
