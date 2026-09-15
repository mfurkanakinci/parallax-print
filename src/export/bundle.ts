import { zipSync } from 'fflate';
import { LIMITS } from '../core/limits';
import type { Issue } from '../core/types';
import type {
  ExportFileEntry,
  ExportFileRole,
  ProductionSnapshot,
} from './types';

export interface KitFile {
  readonly path: string;
  readonly role: ExportFileRole;
  readonly bytes: Uint8Array;
}

export interface ProductionManifest {
  readonly schemaVersion: 1;
  readonly status: 'digital-alpha';
  readonly physicalVerification: 'unverified';
  readonly engineVersion: string;
  readonly projectId: string;
  readonly title: string;
  readonly createdAt: string;
  readonly units: 'mm';
  readonly revisionFingerprint: string;
  readonly fingerprints: ProductionSnapshot['fingerprints'];
  readonly source: {
    readonly contentHash: string;
    readonly widthPx: number;
    readonly heightPx: number;
  } | null;
  readonly surfaces: readonly {
    readonly id: string;
    readonly boundsMm: unknown;
    readonly polygonMm: unknown;
    readonly frontNormal: unknown;
    readonly originMm: unknown;
    readonly axisU: unknown;
    readonly axisV: unknown;
    readonly datums: unknown;
  }[];
  readonly registrationRule: string;
  readonly container?: string;
  readonly viewpoint: unknown;
  readonly print: unknown;
  readonly paperMm: unknown;
  readonly gutterMm: number;
  readonly selectedTiles: readonly {
    readonly id: string;
    readonly surfaceId: string;
    readonly row: number;
    readonly column: number;
    readonly regionMm: unknown;
    readonly overlapNeighbors: readonly string[];
    readonly volume: number;
    readonly pageInVolume: number;
  }[];
  readonly files: readonly ExportFileEntry[];
  readonly warnings: readonly Issue[];
  readonly acknowledgements: readonly string[];
  readonly calibration: unknown;
}

export function buildManifest(input: {
  readonly snapshot: ProductionSnapshot;
  readonly files: readonly ExportFileEntry[];
  readonly warnings: readonly Issue[];
  readonly tilePages: ReadonlyMap<string, { volume: number; page: number }>;
  readonly container?: string;
}): ProductionManifest {
  const { snapshot } = input;
  const selectedTiles = snapshot.layout.tiles
    .filter((t) => snapshot.selectedTileIds.includes(t.id))
    .map((t) => {
      const placement = input.tilePages.get(t.id);
      if (!placement) {
        throw new RangeError(`Tile ${t.id} has no volume/page placement.`);
      }
      return {
        id: t.id,
        surfaceId: t.surfaceId,
        row: t.row,
        column: t.column,
        regionMm: t.regionMm,
        overlapNeighbors: t.overlapNeighbors,
        volume: placement.volume,
        pageInVolume: placement.page,
      };
    });
  return {
    schemaVersion: 1,
    status: 'digital-alpha',
    physicalVerification: 'unverified',
    engineVersion: snapshot.engineVersion,
    projectId: snapshot.project.id,
    title: snapshot.project.title,
    createdAt: new Date().toISOString(),
    units: 'mm',
    revisionFingerprint: snapshot.revisionFingerprint,
    fingerprints: snapshot.fingerprints,
    source: snapshot.asset
      ? {
          contentHash: snapshot.asset.contentHash ?? snapshot.asset.assetId,
          widthPx: snapshot.asset.widthPx,
          heightPx: snapshot.asset.heightPx,
        }
      : null,
    surfaces: snapshot.scene.surfaces.map((s) => ({
      id: s.surface.id,
      boundsMm: s.surface.boundsMm,
      polygonMm: s.surface.polygonMm,
      frontNormal: s.surface.frontNormal,
      originMm: s.surface.originMm,
      axisU: s.surface.axisU,
      axisV: s.surface.axisV,
      datums: s.surface.datums,
    })),
    registrationRule:
      'Retain the printed registration tabs until each neighbour match is verified, then trim them; the next tile overlaps the previous tile’s right or bottom band.',
    ...(input.container ? { container: input.container } : {}),
    viewpoint: snapshot.project.viewpoint,
    print: snapshot.project.print,
    paperMm: snapshot.layout.paperMm,
    gutterMm: LIMITS.guideGutterMm,
    selectedTiles,
    files: input.files,
    warnings: input.warnings,
    acknowledgements: snapshot.acknowledgements,
    calibration: snapshot.calibration,
  };
}

export const GUIDE_ALLOWANCE_BYTES = 4 * 1024 * 1024;

export function estimateKitBytes(input: {
  readonly artworkPixels: number;
  readonly tileCount: number;
  readonly sourceBytes: number;
  /** Reference-photo bytes are included in the generated project archive. */
  readonly photoBytes?: number | undefined;
}): number {
  return (
    input.artworkPixels * LIMITS.exportBytesPerPixelEstimate +
    input.tileCount * 65_536 +
    GUIDE_ALLOWANCE_BYTES +
    input.sourceBytes +
    (input.photoBytes ?? 0)
  );
}

export function buildKitZip(files: readonly KitFile[]): Uint8Array {
  const total = files.reduce((sum, f) => sum + f.bytes.length, 0);
  if (total > LIMITS.bundleMaxBytes) {
    throw new RangeError('Kit exceeds the 96 MiB bundle limit.');
  }
  const entries: Record<string, [Uint8Array, { level: 0 }]> = {};
  for (const file of files) {
    entries[file.path] = [file.bytes, { level: 0 }];
  }
  const zipped = zipSync(entries, { level: 0 });
  if (zipped.length > LIMITS.bundleMaxBytes) {
    throw new RangeError('Kit archive exceeds the 96 MiB bundle limit.');
  }
  return zipped;
}
