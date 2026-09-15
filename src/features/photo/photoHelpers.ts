import { buildSurfaces, surfaceUvToWorld } from '../../core/geometry/surfaces';
import type {
  CornerSpec,
  SurfaceId,
  Vec2,
} from '../../core/types';
import {
  solvePhotoPlanes,
  photoReferenceCorner,
  type PhotoImageIdentity,
  type PhotoPlaneRegistration,
  type PhotoRegistrationV1,
} from '../../core/photo/registration';

export const PHOTO_SURFACE_ORDER: readonly SurfaceId[] = ['A', 'B', 'C'];

export function clonePhotoPlanes(
  planes: readonly PhotoPlaneRegistration[],
): PhotoPlaneRegistration[] {
  return planes.map((plane) => ({
    surfaceId: plane.surfaceId,
    corners: plane.corners.map(([x, y]) => [x, y] as Vec2),
  }));
}

export function photoPlaneFor(
  planes: readonly PhotoPlaneRegistration[],
  surfaceId: SurfaceId,
): PhotoPlaneRegistration {
  return (
    planes.find((plane) => plane.surfaceId === surfaceId) ?? {
      surfaceId,
      corners: [],
    }
  );
}

export function upsertPhotoPlane(
  planes: readonly PhotoPlaneRegistration[],
  next: PhotoPlaneRegistration,
): PhotoPlaneRegistration[] {
  const result: { surfaceId: SurfaceId; corners: Vec2[] }[] = planes.map((plane) => ({
    surfaceId: plane.surfaceId,
    corners: plane.corners.map(([x, y]) => [x, y] as Vec2),
  }));
  const index = result.findIndex((plane) => plane.surfaceId === next.surfaceId);
  const copy = {
    surfaceId: next.surfaceId,
    corners: next.corners.map(([x, y]) => [x, y] as Vec2),
  };
  if (index < 0) result.push(copy);
  else result[index] = copy;
  return result;
}

export function clampPhotoPoint(point: Vec2): Vec2 {
  return [
    Math.max(0, Math.min(1, Number.isFinite(point[0]) ? point[0] : 0)),
    Math.max(0, Math.min(1, Number.isFinite(point[1]) ? point[1] : 0)),
  ];
}

export function pointFromClient(
  rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>,
  clientX: number,
  clientY: number,
): Vec2 {
  if (!(rect.width > 0) || !(rect.height > 0)) return [0, 0];
  return clampPhotoPoint([
    (clientX - rect.left) / rect.width,
    (clientY - rect.top) / rect.height,
  ]);
}

interface VertexRef {
  readonly surfaceId: SurfaceId;
  readonly index: number;
  readonly world: readonly [number, number, number];
}

/**
 * Copy only anchors that represent the same world vertex. The follow-up
 * prefix pass may append those known anchors in order, but never invents an
 * unmatched point; differing wall heights therefore remain explicit.
 */
export function reuseSharedPhotoAnchors(
  planes: readonly PhotoPlaneRegistration[],
  corner: CornerSpec,
): PhotoPlaneRegistration[] {
  const surfaces = buildSurfaces(corner);
  const vertices: VertexRef[] = surfaces.flatMap((surface) =>
    surface.polygonMm.map((point, index) => ({
      surfaceId: surface.id,
      index,
      world: surfaceUvToWorld(surface, point),
    })),
  );
  const result: { surfaceId: SurfaceId; corners: Vec2[] }[] = planes.map((plane) => ({
    surfaceId: plane.surfaceId,
    corners: plane.corners.map(([x, y]) => [x, y] as Vec2),
  }));
  const findPlane = (surfaceId: SurfaceId) =>
    result.find((plane) => plane.surfaceId === surfaceId);
  for (let i = 0; i < vertices.length; i += 1) {
    const a = vertices[i]!;
    const aPlane = findPlane(a.surfaceId);
    const aPoint = aPlane?.corners[a.index];
    if (!aPoint) continue;
    for (let j = 0; j < vertices.length; j += 1) {
      const b = vertices[j]!;
      if (a.surfaceId === b.surfaceId) continue;
      if (
        Math.hypot(
          a.world[0] - b.world[0],
          a.world[1] - b.world[1],
          a.world[2] - b.world[2],
        ) > 1e-5
      ) {
        continue;
      }
      const bPlane = findPlane(b.surfaceId);
      if (!bPlane || b.index >= bPlane.corners.length) continue;
      bPlane.corners[b.index] = [aPoint[0], aPoint[1]];
    }
  }
  return completeSharedPhotoPrefixes(result, corner);
}

/**
 * Fill only a consecutive prefix from already marked world vertices.  This is
 * what lets a wall's shared seam endpoints be marked once: B still asks for
 * its outer bottom first, then fills O/seam-top before asking for outer top;
 * C can begin with the known wall-floor endpoint and ask for its one front
 * point.  No unknown slot is skipped.
 */
export function completeSharedPhotoPrefixes(
  planes: readonly PhotoPlaneRegistration[],
  corner: CornerSpec,
): PhotoPlaneRegistration[] {
  const surfaces = buildSurfaces(corner);
  const result: { surfaceId: SurfaceId; corners: Vec2[] }[] = planes.map((plane) => ({
    surfaceId: plane.surfaceId,
    corners: plane.corners.map(([x, y]) => [x, y] as Vec2),
  }));
  const vertexRefs = surfaces.flatMap((surface) =>
    surface.polygonMm.map((point, index) => ({
      surfaceId: surface.id,
      index,
      world: surfaceUvToWorld(surface, point),
    })),
  );
  const sameWorld = (a: readonly [number, number, number], b: readonly [number, number, number]) =>
    Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) <= 1e-5;
  const findPlane = (surfaceId: SurfaceId) =>
    result.find((plane) => plane.surfaceId === surfaceId);

  let changed = true;
  while (changed) {
    changed = false;
    for (const surface of surfaces) {
      const target = findPlane(surface.id);
      if (!target || target.corners.length >= surface.polygonMm.length) continue;
      const nextIndex = target.corners.length;
      const targetRef = vertexRefs.find(
        (ref) => ref.surfaceId === surface.id && ref.index === nextIndex,
      );
      if (!targetRef) continue;
      const source = vertexRefs.find((ref) => {
        if (ref.surfaceId === targetRef.surfaceId) return false;
        if (!sameWorld(ref.world, targetRef.world)) return false;
        return Boolean(findPlane(ref.surfaceId)?.corners[ref.index]);
      });
      const sourcePoint = source
        ? findPlane(source.surfaceId)?.corners[source.index]
        : undefined;
      if (!sourcePoint) continue;
      target.corners.push([sourcePoint[0], sourcePoint[1]]);
      changed = true;
    }
  }
  return result;
}

/** Propagate an edited shared vertex to every already-present counterpart. */
export function updateSharedPhotoPoint(
  planes: readonly PhotoPlaneRegistration[],
  corner: CornerSpec,
  surfaceId: SurfaceId,
  pointIndex: number,
  point: Vec2,
): PhotoPlaneRegistration[] {
  const surfaces = buildSurfaces(corner);
  const result: { surfaceId: SurfaceId; corners: Vec2[] }[] = planes.map((plane) => ({
    surfaceId: plane.surfaceId,
    corners: plane.corners.map(([x, y]) => [x, y] as Vec2),
  }));
  const sourceSurface = surfaces.find((surface) => surface.id === surfaceId);
  const sourcePoint = sourceSurface?.polygonMm[pointIndex];
  if (!sourcePoint) return result;
  const sourceWorld = surfaceUvToWorld(sourceSurface, sourcePoint);
  const source = result.find((plane) => plane.surfaceId === surfaceId);
  if (!source || !source.corners[pointIndex]) return result;
  source.corners[pointIndex] = clampPhotoPoint(point);
  for (const surface of surfaces) {
    if (surface.id === surfaceId) continue;
    const target = result.find((plane) => plane.surfaceId === surface.id);
    if (!target) continue;
    for (let index = 0; index < surface.polygonMm.length; index += 1) {
      const world = surfaceUvToWorld(surface, surface.polygonMm[index]!);
      if (
        Math.hypot(
          world[0] - sourceWorld[0],
          world[1] - sourceWorld[1],
          world[2] - sourceWorld[2],
        ) <= 1e-5 &&
        target.corners[index]
      ) {
        target.corners[index] = [...source.corners[pointIndex]!] as Vec2;
      }
    }
  }
  return completeSharedPhotoPrefixes(result, corner);
}

export function photoPlaneHasFourCorners(
  planes: readonly PhotoPlaneRegistration[],
  surfaceId: SurfaceId,
): boolean {
  return photoPlaneFor(planes, surfaceId).corners.length === 4;
}

export function photoPlanesReviewable(
  planes: readonly PhotoPlaneRegistration[],
): boolean {
  const marked = planes.filter((plane) => plane.corners.length > 0);
  return marked.length > 0 && marked.every((plane) => plane.corners.length === 4);
}

export interface PhotoReplacementResult {
  readonly registration: PhotoRegistrationV1;
  readonly needsNewMarking: boolean;
}

/**
 * A replacement photo keeps a reviewed registration's measured geometry and
 * points, but is explicitly stale until the user reviews the new image.  If
 * the old point set cannot even form a structural mapping for the replacement,
 * clear those points rather than claiming they survived.
 */
export function replacePhotoRegistration(
  registration: PhotoRegistrationV1,
  image: PhotoImageIdentity,
  _corner: CornerSpec,
): PhotoReplacementResult {
  const wasReviewed = registration.status !== 'draft';
  // Validate the old point set against the geometry snapshot it was measured
  // with. The current project corner may already be stale; that must not turn
  // an otherwise valid reviewed replacement into a needless re-marking.
  const referenceCorner = photoReferenceCorner(registration.geometry);
  const activeSurfaces = new Set(
    buildSurfaces(referenceCorner).map((surface) => surface.id),
  );
  const activePlanes = registration.planes.filter((plane) =>
    activeSurfaces.has(plane.surfaceId),
  );
  if (activePlanes.length === 0) {
    return {
      registration: {
        ...registration,
        image,
        status: wasReviewed ? 'stale' : 'draft',
        reviewedAt: wasReviewed ? registration.reviewedAt : null,
      },
      needsNewMarking: false,
    };
  }
  try {
    solvePhotoPlanes(activePlanes, referenceCorner, image);
    return {
      registration: {
        ...registration,
        image,
        status: wasReviewed ? 'stale' : 'draft',
        reviewedAt: wasReviewed ? registration.reviewedAt : null,
      },
      needsNewMarking: false,
    };
  } catch {
    return {
      registration: {
        ...registration,
        image,
        planes: [],
        status: 'draft',
        reviewedAt: null,
      },
      needsNewMarking: true,
    };
  }
}
