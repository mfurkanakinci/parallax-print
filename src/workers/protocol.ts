import { z } from 'zod';
import { LIMITS } from '../core/limits';
import { parsePhotoRegistration } from '../core/photo/registration';
import {
  mat3Schema,
  projectV1Schema,
  surfaceIdSchema,
  vec2Schema,
  vec3Schema,
} from '../core/schema';
import type {
  CompiledScene,
  ExportSnapshot,
  PreviewSurfaceResult,
  ProjectV1,
  VolumePlan,
} from '../core/types';
import type { ExportKind, ProductionSnapshot } from '../export/types';

export type WorkerRequest =
  | { type: 'load-asset'; jobId: string; assetId: string; pngBytes: ArrayBuffer }
  | {
      type: 'preview';
      jobId: string;
      revision: number;
      scene: CompiledScene;
      maxEdgePx: number;
    }
  | { type: 'export-volume'; jobId: string; snapshot: ExportSnapshot; volume: VolumePlan }
  | {
      type: 'start-export';
      jobId: string;
      kind: ExportKind;
      snapshot: ProductionSnapshot;
      sourcePng: ArrayBuffer | null;
      /** Only a kit with frozen photo metadata may carry reference-photo bytes. */
      photoPng?: ArrayBuffer | null | undefined;
      fonts: ArrayBuffer[];
    }
  | {
      type: 'start-calibration';
      jobId: string;
      project: ProjectV1;
      fonts: ArrayBuffer[];
    }
  | { type: 'cancel'; jobId: string }
  | { type: 'release-asset'; assetId: string };

export type WorkerReply =
  | { type: 'progress'; jobId: string; phase: string; completed: number; total: number }
  | { type: 'asset-ready'; jobId: string; assetId: string; widthPx: number; heightPx: number }
  | { type: 'preview-ready'; jobId: string; revision: number; surfaces: PreviewSurfaceResult[] }
  | { type: 'file-ready'; jobId: string; filename: string; mime: string; bytes: ArrayBuffer }
  | { type: 'canceled'; jobId: string }
  | { type: 'failed'; jobId: string; code: string; message: string };

const nonEmptyString = z.string().min(1);
const finite = z.number().finite();
const positiveInt = z.number().int().positive();

const boundsMmSchema = z.object({
  x: finite,
  y: finite,
  width: finite,
  height: finite,
});

const surfaceDatumSchema = z.object({
  id: nonEmptyString,
  label: z.string(),
  kind: z.enum(['point', 'edge']),
  localMm: vec2Schema,
  localEndMm: vec2Schema.optional(),
});

const surfaceSchema = z.object({
  id: surfaceIdSchema,
  originMm: vec3Schema,
  axisU: vec3Schema,
  axisV: vec3Schema,
  frontNormal: vec3Schema,
  polygonMm: z.array(vec2Schema).min(3).max(16),
  boundsMm: boundsMmSchema,
  datums: z.array(surfaceDatumSchema).max(16),
});

const compiledSurfaceSchema = z.object({
  surface: surfaceSchema,
  surfaceToSource: mat3Schema,
  sourceToSurface: mat3Schema,
  printableFootprintMm: z.array(vec2Schema).max(32),
});

const cameraFrameSchema = z.object({
  eyeMm: vec3Schema,
  targetMm: vec3Schema,
  forward: vec3Schema,
  right: vec3Schema,
  up: vec3Schema,
});

const artworkFrameSchema = z.object({
  assetId: nonEmptyString,
  centerSlope: vec2Schema,
  heightSlope: finite,
  widthSlope: finite,
  rotationDeg: finite,
  sourceWidthPx: positiveInt,
  sourceHeightPx: positiveInt,
  imagePlaneToSource: mat3Schema,
  sourceToImagePlane: mat3Schema,
});

const compiledSceneSchema = z.object({
  surfaces: z.array(compiledSurfaceSchema).max(3),
  camera: cameraFrameSchema,
  artwork: artworkFrameSchema.nullable(),
  sceneExtentMm: finite,
  epsilonMm: finite.positive(),
  engineVersion: nonEmptyString,
});

const assetMetadataSchema = z.object({
  assetId: nonEmptyString,
  widthPx: positiveInt,
  heightPx: positiveInt,
  contentHash: z.string().optional(),
});

const photoAssetMetadataSchema = z
  .object({
    assetId: z.string().regex(/^[0-9a-f]{64}$/),
    widthPx: positiveInt.max(LIMITS.photo.maxSidePx),
    heightPx: positiveInt.max(LIMITS.photo.maxSidePx),
    contentHash: z.string().regex(/^[0-9a-f]{64}$/),
    displayFilename: z.string().min(1).max(255),
  })
  .strict()
  .refine((asset) => asset.assetId === asset.contentHash, {
    message: 'Reference photo asset identity must match its content hash.',
  })
  .refine((asset) => asset.widthPx * asset.heightPx <= LIMITS.photo.maxPixels, {
    message: 'Reference photo exceeds its pixel budget.',
  });

const photoRegistrationSchema = z
  .unknown()
  .refine((registration) => {
    try {
      parsePhotoRegistration(registration);
      return true;
    } catch {
      return false;
    }
  }, 'Reference photo registration is invalid.');

const frozenPhotoSchema = z
  .object({
    schemaVersion: z.literal(1),
    asset: photoAssetMetadataSchema,
    registration: photoRegistrationSchema,
  })
  .strict()
  .superRefine((photo, ctx) => {
    try {
      const registration = parsePhotoRegistration(photo.registration);
      if (
        registration.image.contentHash !== photo.asset.contentHash ||
        registration.image.widthPx !== photo.asset.widthPx ||
        registration.image.heightPx !== photo.asset.heightPx
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Reference photo metadata does not match its registration.',
          path: ['registration', 'image'],
        });
      }
    } catch {
      // The field-level refinement above reports malformed registrations.
    }
  });

const printSpecSchema = z.object({
  paper: z.enum(['a4', 'letter', 'a3']),
  orientation: z.enum(['portrait', 'landscape']),
  marginMm: z.object({
    top: finite,
    right: finite,
    bottom: finite,
    left: finite,
  }),
  overlapMm: finite,
  dpi: z.union([z.literal(150), z.literal(300)]),
  surfaceIds: z.array(surfaceIdSchema),
});

const exportSnapshotSchema = z.object({
  project: projectV1Schema,
  asset: assetMetadataSchema.nullable(),
  scene: compiledSceneSchema,
  print: printSpecSchema,
  acknowledgements: z.array(z.string()).max(64),
  engineVersion: nonEmptyString,
});

const volumePlanSchema = z.object({
  index: z.number().int().nonnegative(),
  tileIds: z.array(nonEmptyString).max(240),
});

const rectMmSchema = z.object({
  x: finite,
  y: finite,
  width: finite,
  height: finite,
});

const tilePlanSchema = z.object({
  id: nonEmptyString,
  surfaceId: surfaceIdSchema,
  row: z.number().int().nonnegative(),
  column: z.number().int().nonnegative(),
  regionMm: rectMmSchema,
  overlapNeighbors: z.array(z.string()).max(8),
});

const printLayoutSchema = z.object({
  tiles: z.array(tilePlanSchema).max(2048),
  artworkAreaMm: z.object({ width: finite, height: finite }),
  stepMm: z.object({ x: finite, y: finite }),
  paperMm: z.object({ width: finite.positive(), height: finite.positive() }),
  grids: z
    .array(
      z.object({
        surfaceId: surfaceIdSchema,
        rows: z.number().int().positive(),
        columns: z.number().int().positive(),
      }),
    )
    .max(3),
  volumes: z
    .array(
      volumePlanSchema.extend({ pixelCount: z.number().int().nonnegative() }),
    )
    .max(2048),
  pixelCount: z.number().int().nonnegative(),
  estimatedBytes: z.number().nonnegative(),
});

const calibrationRecordSchema = z.object({
  scopeFingerprint: z.string(),
  settingsFingerprint: z.string(),
  rulerXMm: finite.nullable(),
  rulerYMm: finite.nullable(),
  declaredProofResult: z.enum(['pass', 'fail']).nullable(),
  recordedAt: z.string(),
});

const productionSnapshotSchema = exportSnapshotSchema.extend({
  revisionFingerprint: z.string(),
  fingerprints: z.object({
    physical: z.string(),
    layout: z.string(),
    export: z.string(),
  }),
  layout: printLayoutSchema,
  calibration: calibrationRecordSchema.nullable(),
  photo: frozenPhotoSchema.nullable().optional(),
  selectedTileIds: z
    .array(nonEmptyString)
    .max(240)
    .refine((ids) => new Set(ids).size === ids.length),
  volumeIndex: z.number().int().nonnegative().optional(),
  masterSurfaceId: surfaceIdSchema.optional(),
});

const photoPngSchema = z
  .instanceof(ArrayBuffer)
  .refine((bytes) => bytes.byteLength > 0, 'Reference photo bytes are empty.')
  .refine(
    (bytes) => bytes.byteLength <= LIMITS.photo.maxNormalizedBytes,
    'Reference photo exceeds its normalized byte budget.',
  );

const startExportSchema = z
  .object({
    type: z.literal('start-export'),
    jobId: nonEmptyString,
    kind: z.enum([
      'kit',
      'volume',
      'proof',
      'calibration',
      'master-pdf',
      'master-svg',
    ]),
    snapshot: productionSnapshotSchema,
    sourcePng: z
      .instanceof(ArrayBuffer)
      .nullable()
      .refine(
        (b) => !b || b.byteLength <= LIMITS.source.maxNormalizedBytes,
      ),
    photoPng: photoPngSchema.nullable().optional(),
    fonts: z
      .array(
        z
          .instanceof(ArrayBuffer)
          .refine((b) => b.byteLength > 0 && b.byteLength <= 4 * 1024 * 1024),
      )
      .max(4),
  })
  .superRefine((request, ctx) => {
    const hasPhoto = !!request.snapshot.photo;
    const hasPhotoBytes = request.photoPng instanceof ArrayBuffer;
    if (request.kind === 'kit') {
      if (hasPhoto && !hasPhotoBytes) {
        ctx.addIssue({
          code: 'custom',
          path: ['photoPng'],
          message: 'A kit with a reference photo must carry its photo bytes.',
        });
      }
      if (!hasPhoto && hasPhotoBytes) {
        ctx.addIssue({
          code: 'custom',
          path: ['photoPng'],
          message: 'Reference photo bytes require frozen photo metadata.',
        });
      }
    } else if (hasPhotoBytes) {
      ctx.addIssue({
        code: 'custom',
        path: ['photoPng'],
        message: 'Reference photo bytes are only transferred for kit exports.',
      });
    }
  });

const previewSurfaceResultSchema = z
  .object({
    surfaceId: surfaceIdSchema,
    widthPx: z.number().int().min(1).max(8192),
    heightPx: z.number().int().min(1).max(8192),
    mmPerPixel: finite.positive(),
    pixels: z.instanceof(Uint8ClampedArray),
  })
  .refine((s) => s.pixels.length === s.widthPx * s.heightPx * 4);

const requestSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('load-asset'),
    jobId: nonEmptyString,
    assetId: nonEmptyString,
    pngBytes: z.instanceof(ArrayBuffer),
  }),
  z.object({
    type: z.literal('preview'),
    jobId: nonEmptyString,
    revision: z.number().int().nonnegative(),
    scene: compiledSceneSchema,
    maxEdgePx: z.number().int().min(1).max(1024),
  }),
  z.object({
    type: z.literal('export-volume'),
    jobId: nonEmptyString,
    snapshot: exportSnapshotSchema,
    volume: volumePlanSchema,
  }),
  startExportSchema,
  z.object({
    type: z.literal('start-calibration'),
    jobId: nonEmptyString,
    project: projectV1Schema,
    fonts: z
      .array(
        z
          .instanceof(ArrayBuffer)
          .refine((b) => b.byteLength > 0 && b.byteLength <= 4 * 1024 * 1024),
      )
      .max(4),
  }),
  z.object({ type: z.literal('cancel'), jobId: nonEmptyString }),
  z.object({ type: z.literal('release-asset'), assetId: nonEmptyString }),
]);

const replySchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('progress'),
    jobId: nonEmptyString,
    phase: z.string(),
    completed: z.number(),
    total: z.number(),
  }),
  z.object({
    type: z.literal('asset-ready'),
    jobId: nonEmptyString,
    assetId: nonEmptyString,
    widthPx: positiveInt,
    heightPx: positiveInt,
  }),
  z.object({
    type: z.literal('preview-ready'),
    jobId: nonEmptyString,
    revision: z.number().int().nonnegative(),
    surfaces: z.array(previewSurfaceResultSchema).max(3),
  }),
  z.object({
    type: z.literal('file-ready'),
    jobId: nonEmptyString,
    filename: z.string(),
    mime: z.string(),
    bytes: z.instanceof(ArrayBuffer),
  }),
  z.object({ type: z.literal('canceled'), jobId: nonEmptyString }),
  z.object({
    type: z.literal('failed'),
    jobId: nonEmptyString,
    code: z.string(),
    message: z.string(),
  }),
]);

export function parseWorkerRequest(data: unknown): WorkerRequest | null {
  const result = requestSchema.safeParse(data);
  return result.success ? (result.data as WorkerRequest) : null;
}

export function parseWorkerReply(data: unknown): WorkerReply | null {
  const result = replySchema.safeParse(data);
  return result.success ? (result.data as WorkerReply) : null;
}
