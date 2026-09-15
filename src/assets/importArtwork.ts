import { LIMITS } from '../core/limits';
import type { StoredAsset } from '../persistence/types';
import { sha256Hex } from './contentHash';
import {
  browserImageDecoder,
  encodeNormalizedPngBrowser,
  normalizeArtworkBytes,
  type ImageDecoder,
} from './normalizeArtwork';
import { SAMPLE_ARTWORKS, type SampleArtwork } from './sampleProject';

export async function importArtworkFile(
  file: Blob,
  displayFilename: string,
  decode: ImageDecoder = browserImageDecoder,
): Promise<StoredAsset> {
  if (file.size > LIMITS.source.maxCompressedBytes) {
    throw new RangeError(
      `Image exceeds the ${LIMITS.source.maxCompressedBytes / (1024 * 1024)} MiB compressed limit.`,
    );
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const normalized = await normalizeArtworkBytes(bytes, decode);
  const png = await encodeNormalizedPngBrowser({
    widthPx: normalized.widthPx,
    heightPx: normalized.heightPx,
    pixels: normalized.pixels,
  });
  const contentHash = await sha256Hex(png);
  return {
    assetId: contentHash,
    contentHash,
    widthPx: normalized.widthPx,
    heightPx: normalized.heightPx,
    normalizedPng: new Blob([png.buffer as ArrayBuffer], { type: 'image/png' }),
    displayFilename,
  };
}

export async function loadBundledSampleAsset(
  artwork: SampleArtwork = SAMPLE_ARTWORKS[0]!,
  decode: ImageDecoder = browserImageDecoder,
): Promise<StoredAsset> {
  const response = await fetch(artwork.path);
  if (!response.ok) {
    throw new Error(`Sample artwork fetch failed (${response.status}).`);
  }
  const blob = await response.blob();
  return importArtworkFile(blob, artwork.fileName, decode);
}

export const MAX_ASSET_BLOB_BYTES = LIMITS.source.maxNormalizedBytes;
