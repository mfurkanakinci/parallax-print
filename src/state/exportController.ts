import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  canonicalize,
  exportFingerprint,
  layoutFingerprint,
  physicalFingerprint,
  physicalFingerprintPayload,
  revisionFingerprint,
  type AckFingerprints,
} from '../core/fingerprints';
import type { PrintLayout } from '../core/print/tiling';
import type {
  CalibrationRecord,
  CompiledScene,
  ProjectV1,
  SurfaceId,
} from '../core/types';
import type { EditorDocument } from '../persistence/types';
import { downloadBlob } from '../persistence/download';
import type {
  ExportKind,
  FrozenPhotoSnapshot,
  ProductionSnapshot,
} from '../export/types';
import { parseWorkerReply } from '../workers/protocol';
import type { StoredAsset } from '../persistence/types';
import type { RenderJobController } from './jobController';
import ExportWorker from '../workers/export.worker?worker&inline';

export interface ExportJobState {
  readonly kind: ExportKind;
  readonly status: 'running' | 'done' | 'failed' | 'canceled';
  readonly phase: string;
  readonly completed: number;
  readonly total: number;
  readonly error: string | null;
  readonly revisionFingerprint: string;
  readonly fileName: string | null;
}

export function useFingerprints(
  project: ProjectV1 | null,
  scene: CompiledScene | null,
  asset: StoredAsset | null,
): AckFingerprints | null {
  const [cache, setCache] = useState<
    ({ key: string } & AckFingerprints) | null
  >(null);
  const inputKey = useMemo(() => {
    if (!project || !scene) return null;
    return `${canonicalize(
      physicalFingerprintPayload({
        engineVersion: scene.engineVersion,
        corner: project.corner,
        viewpoint: project.viewpoint,
        artwork: project.artwork,
        asset: asset
          ? {
              contentHash: asset.contentHash,
              widthPx: asset.widthPx,
              heightPx: asset.heightPx,
            }
          : null,
      }),
    )}|${canonicalize(project.print)}`;
  }, [project, scene, asset]);
  useEffect(() => {
    let live = true;
    if (!project || !scene || inputKey === null) {
      queueMicrotask(() => {
        if (live) setCache(null);
      });
      return () => {
        live = false;
      };
    }
    const key = inputKey;
    void (async () => {
      const physical = await physicalFingerprint({
        engineVersion: scene.engineVersion,
        corner: project.corner,
        viewpoint: project.viewpoint,
        artwork: project.artwork,
        asset: asset
          ? {
              contentHash: asset.contentHash,
              widthPx: asset.widthPx,
              heightPx: asset.heightPx,
            }
          : null,
      });
      const layoutHash = await layoutFingerprint(physical, project.print);
      if (live) setCache({ key, physical, layout: layoutHash });
    })().catch(() => {
      if (live) setCache(null);
    });
    return () => {
      live = false;
    };
  }, [inputKey, project, scene, asset]);
  if (!cache || cache.key !== inputKey) return null;
  return {
    physical: cache.physical,
    layout: cache.layout,
  };
}

export async function buildProductionSnapshot(input: {
  readonly document: EditorDocument;
  readonly scene: CompiledScene;
  readonly layout: PrintLayout;
  readonly selectedTileIds: readonly string[];
  readonly acknowledgements: readonly string[];
  readonly calibration: CalibrationRecord | null;
  readonly volumeIndex?: number;
  readonly masterSurfaceId?: SurfaceId;
}): Promise<ProductionSnapshot> {
  const { document, scene } = input;
  const assetMeta = document.asset
    ? {
        contentHash: document.asset.contentHash,
        widthPx: document.asset.widthPx,
        heightPx: document.asset.heightPx,
      }
    : null;
  const physical = await physicalFingerprint({
    engineVersion: scene.engineVersion,
    corner: document.project.corner,
    viewpoint: document.project.viewpoint,
    artwork: document.project.artwork,
    asset: assetMeta,
  });
  const layoutHash = await layoutFingerprint(physical, document.project.print);
  const exportHash = await exportFingerprint({
    layoutHash,
    title: document.project.title,
    selectedTileIds: input.selectedTileIds,
    acknowledgements: input.acknowledgements,
  });
  const revision = await revisionFingerprint(
    document.project,
    assetMeta,
    scene.engineVersion,
  );
  const photo = document.photo
    ? {
        schemaVersion: 1 as const,
        asset: {
          assetId: document.photo.asset.assetId,
          contentHash: document.photo.asset.contentHash,
          widthPx: document.photo.asset.widthPx,
          heightPx: document.photo.asset.heightPx,
          displayFilename: document.photo.asset.displayFilename,
        },
        // The worker receives a structured-cloned request, but keep the
        // builder itself frozen against callers mutating a live registration
        // object while the export snapshot is being prepared.
        registration: JSON.parse(
          JSON.stringify(document.photo.registration),
        ) as FrozenPhotoSnapshot['registration'],
      }
    : null;
  const snapshot: ProductionSnapshot = {
    project: document.project,
    asset: document.asset
      ? {
          assetId: document.asset.assetId,
          widthPx: document.asset.widthPx,
          heightPx: document.asset.heightPx,
          contentHash: document.asset.contentHash,
        }
      : null,
    scene,
    print: document.project.print,
    acknowledgements: input.acknowledgements,
    engineVersion: scene.engineVersion,
    revisionFingerprint: revision,
    fingerprints: { physical, layout: layoutHash, export: exportHash },
    layout: input.layout,
    calibration: input.calibration,
    selectedTileIds: input.selectedTileIds,
    ...(photo ? { photo } : {}),
  };
  if (input.volumeIndex !== undefined) {
    (snapshot as { volumeIndex?: number }).volumeIndex = input.volumeIndex;
  }
  if (input.masterSurfaceId !== undefined) {
    (snapshot as { masterSurfaceId?: SurfaceId }).masterSurfaceId =
      input.masterSurfaceId;
  }
  return snapshot;
}

interface ActiveJob {
  readonly worker: Worker;
  readonly kind: ExportKind;
  readonly revisionFingerprint: string;
  settle(
    status: ExportJobState['status'],
    error?: string | null,
    fileName?: string | null,
  ): void;
}

export type ExportStartInput =
  | {
      readonly kind: 'calibration';
      readonly project: ProjectV1;
      readonly fonts: readonly ArrayBuffer[];
      readonly onFile?: (blob: Blob, filename: string) => void;
    }
  | {
      readonly kind: Exclude<ExportKind, 'calibration'>;
      readonly snapshot: ProductionSnapshot;
      readonly sourcePng: ArrayBuffer | null;
      /** Present only for kit exports when the snapshot carries a photo. */
      readonly photoPng?: ArrayBuffer | null | undefined;
      readonly fonts: readonly ArrayBuffer[];
      readonly onFile?: (blob: Blob, filename: string) => void;
    };

export function useExportController(
  renderController: RenderJobController | null,
): {
  readonly job: ExportJobState | null;
  readonly start: (input: ExportStartInput) => string;
  readonly cancel: () => void;
  readonly readyFile: { blob: Blob; filename: string } | null;
  readonly downloadReady: () => void;
  readonly clearReady: () => void;
} {
  const [job, setJob] = useState<ExportJobState | null>(null);
  const [readyFile, setReadyFile] = useState<{
    blob: Blob;
    filename: string;
  } | null>(null);
  const readyRef = useRef<{ blob: Blob; filename: string } | null>(null);
  const activeRef = useRef<ActiveJob | null>(null);
  const counterRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      activeRef.current?.worker.terminate();
      activeRef.current = null;
    };
  }, []);

  const start = useCallback(
    (input: ExportStartInput): string => {
      if (!mountedRef.current) return '';
      if (activeRef.current) return '';
      const jobId = `export-${++counterRef.current}-${Date.now()}`;
      const revision =
        input.kind === 'calibration'
          ? ''
          : input.snapshot.revisionFingerprint;
      const fonts = input.fonts.map((b) => b.slice(0));
      if (fonts.some((b) => b.byteLength === 0)) {
        setJob({
          kind: input.kind,
          status: 'failed',
          phase: 'done',
          completed: 1,
          total: 1,
          error: 'Embedded fonts are empty — cannot export.',
          revisionFingerprint: revision,
          fileName: null,
        });
        return jobId;
      }
      setReadyFile(null);
      readyRef.current = null;
      renderController?.suspend();
      let worker: Worker;
      try {
        worker = new ExportWorker();
      } catch (e) {
        renderController?.resume();
        setJob({
          kind: input.kind,
          status: 'failed',
          phase: 'done',
          completed: 1,
          total: 1,
          error:
            e instanceof Error
              ? e.message
              : 'The export worker could not start.',
          revisionFingerprint: revision,
          fileName: null,
        });
        return jobId;
      }
      const settle: ActiveJob['settle'] = (
        status,
        error = null,
        fileName = null,
      ) => {
        if (activeRef.current?.worker === worker) activeRef.current = null;
        worker.terminate();
        renderController?.resume();
        if (!mountedRef.current) return;
        setJob({
          kind: input.kind,
          status,
          phase: 'done',
          completed: 1,
          total: 1,
          error,
          revisionFingerprint: revision,
          fileName,
        });
      };
      worker.onmessage = (event: MessageEvent) => {
        if (activeRef.current?.worker !== worker) return;
        const reply = parseWorkerReply(event.data);
        if (!reply) {
          settle('failed', 'The export worker sent a malformed reply.');
          return;
        }
        if (reply.jobId !== jobId) return;
        if (reply.type === 'progress') {
          if (mountedRef.current) {
            setJob({
              kind: input.kind,
              status: 'running',
              phase: reply.phase,
              completed: reply.completed,
              total: reply.total,
              error: null,
              revisionFingerprint: revision,
              fileName: null,
            });
          }
          return;
        }
        if (reply.type === 'file-ready') {
          const blob = new Blob([reply.bytes], { type: reply.mime });
          readyRef.current = { blob, filename: reply.filename };
          if (mountedRef.current) {
            setReadyFile({ blob, filename: reply.filename });
          }
          input.onFile?.(blob, reply.filename);
          settle('done', null, reply.filename);
          return;
        }
        if (reply.type === 'canceled') {
          settle('canceled');
          return;
        }
        if (reply.type === 'failed') {
          settle('failed', reply.message);
        }
      };
      worker.onerror = () => {
        if (activeRef.current?.worker !== worker) return;
        settle('failed', 'The export worker stopped unexpectedly.');
      };
      worker.onmessageerror = () => {
        if (activeRef.current?.worker !== worker) return;
        settle('failed', 'The export worker sent an unreadable message.');
      };
      activeRef.current = {
        worker,
        kind: input.kind,
        revisionFingerprint: revision,
        settle,
      };
      if (mountedRef.current) {
        setJob({
          kind: input.kind,
          status: 'running',
          phase: 'starting',
          completed: 0,
          total: 1,
          error: null,
          revisionFingerprint: revision,
          fileName: null,
        });
      }
      const sourcePng =
        input.kind === 'calibration' ? null : input.sourcePng;
      const photoPng =
        input.kind === 'kit' ? input.photoPng : undefined;
      try {
        if (input.kind === 'calibration') {
          worker.postMessage(
            {
              type: 'start-calibration',
              jobId,
              project: input.project,
              fonts,
            },
            [...fonts] as Transferable[],
          );
        } else {
          worker.postMessage(
            {
              type: 'start-export',
              jobId,
              kind: input.kind,
              snapshot: input.snapshot,
              sourcePng,
              ...(photoPng !== undefined ? { photoPng } : {}),
              fonts,
            },
            [
              ...(sourcePng ? [sourcePng] : []),
              ...(photoPng ? [photoPng] : []),
              ...fonts,
            ] as Transferable[],
          );
        }
      } catch (e) {
        settle(
          'failed',
          e instanceof Error ? e.message : 'Could not start the export job.',
        );
      }
      return jobId;
    },
    [renderController],
  );

  const cancel = useCallback(() => {
    const active = activeRef.current;
    if (!active) return;
    active.worker.terminate();
    activeRef.current = null;
    setJob((prev) =>
      prev ? { ...prev, status: 'canceled', phase: 'canceled' } : prev,
    );
    setReadyFile(null);
    readyRef.current = null;
    renderController?.resume();
  }, [renderController]);

  const downloadReady = useCallback(() => {
    const current = readyRef.current;
    if (current) downloadBlob(current.blob, current.filename);
  }, []);

  const clearReady = useCallback(() => {
    readyRef.current = null;
    setReadyFile(null);
  }, []);

  return { job, start, cancel, readyFile, downloadReady, clearReady };
}
