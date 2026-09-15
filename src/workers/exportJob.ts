import { sha256Hex } from '../assets/contentHash';
import { parseImageHeader } from '../assets/imageHeaders';
import { LIMITS } from '../core/limits';
import { parsePhotoRegistration } from '../core/photo/registration';
import {
  exportFingerprint,
  layoutFingerprint,
  physicalFingerprint,
  revisionFingerprint,
} from '../core/fingerprints';
import { compileProject } from '../core/geometry/compileProject';
import {
  paperDimensions,
  planTiles,
  splitVolumes,
  tileRasterRegion,
  volumeMemoryEstimate,
} from '../core/print/tiling';
import { runPreflight } from '../core/preflight/preflight';
import { buildKitZip, buildManifest, estimateKitBytes, type KitFile } from '../export/bundle';
import {
  buildArtworkVolumePdf,
  buildAssemblyGuidePdf,
  buildCalibrationPdf,
  buildMasterPdf,
  buildPlacementRecipePdf,
  CanceledError,
} from '../export/pdf';
import { buildMasterSvg } from '../export/svg';
import { diagnosticPyramid } from '../export/proof';
import {
  sanitizeBasename,
  type ExportKind,
  type ProductionSnapshot,
} from '../export/types';
import { exportProjectArchive } from '../persistence/projectArchive';
import type { EditorDocument, StoredAsset, StoredPhoto } from '../persistence/types';
import type { CompiledScene, SourcePyramid, TilePlan } from '../core/types';
import type { WorkerReply, WorkerRequest } from './protocol';

export interface ExportJobDeps {
  readonly post: (reply: WorkerReply) => void;
  readonly decodePng: (bytes: ArrayBuffer) => Promise<SourcePyramid>;
  readonly yieldControl?: () => Promise<void>;
}

const ACK_GATED_KINDS = new Set(['kit', 'volume', 'master-pdf', 'master-svg']);

/**
 * Validate the serializable photo metadata and, for a kit, bind the separate
 * PNG payload to that metadata. Reference-photo bytes are intentionally not
 * accepted for volume/master/proof requests because those outputs do not
 * embed the photo archive.
 */
async function validateFrozenPhoto(
  snapshot: ProductionSnapshot,
  kind: ExportKind,
  photoPng: ArrayBuffer | null | undefined,
): Promise<Uint8Array | null> {
  const photo = snapshot.photo ?? null;
  const hasPhotoBytes = photoPng !== null && photoPng !== undefined;
  if (kind === 'kit') {
    if (photo && !hasPhotoBytes) {
      throw new RangeError(
        'A kit with a reference photo must carry its frozen photo bytes.',
      );
    }
    if (!photo && hasPhotoBytes) {
      throw new RangeError(
        'Reference photo bytes require frozen photo metadata.',
      );
    }
  } else if (hasPhotoBytes) {
    throw new RangeError(
      'Reference photo bytes are only accepted for kit exports.',
    );
  }

  if (!photo) return null;
  if (
    photo.schemaVersion !== 1 ||
    !/^[0-9a-f]{64}$/.test(photo.asset.assetId) ||
    photo.asset.assetId !== photo.asset.contentHash ||
    !/^[0-9a-f]{64}$/.test(photo.asset.contentHash) ||
    !Number.isSafeInteger(photo.asset.widthPx) ||
    !Number.isSafeInteger(photo.asset.heightPx) ||
    photo.asset.widthPx < 1 ||
    photo.asset.heightPx < 1 ||
    photo.asset.widthPx > LIMITS.photo.maxSidePx ||
    photo.asset.heightPx > LIMITS.photo.maxSidePx ||
    photo.asset.widthPx * photo.asset.heightPx > LIMITS.photo.maxPixels ||
    typeof photo.asset.displayFilename !== 'string' ||
    photo.asset.displayFilename.length === 0
  ) {
    throw new RangeError('Frozen reference photo metadata is invalid or over budget.');
  }

  const registration = parsePhotoRegistration(photo.registration);
  if (
    registration.image.contentHash !== photo.asset.contentHash ||
    registration.image.widthPx !== photo.asset.widthPx ||
    registration.image.heightPx !== photo.asset.heightPx
  ) {
    throw new RangeError(
      'Frozen reference photo metadata does not match its registration.',
    );
  }

  // Metadata is carried on every production snapshot for reproducibility, but
  // only a kit needs the bytes to rebuild the editable project archive.
  if (kind !== 'kit') return null;
  if (photoPng === null || photoPng === undefined) {
    throw new RangeError('Frozen reference photo bytes are missing.');
  }
  const bytes = new Uint8Array(photoPng);
  if (bytes.byteLength === 0 || bytes.byteLength > LIMITS.photo.maxNormalizedBytes) {
    throw new RangeError('Frozen reference photo exceeds its normalized byte budget.');
  }
  const header = parseImageHeader(bytes, {
    maxCompressedBytes: LIMITS.photo.maxNormalizedBytes,
  });
  if (
    header.format !== 'png' ||
    header.bitDepth !== 8 ||
    header.orientation !== 1 ||
    header.widthPx !== photo.asset.widthPx ||
    header.heightPx !== photo.asset.heightPx
  ) {
    throw new RangeError(
      'Frozen reference photo PNG does not match its metadata.',
    );
  }
  if ((await sha256Hex(bytes)) !== photo.asset.contentHash) {
    throw new RangeError('Frozen reference photo hash does not match its metadata.');
  }
  return bytes;
}

export function createExportJobHandler(
  deps: ExportJobDeps,
): (request: WorkerRequest) => Promise<void> {
  const canceledJobs = new Set<string>();
  const yieldControl =
    deps.yieldControl ?? (() => new Promise<void>((r) => setTimeout(r, 0)));

  const cancellation = (jobId: string) => ({
    isCanceled: () => canceledJobs.has(jobId),
  });

  const progress = (
    jobId: string,
    phase: string,
    completed: number,
    total: number,
  ) => deps.post({ type: 'progress', jobId, phase, completed, total });

  const ready = (
    jobId: string,
    filename: string,
    mime: string,
    bytes: Uint8Array,
  ) => {
    if (canceledJobs.has(jobId)) throw new CanceledError();
    if (bytes.byteLength > LIMITS.bundleMaxBytes) {
      throw new RangeError('The generated file exceeds the 96 MiB limit.');
    }
    const buffer =
      bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
        ? (bytes.buffer as ArrayBuffer)
        : (bytes.slice().buffer as ArrayBuffer);
    deps.post({ type: 'file-ready', jobId, filename, mime, bytes: buffer });
  };

  const fail = (jobId: string, e: unknown) => {
    canceledJobs.delete(jobId);
    if (e instanceof CanceledError) {
      deps.post({ type: 'canceled', jobId });
      return;
    }
    deps.post({
      type: 'failed',
      jobId,
      code: 'export-error',
      message: e instanceof Error ? e.message : 'export failed',
    });
  };

  return async (request: WorkerRequest): Promise<void> => {
    if (request.type === 'cancel') {
      canceledJobs.add(request.jobId);
      return;
    }

    if (request.type === 'start-calibration') {
      const jobId = request.jobId;
      try {
        const project = request.project;
        const paperMm = paperDimensions(project.print);
        const margins = Object.values(project.print.marginMm);
        if (
          margins.length !== 4 ||
          margins.some(
            (v) =>
              !Number.isFinite(v) ||
              v < LIMITS.marginMm.min ||
              v > LIMITS.marginMm.max,
          )
        ) {
          throw new RangeError('Margins must be finite values of 5–30 mm.');
        }
        const bytes = await buildCalibrationPdf({
          fonts: request.fonts,
          project,
          paperMm,
        });
        ready(
          jobId,
          `${sanitizeBasename(project.title)}-calibration.pdf`,
          'application/pdf',
          bytes,
        );
      } catch (e) {
        fail(jobId, e);
        return;
      }
      canceledJobs.delete(jobId);
      return;
    }

    if (request.type !== 'start-export') return;
    const jobId = request.jobId;
    const { snapshot } = request;
    const base = sanitizeBasename(snapshot.project.title);
    try {
      const frozenPhotoPng = await validateFrozenPhoto(
        snapshot,
        request.kind,
        request.photoPng,
      );
      const compiled = compileProject(snapshot.project, snapshot.asset);
      const scene = compiled.scene;
      if (!scene && request.kind !== 'calibration') {
        throw new RangeError(
          `The frozen project cannot be compiled: ${compiled.issues
            .filter((i) => i.severity === 'blocker')
            .map((i) => i.message)
            .join('; ') || 'unknown blocker'}`,
        );
      }
      const layout = scene
        ? planTiles(scene, snapshot.project.print)
        : null;

      const assetMeta = snapshot.asset
        ? {
            contentHash: snapshot.asset.contentHash ?? snapshot.asset.assetId,
            widthPx: snapshot.asset.widthPx,
            heightPx: snapshot.asset.heightPx,
          }
        : null;
      const physical = await physicalFingerprint({
        engineVersion: snapshot.engineVersion,
        corner: snapshot.project.corner,
        viewpoint: snapshot.project.viewpoint,
        artwork: snapshot.project.artwork,
        asset: assetMeta,
      });
      const layoutHash = await layoutFingerprint(
        physical,
        snapshot.project.print,
      );
      const exportHash = await exportFingerprint({
        layoutHash,
        title: snapshot.project.title,
        selectedTileIds: snapshot.selectedTileIds,
        acknowledgements: snapshot.acknowledgements,
      });
      const revision = await revisionFingerprint(
        snapshot.project,
        assetMeta,
        snapshot.engineVersion,
      );
      if (
        physical !== snapshot.fingerprints.physical ||
        layoutHash !== snapshot.fingerprints.layout ||
        exportHash !== snapshot.fingerprints.export ||
        revision !== snapshot.revisionFingerprint
      ) {
        throw new RangeError(
          'The frozen snapshot fingerprints do not match its content — the export was tampered with or is stale.',
        );
      }

      const canonicalSnapshot = {
        ...snapshot,
        ...(scene ? { scene } : {}),
        ...(layout ? { layout } : {}),
        fingerprints: { physical, layout: layoutHash, export: exportHash },
      };

      const tileIndex = new Map(
        (layout?.tiles ?? []).map((t) => [t.id, t] as const),
      );
      const selected = snapshot.selectedTileIds.map((id) => {
        const tile = tileIndex.get(id);
        if (!tile) {
          throw new RangeError(`Selected tile "${id}" is not in the plan.`);
        }
        return tile;
      });
      if (
        request.kind !== 'calibration' &&
        request.kind !== 'master-pdf' &&
        request.kind !== 'master-svg' &&
        selected.length === 0
      ) {
        throw new RangeError('The export selection contains no tiles.');
      }
      if (selected.length > LIMITS.exportMaxPages) {
        throw new RangeError(
          `The selected job exceeds the ${LIMITS.exportMaxPages} page budget — select fewer pages.`,
        );
      }

      const needsArtwork =
        request.kind === 'volume' ||
        request.kind === 'master-pdf' ||
        request.kind === 'master-svg' ||
        request.kind === 'kit';
      let pyramid: SourcePyramid | null = null;
      if (needsArtwork) {
        if (!snapshot.project.artwork || !snapshot.asset) {
          throw new RangeError('This export requires artwork.');
        }
        if (!request.sourcePng) {
          throw new RangeError(
            'The artwork asset is missing; only geometry documents can be produced.',
          );
        }
        const header = parseImageHeader(new Uint8Array(request.sourcePng), {
          maxCompressedBytes: LIMITS.source.maxNormalizedBytes,
        });
        if (
          header.format !== 'png' ||
          header.bitDepth !== 8 ||
          header.orientation !== 1
        ) {
          throw new RangeError(
            'The artwork asset is not a normalized 8-bit PNG.',
          );
        }
        const sourceHash = await sha256Hex(request.sourcePng);
        if (sourceHash !== assetMeta?.contentHash) {
          throw new RangeError(
            'The artwork bytes do not match the frozen content hash.',
          );
        }
        if (
          header.widthPx !== snapshot.asset.widthPx ||
          header.heightPx !== snapshot.asset.heightPx
        ) {
          throw new RangeError(
            'The artwork dimensions do not match the frozen snapshot.',
          );
        }
        if (request.kind === 'kit') {
          const volumes = splitVolumes(
            selected,
            scene!,
            snapshot.project.print.dpi,
          );
          let selectedPixels = 0;
          for (const volume of volumes) {
            selectedPixels += volume.pixelCount;
            const estimate = volumeMemoryEstimate(
              request.sourcePng.byteLength + (frozenPhotoPng?.byteLength ?? 0),
              snapshot.asset.widthPx * snapshot.asset.heightPx,
              volume.pixelCount,
            );
            if (estimate > LIMITS.bulkBufferTargetBytes) {
              throw new RangeError(
                `Volume ${volume.index + 1} exceeds the memory budget — select a narrower range or a lower DPI.`,
              );
            }
          }
          const kitEstimate = estimateKitBytes({
            artworkPixels: selectedPixels,
            tileCount: selected.length,
            sourceBytes: request.sourcePng.byteLength + 256 * 1024,
            photoBytes: frozenPhotoPng?.byteLength ?? 0,
          });
          if (kitEstimate > LIMITS.bundleMaxBytes) {
            throw new RangeError(
              'The selected kit is estimated to exceed 96 MiB — download volumes separately.',
            );
          }
        } else if (
          request.kind === 'master-pdf' ||
          request.kind === 'master-svg'
        ) {
          const masterSurface = scene!.surfaces.find(
            (s) => s.surface.id === snapshot.masterSurfaceId,
          )?.surface;
          if (!masterSurface) {
            throw new RangeError('Master surface is not available.');
          }
          const region = tileRasterRegion(
            masterSurface,
            masterSurface.boundsMm,
            snapshot.project.print.dpi,
          );
          const masterPixels = region.width * region.height;
          if (masterPixels > LIMITS.masterMaxPixels) {
            throw new RangeError(
              'Master exceeds the 24 MP budget — export the tiled volumes instead.',
            );
          }
          const estimate = volumeMemoryEstimate(
            request.sourcePng.byteLength,
            snapshot.asset.widthPx * snapshot.asset.heightPx,
            masterPixels,
          );
          if (estimate > LIMITS.bulkBufferTargetBytes) {
            throw new RangeError(
              'Estimated master memory exceeds the device budget — use the tiled volumes instead.',
            );
          }
        } else {
          const volumePixels = selected.reduce(
            (sum, tile) =>
              sum +
              volumeRasterPixels(scene!, tile, snapshot.project.print.dpi),
            0,
          );
          const estimate = volumeMemoryEstimate(
            request.sourcePng.byteLength,
            snapshot.asset.widthPx * snapshot.asset.heightPx,
            volumePixels,
          );
          if (estimate > LIMITS.bulkBufferTargetBytes) {
            throw new RangeError(
              'Estimated export memory exceeds the device budget — select fewer pages or a lower DPI.',
            );
          }
        }
        pyramid = await deps.decodePng(request.sourcePng);
        if (
          pyramid.widthPx !== snapshot.asset.widthPx ||
          pyramid.heightPx !== snapshot.asset.heightPx
        ) {
          throw new RangeError(
            'Decoded artwork dimensions do not match the frozen snapshot.',
          );
        }
      }

      if (ACK_GATED_KINDS.has(request.kind) && scene && layout) {
        const preflight = runPreflight({
          project: snapshot.project,
          scene,
          compileIssues: compiled.issues,
          layout,
          hasAsset: !!pyramid,
          calibration: snapshot.calibration,
          physicalHash: physical,
          layoutHash,
        });
        const acked = new Set(snapshot.acknowledgements);
        const missing = preflight.warnings
          .map((w) => w.ackId)
          .filter((id): id is string => !!id && !acked.has(id));
        if (missing.length > 0) {
          throw new RangeError(
            `Unacknowledged warnings: ${missing.join(', ')}.`,
          );
        }
      }

      const depsRender = {
        cancellation: cancellation(jobId),
        yieldControl,
      };
      const fonts = request.fonts;
      let filename = '';
      let mime = 'application/pdf';
      let bytes: Uint8Array;

      if (request.kind === 'calibration') {
        bytes = await buildCalibrationPdf({
          fonts,
          project: snapshot.project,
          paperMm: layout?.paperMm ?? paperDimensions(snapshot.project.print),
          physicalHash: physical,
        });
        filename = `${base}-calibration.pdf`;
      } else if (request.kind === 'proof') {
        const proofPyramid = diagnosticPyramid(
          snapshot.asset
            ? snapshot.asset.widthPx / snapshot.asset.heightPx
            : 1.5,
        );
        const proofScene = scene!.artwork
          ? {
              ...scene!,
              artwork: {
                ...scene!.artwork,
                sourceWidthPx: proofPyramid.widthPx,
                sourceHeightPx: proofPyramid.heightPx,
              },
            }
          : scene!;
        bytes = await buildArtworkVolumePdf({
          fonts,
          project: {
            ...snapshot.project,
            title: `${snapshot.project.title} — geometry proof`,
          },
          revisionFingerprint: snapshot.revisionFingerprint,
          scene: proofScene,
          layout: layout!,
          tiles: selected,
          pyramid: proofPyramid,
          volumeIndex: snapshot.volumeIndex ?? 0,
          deps: depsRender,
          onPage: (d, t) => progress(jobId, 'proof', d, t),
        });
        filename = `${base}-proof.pdf`;
      } else if (request.kind === 'volume') {
        if (!pyramid) throw new RangeError('Artwork asset required.');
        bytes = await buildArtworkVolumePdf({
          fonts,
          project: snapshot.project,
          revisionFingerprint: snapshot.revisionFingerprint,
          scene: scene!,
          layout: layout!,
          tiles: selected,
          pyramid,
          volumeIndex: snapshot.volumeIndex ?? 0,
          deps: depsRender,
          onPage: (d, t) => progress(jobId, 'warp-pages', d, t),
        });
        filename = `${base}-artwork-v${String((snapshot.volumeIndex ?? 0) + 1).padStart(2, '0')}.pdf`;
      } else if (request.kind === 'master-pdf' || request.kind === 'master-svg') {
        if (!pyramid) throw new RangeError('Artwork asset required.');
        const surface = scene!.surfaces.find(
          (s) => s.surface.id === snapshot.masterSurfaceId,
        );
        if (!surface) throw new RangeError('Master surface is not available.');
        if (request.kind === 'master-pdf') {
          bytes = await buildMasterPdf({
            fonts,
            project: snapshot.project,
            scene: scene!,
            surface,
            dpi: snapshot.project.print.dpi,
            pyramid,
            deps: depsRender,
          });
          filename = `${base}-master-${surface.surface.id}.pdf`;
        } else {
          const svg = await buildMasterSvg({
            title: snapshot.project.title,
            scene: scene!,
            surface,
            dpi: snapshot.project.print.dpi,
            pyramid,
            deps: depsRender,
          });
          bytes = new TextEncoder().encode(svg);
          filename = `${base}-master-${surface.surface.id}.svg`;
          mime = 'image/svg+xml';
        }
      } else {
        const files: KitFile[] = [];
        const tilePages = new Map<string, { volume: number; page: number }>();
        const volumes = splitVolumes(
          selected,
          scene!,
          snapshot.project.print.dpi,
        );
        let totalBytes = 0;
        const pushFile = (
          path: string,
          role: KitFile['role'],
          data: Uint8Array,
        ) => {
          totalBytes += data.length;
          if (totalBytes > LIMITS.bundleMaxBytes) {
            throw new RangeError(
              'Kit exceeds the 96 MiB bundle limit — download volumes separately.',
            );
          }
          files.push({ path, role, bytes: data });
        };

        if (!pyramid) throw new RangeError('Artwork asset required for a kit.');
        for (const volume of volumes) {
          if (cancellation(jobId).isCanceled()) throw new CanceledError();
          const volumeTiles = selected.filter((t) =>
            volume.tileIds.includes(t.id),
          );
          volumeTiles.forEach((t, i) =>
            tilePages.set(t.id, { volume: volume.index, page: i }),
          );
          const pdf = await buildArtworkVolumePdf({
            fonts,
            project: snapshot.project,
            revisionFingerprint: snapshot.revisionFingerprint,
            scene: scene!,
            layout: layout!,
            tiles: volumeTiles,
            pyramid,
            volumeIndex: volume.index,
            deps: depsRender,
            onPage: (d, t) =>
              progress(
                jobId,
                `volume ${volume.index + 1}/${volumes.length}`,
                d,
                t,
              ),
          });
          pushFile(
            `${base}-artwork-v${String(volume.index + 1).padStart(2, '0')}.pdf`,
            'artwork-volume',
            pdf,
          );
        }

        progress(jobId, 'documents', 0, 4);
        pushFile(
          `${base}-placement-recipe.pdf`,
          'placement',
          await buildPlacementRecipePdf({
            fonts,
            project: snapshot.project,
            revisionFingerprint: snapshot.revisionFingerprint,
            scene: scene!,
            layout: layout!,
            tiles: selected,
            physicalHash: physical,
            layoutHash,
          }),
        );
        progress(jobId, 'documents', 1, 4);
        pushFile(
          `${base}-calibration.pdf`,
          'calibration',
          await buildCalibrationPdf({
            fonts,
            project: snapshot.project,
            paperMm: layout!.paperMm,
            physicalHash: physical,
          }),
        );
        pushFile(
          `${base}-assembly-guide.pdf`,
          'assembly-guide',
          await buildAssemblyGuidePdf({
            fonts,
            project: snapshot.project,
            revisionFingerprint: snapshot.revisionFingerprint,
            physicalHash: physical,
            layoutHash,
            exportHash,
            scene: scene!,
            layout: layout!,
            selectedTiles: selected,
          }),
        );
        progress(jobId, 'documents', 2, 4);

        let archiveDoc: EditorDocument = {
          project: snapshot.project,
          asset: null,
        };
        if (snapshot.asset && request.sourcePng) {
          const asset: StoredAsset = {
            assetId: snapshot.asset.assetId,
            contentHash: snapshot.asset.contentHash ?? snapshot.asset.assetId,
            widthPx: snapshot.asset.widthPx,
            heightPx: snapshot.asset.heightPx,
            displayFilename: 'source.png',
            normalizedPng: new Blob([request.sourcePng], {
              type: 'image/png',
            }),
          };
          archiveDoc = { project: snapshot.project, asset };
        } else if (snapshot.project.artwork) {
          archiveDoc = {
            project: { ...snapshot.project, artwork: null },
            asset: null,
          };
        }
        if (snapshot.photo) {
          if (!frozenPhotoPng) {
            throw new RangeError(
              'Frozen reference photo bytes are missing from the kit archive.',
            );
          }
          const photoAsset: StoredAsset = {
            assetId: snapshot.photo.asset.assetId,
            contentHash: snapshot.photo.asset.contentHash,
            widthPx: snapshot.photo.asset.widthPx,
            heightPx: snapshot.photo.asset.heightPx,
            displayFilename: snapshot.photo.asset.displayFilename,
            normalizedPng: new Blob(
              [
                frozenPhotoPng.buffer.slice(
                  frozenPhotoPng.byteOffset,
                  frozenPhotoPng.byteOffset + frozenPhotoPng.byteLength,
                ) as ArrayBuffer,
              ],
              { type: 'image/png' },
            ),
          };
          const photo: StoredPhoto = {
            schemaVersion: 1,
            asset: photoAsset,
            registration: snapshot.photo.registration,
          };
          archiveDoc = { ...archiveDoc, photo };
        }
        const archiveBlob = await exportProjectArchive(
          archiveDoc,
          async (bytes, format) => {
            if (format !== 'png') {
              throw new RangeError('Reference archive assets must be PNG data.');
            }
            const decoded = await deps.decodePng(
              bytes.buffer.slice(
                bytes.byteOffset,
                bytes.byteOffset + bytes.byteLength,
              ) as ArrayBuffer,
            );
            const level = decoded.levels[0];
            if (!level) throw new RangeError('Decoded archive image is empty.');
            return {
              widthPx: decoded.widthPx,
              heightPx: decoded.heightPx,
              data: level.pixels,
            };
          },
        );
        pushFile(
          `${base}.parallax`,
          'project-archive',
          new Uint8Array(await archiveBlob.arrayBuffer()),
        );
        progress(jobId, 'documents', 3, 4);

        const preflight = runPreflight({
          project: snapshot.project,
          scene: scene!,
          compileIssues: compiled.issues,
          layout: layout!,
          hasAsset: !!pyramid,
          calibration: snapshot.calibration,
          physicalHash: physical,
          layoutHash,
        });
        const fileEntries = [
          ...files.map((f) => ({
            path: f.path,
            role: f.role,
            status: 'included' as const,
            bytes: f.bytes.length,
          })),
          {
            path: `${base}-manifest.json`,
            role: 'manifest' as const,
            status: 'included' as const,
          },
          {
            path: `${base}-master.pdf`,
            role: 'master-pdf' as const,
            status: 'not-requested' as const,
          },
          {
            path: `${base}-master.svg`,
            role: 'master-svg' as const,
            status: 'not-requested' as const,
          },
          {
            path: `${base}-kit.zip`,
            role: 'kit' as const,
            status: 'container' as const,
          },
        ];
        const manifest = buildManifest({
          snapshot: canonicalSnapshot,
          files: fileEntries,
          warnings: preflight.warnings,
          tilePages,
          container: `${base}-kit.zip`,
        });
        pushFile(
          `${base}-manifest.json`,
          'manifest',
          new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
        );
        progress(jobId, 'package', 4, 4);
        bytes = buildKitZip(files);
        filename = `${base}-kit.zip`;
        mime = 'application/zip';
      }
      ready(jobId, filename, mime, bytes);
      canceledJobs.delete(jobId);
    } catch (e) {
      fail(jobId, e);
    }
  };
}

function volumeRasterPixels(
  scene: CompiledScene,
  tile: TilePlan,
  dpi: 150 | 300,
): number {
  const surface = scene.surfaces.find(
    (s) => s.surface.id === tile.surfaceId,
  )?.surface;
  if (!surface) throw new RangeError('Tile refers to a missing surface.');
  const region = tileRasterRegion(surface, tile.regionMm, dpi);
  return region.width * region.height;
}
