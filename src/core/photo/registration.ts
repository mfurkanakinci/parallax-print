import { z } from 'zod';
import { LIMITS } from '../limits';
import { applyMat3, invertMat3 } from '../math/matrix3';
import { buildSurfaces, surfaceUvToWorld } from '../geometry/surfaces';
import type { CornerSpec, Mat3, Surface, SurfaceId, Vec2 } from '../types';
import { fitHomography, PhotoCalibrationError, validatePhotoQuad, type Quad } from './homography';

export interface PhotoImageIdentity {
  readonly contentHash: string;
  readonly widthPx: number;
  readonly heightPx: number;
}

export interface PhotoGeometryReference {
  readonly panelA: { readonly widthMm: number; readonly heightMm: number };
  readonly panelB: { readonly widthMm: number; readonly heightMm: number };
  readonly angleDeg: number;
  readonly includeBase: boolean;
}

export interface PhotoPlaneRegistration {
  readonly surfaceId: SurfaceId;
  /** Correspond to surface.polygonMm in order; normalized photo X/Y (down). */
  readonly corners: readonly Vec2[];
}

export interface PhotoOcclusionRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PhotoRegistrationV1 {
  readonly schemaVersion: 1;
  readonly image: PhotoImageIdentity;
  readonly geometry: PhotoGeometryReference;
  readonly planes: readonly PhotoPlaneRegistration[];
  readonly status: 'draft' | 'calibrated' | 'stale';
  readonly reviewMethod: 'visual';
  readonly reviewedAt: string | null;
  /** Explicit user exclusions in the photo only; never alter printable pieces. */
  readonly occlusionRects?: readonly PhotoOcclusionRect[] | undefined;
}

export interface SolvedPhotoPlane {
  readonly surface: Surface;
  readonly corners: Quad;
  readonly surfaceToPhoto: Mat3;
  readonly photoToSurface: Mat3;
}

const finite = z.number().finite();
const dimension = finite.min(LIMITS.panelMm.min).max(LIMITS.panelMm.max);
const panelSchema = z.object({ widthMm: dimension, heightMm: dimension }).strict();
const geometrySchema = z.object({
  panelA: panelSchema,
  panelB: panelSchema,
  angleDeg: finite.min(LIMITS.angleDeg.min).max(LIMITS.angleDeg.max),
  includeBase: z.boolean(),
}).strict();
const imageSchema = z.object({
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  widthPx: z.number().int().positive().max(LIMITS.photo.maxSidePx),
  heightPx: z.number().int().positive().max(LIMITS.photo.maxSidePx),
}).strict().refine((i) => i.widthPx * i.heightPx <= LIMITS.photo.maxPixels, 'Reference photo exceeds its pixel budget.');
const pointSchema = z.tuple([finite.min(0).max(1), finite.min(0).max(1)]);
const registrationSchema = z.object({
  schemaVersion: z.literal(1),
  image: imageSchema,
  geometry: geometrySchema,
  planes: z.array(z.object({
    surfaceId: z.enum(['A', 'B', 'C']),
    corners: z.array(pointSchema).max(4),
  }).strict()).max(3),
  status: z.enum(['draft', 'calibrated', 'stale']),
  reviewMethod: z.literal('visual'),
  reviewedAt: z.string().max(64).refine((s) => Number.isFinite(Date.parse(s)), 'Invalid review date.').nullable(),
  occlusionRects: z.array(z.object({
    x: finite.min(0).max(1), y: finite.min(0).max(1),
    width: finite.positive().max(1), height: finite.positive().max(1),
  }).strict().refine((r) => r.x + r.width <= 1 + 1e-9 && r.y + r.height <= 1 + 1e-9, 'Occlusion must lie inside the photo.')).max(16).optional(),
}).strict();

export function photoGeometryReference(corner: CornerSpec): PhotoGeometryReference {
  const reference = {
    panelA: { ...corner.panelA },
    panelB: { ...corner.panelB },
    angleDeg: corner.angleDeg,
    includeBase: corner.includeBase,
  };
  if (!geometrySchema.safeParse(reference).success) {
    throw new PhotoCalibrationError('measurements', 'Enter valid measured wall dimensions and the corner angle before calibration.');
  }
  return reference;
}

/** Stable geometry-only identity: artwork, eye, paper and display units do not enter it. */
export function photoGeometryKey(geometry: PhotoGeometryReference): string {
  return JSON.stringify([
    geometry.panelA.widthMm, geometry.panelA.heightMm,
    geometry.panelB.widthMm, geometry.panelB.heightMm,
    geometry.angleDeg, geometry.includeBase,
  ]);
}

export function photoReferenceCorner(geometry: PhotoGeometryReference): CornerSpec {
  return { kind: 'interior-corner', ...geometry };
}

export function createPhotoRegistration(image: PhotoImageIdentity, corner: CornerSpec): PhotoRegistrationV1 {
  const identity = imageSchema.parse({
    contentHash: image.contentHash,
    widthPx: image.widthPx,
    heightPx: image.heightPx,
  });
  return {
    schemaVersion: 1,
    image: identity,
    geometry: photoGeometryReference(corner),
    planes: [],
    status: 'draft',
    reviewMethod: 'visual',
    reviewedAt: null,
  };
}

export function solvePhotoPlane(plane: PhotoPlaneRegistration, corner: CornerSpec): SolvedPhotoPlane {
  photoGeometryReference(corner);
  const surface = buildSurfaces(corner).find((s) => s.id === plane.surfaceId);
  if (!surface) {
    throw new PhotoCalibrationError('surface', `Surface ${plane.surfaceId} is not enabled in this corner.`);
  }
  validatePhotoQuad(plane.corners);
  const surfaceToPhoto = fitHomography(surface.polygonMm, plane.corners);
  const photoToSurface = invertMat3(surfaceToPhoto);
  if (!photoToSurface) throw new PhotoCalibrationError('singular', 'The plane mapping is not invertible.');
  return { surface, corners: plane.corners, surfaceToPhoto, photoToSurface };
}

function checkSharedSeams(solved: readonly SolvedPhotoPlane[], corner: CornerSpec, image: PhotoImageIdentity): void {
  const maxErrorPx = Math.max(3, Math.hypot(image.widthPx, image.heightPx) * LIMITS.photo.maxSeamErrorRatio);
  const compare = (a: SolvedPhotoPlane, b: SolvedPhotoPlane, aPoint: Vec2, bPoint: Vec2) => {
    const pa = applyMat3(a.surfaceToPhoto, aPoint);
    const pb = applyMat3(b.surfaceToPhoto, bPoint);
    if (Math.hypot((pa[0] - pb[0]) * image.widthPx, (pa[1] - pb[1]) * image.heightPx) > maxErrorPx) {
      throw new PhotoCalibrationError('seam', `Surfaces ${a.surface.id} and ${b.surface.id} disagree along their shared edge. Align the seam anchors and check the measurements.`);
    }
  };
  for (let i = 0; i < solved.length; i += 1) {
    for (let j = i + 1; j < solved.length; j += 1) {
      const a = solved[i]!;
      const b = solved[j]!;
      if (new Set([a.surface.id, b.surface.id]).has('A') && new Set([a.surface.id, b.surface.id]).has('B')) {
        const wallA = a.surface.id === 'A' ? a : b;
        const wallB = a.surface.id === 'B' ? a : b;
        const height = Math.min(corner.panelA.heightMm, corner.panelB.heightMm);
        for (const t of [0, 0.5, 1]) compare(wallA, wallB, [0, height * t], [corner.panelB.widthMm, height * t]);
        continue;
      }
      const shared: { a: Vec2; b: Vec2 }[] = [];
      for (const av of a.surface.polygonMm) {
        const aw = surfaceUvToWorld(a.surface, av);
        for (const bv of b.surface.polygonMm) {
          const bw = surfaceUvToWorld(b.surface, bv);
          if (Math.hypot(aw[0] - bw[0], aw[1] - bw[1], aw[2] - bw[2]) < 1e-5) shared.push({ a: av, b: bv });
        }
      }
      shared.forEach((p) => compare(a, b, p.a, p.b));
      if (shared.length >= 2) {
        const p = shared[0]!;
        const q = shared[1]!;
        compare(a, b, [(p.a[0] + q.a[0]) / 2, (p.a[1] + q.a[1]) / 2], [(p.b[0] + q.b[0]) / 2, (p.b[1] + q.b[1]) / 2]);
      }
    }
  }
}

export function solvePhotoPlanes(planes: readonly PhotoPlaneRegistration[], corner: CornerSpec, image: PhotoImageIdentity): readonly SolvedPhotoPlane[] {
  if (new Set(planes.map((p) => p.surfaceId)).size !== planes.length) {
    throw new PhotoCalibrationError('surface', 'Each surface may be registered only once.');
  }
  const active = planes.filter((p) => p.corners.length > 0);
  if (!active.length) throw new PhotoCalibrationError('incomplete', 'Mark at least one measured wall region before review.');
  const solved = active.map((p) => solvePhotoPlane(p, corner));
  checkSharedSeams(solved, corner, image);
  return solved;
}

export function parsePhotoRegistration(value: unknown): PhotoRegistrationV1 {
  const result = registrationSchema.safeParse(value);
  if (!result.success) throw new Error(`Photo registration is invalid: ${result.error.issues[0]?.message ?? 'unsupported data'}`);
  const registration: PhotoRegistrationV1 = result.data;
  if (new Set(registration.planes.map((p) => p.surfaceId)).size !== registration.planes.length) {
    throw new PhotoCalibrationError('surface', 'Photo registration contains duplicate plane associations.');
  }
  if (registration.status !== 'draft') {
    if (!registration.reviewedAt) throw new Error('A reviewed photo registration needs its review date.');
    solvePhotoPlanes(registration.planes, photoReferenceCorner(registration.geometry), registration.image);
  }
  return registration;
}

/** Marks geometry changes stale without throwing away the previous measured reference. */
export function reconcilePhotoRegistration(registration: PhotoRegistrationV1, corner: CornerSpec): PhotoRegistrationV1 {
  // ProjectV1 may retain finite but out-of-range measurements for repair.
  // Those must invalidate review, not prevent unrelated document edits.
  let geometry: PhotoGeometryReference;
  try {
    geometry = photoGeometryReference(corner);
  } catch {
    return registration.status === 'calibrated'
      ? { ...registration, status: 'stale' }
      : registration;
  }
  if (photoGeometryKey(geometry) === photoGeometryKey(registration.geometry)) return registration;
  return registration.status === 'draft'
    ? { ...registration, geometry }
    : { ...registration, status: 'stale' };
}

export function isPhotoRegistrationCurrent(registration: PhotoRegistrationV1, corner: CornerSpec, image: PhotoImageIdentity = registration.image): boolean {
  return registration.status === 'calibrated'
    && registration.image.contentHash === image.contentHash
    && registration.image.widthPx === image.widthPx
    && registration.image.heightPx === image.heightPx
    && photoGeometryKey(registration.geometry) === photoGeometryKey(corner);
}

/** The caller supplies its clock value; confirmation is a visual self-report, not accuracy certification. */
export function confirmPhotoRegistration(registration: PhotoRegistrationV1, corner: CornerSpec, reviewedAt: string): PhotoRegistrationV1 {
  solvePhotoPlanes(registration.planes, corner, registration.image);
  return parsePhotoRegistration({
    ...registration,
    geometry: photoGeometryReference(corner),
    status: 'calibrated',
    reviewMethod: 'visual',
    reviewedAt,
  });
}

export function photoCornerLabels(surface: Surface): readonly string[] {
  if (surface.id === 'A') return ['Shared bottom O', 'A outer bottom', 'A outer top', 'A seam top'];
  if (surface.id === 'B') return ['B outer bottom', 'Shared bottom O', 'B seam top', 'B outer top'];
  return surface.polygonMm.map((p) => {
    const datum = surface.datums.find((d) => Math.hypot(d.localMm[0] - p[0], d.localMm[1] - p[1]) < 1e-5);
    return datum?.label ?? 'Outer floor corner';
  });
}
