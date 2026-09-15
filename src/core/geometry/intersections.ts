import { LIMITS } from '../limits';
import { add3, dot3, scale3, sub3 } from '../math/vector';
import type { Ray, Surface, SurfaceHit, Vec2 } from '../types';

export function pointInConvexPolygon(
  polygon: readonly Vec2[],
  point: Vec2,
  epsilonMm: number,
): boolean {
  if (polygon.length < 3) return false;
  if (!Number.isFinite(point[0]) || !Number.isFinite(point[1])) return false;
  let area2 = 0;
  for (let i = 0; i < polygon.length; i += 1) {
    const p = polygon[i]!;
    const q = polygon[(i + 1) % polygon.length]!;
    if (
      !Number.isFinite(p[0]) ||
      !Number.isFinite(p[1]) ||
      !Number.isFinite(q[0]) ||
      !Number.isFinite(q[1])
    ) {
      return false;
    }
    area2 += p[0] * q[1] - q[0] * p[1];
  }
  if (!Number.isFinite(area2) || Math.abs(area2) < 2 * epsilonMm * epsilonMm) {
    return false;
  }
  const winding = Math.sign(area2);
  for (let i = 0; i < polygon.length; i += 1) {
    const p = polygon[i]!;
    const q = polygon[(i + 1) % polygon.length]!;
    const ex = q[0] - p[0];
    const ey = q[1] - p[1];
    const edgeLen = Math.hypot(ex, ey);
    if (edgeLen <= epsilonMm) continue;
    const signedDistance =
      (ex * (point[1] - p[1]) - ey * (point[0] - p[0])) / edgeLen;
    if (signedDistance * winding < -epsilonMm) return false;
  }
  return true;
}

export function intersectRaySurface(
  ray: Ray,
  surface: Surface,
  epsilonMm: number,
): SurfaceHit | null {
  const denominator = dot3(ray.direction, surface.frontNormal);
  if (Math.abs(denominator) < LIMITS.parallelDenominatorEps) return null;
  const t =
    dot3(sub3(surface.originMm, ray.originMm), surface.frontNormal) / denominator;
  if (!Number.isFinite(t) || t <= 0) return null;
  const world = add3(ray.originMm, scale3(ray.direction, t));
  const local: Vec2 = [
    dot3(sub3(world, surface.originMm), surface.axisU),
    dot3(sub3(world, surface.originMm), surface.axisV),
  ];
  if (!pointInConvexPolygon(surface.polygonMm, local, epsilonMm)) return null;
  return {
    surfaceId: surface.id,
    distanceMm: t,
    localMm: local,
    worldMm: world,
  };
}

export function nearestVisibleHit(
  ray: Ray,
  surfaces: readonly Surface[],
  epsilonMm: number,
): SurfaceHit | null {
  let best: SurfaceHit | null = null;
  for (const surface of surfaces) {
    const hit = intersectRaySurface(ray, surface, epsilonMm);
    if (!hit) continue;
    if (
      !best ||
      hit.distanceMm < best.distanceMm - epsilonMm ||
      (Math.abs(hit.distanceMm - best.distanceMm) <= epsilonMm &&
        hit.surfaceId < best.surfaceId)
    ) {
      best = hit;
    }
  }
  return best;
}
