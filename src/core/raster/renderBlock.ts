import { LIMITS } from '../limits';
import { nearestVisibleHit, pointInConvexPolygon } from '../geometry/intersections';
import { add3, normalize3, scale3, sub3 } from '../math/vector';
import {
  encodePremultToSrgb,
  samplePyramidLinear,
  type PremultipliedLinear,
} from './sample';
import type {
  CompiledSurface,
  RasterBlockRequest,
  RasterBlockResult,
  SourcePyramid,
  Surface,
  Vec2,
  Vec3,
} from '../types';

const BOUNDARY_EPS = 1e-9;
const QUARTER_OFFSETS: readonly (readonly [number, number])[] = [
  [0.25, 0.25],
  [0.75, 0.25],
  [0.25, 0.75],
  [0.75, 0.75],
];

interface SampleContext {
  readonly compiled: CompiledSurface;
  readonly mmPerPixel: number;
  readonly srcW: number;
  readonly srcH: number;
  readonly eyeMm: Vec3;
  readonly surfaceList: readonly Surface[];
  readonly epsilonMm: number;
}

interface EdgeTest {
  readonly px: number;
  readonly py: number;
  readonly ex: number;
  readonly ey: number;
  readonly bound: number;
}

interface PixelHit {
  readonly s: number;
  readonly t: number;
  readonly lod: number;
}

function footprintEdgeTests(
  polygon: readonly Vec2[],
  mmPerPixel: number,
): { edges: EdgeTest[]; winding: number } {
  let area = 0;
  const n = polygon.length;
  for (let i = 0; i < n; i += 1) {
    const p = polygon[i]!;
    const q = polygon[(i + 1) % n]!;
    area += p[0] * q[1] - q[0] * p[1];
  }
  const winding = Math.sign(area) || 1;
  const edges: EdgeTest[] = polygon.map((p, i) => {
    const q = polygon[(i + 1) % n]!;
    const ex = q[0] - p[0];
    const ey = q[1] - p[1];
    return {
      px: p[0],
      py: p[1],
      ex,
      ey,
      bound: (mmPerPixel / 2) * (Math.abs(ex) + Math.abs(ey)),
    };
  });
  return { edges, winding };
}

function evaluatePoint(
  ctx: SampleContext,
  px: number,
  py: number,
): PixelHit | null {
  const { compiled, mmPerPixel } = ctx;
  const surface = compiled.surface;
  const bounds = surface.boundsMm;
  const u = bounds.x + px * mmPerPixel;
  const v = bounds.y + bounds.height - py * mmPerPixel;
  if (!pointInConvexPolygon(compiled.printableFootprintMm, [u, v], ctx.epsilonMm)) {
    return null;
  }
  const m = compiled.surfaceToSource;
  const sNum = m[0] * u + m[1] * v + m[2];
  const tNum = m[3] * u + m[4] * v + m[5];
  const depth = m[6] * u + m[7] * v + m[8];
  if (!Number.isFinite(depth) || depth < LIMITS.nearPlaneMm) return null;
  const s = sNum / depth;
  const t = tNum / depth;
  if (
    !Number.isFinite(s) ||
    !Number.isFinite(t) ||
    s < -BOUNDARY_EPS ||
    s > 1 + BOUNDARY_EPS ||
    t < -BOUNDARY_EPS ||
    t > 1 + BOUNDARY_EPS
  ) {
    return null;
  }
  const world = add3(
    surface.originMm,
    add3(scale3(surface.axisU, u), scale3(surface.axisV, v)),
  );
  const direction = normalize3(sub3(world, ctx.eyeMm));
  if (!direction) return null;
  const hit = nearestVisibleHit(
    { originMm: ctx.eyeMm, direction },
    ctx.surfaceList,
    ctx.epsilonMm,
  );
  if (!hit || hit.surfaceId !== surface.id) return null;

  const d2 = depth * depth;
  const dsdu = (m[0] * depth - sNum * m[6]) / d2;
  const dsdv = (m[1] * depth - sNum * m[7]) / d2;
  const dtdu = (m[3] * depth - tNum * m[6]) / d2;
  const dtdv = (m[4] * depth - tNum * m[7]) / d2;
  const rhoU = mmPerPixel * Math.hypot(dsdu * ctx.srcW, dtdu * ctx.srcH);
  const rhoV = mmPerPixel * Math.hypot(dsdv * ctx.srcW, dtdv * ctx.srcH);
  const rho = Math.max(rhoU, rhoV, 1e-12);
  return {
    s: Math.min(1, Math.max(0, s)),
    t: Math.min(1, Math.max(0, t)),
    lod: Math.log2(rho),
  };
}

function assertPyramid(pyramid: SourcePyramid): void {
  if (
    !Number.isSafeInteger(pyramid.widthPx) ||
    !Number.isSafeInteger(pyramid.heightPx) ||
    pyramid.widthPx < 1 ||
    pyramid.heightPx < 1 ||
    pyramid.widthPx > LIMITS.source.maxSidePx ||
    pyramid.heightPx > LIMITS.source.maxSidePx ||
    pyramid.widthPx * pyramid.heightPx > LIMITS.source.maxMegapixels * 1_000_000 ||
    pyramid.levels.length < 1
  ) {
    throw new RangeError('Source pyramid is outside supported limits.');
  }
  const base = pyramid.levels[0]!;
  if (base.widthPx !== pyramid.widthPx || base.heightPx !== pyramid.heightPx) {
    throw new RangeError('Source pyramid level zero does not match its dimensions.');
  }
  for (const level of pyramid.levels) {
    if (
      !Number.isSafeInteger(level.widthPx) ||
      !Number.isSafeInteger(level.heightPx) ||
      level.widthPx < 1 ||
      level.heightPx < 1 ||
      !(level.pixels instanceof Uint8ClampedArray) ||
      level.pixels.length !== level.widthPx * level.heightPx * 4
    ) {
      throw new RangeError('Source pyramid level is malformed.');
    }
  }
}

export async function renderRasterBlock(
  request: RasterBlockRequest,
): Promise<RasterBlockResult> {
  const {
    scene,
    surfaceId,
    blockPx,
    mmPerPixel,
    pyramid,
    cancellation,
    yieldEveryRows = 16,
    yieldControl,
  } = request;
  const width = blockPx.width;
  const height = blockPx.height;
  const fail = (): RasterBlockResult => ({
    status: 'canceled',
    surfaceId,
    blockPx,
    pixels: null,
  });
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    !Number.isSafeInteger(blockPx.x) ||
    !Number.isSafeInteger(blockPx.y) ||
    width < 1 ||
    height < 1 ||
    width > LIMITS.rasterBlockMaxPx ||
    height > LIMITS.rasterBlockMaxPx ||
    !Number.isFinite(mmPerPixel) ||
    mmPerPixel <= 0
  ) {
    throw new RangeError('Raster block is outside supported limits.');
  }
  if (cancellation?.isCanceled()) return fail();
  assertPyramid(pyramid);
  const compiled = scene.surfaces.find((s) => s.surface.id === surfaceId);
  const out = new Uint8ClampedArray(width * height * 4);
  if (!compiled || !scene.artwork || compiled.printableFootprintMm.length < 3) {
    return { status: 'ready', surfaceId, blockPx, pixels: out };
  }
  const { edges, winding } = footprintEdgeTests(
    compiled.printableFootprintMm,
    mmPerPixel,
  );
  const fullyInterior = (u: number, v: number): boolean => {
    for (const e of edges) {
      if (winding * (e.ex * (v - e.py) - e.ey * (u - e.px)) <= e.bound) {
        return false;
      }
    }
    return true;
  };
  const ctx: SampleContext = {
    compiled,
    mmPerPixel,
    srcW: scene.artwork.sourceWidthPx,
    srcH: scene.artwork.sourceHeightPx,
    eyeMm: scene.camera.eyeMm,
    surfaceList: scene.surfaces.map((s) => s.surface),
    epsilonMm: scene.epsilonMm,
  };
  const yieldNow =
    yieldControl ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  const every = Math.max(1, yieldEveryRows);
  for (let row = 0; row < height; row += 1) {
    if (row % every === 0) {
      if (cancellation?.isCanceled()) return fail();
      await yieldNow();
      if (cancellation?.isCanceled()) return fail();
    }
    for (let col = 0; col < width; col += 1) {
      const gx = blockPx.x + col;
      const gy = blockPx.y + row;
      const cu = compiled.surface.boundsMm.x + (gx + 0.5) * mmPerPixel;
      const cv =
        compiled.surface.boundsMm.y +
        compiled.surface.boundsMm.height -
        (gy + 0.5) * mmPerPixel;
      const i = (row * width + col) * 4;
      if (fullyInterior(cu, cv)) {
        const center = evaluatePoint(ctx, gx + 0.5, gy + 0.5);
        if (center) {
          const [r, g, b, a] = encodePremultToSrgb(
            samplePyramidLinear(pyramid, center.s, center.t, center.lod),
          );
          out[i] = r;
          out[i + 1] = g;
          out[i + 2] = b;
          out[i + 3] = a;
          continue;
        }
      }
      let sr = 0;
      let sg = 0;
      let sb = 0;
      let sa = 0;
      for (const [ox, oy] of QUARTER_OFFSETS) {
        const sub = evaluatePoint(ctx, gx + ox, gy + oy);
        if (!sub) continue;
        const sm: PremultipliedLinear = samplePyramidLinear(
          pyramid,
          sub.s,
          sub.t,
          sub.lod,
        );
        sr += sm[0];
        sg += sm[1];
        sb += sm[2];
        sa += sm[3];
      }
      if (sa <= 0) continue;
      const [r, g, b, a] = encodePremultToSrgb([sr / 4, sg / 4, sb / 4, sa / 4]);
      out[i] = r;
      out[i + 1] = g;
      out[i + 2] = b;
      out[i + 3] = a;
    }
  }
  return { status: 'ready', surfaceId, blockPx, pixels: out };
}
