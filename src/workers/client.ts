import type { CompiledScene, PreviewSurfaceResult } from '../core/types';
import { parseWorkerReply, type WorkerReply, type WorkerRequest } from './protocol';

export interface WorkerPort {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror?: ((event: unknown) => void) | null;
  onmessageerror?: ((event: unknown) => void) | null;
  terminate?(): void;
}

export interface PreviewHandle {
  readonly jobId: string;
  readonly revision: number;
  readonly done: Promise<PreviewSurfaceResult[] | null>;
}

interface PendingJob {
  readonly kind: 'load' | 'preview';
  readonly revision: number;
  readonly assetId?: string;
  readonly resolve: (value: PreviewSurfaceResult[] | null) => void;
  readonly reject: (error: Error) => void;
}

export class RenderClient {
  private readonly port: WorkerPort;
  private nextJob = 0;
  private latestRevision = 0;
  private readonly pending = new Map<string, PendingJob>();
  private readonly pendingLoads = new Map<string, Promise<void>>();
  private readonly sentPreviews = new Set<string>();
  private activePreviewJobId: string | null = null;
  private disposed = false;
  private failed: Error | null = null;

  constructor(port: WorkerPort) {
    this.port = port;
    this.port.onmessage = (event) => this.onMessage(event.data);
    if ('onerror' in port) {
      this.port.onerror = () =>
        this.failAll(new Error('render worker error'));
    }
    if ('onmessageerror' in port) {
      this.port.onmessageerror = () =>
        this.failAll(new Error('render worker message error'));
    }
  }

  private send(request: WorkerRequest, transfer?: Transferable[]): void {
    if (this.disposed || this.failed) return;
    try {
      this.port.postMessage(request, transfer);
    } catch (e) {
      // A synchronous postMessage throw means the port could not deliver the
      // message. Treat it as a transport failure so no job is left pending.
      this.failAll(
        e instanceof Error
          ? e
          : new Error('render worker postMessage failed'),
      );
    }
  }

  private onMessage(data: unknown): void {
    if (this.disposed) return;
    const reply = parseWorkerReply(data);
    if (!reply) {
      // A schema-invalid reply is a protocol failure: the peer can no longer
      // be trusted, so settle all pending work as failed instead of dropping
      // the message and leaving jobs registered forever.
      this.failAll(new Error('render worker sent a malformed reply'));
      return;
    }
    this.handleReply(reply);
  }

  private handleReply(reply: WorkerReply): void {
    if (reply.type === 'asset-ready') {
      const job = this.pending.get(reply.jobId);
      if (!job || job.kind !== 'load') return;
      this.pending.delete(reply.jobId);
      job.resolve(null);
      return;
    }
    if (reply.type === 'preview-ready') {
      this.sentPreviews.delete(reply.jobId);
      const job = this.pending.get(reply.jobId);
      if (!job || job.kind !== 'preview') return;
      this.pending.delete(reply.jobId);
      if (this.activePreviewJobId === reply.jobId) this.activePreviewJobId = null;
      if (reply.revision < this.latestRevision) {
        job.resolve(null);
        return;
      }
      job.resolve(reply.surfaces as PreviewSurfaceResult[]);
      return;
    }
    if (reply.type === 'canceled') {
      this.sentPreviews.delete(reply.jobId);
      const job = this.pending.get(reply.jobId);
      if (job) {
        this.pending.delete(reply.jobId);
        if (this.activePreviewJobId === reply.jobId) this.activePreviewJobId = null;
        job.resolve(null);
      }
      return;
    }
    if (reply.type === 'failed') {
      this.sentPreviews.delete(reply.jobId);
      const job = this.pending.get(reply.jobId);
      if (job) {
        this.pending.delete(reply.jobId);
        if (this.activePreviewJobId === reply.jobId) this.activePreviewJobId = null;
        job.reject(new Error(`${reply.code}: ${reply.message}`));
      }
    }
  }

  private failAll(error: Error): void {
    this.failed = error;
    // Transport and protocol failures are not benign: every pending job —
    // previews included — rejects so callers can surface a retryable error
    // instead of treating the failure like a stale/canceled result.
    for (const [jobId, job] of this.pending) {
      job.reject(error);
      this.pending.delete(jobId);
    }
    this.pendingLoads.clear();
    this.sentPreviews.clear();
    this.activePreviewJobId = null;
  }

  private settleLoad(assetId: string, promise: Promise<void>): void {
    promise.then(
      () => {
        if (this.pendingLoads.get(assetId) === promise) {
          this.pendingLoads.delete(assetId);
        }
      },
      () => {
        if (this.pendingLoads.get(assetId) === promise) {
          this.pendingLoads.delete(assetId);
        }
      },
    );
  }

  loadAsset(assetId: string, pngBytes: ArrayBuffer): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new Error('render client disposed'));
    }
    if (this.failed) {
      return Promise.reject(this.failed);
    }
    this.nextJob += 1;
    const jobId = `load-${this.nextJob}`;
    const done = new Promise<PreviewSurfaceResult[] | null>((resolve, reject) => {
      this.pending.set(jobId, {
        kind: 'load',
        revision: 0,
        assetId,
        resolve,
        reject,
      });
    }).then(() => undefined);
    this.pendingLoads.set(assetId, done);
    this.settleLoad(assetId, done);
    this.send({ type: 'load-asset', jobId, assetId, pngBytes }, [pngBytes]);
    return done;
  }

  releaseAsset(assetId: string): void {
    this.send({ type: 'release-asset', assetId });
  }

  requestPreview(scene: CompiledScene, maxEdgePx: number): PreviewHandle {
    if (this.disposed || this.failed) {
      return {
        jobId: 'disposed',
        revision: this.latestRevision,
        done: this.failed
          ? Promise.reject(this.failed)
          : Promise.resolve(null),
      };
    }
    if (this.activePreviewJobId) {
      this.cancel(this.activePreviewJobId);
    }
    this.nextJob += 1;
    this.latestRevision += 1;
    const jobId = `preview-${this.nextJob}`;
    const revision = this.latestRevision;
    let resolveFn!: (v: PreviewSurfaceResult[] | null) => void;
    let rejectFn!: (e: Error) => void;
    const done = new Promise<PreviewSurfaceResult[] | null>((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });
    this.pending.set(jobId, {
      kind: 'preview',
      revision,
      resolve: resolveFn,
      reject: rejectFn,
    });
    this.activePreviewJobId = jobId;
    const doSend = () => {
      if (this.disposed || !this.pending.has(jobId)) return;
      this.sentPreviews.add(jobId);
      this.send({ type: 'preview', jobId, revision, scene, maxEdgePx });
    };
    const pendingLoad = scene.artwork
      ? this.pendingLoads.get(scene.artwork.assetId)
      : undefined;
    if (pendingLoad) {
      pendingLoad.then(doSend, (e: unknown) => {
        const job = this.pending.get(jobId);
        if (job) {
          this.pending.delete(jobId);
          if (this.activePreviewJobId === jobId) this.activePreviewJobId = null;
          job.reject(e instanceof Error ? e : new Error('asset load failed'));
        }
      });
    } else {
      doSend();
    }
    return { jobId, revision, done };
  }

  cancel(jobId: string): void {
    const job = this.pending.get(jobId);
    const unsentPreview = job?.kind === 'preview' && !this.sentPreviews.has(jobId);
    this.sentPreviews.delete(jobId);
    if (job) {
      this.pending.delete(jobId);
      if (this.activePreviewJobId === jobId) this.activePreviewJobId = null;
      if (job.kind === 'preview') {
        job.resolve(null);
      } else {
        job.reject(new Error('canceled'));
      }
    }
    if (this.disposed || unsentPreview || job?.kind === 'load') return;
    this.send({ type: 'cancel', jobId });
  }

  dispose(): void {
    this.disposed = true;
    this.port.onmessage = null;
    if ('onerror' in this.port) this.port.onerror = null;
    if ('onmessageerror' in this.port) this.port.onmessageerror = null;
    this.port.terminate?.();
    const error = new Error('render client disposed');
    for (const [jobId, job] of this.pending) {
      if (job.kind === 'load') {
        job.reject(error);
      } else {
        job.resolve(null);
      }
      this.pending.delete(jobId);
    }
    this.pendingLoads.clear();
    this.sentPreviews.clear();
    this.activePreviewJobId = null;
  }
}
