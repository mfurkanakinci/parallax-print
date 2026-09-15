import { LIMITS } from '../core/limits';
import {
  AssetHeaderError,
  parseImageHeader,
  stripImageMetadata,
} from './imageHeaders';

export interface DecodedImageData {
  readonly widthPx: number;
  readonly heightPx: number;
  readonly data: Uint8ClampedArray;
}

export type ImageDecoder = (
  bytes: Uint8Array,
  format: 'png' | 'jpeg',
) => Promise<DecodedImageData>;

export interface NormalizedArtwork {
  readonly format: 'png' | 'jpeg';
  readonly widthPx: number;
  readonly heightPx: number;
  readonly pixels: Uint8ClampedArray;
  readonly orientationApplied: number;
}

export function applyOrientation(
  image: DecodedImageData,
  orientation: number,
): DecodedImageData {
  const { widthPx: w, heightPx: h, data } = image;
  if (orientation < 1 || orientation > 8) {
    return { widthPx: w, heightPx: h, data: new Uint8ClampedArray(data) };
  }
  const swapped = orientation >= 5;
  const outW = swapped ? h : w;
  const outH = swapped ? w : h;
  const out = new Uint8ClampedArray(outW * outH * 4);
  const map = (x: number, y: number): [number, number] => {
    switch (orientation) {
      case 2:
        return [w - 1 - x, y];
      case 3:
        return [w - 1 - x, h - 1 - y];
      case 4:
        return [x, h - 1 - y];
      case 5:
        return [y, x];
      case 6:
        return [y, h - 1 - x];
      case 7:
        return [w - 1 - y, h - 1 - x];
      case 8:
        return [w - 1 - y, x];
      default:
        return [x, y];
    }
  };
  for (let y = 0; y < outH; y += 1) {
    for (let x = 0; x < outW; x += 1) {
      const [sx, sy] = map(x, y);
      const src = (sy * w + sx) * 4;
      const dst = (y * outW + x) * 4;
      out[dst] = data[src]!;
      out[dst + 1] = data[src + 1]!;
      out[dst + 2] = data[src + 2]!;
      out[dst + 3] = data[src + 3]!;
    }
  }
  return { widthPx: outW, heightPx: outH, data: out };
}

export async function normalizeArtworkBytes(
  bytes: Uint8Array,
  decode: ImageDecoder,
): Promise<NormalizedArtwork> {
  if (bytes.length > LIMITS.source.maxCompressedBytes) {
    throw new AssetHeaderError(
      'file-too-large',
      'Source file exceeds the 20 MiB compressed limit.',
    );
  }
  const header = parseImageHeader(bytes);
  const stripped = stripImageMetadata(bytes, header);
  const decoded = await decode(stripped, header.format);
  if (
    decoded.widthPx !== header.widthPx ||
    decoded.heightPx !== header.heightPx ||
    decoded.data.length !== decoded.widthPx * decoded.heightPx * 4
  ) {
    throw new AssetHeaderError(
      'corrupt-header',
      'Decoded dimensions do not match the file header.',
    );
  }
  const oriented = applyOrientation(decoded, header.orientation);
  if (
    oriented.data.length > LIMITS.source.maxNormalizedBytes ||
    oriented.widthPx * oriented.heightPx > LIMITS.source.maxMegapixels * 1_000_000
  ) {
    throw new AssetHeaderError(
      'image-too-large',
      'Normalized artwork exceeds the supported budget.',
    );
  }
  return {
    format: header.format,
    widthPx: oriented.widthPx,
    heightPx: oriented.heightPx,
    pixels: oriented.data,
    orientationApplied: header.orientation,
  };
}

export const browserImageDecoder: ImageDecoder = async (bytes, format) => {
  const blob = new Blob([new Uint8Array(bytes) as Uint8Array<ArrayBuffer>], {
    type: format === 'png' ? 'image/png' : 'image/jpeg',
  });
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas =
      typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(bitmap.width, bitmap.height)
        : Object.assign(document.createElement('canvas'), {
            width: bitmap.width,
            height: bitmap.height,
          });
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new AssetHeaderError('corrupt-header', 'Canvas 2D is unavailable.');
    }
    ctx.drawImage(bitmap, 0, 0);
    const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    return {
      widthPx: imageData.width,
      heightPx: imageData.height,
      data: imageData.data,
    };
  } finally {
    bitmap.close();
  }
};

export async function encodeNormalizedPngBrowser(image: {
  readonly widthPx: number;
  readonly heightPx: number;
  readonly pixels: Uint8ClampedArray;
}): Promise<Uint8Array> {
  if (
    !Number.isSafeInteger(image.widthPx) ||
    !Number.isSafeInteger(image.heightPx) ||
    image.widthPx < 1 ||
    image.heightPx < 1 ||
    image.widthPx > LIMITS.source.maxSidePx ||
    image.heightPx > LIMITS.source.maxSidePx ||
    image.widthPx * image.heightPx > LIMITS.source.maxMegapixels * 1_000_000 ||
    image.pixels.length !== image.widthPx * image.heightPx * 4
  ) {
    throw new RangeError('Normalized image is outside supported limits.');
  }
  const pixels = new Uint8ClampedArray(image.pixels);
  const canvas =
    typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(image.widthPx, image.heightPx)
      : Object.assign(document.createElement('canvas'), {
          width: image.widthPx,
          height: image.heightPx,
        });
  const ctx = canvas.getContext('2d') as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null;
  if (!ctx) {
    throw new AssetHeaderError('corrupt-header', 'Canvas 2D is unavailable.');
  }
  ctx.putImageData(new ImageData(pixels, image.widthPx, image.heightPx), 0, 0);
  const blob =
    typeof OffscreenCanvas !== 'undefined' && canvas instanceof OffscreenCanvas
      ? await canvas.convertToBlob({ type: 'image/png' })
      : await new Promise<Blob>((resolve, reject) => {
          (canvas as HTMLCanvasElement).toBlob(
            (b) => (b ? resolve(b) : reject(new Error('PNG encode failed'))),
            'image/png',
          );
        });
  if (blob.size > LIMITS.source.maxNormalizedBytes) {
    throw new AssetHeaderError(
      'image-too-large',
      'Encoded PNG exceeds the normalized byte limit.',
    );
  }
  return new Uint8Array(await blob.arrayBuffer());
}
