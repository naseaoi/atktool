const fs = require('node:fs');
const path = require('node:path');
const { createCanvas, drawRoundedRect, encodePng } = require('./png-canvas');

const SIZE = 512;

function renderAppIcon() {
  const pixels = createCanvas(SIZE, SIZE);
  const accent = [120, 212, 193, 255];
  const background = [7, 22, 29, 255];
  const surface = [14, 42, 50, 255];
  const highlight = [226, 251, 246, 255];

  drawRoundedRect(pixels, SIZE, SIZE, 18, 18, 476, 476, 108, accent);
  drawRoundedRect(pixels, SIZE, SIZE, 32, 32, 448, 448, 96, background);
  drawRoundedRect(pixels, SIZE, SIZE, 76, 150, 326, 212, 46, accent);
  drawRoundedRect(pixels, SIZE, SIZE, 92, 166, 294, 180, 34, surface);
  drawRoundedRect(pixels, SIZE, SIZE, 402, 210, 38, 92, 12, accent);
  drawRoundedRect(pixels, SIZE, SIZE, 116, 190, 190, 132, 24, accent);
  drawRoundedRect(pixels, SIZE, SIZE, 306, 190, 56, 132, 18, highlight);

  return pixels;
}

function alphaBounds(pixels) {
  const bounds = { minX: SIZE, minY: SIZE, maxX: -1, maxY: -1 };
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      if (pixels[(y * SIZE + x) * 4 + 3] === 0) {
        continue;
      }
      bounds.minX = Math.min(bounds.minX, x);
      bounds.minY = Math.min(bounds.minY, y);
      bounds.maxX = Math.max(bounds.maxX, x);
      bounds.maxY = Math.max(bounds.maxY, y);
    }
  }
  return bounds;
}

function generate() {
  const pixels = renderAppIcon();
  const bounds = alphaBounds(pixels);
  if (bounds.minY > 24 || bounds.maxY < SIZE - 24 || bounds.maxX < SIZE - 24) {
    throw new Error(`App icon coverage is incomplete: ${JSON.stringify(bounds)}`);
  }
  const output = path.resolve('assets/app-icon.png');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, encodePng(SIZE, SIZE, pixels));
}

if (require.main === module) {
  generate();
}

module.exports = { alphaBounds, renderAppIcon };
