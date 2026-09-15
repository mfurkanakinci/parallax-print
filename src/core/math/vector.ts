import type { Vec2, Vec3 } from '../types';

export const vec3 = (x: number, y: number, z: number): Vec3 => [x, y, z];

export const add3 = (a: Vec3, b: Vec3): Vec3 => [
  a[0] + b[0],
  a[1] + b[1],
  a[2] + b[2],
];

export const sub3 = (a: Vec3, b: Vec3): Vec3 => [
  a[0] - b[0],
  a[1] - b[1],
  a[2] - b[2],
];

export const scale3 = (a: Vec3, s: number): Vec3 => [
  a[0] * s,
  a[1] * s,
  a[2] * s,
];

export const dot3 = (a: Vec3, b: Vec3): number =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export const cross3 = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

export const length3 = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);

export function normalize3(a: Vec3): Vec3 | null {
  const len = length3(a);
  if (!Number.isFinite(len) || len < 1e-12) return null;
  return [a[0] / len, a[1] / len, a[2] / len];
}

export const dot2 = (a: Vec2, b: Vec2): number => a[0] * b[0] + a[1] * b[1];

export function isFiniteVec2(v: Vec2): boolean {
  return Number.isFinite(v[0]) && Number.isFinite(v[1]);
}

export function isFiniteVec3(v: Vec3): boolean {
  return (
    Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2])
  );
}
