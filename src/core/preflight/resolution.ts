import { nearestVisibleHit, pointInConvexPolygon } from '../geometry/intersections';
import { applyMat3 } from '../math/matrix3';
import { add3, dot3, normalize3, scale3, sub3 } from '../math/vector';
import type { CompiledScene } from '../types';

const COVERAGE_GRID = 256;
const PPI_GRID = 9;

export function ppiFromJacobian(
  a: number,
  b: number,
  c: number,
  d: number,
): number {
  const tr = a * a + b * b + c * c + d * d;
  const det = a * d - b * c;
  if (!Number.isFinite(tr) || !Number.isFinite(det)) return 0;
  const disc = tr * tr - 4 * det * det;
  const largest = Math.sqrt((tr + Math.sqrt(Math.max(0, disc))) / 2);
  return largest > 0 ? (25.4 * Math.abs(det)) / largest : 0;
}

export function frameCoverage(scene: CompiledScene): number | null {
  const artwork = scene.artwork;
  if (!artwork) return null;
  const { forward, right, up, eyeMm } = scene.camera;
  const surfaces = scene.surfaces.map((s) => s.surface);
  let hits = 0;
  for (let y = 0; y < COVERAGE_GRID; y += 1) {
    for (let x = 0; x < COVERAGE_GRID; x += 1) {
      const q = applyMat3(artwork.sourceToImagePlane, [
        (x + 0.5) / COVERAGE_GRID,
        (y + 0.5) / COVERAGE_GRID,
      ]);
      const direction = normalize3(
        add3(forward, add3(scale3(right, q[0]), scale3(up, q[1]))),
      );
      if (!direction) continue;
      const hit = nearestVisibleHit(
        { originMm: eyeMm, direction },
        surfaces,
        scene.epsilonMm,
      );
      if (hit && dot3(sub3(hit.worldMm, eyeMm), forward) >= 1) {
        hits += 1;
      }
    }
  }
  return hits / (COVERAGE_GRID * COVERAGE_GRID);
}

export function sampledSourcePpi(scene: CompiledScene): number | null {
  const artwork = scene.artwork;
  if (!artwork) return null;
  const surfaces = scene.surfaces.map((s) => s.surface);
  const eyeMm = scene.camera.eyeMm;
  let minPpi = Number.POSITIVE_INFINITY;
  for (const compiled of scene.surfaces) {
    const { surface, surfaceToSource: h, printableFootprintMm } = compiled;
    if (printableFootprintMm.length < 3) continue;
    const us = printableFootprintMm.map((p) => p[0]);
    const vs = printableFootprintMm.map((p) => p[1]);
    const minU = Math.min(...us);
    const maxU = Math.max(...us);
    const minV = Math.min(...vs);
    const maxV = Math.max(...vs);
    const samples: [number, number][] = printableFootprintMm.map(
      (p) => [p[0], p[1]] as [number, number],
    );
    for (let y = 0; y < PPI_GRID; y += 1) {
      for (let x = 0; x < PPI_GRID; x += 1) {
        samples.push([
          minU + ((x + 0.5) / PPI_GRID) * (maxU - minU),
          minV + ((y + 0.5) / PPI_GRID) * (maxV - minV),
        ]);
      }
    }
    for (const [u, v] of samples) {
      if (
        !pointInConvexPolygon(printableFootprintMm, [u, v], scene.epsilonMm)
      ) {
        continue;
      }
      const world = add3(
        surface.originMm,
        add3(scale3(surface.axisU, u), scale3(surface.axisV, v)),
      );
      const direction = normalize3(sub3(world, eyeMm));
      if (!direction) continue;
      const hit = nearestVisibleHit(
        { originMm: eyeMm, direction },
        surfaces,
        scene.epsilonMm,
      );
      if (!hit || hit.surfaceId !== surface.id) continue;
      const sNum = h[0] * u + h[1] * v + h[2];
      const tNum = h[3] * u + h[4] * v + h[5];
      const d = h[6] * u + h[7] * v + h[8];
      if (!Number.isFinite(d) || d === 0) continue;
      const sw = artwork.sourceWidthPx;
      const sh = artwork.sourceHeightPx;
      const a = (sw * (h[0] * d - sNum * h[6])) / (d * d);
      const b = (sw * (h[1] * d - sNum * h[7])) / (d * d);
      const c = (sh * (h[3] * d - tNum * h[6])) / (d * d);
      const e = (sh * (h[4] * d - tNum * h[7])) / (d * d);
      const ppi = ppiFromJacobian(a, b, c, e);
      if (Number.isFinite(ppi) && ppi >= 0 && ppi < minPpi) {
        minPpi = ppi;
      }
    }
  }
  return Number.isFinite(minPpi) ? minPpi : null;
}
