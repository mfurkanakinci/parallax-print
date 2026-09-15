import { LIMITS } from '../core/limits';

export type ImageFormat = 'png' | 'jpeg';

export type AssetHeaderErrorCode =
  | 'file-too-large'
  | 'unsupported-format'
  | 'truncated'
  | 'corrupt-header'
  | 'animated-png'
  | 'unsupported-png'
  | 'unsupported-jpeg'
  | 'unsupported-jpeg-components'
  | 'image-too-large';

export class AssetHeaderError extends Error {
  readonly code: AssetHeaderErrorCode;

  constructor(code: AssetHeaderErrorCode, message: string) {
    super(message);
    this.name = 'AssetHeaderError';
    this.code = code;
  }
}

export interface ImageHeaderInfo {
  readonly format: ImageFormat;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly orientation: number;
  readonly hasAlpha: boolean;
  readonly bitDepth: number;
  readonly components: number;
}

export interface ParseHeaderOptions {
  readonly maxCompressedBytes?: number;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const PNG_BIT_DEPTHS: Record<number, readonly number[]> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
};

function checkPixelBudget(widthPx: number, heightPx: number): void {
  if (
    !Number.isInteger(widthPx) ||
    !Number.isInteger(heightPx) ||
    widthPx <= 0 ||
    heightPx <= 0 ||
    widthPx > LIMITS.source.maxSidePx ||
    heightPx > LIMITS.source.maxSidePx ||
    widthPx * heightPx > LIMITS.source.maxMegapixels * 1_000_000
  ) {
    throw new AssetHeaderError(
      'image-too-large',
      `Declared dimensions ${widthPx}×${heightPx} exceed the supported budget.`,
    );
  }
}

function ascii(view: DataView, offset: number, length: number): string {
  let s = '';
  for (let i = 0; i < length; i += 1) {
    s += String.fromCharCode(view.getUint8(offset + i));
  }
  return s;
}

function tiffOrientation(view: DataView, base: number): number {
  if (view.byteLength - base < 8) return 1;
  const little = view.getUint16(base) === 0x4949;
  if (!little && view.getUint16(base) !== 0x4d4d) return 1;
  if (view.getUint16(base + 2, little) !== 42) return 1;
  const ifdOffset = view.getUint32(base + 4, little);
  if (base + ifdOffset + 2 > view.byteLength) return 1;
  const count = view.getUint16(base + ifdOffset, little);
  for (let i = 0; i < count; i += 1) {
    const entry = base + ifdOffset + 2 + i * 12;
    if (entry + 12 > view.byteLength) break;
    const tag = view.getUint16(entry, little);
    const type = view.getUint16(entry + 2, little);
    const num = view.getUint32(entry + 4, little);
    if (tag === 0x0112 && type === 3 && num === 1) {
      const value = view.getUint16(entry + 8, little);
      return value >= 1 && value <= 8 ? value : 1;
    }
  }
  return 1;
}

function readExifOrientation(bytes: Uint8Array, offset: number, length: number): number {
  if (length < 14 || offset + length > bytes.length) return 1;
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, length);
  if (ascii(view, 0, 6) !== 'Exif\0\0') return 1;
  return tiffOrientation(view, 6);
}

function parsePng(bytes: Uint8Array): ImageHeaderInfo {
  if (bytes.length < 33) {
    throw new AssetHeaderError('truncated', 'PNG header is truncated.');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ihdrLength = view.getUint32(8);
  const ihdrType = ascii(view, 12, 4);
  if (ihdrType !== 'IHDR' || ihdrLength !== 13) {
    throw new AssetHeaderError('corrupt-header', 'PNG is missing a valid IHDR chunk.');
  }
  const widthPx = view.getUint32(16);
  const heightPx = view.getUint32(20);
  const bitDepth = view.getUint8(24);
  const colorType = view.getUint8(25);
  const compression = view.getUint8(26);
  const filter = view.getUint8(27);
  const interlace = view.getUint8(28);
  checkPixelBudget(widthPx, heightPx);
  if (compression !== 0 || filter !== 0 || interlace > 1) {
    throw new AssetHeaderError(
      'unsupported-png',
      'Unsupported PNG compression, filter, or interlace method.',
    );
  }
  const allowedDepths = PNG_BIT_DEPTHS[colorType];
  if (!allowedDepths || !allowedDepths.includes(bitDepth)) {
    throw new AssetHeaderError(
      'unsupported-png',
      `PNG bit depth ${bitDepth} with color type ${colorType} is not supported.`,
    );
  }
  let orientation = 1;
  let hasAlpha = colorType === 4 || colorType === 6;
  let offset = 8 + 12 + ihdrLength;
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    if (length > bytes.length || offset + 12 + length > bytes.length) {
      throw new AssetHeaderError('truncated', 'PNG chunk extends past the file end.');
    }
    const type = ascii(view, offset + 4, 4);
    if (type === 'acTL') {
      throw new AssetHeaderError('animated-png', 'Animated PNG files are not supported.');
    }
    if (type === 'eXIf') {
      const exifView = new DataView(
        bytes.buffer,
        bytes.byteOffset + offset + 8,
        length,
      );
      const found = tiffOrientation(exifView, 0);
      if (found !== 1) orientation = found;
    }
    if (type === 'tRNS') hasAlpha = true;
    offset += 12 + length;
    if (type === 'IEND') break;
  }
  return {
    format: 'png',
    widthPx,
    heightPx,
    orientation,
    hasAlpha,
    bitDepth,
    components: colorType === 6 ? 4 : colorType === 4 ? 2 : colorType === 2 ? 3 : 1,
  };
}

function parseJpeg(bytes: Uint8Array): ImageHeaderInfo {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new AssetHeaderError('corrupt-header', 'JPEG is missing its SOI marker.');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  let orientation = 1;
  let frame: { widthPx: number; heightPx: number; precision: number; components: number } | null = null;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break;
    const length = view.getUint16(offset + 2);
    if (length < 2 || offset + 2 + length > bytes.length) {
      throw new AssetHeaderError('truncated', 'JPEG segment is truncated.');
    }
    if (marker === 0xe1) {
      const found = readExifOrientation(bytes, offset + 4, length - 2);
      if (found !== 1) orientation = found;
    }
    if ([0xc0, 0xc1, 0xc2].includes(marker) && !frame) {
      if (length < 8) {
        throw new AssetHeaderError('truncated', 'JPEG SOF segment is truncated.');
      }
      const precision = view.getUint8(offset + 4);
      const heightPx = view.getUint16(offset + 5);
      const widthPx = view.getUint16(offset + 7);
      const components = view.getUint8(offset + 9);
      checkPixelBudget(widthPx, heightPx);
      if (precision !== 8) {
        throw new AssetHeaderError('unsupported-jpeg', 'Only 8-bit JPEG is supported.');
      }
      if (components !== 1 && components !== 3) {
        throw new AssetHeaderError(
          'unsupported-jpeg-components',
          'Four-component (CMYK) JPEG is not supported.',
        );
      }
      frame = { widthPx, heightPx, precision, components };
    }
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc0, 0xc1, 0xc2, 0xc4, 0xc8, 0xcc].includes(marker)) {
      throw new AssetHeaderError('unsupported-jpeg', 'Unsupported JPEG encoding.');
    }
    offset += 2 + length;
  }
  if (!frame) {
    throw new AssetHeaderError('corrupt-header', 'No supported JPEG frame header found.');
  }
  return {
    format: 'jpeg',
    widthPx: frame.widthPx,
    heightPx: frame.heightPx,
    orientation,
    hasAlpha: false,
    bitDepth: frame.precision,
    components: frame.components,
  };
}

export function parseImageHeader(
  bytes: Uint8Array,
  options?: ParseHeaderOptions,
): ImageHeaderInfo {
  const maxCompressedBytes = options?.maxCompressedBytes ?? LIMITS.source.maxCompressedBytes;
  if (bytes.length > maxCompressedBytes) {
    throw new AssetHeaderError(
      'file-too-large',
      'Source file exceeds the compressed size limit.',
    );
  }
  if (bytes.length >= 8 && PNG_SIGNATURE.every((b, i) => bytes[i] === b)) {
    return parsePng(bytes);
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return parseJpeg(bytes);
  }
  if (bytes.length < 8) {
    throw new AssetHeaderError('truncated', 'File is too short to identify.');
  }
  throw new AssetHeaderError(
    'unsupported-format',
    'Only PNG and JPEG sources are supported.',
  );
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function isExifApp1(bytes: Uint8Array, offset: number, length: number): boolean {
  return (
    length >= 8 &&
    offset + 10 <= bytes.length &&
    ascii(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), offset + 4, 6) ===
      'Exif\0\0'
  );
}

function stripJpegMetadata(bytes: Uint8Array): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const parts: Uint8Array[] = [];
  let cursor = 0;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break;
    const length = view.getUint16(offset + 2);
    if (length < 2 || offset + 2 + length > bytes.length) break;
    if (marker === 0xe1 && isExifApp1(bytes, offset, length)) {
      parts.push(bytes.subarray(cursor, offset));
      cursor = offset + 2 + length;
    }
    offset += 2 + length;
  }
  parts.push(bytes.subarray(cursor));
  return concatBytes(parts);
}

function stripPngMetadata(bytes: Uint8Array): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const parts: Uint8Array[] = [];
  let cursor = 0;
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    if (length > bytes.length || offset + 12 + length > bytes.length) break;
    const type = ascii(view, offset + 4, 4);
    if (type === 'eXIf') {
      parts.push(bytes.subarray(cursor, offset));
      cursor = offset + 12 + length;
    }
    offset += 12 + length;
    if (type === 'IEND') break;
  }
  parts.push(bytes.subarray(cursor));
  return concatBytes(parts);
}

export function stripImageMetadata(
  bytes: Uint8Array,
  info: ImageHeaderInfo,
): Uint8Array {
  return info.format === 'jpeg' ? stripJpegMetadata(bytes) : stripPngMetadata(bytes);
}
