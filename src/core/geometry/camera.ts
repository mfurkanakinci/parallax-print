import { cross3, dot3, isFiniteVec3, normalize3, sub3 } from '../math/vector';
import type {
  CameraFrame,
  Surface,
  Vec2,
  Vec3,
  ViewpointSpec,
} from '../types';
import { GeometryInputError } from './angleMeasurement';
import { surfaceUvToWorld } from './surfaces';

const WORLD_UP: Vec3 = [0, 1, 0];
const NEAR_VERTICAL_DOT = 1 - 1e-6;

export function buildCamera(viewpoint: ViewpointSpec): CameraFrame {
  const eyeMm = viewpoint.eyeMm;
  const targetMm: Vec3 = [0, viewpoint.aimHeightMm, 0];
  if (!isFiniteVec3(eyeMm) || !Number.isFinite(viewpoint.aimHeightMm)) {
    throw new GeometryInputError('camera-undefined', 'viewpoint is not finite');
  }
  const forward = normalize3(sub3(targetMm, eyeMm));
  if (!forward) {
    throw new GeometryInputError(
      'camera-undefined',
      'eye position coincides with the aim point on the seam',
    );
  }
  if (Math.abs(dot3(forward, WORLD_UP)) > NEAR_VERTICAL_DOT) {
    throw new GeometryInputError(
      'camera-undefined',
      'viewing direction is near-vertical; the world-up camera basis is undefined',
    );
  }
  const right = normalize3(cross3(forward, WORLD_UP));
  if (!right) {
    throw new GeometryInputError('camera-undefined', 'camera right axis is undefined');
  }
  const up = cross3(right, forward);
  return { eyeMm, targetMm, forward, right, up };
}

export function projectWorldPoint(camera: CameraFrame, pointMm: Vec3): Vec2 | null {
  const rel = sub3(pointMm, camera.eyeMm);
  const depth = dot3(rel, camera.forward);
  if (!Number.isFinite(depth) || depth <= 0) return null;
  const qx = dot3(rel, camera.right) / depth;
  const qy = dot3(rel, camera.up) / depth;
  if (!Number.isFinite(qx) || !Number.isFinite(qy)) return null;
  return [qx, qy];
}

/**
 * Projects a surface's UV polygon into design-eye slopes. Vertices at or
 * behind the eye plane come back null so callers can ignore them.
 */
export function projectSurfacePolygon(
  camera: CameraFrame,
  surface: Surface,
): readonly (Vec2 | null)[] {
  return surface.polygonMm.map((uv) =>
    projectWorldPoint(camera, surfaceUvToWorld(surface, uv)),
  );
}

/**
 * Maximum absolute horizontal/vertical slopes over every visible surface
 * vertex, or null when no vertex has positive forward depth. Deliberately
 * artwork-independent so resolved framing cannot shift under the pointer
 * while the artwork is being dragged (§12.2).
 */
export function surfaceSlopeExtent(
  camera: CameraFrame,
  surfaces: readonly Surface[],
): { readonly maxAbsX: number; readonly maxAbsY: number } | null {
  let maxAbsX = 0;
  let maxAbsY = 0;
  let seen = false;
  for (const surface of surfaces) {
    for (const slope of projectSurfacePolygon(camera, surface)) {
      if (!slope) continue;
      seen = true;
      maxAbsX = Math.max(maxAbsX, Math.abs(slope[0]));
      maxAbsY = Math.max(maxAbsY, Math.abs(slope[1]));
    }
  }
  return seen ? { maxAbsX, maxAbsY } : null;
}

const FOV_SLOPE_PADDING = 1.08;
const FOV_MIN_ASPECT = 0.2;
const FOV_MIN_DEG = 15;
const FOV_MAX_DEG = 140;

/**
 * Vertical FOV that fits the slope extent: 8% padding, the horizontal
 * requirement converted through the viewport aspect, and the larger of the
 * two requirements driving vertical FOV — clamped to 15–140°.
 */
export function resolvedVerticalFovDeg(
  extent: { readonly maxAbsX: number; readonly maxAbsY: number },
  aspect: number,
): number {
  const vNeed = Math.atan(extent.maxAbsY * FOV_SLOPE_PADDING);
  const hNeed = Math.atan(extent.maxAbsX * FOV_SLOPE_PADDING);
  const vFromH = Math.atan(Math.tan(hNeed) / Math.max(aspect, FOV_MIN_ASPECT));
  const halfDeg = (Math.max(vNeed, vFromH) * 180) / Math.PI;
  return Math.min(FOV_MAX_DEG, Math.max(FOV_MIN_DEG, halfDeg * 2));
}
