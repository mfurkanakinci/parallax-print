import { sha256Hex } from './contentHash';
import {
  browserImageDecoder,
  encodeNormalizedPngBrowser,
  normalizeArtworkBytes,
  type ImageDecoder,
} from './normalizeArtwork';
import { LIMITS } from '../core/limits';
import type { StoredAsset } from '../persistence/types';

export interface PhotoPixels {
  readonly widthPx: number;
  readonly heightPx: number;
  readonly pixels: Uint8ClampedArray;
}

/** Deterministic bounded bilinear resize; coordinates remain normalized to the resulting image. */
export function fitReferencePhoto(image: PhotoPixels): PhotoPixels {
  const { widthPx, heightPx, pixels } = image;
  if (!Number.isSafeInteger(widthPx) || !Number.isSafeInteger(heightPx) || widthPx < 1 || heightPx < 1
      || widthPx > LIMITS.source.maxSidePx || heightPx > LIMITS.source.maxSidePx
      || widthPx * heightPx > LIMITS.source.maxMegapixels * 1_000_000
      || pixels.length !== widthPx * heightPx * 4) {
    throw new Error('Reference photo dimensions are invalid or exceed the decode budget.');
  }
  const ratio = Math.min(1, LIMITS.photo.maxSidePx / widthPx, LIMITS.photo.maxSidePx / heightPx,
    Math.sqrt(LIMITS.photo.maxPixels / (widthPx * heightPx)));
  if (ratio === 1) return image;
  const width = Math.max(1, Math.floor(widthPx * ratio));
  const height = Math.max(1, Math.floor(heightPx * ratio));
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const sy = Math.max(0, (y + 0.5) * heightPx / height - 0.5);
    const y0 = Math.min(heightPx - 1, Math.floor(sy));
    const y1 = Math.min(heightPx - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < width; x += 1) {
      const sx = Math.max(0, (x + 0.5) * widthPx / width - 0.5);
      const x0 = Math.min(widthPx - 1, Math.floor(sx));
      const x1 = Math.min(widthPx - 1, x0 + 1);
      const fx = sx - x0;
      const weights = [(1 - fx) * (1 - fy), fx * (1 - fy), (1 - fx) * fy, fx * fy];
      const offsets = [(y0 * widthPx + x0) * 4, (y0 * widthPx + x1) * 4, (y1 * widthPx + x0) * 4, (y1 * widthPx + x1) * 4];
      const dst = (y * width + x) * 4;
      let alpha = 0;
      for (let i = 0; i < 4; i += 1) alpha += pixels[offsets[i]! + 3]! * weights[i]!;
      out[dst + 3] = alpha;
      for (let c = 0; c < 3; c += 1) {
        let premultiplied = 0;
        for (let i = 0; i < 4; i += 1) premultiplied += pixels[offsets[i]! + c]! * pixels[offsets[i]! + 3]! * weights[i]!;
        out[dst + c] = alpha > 0 ? premultiplied / alpha : 0;
      }
    }
  }
  return { widthPx: width, heightPx: height, pixels: out };
}

export async function importReferencePhoto(
  file: Blob,
  displayFilename: string,
  decode: ImageDecoder = browserImageDecoder,
  encode: (image: PhotoPixels) => Promise<Uint8Array> = encodeNormalizedPngBrowser,
): Promise<StoredAsset> {
  if (file.size > LIMITS.source.maxCompressedBytes) throw new Error('Reference photo exceeds the 20 MiB file limit.');
  // Uses the same explicit EXIF orientation and metadata stripping as artwork.
  // Only the bounded normalized PNG is retained; original metadata is not stored.
  const normalized = await normalizeArtworkBytes(new Uint8Array(await file.arrayBuffer()), decode);
  const fitted = fitReferencePhoto(normalized);
  const png = await encode(fitted);
  if (png.byteLength > LIMITS.photo.maxNormalizedBytes) throw new Error('Normalized reference photo exceeds the 32 MiB limit.');
  const hash = await sha256Hex(png);
  return {
    assetId: hash,
    contentHash: hash,
    widthPx: fitted.widthPx,
    heightPx: fitted.heightPx,
    displayFilename,
    normalizedPng: new Blob([new Uint8Array(png) as Uint8Array<ArrayBuffer>], { type: 'image/png' }),
  };
}
