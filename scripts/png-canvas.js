const zlib = require('node:zlib');

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

const CRC_TABLE = createCrcTable();

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function createChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  const checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

function encodePng(width, height, pixels) {
  const header = Buffer.alloc(13);
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;

  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * (stride + 1);
    pixels.copy(raw, rowOffset + 1, y * stride, y * stride + stride);
  }

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    createChunk('IHDR', header),
    createChunk('IDAT', zlib.deflateSync(raw)),
    createChunk('IEND', Buffer.alloc(0)),
  ]);
}

function createCanvas(width, height) {
  return Buffer.alloc(width * height * 4);
}

function blendPixel(pixels, width, height, x, y, color, alphaScale = 1) {
  if (x < 0 || y < 0 || x >= width || y >= height) {
    return;
  }
  const index = (y * width + x) * 4;
  const sourceAlpha = (color[3] / 255) * alphaScale;
  const targetAlpha = pixels[index + 3] / 255;
  const outputAlpha = sourceAlpha + targetAlpha * (1 - sourceAlpha);
  if (outputAlpha <= 0) {
    return;
  }
  pixels[index] = Math.round(
    (color[0] * sourceAlpha + pixels[index] * targetAlpha * (1 - sourceAlpha)) / outputAlpha,
  );
  pixels[index + 1] = Math.round(
    (color[1] * sourceAlpha + pixels[index + 1] * targetAlpha * (1 - sourceAlpha)) / outputAlpha,
  );
  pixels[index + 2] = Math.round(
    (color[2] * sourceAlpha + pixels[index + 2] * targetAlpha * (1 - sourceAlpha)) / outputAlpha,
  );
  pixels[index + 3] = Math.round(outputAlpha * 255);
}

function isInsideRoundedRect(pointX, pointY, x, y, width, height, radius) {
  const nearestX = Math.max(x + radius, Math.min(pointX, x + width - radius));
  const nearestY = Math.max(y + radius, Math.min(pointY, y + height - radius));
  const distanceX = pointX - nearestX;
  const distanceY = pointY - nearestY;
  return distanceX * distanceX + distanceY * distanceY <= radius * radius;
}

function drawRoundedRect(pixels, canvasWidth, canvasHeight, x, y, width, height, radius, color) {
  const samples = [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]];
  const startX = Math.max(0, Math.floor(x));
  const endX = Math.min(canvasWidth - 1, Math.ceil(x + width));
  const startY = Math.max(0, Math.floor(y));
  const endY = Math.min(canvasHeight - 1, Math.ceil(y + height));

  for (let pixelY = startY; pixelY <= endY; pixelY += 1) {
    for (let pixelX = startX; pixelX <= endX; pixelX += 1) {
      const coverage = samples.filter(([offsetX, offsetY]) => isInsideRoundedRect(
        pixelX + offsetX,
        pixelY + offsetY,
        x,
        y,
        width,
        height,
        radius,
      )).length / samples.length;
      if (coverage > 0) {
        blendPixel(pixels, canvasWidth, canvasHeight, pixelX, pixelY, color, coverage);
      }
    }
  }
}

module.exports = {
  createCanvas,
  drawRoundedRect,
  encodePng,
};
