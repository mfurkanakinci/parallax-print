import { buildSourcePyramid } from '../core/raster/sourcePyramid';
import { LIMITS } from '../core/limits';
import type { SourcePyramid } from '../core/types';
import { AssetHeaderError, parseImageHeader } from '../assets/imageHeaders';
import { createRenderJobHandler } from './renderJob';
import { parseWorkerRequest } from './protocol';

async function decodePngToPyramid(bytes: ArrayBuffer): Promise<SourcePyramid> {
  const view = new Uint8Array(bytes);
  if (view.byteLength > LIMITS.source.maxNormalizedBytes) {
    throw new AssetHeaderError(
      'file-too-large',
      'Normalized asset exceeds the 72 MiB limit.',
    );
  }
  const header = parseImageHeader(view, {
    maxCompressedBytes: LIMITS.source.maxNormalizedBytes,
  });
  if (header.format !== 'png') {
    throw new AssetHeaderError(
      'unsupported-format',
      'Worker assets must be normalized PNG data.',
    );
  }
  const blob = new Blob([view], { type: 'image/png' });
  const bitmap = await createImageBitmap(blob);
  try {
    if (bitmap.width !== header.widthPx || bitmap.height !== header.heightPx) {
      throw new AssetHeaderError(
        'corrupt-header',
        'Decoded bitmap dimensions do not match the PNG header.',
      );
    }
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('OffscreenCanvas 2D unavailable');
    ctx.drawImage(bitmap, 0, 0);
    const image = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    return buildSourcePyramid(image.width, image.height, image.data);
  } finally {
    bitmap.close();
  }
}

const handle = createRenderJobHandler({
  decodeAsset: decodePngToPyramid,
  post: (reply) => {
    const transfer: Transferable[] = [];
    if (reply.type === 'preview-ready') {
      for (const s of reply.surfaces) {
        transfer.push(s.pixels.buffer as ArrayBuffer);
      }
    }
    if (reply.type === 'file-ready') {
      transfer.push(reply.bytes);
    }
    (self as unknown as Worker).postMessage(reply, transfer);
  },
  yieldControl: () => new Promise((resolve) => setTimeout(resolve, 0)),
});

self.onmessage = (event: MessageEvent) => {
  const request = parseWorkerRequest(event.data);
  if (request) {
    void handle(request);
  }
};

export {};
