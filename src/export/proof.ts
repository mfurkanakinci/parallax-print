import { buildSourcePyramid } from '../core/raster/sourcePyramid';
import type { SourcePyramid } from '../core/types';

export function diagnosticPyramid(aspect: number): SourcePyramid {
  if (!Number.isFinite(aspect) || aspect <= 0) {
    throw new RangeError('Invalid artwork aspect');
  }
  const widthPx =
    aspect >= 1 ? 512 : Math.max(1, Math.round(512 * aspect));
  const heightPx =
    aspect >= 1 ? Math.max(1, Math.round(512 / aspect)) : 512;
  const pixels = new Uint8ClampedArray(widthPx * heightPx * 4);
  pixels.fill(255);
  const set = (x: number, y: number, v: number) => {
    if (x < 0 || y < 0 || x >= widthPx || y >= heightPx) return;
    const i = (y * widthPx + x) * 4;
    pixels[i] = v;
    pixels[i + 1] = v;
    pixels[i + 2] = v;
  };
  for (let x = 0; x < widthPx; x += 32) {
    for (let y = 0; y < heightPx; y += 1) set(x, y, 200);
  }
  for (let y = 0; y < heightPx; y += 32) {
    for (let x = 0; x < widthPx; x += 1) set(x, y, 200);
  }
  for (let i = 0; i < Math.max(widthPx, heightPx); i += 1) {
    set(i, Math.round((i * heightPx) / widthPx), 40);
    set(i, heightPx - 1 - Math.round((i * heightPx) / widthPx), 40);
  }
  for (let y = 8; y < Math.min(40, heightPx); y += 1) {
    for (let x = 8; x < Math.min(40, widthPx); x += 1) set(x, y, 0);
  }
  for (
    let y = Math.max(0, heightPx - 40);
    y < Math.max(0, heightPx - 8);
    y += 1
  ) {
    for (
      let x = Math.max(0, widthPx - 24);
      x < Math.max(0, widthPx - 8);
      x += 1
    ) {
      set(x, y, 0);
    }
  }
  return buildSourcePyramid(widthPx, heightPx, pixels);
}
