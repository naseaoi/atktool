const zlib = require('node:zlib');
const { TRAY_ICON_SIZE, TRAY_DIGIT_SEGMENTS } = require('../core/constants');

// 纯函数模块：PNG 编码 + 七段数码管光栅化,不依赖 Electron 运行时。
// 托盘图标直接在这里合成 PNG,避免 Win11/Electron 对 SVG 托盘图的透明兼容问题。

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

function drawRect(pixels, width, height, x, y, rectWidth, rectHeight, color) {
  const startX = Math.max(0, Math.floor(x));
  const endX = Math.min(width, Math.ceil(x + rectWidth));
  const startY = Math.max(0, Math.floor(y));
  const endY = Math.min(height, Math.ceil(y + rectHeight));

  for (let pixelY = startY; pixelY < endY; pixelY += 1) {
    for (let pixelX = startX; pixelX < endX; pixelX += 1) {
      blendPixel(pixels, width, pixelX, pixelY, color);
    }
  }
}

function drawRectOutline(pixels, width, height, x, y, rectWidth, rectHeight, thickness, color) {
  drawRect(pixels, width, height, x, y, rectWidth, thickness, color);
  drawRect(pixels, width, height, x, y + rectHeight - thickness, rectWidth, thickness, color);
  drawRect(pixels, width, height, x, y + thickness, thickness, rectHeight - thickness * 2, color);
  drawRect(pixels, width, height, x + rectWidth - thickness, y + thickness, thickness, rectHeight - thickness * 2, color);
}

function drawTrayDigit(pixels, width, height, digit, offsetX, offsetY, scale, color) {
  const thickness = 2 * scale;
  const length = 7 * scale;
  const halfLength = 5.5 * scale;
  const rounded = 0.425 * scale;
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

function renderTrayIconPixels(percent = null, charging = false) {
  const pixels = createRgbaCanvas(TRAY_ICON_SIZE, TRAY_ICON_SIZE);
  const numericPercent = Number.isFinite(percent)
    ? Math.max(0, Math.min(100, Math.round(percent)))
    : null;
  const text = numericPercent === null
    ? '--'
    : numericPercent >= 100 && !charging
      ? 'F'
      : String(numericPercent);
  const isFull = text === 'F';
  const scale = isFull ? 2.4 : text.length >= 3 ? 1.52 : text.length === 2 ? 2.1 : 2.8;
  const digitVisualWidth = isFull ? 9 * scale : 11 * scale;
  const gap = text.length >= 3 ? 2.4 : text.length === 2 ? 3.6 : 0;
  const totalWidth = digitVisualWidth * text.length + gap * Math.max(0, text.length - 1);
  const digitHeight = 16 * scale;
  const startX = (TRAY_ICON_SIZE - totalWidth) / 2;
  const startY = (TRAY_ICON_SIZE - digitHeight) / 2 - 1 + (isFull ? 1.25 * scale : 0);
  const isLow = numericPercent !== null && numericPercent < 20 && !charging;
  const digitColor = charging
    ? [126, 230, 168, 255]
    : isLow
      ? [255, 166, 70, 255]
      : [255, 255, 255, 255];
  const digitShadowColor = [0, 0, 0, 120];

  drawRect(pixels, TRAY_ICON_SIZE, TRAY_ICON_SIZE, 2, 2, 66, 66, [0, 0, 0, 51]);
  drawRectOutline(pixels, TRAY_ICON_SIZE, TRAY_ICON_SIZE, 2, 2, 66, 66, 2, [255, 255, 255, 235]);

  text.split('').forEach((digit, index) => {
    const offsetX = startX + index * (digitVisualWidth + gap);
    drawTrayDigit(pixels, TRAY_ICON_SIZE, TRAY_ICON_SIZE, digit, offsetX + 0.9, startY + 1.1, scale, digitShadowColor);
    drawTrayDigit(pixels, TRAY_ICON_SIZE, TRAY_ICON_SIZE, digit, offsetX, startY, scale, digitColor);
  });

  return pixels;
}

function renderTrayIconBuffer(percent = null, charging = false) {
  return encodeRgbaToPng(TRAY_ICON_SIZE, TRAY_ICON_SIZE, renderTrayIconPixels(percent, charging));
}

module.exports = {
  renderTrayIconBuffer,
  renderTrayIconPixels,
  encodeRgbaToPng,
  createRgbaCanvas,
  drawRect,
  drawRoundedRect,
  drawTrayDigit,
};
