import { pointInConvexPolygon } from '../geometry/intersections';
import { LIMITS } from '../limits';
import { applyMat3 } from '../math/matrix3';
import type { CompiledScene, CornerSpec, PreviewSurfaceResult, SurfaceId } from '../types';
import { isPhotoRegistrationCurrent, solvePhotoPlanes, type PhotoImageIdentity, type PhotoRegistrationV1 } from './registration';

export interface PhotoRaster {
  readonly widthPx: number;
  readonly heightPx: number;
  readonly pixels: Uint8ClampedArray;
}

export interface PhotoComposite extends PhotoRaster {
  readonly appliedSurfaces: readonly SurfaceId[];
}

/** Bilinear straight-alpha sampling, compositing over white only for real print stock. */
function sampleInto(source: PhotoRaster, x: number, y: number, out: Uint8ClampedArray, offset: number, paper: boolean): void {
  const sx = Math.max(0, Math.min(source.widthPx - 1, x));
  const sy = Math.max(0, Math.min(source.heightPx - 1, y));
  const x0 = Math.floor(sx);
  const y0 = Math.floor(sy);
  const x1 = Math.min(source.widthPx - 1, x0 + 1);
  const y1 = Math.min(source.heightPx - 1, y0 + 1);
  const fx = sx - x0;
  const fy = sy - y0;
  const i0 = (y0 * source.widthPx + x0) * 4;
  const i1 = (y0 * source.widthPx + x1) * 4;
  const i2 = (y1 * source.widthPx + x0) * 4;
  const i3 = (y1 * source.widthPx + x1) * 4;
  const p = source.pixels;
  const a0 = p[i0 + 3]! / 255 * (1 - fx) * (1 - fy);
  const a1 = p[i1 + 3]! / 255 * fx * (1 - fy);
  const a2 = p[i2 + 3]! / 255 * (1 - fx) * fy;
  const a3 = p[i3 + 3]! / 255 * fx * fy;
  const alpha = a0 + a1 + a2 + a3;
  for (let c = 0; c < 3; c += 1) {
    const premult = p[i0 + c]! * a0 + p[i1 + c]! * a1 + p[i2 + c]! * a2 + p[i3 + c]! * a3;
    out[offset + c] = paper ? premult + 255 * (1 - alpha) : alpha > 0 ? premult / alpha : 0;
  }
  out[offset + 3] = paper ? 255 : alpha * 255;
}

/**
 * Local-only photo preview. Every painted pixel samples the real worker raster
 * through the explicitly reviewed per-plane homography. Unregistered, stale,
 * excluded or unprinted regions retain the supplied photograph unchanged.
 * This never feeds back into projection, fingerprints, tiling or export.
 */
export function compositePhotoPreview(input: {
  readonly reference: PhotoRaster;
  readonly image: PhotoImageIdentity;
  readonly registration: PhotoRegistrationV1;
  readonly corner: CornerSpec;
  readonly scene: CompiledScene | null;
  readonly previews: readonly PreviewSurfaceResult[] | null;
  readonly maxEdgePx?: number;
}): PhotoComposite {
  const { reference, image, registration, corner, scene, previews } = input;
  if (!Number.isSafeInteger(reference.widthPx) || !Number.isSafeInteger(reference.heightPx)
      || reference.widthPx < 1 || reference.heightPx < 1
      || reference.widthPx > LIMITS.photo.maxSidePx || reference.heightPx > LIMITS.photo.maxSidePx
      || reference.widthPx * reference.heightPx > LIMITS.photo.maxPixels
      || reference.pixels.length !== reference.widthPx * reference.heightPx * 4
      || reference.widthPx !== image.widthPx || reference.heightPx !== image.heightPx) {
    throw new Error('Reference photo pixels do not match their normalized dimensions.');
  }
  const requestedEdge = input.maxEdgePx ?? LIMITS.photo.previewMaxEdgePx;
  if (!Number.isFinite(requestedEdge) || requestedEdge < 1) throw new Error('Invalid photo preview size.');
  const edge = Math.min(requestedEdge, LIMITS.photo.previewMaxEdgePx);
  const scale = Math.min(1, edge / Math.max(reference.widthPx, reference.heightPx));
  const widthPx = Math.max(1, Math.round(reference.widthPx * scale));
  const heightPx = Math.max(1, Math.round(reference.heightPx * scale));
  const pixels = new Uint8ClampedArray(widthPx * heightPx * 4);
  if (widthPx === reference.widthPx && heightPx === reference.heightPx) pixels.set(reference.pixels);
  else {
    for (let y = 0; y < heightPx; y += 1) {
      for (let x = 0; x < widthPx; x += 1) {
        sampleInto(reference, (x + 0.5) * reference.widthPx / widthPx - 0.5,
          (y + 0.5) * reference.heightPx / heightPx - 0.5, pixels, (y * widthPx + x) * 4, false);
      }
    }
  }
  const result: PhotoComposite = { widthPx, heightPx, pixels, appliedSurfaces: [] };
  if (!scene || !previews || !isPhotoRegistrationCurrent(registration, corner, image)) return result;
  const solved = solvePhotoPlanes(registration.planes, corner, image);
  const appliedSurfaces: SurfaceId[] = [];
  for (const plane of solved) {
    const compiled = scene.surfaces.find((s) => s.surface.id === plane.surface.id);
    const preview = previews.find((p) => p.surfaceId === plane.surface.id);
    if (!compiled || !preview || compiled.printableFootprintMm.length < 3) continue;
    if (!Number.isSafeInteger(preview.widthPx) || !Number.isSafeInteger(preview.heightPx)
        || preview.widthPx < 1 || preview.heightPx < 1 || !Number.isFinite(preview.mmPerPixel) || preview.mmPerPixel <= 0
        || preview.pixels.length !== preview.widthPx * preview.heightPx * 4) throw new Error('The computed artwork preview is malformed.');
    const projected = compiled.printableFootprintMm.map((p) => applyMat3(plane.surfaceToPhoto, p));
    if (projected.some((p) => !p.every(Number.isFinite))) continue;
    const minX = Math.max(0, Math.floor(Math.min(...projected.map((p) => p[0])) * widthPx));
    const maxX = Math.min(widthPx - 1, Math.ceil(Math.max(...projected.map((p) => p[0])) * widthPx));
    const minY = Math.max(0, Math.floor(Math.min(...projected.map((p) => p[1])) * heightPx));
    const maxY = Math.min(heightPx - 1, Math.ceil(Math.max(...projected.map((p) => p[1])) * heightPx));
    const bounds = compiled.surface.boundsMm;
    let painted = false;
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const photoX = (x + 0.5) / widthPx;
        const photoY = (y + 0.5) / heightPx;
        if (registration.occlusionRects?.some((r) => photoX >= r.x && photoX <= r.x + r.width && photoY >= r.y && photoY <= r.y + r.height)) continue;
        const uv = applyMat3(plane.photoToSurface, [photoX, photoY]);
        if (!uv.every(Number.isFinite) || !pointInConvexPolygon(compiled.printableFootprintMm, uv, scene.epsilonMm)) continue;
        // The core raster's first row is the top of the surface (V decreases
        // down the array). Preserve that convention; do not mirror the pieces.
        const rx = (uv[0] - bounds.x) / preview.mmPerPixel - 0.5;
        const ry = (bounds.y + bounds.height - uv[1]) / preview.mmPerPixel - 0.5;
        sampleInto(preview, rx, ry, pixels, (y * widthPx + x) * 4, true);
        painted = true;
      }
    }
    if (painted) appliedSurfaces.push(plane.surface.id);
  }
  return { ...result, appliedSurfaces };
}
