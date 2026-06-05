// Generates minimal valid PNG icons using only Node.js built-ins (no extra packages)
const zlib = require('zlib');
const fs   = require('fs');
const path = require('path');

// CRC32 table for PNG chunk checksums
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (const b of buf) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ b) & 0xFF];
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const len = Buffer.allocUnsafe(4); len.writeUInt32BE(data.length);
  const crcSrc = Buffer.concat([typeBytes, data]);
  const crcBuf = Buffer.allocUnsafe(4); crcBuf.writeUInt32BE(crc32(crcSrc));
  return Buffer.concat([len, typeBytes, data, crcBuf]);
}

function makePNG(size) {
  // IHDR: width, height, 8-bit depth, RGBA color type (6)
  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = ihdr[11] = ihdr[12] = 0;

  // Draw a dark background with a lighter circle (globe-like)
  const rows = [];
  const cx = size / 2, cy = size / 2, r = size * 0.45;
  for (let y = 0; y < size; y++) {
    const row = Buffer.allocUnsafe(1 + size * 4);
    row[0] = 0; // filter none
    for (let x = 0; x < size; x++) {
      const i = 1 + x * 4;
      const dx = x - cx, dy = y - cy;
      const dist = Math.sqrt(dx*dx + dy*dy);
      if (dist < r) {
        // Inside circle — teal/blue
        const t = 1 - dist / r;
        row[i]   = Math.round(13 + t * 30);   // R
        row[i+1] = Math.round(100 + t * 80);  // G
        row[i+2] = Math.round(200 + t * 55);  // B
        row[i+3] = 255;                        // A
      } else {
        // Background — dark navy
        row[i] = 13; row[i+1] = 17; row[i+2] = 23; row[i+3] = 255;
      }
    }
    rows.push(row);
  }
  const raw = Buffer.concat(rows);
  const compressed = zlib.deflateSync(raw, { level: 6 });

  const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    PNG_SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const publicDir = path.join(__dirname, '..', 'public');
fs.writeFileSync(path.join(publicDir, 'icon-192.png'), makePNG(192));
fs.writeFileSync(path.join(publicDir, 'icon-512.png'), makePNG(512));
console.log('Icons created: public/icon-192.png, public/icon-512.png');
