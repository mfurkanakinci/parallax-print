import { renderRasterBlock } from '../core/raster/renderBlock';
import { LIMITS } from '../core/limits';
import type {
  PreviewSurfaceResult,
  SourcePyramid,
} from '../core/types';
import type { WorkerReply, WorkerRequest } from './protocol';

export interface RenderJobDeps {
  decodeAsset: (bytes: ArrayBuffer, assetId: string) => Promise<SourcePyramid>;
  post: (reply: WorkerReply) => void;
  yieldControl?: () => Promise<void>;
}

export function createRenderJobHandler(
  deps: RenderJobDeps,
): (request: WorkerRequest) => Promise<void> {
  const pyramids = new Map<string, SourcePyramid>();
  const pendingLoads = new Map<string, Promise<void>>();
  let loadQueue: Promise<void> = Promise.resolve();
  let loadGeneration = 0;
  let activeAssetId: string | null = null;
  let latestPreviewJobId: string | null = null;
  let canceledPreviewJobId: string | null = null;
  const yieldControl =
    deps.yieldControl ?? (() => new Promise<void>((r) => setTimeout(r, 0)));

  const isPreviewCanceled = (jobId: string): boolean =>
    jobId !== latestPreviewJobId || jobId === canceledPreviewJobId;

  const postCanceled = (jobId: string): void => {
    deps.post({ type: 'canceled', jobId });
  };

  const postSuperseded = (jobId: string): void => {
    deps.post({
      type: 'failed',
      jobId,
      code: 'asset-superseded',
      message: 'The asset was released or replaced before decode completed.',
    });
  };

  const handleLoad = async (
    jobId: string,
    assetId: string,
    pngBytes: ArrayBuffer,
  ): Promise<void> => {
    loadGeneration += 1;
    const generation = loadGeneration;
    activeAssetId = assetId;
    pyramids.clear();
    const work = loadQueue.then(async () => {
      try {
        if (generation !== loadGeneration || activeAssetId !== assetId) {
          postSuperseded(jobId);
          return;
        }
        const pyramid = await deps.decodeAsset(pngBytes, assetId);
        if (generation !== loadGeneration || activeAssetId !== assetId) {
          postSuperseded(jobId);
          return;
        }
        pyramids.set(assetId, pyramid);
        deps.post({
          type: 'asset-ready',
          jobId,
          assetId,
          widthPx: pyramid.widthPx,
          heightPx: pyramid.heightPx,
        });
      } catch (e) {
        deps.post({
          type: 'failed',
          jobId,
          code: 'asset-decode',
          message: e instanceof Error ? e.message : 'asset decode failed',
        });
      }
    });
    loadQueue = work.then(
      () => undefined,
      () => undefined,
    );
    pendingLoads.set(assetId, work);
    try {
      await work;
    } finally {
      if (pendingLoads.get(assetId) === work) pendingLoads.delete(assetId);
    }
  };

  const handlePreview = async (
    jobId: string,
    revision: number,
    scene: Extract<WorkerRequest, { type: 'preview' }>['scene'],
    maxEdgePx: number,
  ): Promise<void> => {
    try {
      if (scene.artwork) {
        const pending = pendingLoads.get(scene.artwork.assetId);
        if (pending) await pending;
      }
      if (isPreviewCanceled(jobId)) {
        postCanceled(jobId);
        return;
      }
      const pyramid = scene.artwork
        ? pyramids.get(scene.artwork.assetId)
        : null;
      if (scene.artwork && !pyramid) {
        deps.post({
          type: 'failed',
          jobId,
          code: 'missing-asset',
          message: 'No decoded asset is loaded for this artwork reference.',
        });
        return;
      }
      const surfaces: PreviewSurfaceResult[] = [];
      let index = 0;
      for (const compiled of scene.surfaces) {
        index += 1;
        if (isPreviewCanceled(jobId)) {
          postCanceled(jobId);
          return;
        }
        if (!pyramid || compiled.printableFootprintMm.length < 3) {
          continue;
        }
        const bounds = compiled.surface.boundsMm;
        const longestMm = Math.max(bounds.width, bounds.height);
        const mmpp = longestMm / Math.max(1, maxEdgePx);
        const widthPx = Math.max(1, Math.ceil(bounds.width / mmpp));
        const heightPx = Math.max(1, Math.ceil(bounds.height / mmpp));
        const result = await renderRasterBlock({
          scene,
          surfaceId: compiled.surface.id,
          blockPx: { x: 0, y: 0, width: widthPx, height: heightPx },
          mmPerPixel: mmpp,
          pyramid,
          cancellation: { isCanceled: () => isPreviewCanceled(jobId) },
          yieldEveryRows: 8,
          yieldControl,
        });
        if (result.status === 'canceled' || isPreviewCanceled(jobId)) {
          postCanceled(jobId);
          return;
        }
        surfaces.push({
          surfaceId: compiled.surface.id,
          widthPx,
          heightPx,
          mmPerPixel: mmpp,
          pixels: result.pixels!,
        });
        deps.post({
          type: 'progress',
          jobId,
          phase: 'warp',
          completed: index,
          total: scene.surfaces.length,
        });
        await yieldControl();
      }
      if (isPreviewCanceled(jobId)) {
        postCanceled(jobId);
        return;
      }
      deps.post({ type: 'preview-ready', jobId, revision, surfaces });
    } catch (e) {
      deps.post({
        type: 'failed',
        jobId,
        code: 'render-error',
        message: e instanceof Error ? e.message : 'render failed',
      });
    }
  };

  return async (request: WorkerRequest): Promise<void> => {
    try {
      switch (request.type) {
        case 'load-asset': {
          await handleLoad(request.jobId, request.assetId, request.pngBytes);
          return;
        }
        case 'release-asset': {
          if (request.assetId === activeAssetId) {
            loadGeneration += 1;
            activeAssetId = null;
          }
          pyramids.delete(request.assetId);
          return;
        }
        case 'cancel': {
          if (request.jobId === latestPreviewJobId) {
            canceledPreviewJobId = request.jobId;
          }
          return;
        }
        case 'preview': {
          latestPreviewJobId = request.jobId;
          await handlePreview(
            request.jobId,
            request.revision,
            request.scene,
            Math.min(request.maxEdgePx, LIMITS.preview.settledMaxEdgePx),
          );
          return;
        }
        case 'export-volume': {
          deps.post({
            type: 'failed',
            jobId: request.jobId,
            code: 'unsupported',
            message:
              'Volume export runs through the dedicated export worker (start-export).',
          });
          return;
        }
        case 'start-export':
        case 'start-calibration': {
          deps.post({
            type: 'failed',
            jobId: request.jobId,
            code: 'unsupported',
            message: 'This worker only renders previews.',
          });
          return;
        }
      }
    } catch (e) {
      deps.post({
        type: 'failed',
        jobId: 'jobId' in request ? request.jobId : 'unknown',
        code: 'worker-error',
        message: e instanceof Error ? e.message : 'worker request failed',
      });
    }
  };
}
