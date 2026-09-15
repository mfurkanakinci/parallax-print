import type { SourceLevel, SourcePyramid } from '../types';

export const SRGB_TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i += 1) {
  const c = i / 255;
  SRGB_TO_LINEAR[i] =
    c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function linearToSrgbByte(linear: number): number {
  const x = Math.min(1, Math.max(0, linear));
  const c = x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
  return Math.round(c * 255);
}

export type PremultipliedLinear = readonly [number, number, number, number];

export function texelPremultiplied(
  level: SourceLevel,
  x: number,
  y: number,
): PremultipliedLinear {
  const i = (y * level.widthPx + x) * 4;
  const a = level.pixels[i + 3]! / 255;
  return [
    SRGB_TO_LINEAR[level.pixels[i]!]! * a,
    SRGB_TO_LINEAR[level.pixels[i + 1]!]! * a,
    SRGB_TO_LINEAR[level.pixels[i + 2]!]! * a,
    a,
  ];
}

export function sampleLevelBilinear(
  level: SourceLevel,
  s: number,
  t: number,
): PremultipliedLinear {
  const w = level.widthPx;
  const h = level.heightPx;
  const x = Math.min(Math.max(s * w - 0.5, 0), w - 1);
  const y = Math.min(Math.max(t * h - 0.5, 0), h - 1);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, w - 1);
  const y1 = Math.min(y0 + 1, h - 1);
  const fx = x - x0;
  const fy = y - y0;
  const p00 = texelPremultiplied(level, x0, y0);
  const p10 = texelPremultiplied(level, x1, y0);
  const p01 = texelPremultiplied(level, x0, y1);
  const p11 = texelPremultiplied(level, x1, y1);
  const out = [0, 0, 0, 0] as [number, number, number, number];
  for (let c = 0; c < 4; c += 1) {
    const top = p00[c]! * (1 - fx) + p10[c]! * fx;
    const bottom = p01[c]! * (1 - fx) + p11[c]! * fx;
    out[c] = top * (1 - fy) + bottom * fy;
  }
  return out;
}

export function samplePyramidLinear(
  pyramid: SourcePyramid,
  s: number,
  t: number,
  lod: number,
): PremultipliedLinear {
  const maxLevel = pyramid.levels.length - 1;
  const clamped = Math.min(Math.max(lod, 0), maxLevel);
  const lo = Math.floor(clamped);
  const hi = Math.min(lo + 1, maxLevel);
  const frac = clamped - lo;
  const a = sampleLevelBilinear(pyramid.levels[lo]!, s, t);
  if (hi === lo || frac <= 0) return a;
  const b = sampleLevelBilinear(pyramid.levels[hi]!, s, t);
  return [
    a[0] * (1 - frac) + b[0] * frac,
    a[1] * (1 - frac) + b[1] * frac,
    a[2] * (1 - frac) + b[2] * frac,
    a[3] * (1 - frac) + b[3] * frac,
  ];
}

export function encodePremultToSrgb(
  premult: PremultipliedLinear,
): [number, number, number, number] {
  const alpha = premult[3];
  if (alpha <= 0) return [0, 0, 0, 0];
  const invA = 1 / alpha;
  return [
    linearToSrgbByte(premult[0] * invA),
    linearToSrgbByte(premult[1] * invA),
    linearToSrgbByte(premult[2] * invA),
    Math.round(Math.min(1, Math.max(0, alpha)) * 255),
  ];
}

export function samplePyramid(
  pyramid: SourcePyramid,
  s: number,
  t: number,
  lod: number,
): [number, number, number, number] {
  return encodePremultToSrgb(samplePyramidLinear(pyramid, s, t, lod));
}
