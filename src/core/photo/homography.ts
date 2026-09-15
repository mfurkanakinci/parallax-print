import { applyMat3, invertMat3, mat3IsFinite, mulMat3 } from '../math/matrix3';
import type { Mat3, Vec2 } from '../types';

export type Quad = readonly [Vec2, Vec2, Vec2, Vec2];

export class PhotoCalibrationError extends Error {
  constructor(
    readonly code: 'incomplete' | 'non-finite' | 'duplicate' | 'degenerate' | 'crossed' | 'singular' | 'outside-image' | 'orientation' | 'seam' | 'surface' | 'measurements',
    message: string,
  ) {
    super(message);
    this.name = 'PhotoCalibrationError';
  }
}

export function signedQuadArea(points: readonly Vec2[]): number {
  return points.reduce((area, p, i) => {
    const next = points[(i + 1) % points.length]!;
    return area + p[0] * next[1] - next[0] * p[1];
  }, 0) / 2;
}

/** Rejects inputs before solving; a four-point fit is not accuracy evidence. */
export function validateQuad(points: readonly Vec2[]): asserts points is Quad {
  if (points.length !== 4) {
    throw new PhotoCalibrationError('incomplete', 'Mark all four corners of this measured region.');
  }
  if (points.some((p) => p.length !== 2 || !p.every(Number.isFinite))) {
    throw new PhotoCalibrationError('non-finite', 'Corner coordinates must be finite numbers.');
  }
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  if (!(span > 0)) {
    throw new PhotoCalibrationError('duplicate', 'Choose four different corners.');
  }
  for (let i = 0; i < 4; i += 1) {
    for (let j = i + 1; j < 4; j += 1) {
      if (Math.hypot(points[i]![0] - points[j]![0], points[i]![1] - points[j]![1]) <= span * 1e-5) {
        throw new PhotoCalibrationError('duplicate', 'Two marked corners are too close together.');
      }
    }
  }
  let sign = 0;
  for (let i = 0; i < 4; i += 1) {
    const a = points[i]!;
    const b = points[(i + 1) % 4]!;
    const c = points[(i + 2) % 4]!;
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cross) <= span * span * 1e-5) {
      throw new PhotoCalibrationError('degenerate', 'The marked region is too thin or nearly collinear. Choose a clearer view.');
    }
    const nextSign = Math.sign(cross);
    if (sign && sign !== nextSign) {
      throw new PhotoCalibrationError('crossed', 'The region crosses itself or bends inward. Mark the corners in the indicated order.');
    }
    sign = nextSign;
  }
}

/** The displayed photo uses normalized coordinates, with Y increasing down. */
export function validatePhotoQuad(points: readonly Vec2[]): asserts points is Quad {
  validateQuad(points);
  if (points.some(([x, y]) => x < 0 || x > 1 || y < 0 || y > 1)) {
    throw new PhotoCalibrationError('outside-image', 'All marked corners must lie inside the photo.');
  }
  // Core surface polygons are counter-clockwise in their U/V frame. A front
  // face viewed from inside the room projects clockwise in image coordinates.
  if (signedQuadArea(points) >= 0) {
    throw new PhotoCalibrationError('orientation', 'The corner order is reversed. Follow the numbered surface diagram.');
  }
}

function normalize(points: Quad): { points: Quad; transform: Mat3; inverse: Mat3 } {
  const cx = points.reduce((s, p) => s + p[0], 0) / 4;
  const cy = points.reduce((s, p) => s + p[1], 0) / 4;
  const meanDistance = points.reduce((s, p) => s + Math.hypot(p[0] - cx, p[1] - cy), 0) / 4;
  const s = Math.SQRT2 / meanDistance;
  return {
    points: points.map(([x, y]) => [(x - cx) * s, (y - cy) * s] as Vec2) as unknown as Quad,
    transform: [s, 0, -cx * s, 0, s, -cy * s, 0, 0, 1],
    inverse: [1 / s, 0, cx, 0, 1 / s, cy, 0, 0, 1],
  };
}

function solve(rows: number[][]): number[] {
  for (let col = 0; col < 8; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < 8; row += 1) {
      if (Math.abs(rows[row]![col]!) > Math.abs(rows[pivot]![col]!)) pivot = row;
    }
    if (Math.abs(rows[pivot]![col]!) <= 1e-11) {
      throw new PhotoCalibrationError('singular', 'These points do not define a stable perspective mapping.');
    }
    [rows[col], rows[pivot]] = [rows[pivot]!, rows[col]!];
    const divisor = rows[col]![col]!;
    for (let c = col; c <= 8; c += 1) rows[col]![c]! /= divisor;
    for (let row = 0; row < 8; row += 1) {
      if (row === col) continue;
      const factor = rows[row]![col]!;
      for (let c = col; c <= 8; c += 1) rows[row]![c]! -= factor * rows[col]![c]!;
    }
  }
  return rows.map((row) => row[8]!);
}

/**
 * Four-correspondence projective transform, with centroid/scale normalization
 * and partial pivoting. The row-major result uses the core Mat3 convention.
 * No camera, depth, scale or occlusion is inferred from the image.
 */
export function fitHomography(source: readonly Vec2[], destination: readonly Vec2[]): Mat3 {
  validateQuad(source);
  validateQuad(destination);
  const from = normalize(source);
  const to = normalize(destination);
  const rows: number[][] = [];
  for (let i = 0; i < 4; i += 1) {
    const [x, y] = from.points[i]!;
    const [u, v] = to.points[i]!;
    rows.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    rows.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  const coefficients = [...solve(rows), 1] as unknown as Mat3;
  const raw = mulMat3(to.inverse, mulMat3(coefficients, from.transform));
  const scale = Math.abs(raw[8]) > 1e-10 ? raw[8] : Math.max(...raw.map(Math.abs));
  const result = raw.map((v) => v / scale) as unknown as Mat3;
  if (!mat3IsFinite(result) || !invertMat3(result)) {
    throw new PhotoCalibrationError('singular', 'The perspective mapping cannot be inverted safely.');
  }
  const targetSpan = Math.max(...destination.flat().map(Math.abs), 1);
  for (let i = 0; i < 4; i += 1) {
    const mapped = applyMat3(result, source[i]!);
    if (!mapped.every(Number.isFinite) || Math.hypot(mapped[0] - destination[i]![0], mapped[1] - destination[i]![1]) > 1e-7 * targetSpan) {
      throw new PhotoCalibrationError('singular', 'The perspective mapping is numerically unstable.');
    }
  }
  return result;
}

/** Independent check points, never the four points used to fit the map. */
export function checkpointErrorPx(
  surfaceToPhoto: Mat3,
  surfacePointMm: Vec2,
  photoPoint: Vec2,
  photoWidthPx: number,
  photoHeightPx: number,
): number {
  const predicted = applyMat3(surfaceToPhoto, surfacePointMm);
  return Math.hypot((predicted[0] - photoPoint[0]) * photoWidthPx, (predicted[1] - photoPoint[1]) * photoHeightPx);
}
