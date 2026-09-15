import { LIMITS } from '../core/limits';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    crc = (CRC_TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function adler32(data: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length; i += 1) {
    a = (a + data[i]!) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function zlibStore(data: Uint8Array): Uint8Array {
  const blockCount = Math.max(1, Math.ceil(data.length / 65535));
  const out = new Uint8Array(2 + data.length + blockCount * 5 + 4);
  let o = 0;
  out[o++] = 0x78;
  out[o++] = 0x01;
  let p = 0;
  for (let i = 0; i < blockCount; i += 1) {
    const chunk = Math.min(65535, data.length - p);
    const final = i === blockCount - 1;
    out[o++] = final ? 0x01 : 0x00;
    out[o++] = chunk & 0xff;
    out[o++] = (chunk >>> 8) & 0xff;
    out[o++] = ~chunk & 0xff;
    out[o++] = (~chunk >>> 8) & 0xff;
    out.set(data.subarray(p, p + chunk), o);
    o += chunk;
    p += chunk;
  }
  const adler = adler32(data);
  out[o++] = (adler >>> 24) & 0xff;
  out[o++] = (adler >>> 16) & 0xff;
  out[o++] = (adler >>> 8) & 0xff;
  out[o++] = adler & 0xff;
  return out.subarray(0, o);
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i += 1) {
    out[4 + i] = type.charCodeAt(i);
  }
  out.set(data, 8);
  const crcInput = out.subarray(4, 8 + data.length);
  view.setUint32(8 + data.length, crc32(crcInput));
  return out;
}

export function encodePngRgba(
  widthPx: number,
  heightPx: number,
  rgba: Uint8ClampedArray,
): Uint8Array {
  if (
    !Number.isSafeInteger(widthPx) ||
    !Number.isSafeInteger(heightPx) ||
    widthPx < 1 ||
    heightPx < 1 ||
    widthPx > LIMITS.rasterBlockMaxPx ||
    heightPx > LIMITS.rasterBlockMaxPx
  ) {
    throw new RangeError(
      'encodePngRgba dimensions are outside the supported block limit.',
    );
  }
  if (rgba.length !== widthPx * heightPx * 4) {
    throw new Error('encodePngRgba: buffer size does not match dimensions');
  }
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, widthPx);
  ihdrView.setUint32(4, heightPx);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const stride = widthPx * 4;
  const raw = new Uint8Array((stride + 1) * heightPx);
  for (let row = 0; row < heightPx; row += 1) {
    raw[row * (stride + 1)] = 0;
    raw.set(rgba.subarray(row * stride, (row + 1) * stride), row * (stride + 1) + 1);
  }
  const idat = zlibStore(raw);
  const parts = [signature, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
