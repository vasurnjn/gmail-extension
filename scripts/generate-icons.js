import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

function createPng(width, height, r, g, b, a = 255) {
  // Signature
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR chunk
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData.writeUInt8(8, 8); // bit depth
  ihdrData.writeUInt8(6, 9); // RGBA
  ihdrData.writeUInt8(0, 10); // compression
  ihdrData.writeUInt8(0, 11); // filter
  ihdrData.writeUInt8(0, 12); // interlace

  const ihdrChunk = createChunk('IHDR', ihdrData);

  // Raw image data: height scanlines, each starting with filter byte 0
  const rowBytes = width * 4;
  const rawData = Buffer.alloc(height * (rowBytes + 1));

  let offset = 0;
  for (let y = 0; y < height; y++) {
    rawData.writeUInt8(0, offset++); // Filter byte 0 (None)
    for (let x = 0; x < width; x++) {
      // Draw a simple circular / badge shape or solid colored badge with border
      const dx = x - width / 2;
      const dy = y - height / 2;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const radius = width / 2 - 1;

      if (dist <= radius) {
        rawData.writeUInt8(r, offset++);
        rawData.writeUInt8(g, offset++);
        rawData.writeUInt8(b, offset++);
        rawData.writeUInt8(a, offset++);
      } else {
        rawData.writeUInt8(0, offset++);
        rawData.writeUInt8(0, offset++);
        rawData.writeUInt8(0, offset++);
        rawData.writeUInt8(0, offset++);
      }
    }
  }

  const compressedData = zlib.deflateSync(rawData);
  const idatChunk = createChunk('IDAT', compressedData);
  const iendChunk = createChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

function createChunk(type, data) {
  const length = data.length;
  const chunk = Buffer.alloc(8 + length + 4);
  chunk.writeUInt32BE(length, 0);
  chunk.write(type, 4, 4, 'ascii');
  data.copy(chunk, 8);

  const crc = crc32(chunk.subarray(4, 8 + length));
  chunk.writeInt32BE(crc, 8 + length);
  return chunk;
}

// CRC-32 table
const crcTable = [];
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    if (c & 1) {
      c = 0xedb88320 ^ (c >>> 1);
    } else {
      c = c >>> 1;
    }
  }
  crcTable[n] = c;
}

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) | 0;
}

const dir = path.resolve('public/icons');
fs.mkdirSync(dir, { recursive: true });

// Brand color: Indigo / Blue #3b82f6 (59, 130, 246)
fs.writeFileSync(path.join(dir, 'icon16.png'), createPng(16, 16, 59, 130, 246));
fs.writeFileSync(path.join(dir, 'icon48.png'), createPng(48, 48, 59, 130, 246));
fs.writeFileSync(path.join(dir, 'icon128.png'), createPng(128, 128, 59, 130, 246));

console.log('Successfully generated icons: 16x16, 48x48, 128x128');
