import { LIMITS } from '../limits';
import type { CameraFrame, Mat3, Surface, Vec2 } from '../types';

type HalfPlane = (u: number, v: number) => number;

function clipHalfPlane(
  polygon: readonly Vec2[],
  inside: HalfPlane,
  epsilonMm: number,
): Vec2[] {
  const out: Vec2[] = [];
  const n = polygon.length;
  for (let i = 0; i < n; i += 1) {
    const current = polygon[i]!;
    const next = polygon[(i + 1) % n]!;
    const fc = inside(current[0], current[1]);
    const fn = inside(next[0], next[1]);
    const cIn = fc >= -epsilonMm;
    const nIn = fn >= -epsilonMm;
    if (cIn) out.push(current);
    if (cIn !== nIn) {
      const denom = fc - fn;
      if (Math.abs(denom) > 1e-300) {
        const t = fc / denom;
        const ix = current[0] + t * (next[0] - current[0]);
        const iy = current[1] + t * (next[1] - current[1]);
        if (Number.isFinite(ix) && Number.isFinite(iy)) {
          out.push([ix, iy]);
        }
      }
    }
  }
  return out;
}

const DEDUPE_MM2 = 1e-12;
const MIN_AREA_MM2 = 1e-9;

function signedArea(polygon: readonly Vec2[]): number {
  let a = 0;
  for (let i = 0; i < polygon.length; i += 1) {
    const p = polygon[i]!;
    const q = polygon[(i + 1) % polygon.length]!;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

function finalizePolygon(polygon: readonly Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (const p of polygon) {
    const last = out[out.length - 1];
    if (
      last &&
      (p[0] - last[0]) * (p[0] - last[0]) +
          (p[1] - last[1]) * (p[1] - last[1]) <=
        DEDUPE_MM2
    ) {
      continue;
    }
    out.push(p);
  }
  if (out.length > 1) {
    const first = out[0]!;
    const last = out[out.length - 1]!;
    if (
      (first[0] - last[0]) * (first[0] - last[0]) +
        (first[1] - last[1]) * (first[1] - last[1]) <=
      DEDUPE_MM2
    ) {
      out.pop();
    }
  }
  if (out.length < 3) return [];
  if (!Number.isFinite(signedArea(out)) || Math.abs(signedArea(out)) < MIN_AREA_MM2) {
    return [];
  }
  return out;
}

export function clipPrintableFootprint(
  surface: Surface,
  homography: Mat3,
  _camera: CameraFrame,
): readonly Vec2[] {
  const sNum: HalfPlane = (u, v) => homography[0] * u + homography[1] * v + homography[2];
  const tNum: HalfPlane = (u, v) => homography[3] * u + homography[4] * v + homography[5];
  const depth: HalfPlane = (u, v) => homography[6] * u + homography[7] * v + homography[8];

  const eps = 1e-9;
  let poly: Vec2[] = surface.polygonMm.map((p) => [p[0], p[1]]);
  poly = clipHalfPlane(poly, (u, v) => depth(u, v) - LIMITS.nearPlaneMm, eps);
  if (poly.length < 3) return [];
  poly = clipHalfPlane(poly, (u, v) => sNum(u, v), eps);
  poly = clipHalfPlane(poly, (u, v) => depth(u, v) - sNum(u, v), eps);
  poly = clipHalfPlane(poly, (u, v) => tNum(u, v), eps);
  poly = clipHalfPlane(poly, (u, v) => depth(u, v) - tNum(u, v), eps);
  return finalizePolygon(poly);
}
