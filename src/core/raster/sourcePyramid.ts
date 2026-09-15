import { LIMITS } from '../limits';
import type { SourceLevel, SourcePyramid } from '../types';
import { linearToSrgbByte, SRGB_TO_LINEAR } from './sample';

const DEFAULT_MAX_LEVELS = 14;

function downsampleArea(level: SourceLevel): SourceLevel {
  const sw = level.widthPx;
  const sh = level.heightPx;
  const dw = Math.max(1, Math.floor(sw / 2));
  const dh = Math.max(1, Math.floor(sh / 2));
  const out = new Uint8ClampedArray(dw * dh * 4);
  const rx = sw / dw;
  const ry = sh / dh;
  for (let y = 0; y < dh; y += 1) {
    const y0 = y * ry;
    const y1 = (y + 1) * ry;
    for (let x = 0; x < dw; x += 1) {
      const x0 = x * rx;
      const x1 = (x + 1) * rx;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let area = 0;
      for (let sy = Math.floor(y0); sy < Math.ceil(y1) && sy < sh; sy += 1) {
        const wy = Math.min(y1, sy + 1) - Math.max(y0, sy);
        if (wy <= 0) continue;
        for (let sx = Math.floor(x0); sx < Math.ceil(x1) && sx < sw; sx += 1) {
          const wx = Math.min(x1, sx + 1) - Math.max(x0, sx);
          const w = wx * wy;
          if (w <= 0) continue;
          const i = (sy * sw + sx) * 4;
          const alpha = level.pixels[i + 3]! / 255;
          r += SRGB_TO_LINEAR[level.pixels[i]!]! * alpha * w;
          g += SRGB_TO_LINEAR[level.pixels[i + 1]!]! * alpha * w;
          b += SRGB_TO_LINEAR[level.pixels[i + 2]!]! * alpha * w;
          a += alpha * w;
          area += w;
        }
      }
      const o = (y * dw + x) * 4;
      const avgA = area > 0 ? a / area : 0;
      if (a > 0) {
        out[o] = linearToSrgbByte(r / a);
        out[o + 1] = linearToSrgbByte(g / a);
        out[o + 2] = linearToSrgbByte(b / a);
      }
      out[o + 3] = Math.round(avgA * 255);
    }
  }
  return { widthPx: dw, heightPx: dh, pixels: out };
}

export function buildSourcePyramid(
  widthPx: number,
  heightPx: number,
  pixels: Uint8ClampedArray,
  maxLevels = DEFAULT_MAX_LEVELS,
): SourcePyramid {
  if (
    !Number.isSafeInteger(widthPx) ||
    !Number.isSafeInteger(heightPx) ||
    widthPx < 1 ||
    heightPx < 1 ||
    widthPx > LIMITS.source.maxSidePx ||
    heightPx > LIMITS.source.maxSidePx ||
    widthPx * heightPx > LIMITS.source.maxMegapixels * 1_000_000 ||
    !Number.isSafeInteger(maxLevels) ||
    maxLevels < 1 ||
    maxLevels > 14 ||
    pixels.length !== widthPx * heightPx * 4
  ) {
    throw new RangeError('Source pyramid is outside supported limits.');
  }
  const levels: SourceLevel[] = [{ widthPx, heightPx, pixels }];
  while (
    levels.length < maxLevels &&
    (levels[levels.length - 1]!.widthPx > 1 ||
      levels[levels.length - 1]!.heightPx > 1)
  ) {
    levels.push(downsampleArea(levels[levels.length - 1]!));
  }
  return { widthPx, heightPx, levels };
}
