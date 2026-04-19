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

function drawTrayDigit(pixels, width, height, digit, offsetX, offsetY, scale, color) {
  const thickness = 2 * scale;
  const length = 7 * scale;
  const halfLength = 5.5 * scale;
  const rounded = 0.85 * scale;
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

function renderTrayIconBuffer(percent = null, charging = false) {
  const pixels = createRgbaCanvas(TRAY_ICON_SIZE, TRAY_ICON_SIZE);
  const numericPercent = Number.isFinite(percent)
    ? Math.max(0, Math.min(100, Math.round(percent)))
    : null;
  // 满电用单字 "F" 代表 Full,避免 "100" 三位数在小托盘尺寸下挤成一团。
  const text = numericPercent === null
    ? '--'
    : numericPercent >= 100
      ? 'F'
      : String(numericPercent);
  const isFull = text === 'F';
  // 70×70 画布下放大数字占比:1 位约 72%、2 位约 54%,托盘缩到 20-32px 仍清晰;3 位仅作兜底。
  // F 单独走略小的 scale,否则按 1 位数最大比例会偏大又显得孤立。
  const scale = isFull ? 2.4 : text.length >= 3 ? 1.72 : text.length === 2 ? 2.38 : 3.15;
  // F 只亮 a/e/f/g 四段,右侧 (b/c) 没有笔画,按 9×scale 计算可视宽度才能真居中。
  const digitVisualWidth = isFull ? 9 * scale : 11 * scale;
  const gap = text.length >= 3 ? 2.6 : text.length === 2 ? 4.2 : 0;
  const totalWidth = digitVisualWidth * text.length + gap * Math.max(0, text.length - 1);
  const digitHeight = 16 * scale;
  const startX = (TRAY_ICON_SIZE - totalWidth) / 2;
  // F 缺 d (底横) 段,笔画视觉中心比网格中心高约 1.25×scale,额外下移对齐画布中心。
  const startY = (TRAY_ICON_SIZE - digitHeight) / 2 - 1 + (isFull ? 1.25 * scale : 0);
  const isLow = numericPercent !== null && numericPercent <= 20 && !charging;
  // 充电/满电/低电/常态四套配色:充电亮绿、满电柔青、低电告警橙、常态冷青。
  const outerColor = charging
    ? [96, 224, 156, 255]
    : isFull
      ? [84, 208, 176, 255]
      : [40, 94, 110, 255];
  const bodyColor = charging
    ? [14, 48, 36, 255]
    : isFull
      ? [12, 44, 44, 255]
      : [10, 28, 38, 255];
  const innerColor = charging
    ? [26, 78, 58, 255]
    : isFull
      ? [24, 74, 70, 255]
      : [22, 58, 72, 255];
  const highlightColor = charging || isFull ? [220, 255, 230, 38] : [255, 255, 255, 30];
  const digitColor = charging
    ? [148, 255, 204, 255]
    : isFull
      ? [176, 255, 222, 255]
      : isLow
        ? [255, 186, 110, 255]
        : [244, 251, 250, 255];
  const digitShadowColor = [6, 12, 18, 110];

  // 背景三层圆角 + 顶部高光按 70×70 重新对齐,保留立体观感并给数字留出安全区。
  drawRoundedRect(pixels, TRAY_ICON_SIZE, TRAY_ICON_SIZE, 1.5, 1.5, 67, 67, 20, outerColor);
  drawRoundedRect(pixels, TRAY_ICON_SIZE, TRAY_ICON_SIZE, 3.5, 3.5, 63, 63, 17.5, bodyColor);
  drawRoundedRect(pixels, TRAY_ICON_SIZE, TRAY_ICON_SIZE, 5, 5, 60, 60, 16, innerColor);
  drawRoundedRect(pixels, TRAY_ICON_SIZE, TRAY_ICON_SIZE, 11, 6, 48, 10, 5, highlightColor);

  text.split('').forEach((digit, index) => {
    const offsetX = startX + index * (digitVisualWidth + gap);
    // 数字下方叠一层半透明阴影,让笔画边缘在任何底色下都清晰。
    drawTrayDigit(pixels, TRAY_ICON_SIZE, TRAY_ICON_SIZE, digit, offsetX + 0.9, startY + 1.1, scale, digitShadowColor);
    drawTrayDigit(pixels, TRAY_ICON_SIZE, TRAY_ICON_SIZE, digit, offsetX, startY, scale, digitColor);
  });

  return encodeRgbaToPng(TRAY_ICON_SIZE, TRAY_ICON_SIZE, pixels);
}

module.exports = {
  renderTrayIconBuffer,
  encodeRgbaToPng,
  createRgbaCanvas,
  drawRoundedRect,
  drawTrayDigit,
};
