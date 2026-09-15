import { useEffect, useRef, useState } from 'react';
import type {
  CompiledScene,
  PreviewSurfaceResult,
} from '../core/types';
import type { StoredAsset } from '../persistence/types';
import {
  RenderClient,
  type PreviewHandle,
  type WorkerPort,
} from '../workers/client';
import RenderWorker from '../workers/render.worker?worker&inline';

export class RenderJobController {
  private worker: Worker | null = null;
  private client: RenderClient | null = null;
  private loadedAssetId: string | null = null;
  private loadPromise: Promise<void> | null = null;
  private generation = 0;
  private disposed = false;
  private suspendedFlag = false;
  private readonly epochListeners = new Set<() => void>();

  constructor(private readonly clientFactory?: () => RenderClient) {}

  isSuspended(): boolean {
    return this.suspendedFlag;
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  onEpoch(listener: () => void): () => void {
    this.epochListeners.add(listener);
    return () => {
      this.epochListeners.delete(listener);
    };
  }

  private bumpEpoch(): void {
    for (const listener of [...this.epochListeners]) listener();
  }

  suspend(): void {
    this.suspendedFlag = true;
    this.generation += 1;
    if (this.client && this.loadedAssetId) {
      this.client.releaseAsset(this.loadedAssetId);
    }
    this.loadedAssetId = null;
    this.loadPromise = null;
    this.bumpEpoch();
  }

  resume(): void {
    if (!this.suspendedFlag) return;
    this.suspendedFlag = false;
    this.bumpEpoch();
  }

  private ensureClient(): RenderClient {
    if (!this.client) {
      if (this.clientFactory) {
        this.client = this.clientFactory();
        return this.client;
      }
      const worker = new RenderWorker();
      this.worker = worker;
      let onmessage: WorkerPort['onmessage'] = null;
      let onerror: ((event: unknown) => void) | null = null;
      let onmessageerror: ((event: unknown) => void) | null = null;
      const port: WorkerPort = {
        postMessage: (message, transfer) =>
          worker.postMessage(message, transfer ?? []),
        get onmessage() {
          return onmessage;
        },
        set onmessage(handler) {
          onmessage = handler;
          worker.onmessage = handler
            ? (event: MessageEvent) => handler({ data: event.data })
            : null;
        },
        get onerror() {
          return onerror;
        },
        set onerror(handler) {
          onerror = handler;
          worker.onerror = handler ?? null;
        },
        get onmessageerror() {
          return onmessageerror;
        },
        set onmessageerror(handler) {
          onmessageerror = handler;
          worker.onmessageerror = handler ?? null;
        },
        terminate: () => worker.terminate(),
      };
      this.client = new RenderClient(port);
    }
    return this.client;
  }

  async ensureAsset(assetId: string, blob: Blob): Promise<void> {
    if (this.disposed) throw new Error('render controller disposed');
    if (this.loadedAssetId === assetId) {
      await this.loadPromise;
      return;
    }
    const generation = ++this.generation;
    const previousId = this.loadedAssetId;
    this.loadedAssetId = assetId;
    const pending = Promise.resolve().then(async () => {
      const bytes = await blob.arrayBuffer();
      if (generation !== this.generation || this.disposed) {
        throw new Error('asset load superseded');
      }
      const client = this.ensureClient();
      await client.loadAsset(assetId, bytes);
      if (
        previousId &&
        previousId !== assetId &&
        this.loadedAssetId === assetId &&
        !this.disposed
      ) {
        client.releaseAsset(previousId);
      }
    });
    this.loadPromise = pending;
    try {
      await pending;
    } catch (e) {
      if (this.loadedAssetId === assetId) this.loadedAssetId = null;
      throw e;
    } finally {
      if (this.loadPromise === pending) this.loadPromise = null;
    }
  }

  requestPreview(
    scene: CompiledScene,
    maxEdgePx: number,
  ): PreviewHandle {
    if (this.disposed) {
      return {
        jobId: 'disposed',
        revision: 0,
        done: Promise.resolve(null),
      };
    }
    return this.ensureClient().requestPreview(scene, maxEdgePx);
  }

  cancelJob(jobId: string): void {
    this.client?.cancel(jobId);
  }

  recreate(): void {
    this.generation += 1;
    this.client?.dispose();
    this.worker?.terminate();
    this.client = null;
    this.worker = null;
    this.loadedAssetId = null;
    this.loadPromise = null;
    this.disposed = false;
  }

  dispose(): void {
    this.generation += 1;
    this.disposed = true;
    this.client?.dispose();
    this.worker?.terminate();
    this.client = null;
    this.worker = null;
    this.loadedAssetId = null;
    this.loadPromise = null;
  }
}

export type PreviewStatus =
  | 'idle'
  | 'updating'
  | 'ready'
  | 'error';

export interface PreviewState {
  readonly surfaces: readonly PreviewSurfaceResult[] | null;
  readonly status: PreviewStatus;
  readonly error: string | null;
}

const QUICK_DEBOUNCE_MS = 180;
const SETTLED_DEBOUNCE_MS = 700;
const QUICK_EDGE_PX = 256;
const SETTLED_EDGE_PX = 1024;

export interface PreviewQueueResult extends PreviewState {
  readonly retry: () => void;
}

export function usePreviewQueue(
  controller: RenderJobController | null,
  scene: CompiledScene | null,
  asset: StoredAsset | null,
  revision: number,
): PreviewQueueResult {
  const [state, setState] = useState<PreviewState>({
    surfaces: null,
    status: 'idle',
    error: null,
  });
  const [nonce, setNonce] = useState(0);
  const [epoch, setEpoch] = useState(0);
  const runRef = useRef(0);

  useEffect(() => {
    if (!controller) return;
    return controller.onEpoch(() => setEpoch((e) => e + 1));
  }, [controller]);

  useEffect(() => {
    if (!controller) return;
    if (
      !scene ||
      (scene.artwork !== null && !asset) ||
      controller.isSuspended()
    ) {
      runRef.current += 1;
      queueMicrotask(() =>
        setState({ surfaces: null, status: 'idle', error: null }),
      );
      return;
    }
    const run = ++runRef.current;
    queueMicrotask(() =>
      setState((prev) => ({
        surfaces: prev.surfaces,
        status: 'updating',
        error: null,
      })),
    );
    const isStale = () => run !== runRef.current;
    let quickHandle: PreviewHandle | null = null;
    let settledHandle: PreviewHandle | null = null;
    let settledTimer: ReturnType<typeof setTimeout> | null = null;

    const fail = (e: unknown) => {
      if (isStale()) return;
      setState((prev) => ({
        surfaces: prev.surfaces,
        status: 'error',
        error: e instanceof Error ? e.message : 'preview failed',
      }));
    };

    const quickTimer = setTimeout(() => {
      void (async () => {
        try {
          const artworkId = scene.artwork?.assetId;
          if (artworkId && asset) {
            await controller.ensureAsset(artworkId, asset.normalizedPng);
          }
          if (isStale()) return;
          quickHandle = controller.requestPreview(scene, QUICK_EDGE_PX);
          const quick = await quickHandle.done;
          if (isStale() || quick === null) return;
          setState({ surfaces: quick, status: 'updating', error: null });
          settledTimer = setTimeout(() => {
            if (isStale()) return;
            settledHandle = controller.requestPreview(scene, SETTLED_EDGE_PX);
            settledHandle.done.then(
              (final) => {
                if (isStale() || final === null) return;
                setState({ surfaces: final, status: 'ready', error: null });
              },
              fail,
            );
          }, SETTLED_DEBOUNCE_MS);
        } catch (e) {
          fail(e);
        }
      })();
    }, QUICK_DEBOUNCE_MS);

    return () => {
      runRef.current += 1;
      clearTimeout(quickTimer);
      if (settledTimer) clearTimeout(settledTimer);
      if (quickHandle) controller.cancelJob(quickHandle.jobId);
      if (settledHandle) controller.cancelJob(settledHandle.jobId);
    };
  }, [controller, scene, asset, revision, nonce, epoch]);

  return {
    ...state,
    retry: () => {
      controller?.recreate();
      setNonce((n) => n + 1);
    },
  };
}
