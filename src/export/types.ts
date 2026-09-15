import type { PrintLayout } from '../core/print/tiling';
import type { PhotoRegistrationV1 } from '../core/photo/registration';
import type {
  CalibrationRecord,
  ExportSnapshot,
  SurfaceId,
} from '../core/types';

export type ExportKind =
  | 'kit'
  | 'volume'
  | 'proof'
  | 'calibration'
  | 'master-pdf'
  | 'master-svg';

/**
 * Structured-clone-safe reference-photo data carried by a frozen export
 * snapshot. The normalized PNG bytes travel separately only for kit exports.
 */
export interface FrozenPhotoSnapshot {
  readonly schemaVersion: 1;
  readonly asset: {
    readonly assetId: string;
    readonly contentHash: string;
    readonly widthPx: number;
    readonly heightPx: number;
    readonly displayFilename: string;
  };
  readonly registration: PhotoRegistrationV1;
}

export interface ProductionSnapshot extends ExportSnapshot {
  readonly revisionFingerprint: string;
  readonly fingerprints: {
    readonly physical: string;
    readonly layout: string;
    readonly export: string;
  };
  readonly layout: PrintLayout;
  readonly calibration: CalibrationRecord | null;
  readonly selectedTileIds: readonly string[];
  /** Omitted for photo-free snapshots to preserve the v1 shape. */
  readonly photo?: FrozenPhotoSnapshot | null | undefined;
  readonly volumeIndex?: number;
  readonly masterSurfaceId?: SurfaceId;
}

export interface ExportStart {
  readonly type: 'start-export';
  readonly jobId: string;
  readonly kind: ExportKind;
  readonly snapshot: ProductionSnapshot;
  readonly sourcePng: ArrayBuffer | null;
  /** Present only for kit exports when the snapshot carries a photo. */
  readonly photoPng?: ArrayBuffer | null | undefined;
  readonly fonts: readonly ArrayBuffer[];
}

export type ExportFileRole =
  | 'kit'
  | 'artwork-volume'
  | 'placement'
  | 'calibration'
  | 'assembly-guide'
  | 'manifest'
  | 'project-archive'
  | 'master-pdf'
  | 'master-svg'
  | 'proof';

export type ExportFileStatus =
  | 'included'
  | 'container'
  | 'not-requested'
  | 'over-budget'
  | 'failed';

export interface ExportFileEntry {
  readonly path: string;
  readonly role: ExportFileRole;
  readonly status: ExportFileStatus;
  readonly bytes?: number;
}

export interface ExportProgress {
  readonly phase: string;
  readonly completed: number;
  readonly total: number;
}

export function sanitizeBasename(title: string): string {
  const ascii = title
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return ascii || 'parallax';
}
