import type { Mat3, Vec2 } from '../types';

export const identity3 = (): Mat3 => [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function mulMat3(a: Mat3, b: Mat3): Mat3 {
  const out = new Array<number>(9);
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 3; c += 1) {
      out[r * 3 + c] =
        a[r * 3]! * b[c]! + a[r * 3 + 1]! * b[3 + c]! + a[r * 3 + 2]! * b[6 + c]!;
    }
  }
  return out as unknown as Mat3;
}

export function applyMat3(m: Mat3, v: Vec2): Vec2 {
  const w = m[6] * v[0] + m[7] * v[1] + m[8];
  return [
    (m[0] * v[0] + m[1] * v[1] + m[2]) / w,
    (m[3] * v[0] + m[4] * v[1] + m[5]) / w,
  ];
}

export function applyMat3Homogeneous(m: Mat3, v: Vec2): Vec3Out {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2],
    m[3] * v[0] + m[4] * v[1] + m[5],
    m[6] * v[0] + m[7] * v[1] + m[8],
  ];
}

export type Vec3Out = [number, number, number];

export function mat3IsFinite(m: Mat3): boolean {
  for (let i = 0; i < 9; i += 1) {
    if (!Number.isFinite(m[i])) return false;
  }
  return true;
}

export function invertMat3(m: Mat3): Mat3 | null {
  const a: number[][] = [
    [m[0], m[1], m[2], 1, 0, 0],
    [m[3], m[4], m[5], 0, 1, 0],
    [m[6], m[7], m[8], 0, 0, 1],
  ];
  const scale = Math.max(...m.map((v) => Math.abs(v)), 1e-300);
  const pivotEps = 1e-12 * scale;
  for (let col = 0; col < 3; col += 1) {
    let pivot = col;
    let best = Math.abs(a[col]![col]!);
    for (let r = col + 1; r < 3; r += 1) {
      const v = Math.abs(a[r]![col]!);
      if (v > best) {
        best = v;
        pivot = r;
      }
    }
    if (best < pivotEps) return null;
    if (pivot !== col) {
      const tmp = a[pivot]!;
      a[pivot] = a[col]!;
      a[col] = tmp;
    }
    const inv = 1 / a[col]![col]!;
    for (let r = 0; r < 3; r += 1) {
      if (r === col) continue;
      const f = a[r]![col]! * inv;
      if (f === 0) continue;
      for (let c = 0; c < 6; c += 1) {
        a[r]![c]! -= f * a[col]![c]!;
      }
    }
  }
  const out = new Array<number>(9);
  for (let r = 0; r < 3; r += 1) {
    const d = a[r]![r]!;
    if (!Number.isFinite(d) || Math.abs(d) < pivotEps) return null;
    for (let c = 0; c < 3; c += 1) {
      out[r * 3 + c] = a[r]![3 + c]! / d;
    }
  }
  const result = out as unknown as Mat3;
  if (!mat3IsFinite(result)) return null;
  return result;
}

export function mat3ResidualMm(forward: Mat3, inverse: Mat3, points: readonly Vec2[]): number {
  const roundTrip = mulMat3(inverse, forward);
  let worst = 0;
  for (const p of points) {
    const back = applyMat3(roundTrip, p);
    const err = Math.hypot(back[0] - p[0], back[1] - p[1]);
    if (!Number.isFinite(err)) return Number.POSITIVE_INFINITY;
    if (err > worst) worst = err;
  }
  return worst;
}
