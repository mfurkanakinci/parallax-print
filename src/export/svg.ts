import { LIMITS } from '../core/limits';
import { isXml10Text } from '../core/schema';
import { rasterBlocks, tileRasterRegion } from '../core/print/tiling';
import { renderRasterBlock } from '../core/raster/renderBlock';
import type {
  CompiledScene,
  CompiledSurface,
  SourcePyramid,
} from '../core/types';
import type { RenderDeps } from './pdf';
import {
  assertExportTitle,
  CanceledError,
  defaultBlockEncoder,
} from './pdf';

export function xmlEscape(text: string): string {
  // Drop code points XML 1.0 cannot represent (C0/C1 controls other than
  // tab/LF/CR, lone surrogates, U+FFFE/U+FFFF) before entity escaping, so the
  // output is always well-formed even for unsanitized input.
  let safe = '';
  for (const ch of text) {
    if (isXml10Text(ch)) safe += ch;
  }
  return safe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function base64(bytes: Uint8Array): string {
  let out = '';
  const step = 8192;
  for (let i = 0; i < bytes.length; i += step) {
    out += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(out);
}

export async function buildMasterSvg(input: {
  readonly title: string;
  readonly scene: CompiledScene;
  readonly surface: CompiledSurface;
  readonly dpi: 150 | 300;
  readonly pyramid: SourcePyramid;
  readonly deps?: RenderDeps;
}): Promise<string> {
  const { scene, surface, dpi, pyramid } = input;
  const bounds = surface.surface.boundsMm;
  assertExportTitle(input.title);
  const p = 25.4 / dpi;
  const region = tileRasterRegion(surface.surface, bounds, dpi);
  if (region.width * region.height > LIMITS.masterMaxPixels) {
    throw new RangeError(
      'Master exceeds the 24 MP budget — export the tiled volumes instead.',
    );
  }
  const clip = surface.surface.polygonMm
    .map(
      (pt) =>
        `${(pt[0] - bounds.x).toFixed(3)},${(bounds.height - (pt[1] - bounds.y)).toFixed(3)}`,
    )
    .join(' ');
  const datums = surface.surface.datums
    .map(
      (d) =>
        `${d.id}: U ${d.localMm[0].toFixed(1)} V ${d.localMm[1].toFixed(1)} mm`,
    )
    .join(' · ');
  const parts = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${bounds.width.toFixed(3)}mm" height="${bounds.height.toFixed(3)}mm" viewBox="0 0 ${bounds.width.toFixed(3)} ${bounds.height.toFixed(3)}">`,
    `<metadata>Parallax Print master — ${xmlEscape(input.title)} · surface ${surface.surface.id} · ${dpi} DPI · datums: ${xmlEscape(datums)}</metadata>`,
    `<clipPath id="surface"><polygon points="${clip}"/></clipPath>`,
    `<g clip-path="url(#surface)">`,
  ];
  let encodedBytes = parts.join('\n').length + 32;
  const encode = input.deps?.encodeBlock ?? defaultBlockEncoder();
  for (const block of rasterBlocks(region)) {
    if (input.deps?.cancellation?.isCanceled()) throw new CanceledError();
    const result = await renderRasterBlock({
      scene,
      surfaceId: surface.surface.id,
      blockPx: block,
      mmPerPixel: p,
      pyramid,
      yieldEveryRows: 16,
      ...(input.deps?.cancellation
        ? { cancellation: input.deps.cancellation }
        : {}),
      ...(input.deps?.yieldControl
        ? { yieldControl: input.deps.yieldControl }
        : {}),
    });
    if (result.status === 'canceled' || !result.pixels) {
      throw new CanceledError();
    }
    const png = await encode(block.width, block.height, result.pixels);
    const markup =
      `<image x="${((block.x - region.x) * p).toFixed(4)}" y="${((block.y - region.y) * p).toFixed(4)}" width="${(block.width * p).toFixed(4)}" height="${(block.height * p).toFixed(4)}" href="data:image/png;base64,${base64(png)}"/>`;
    encodedBytes += markup.length + 1;
    if (encodedBytes > LIMITS.bundleMaxBytes) {
      throw new RangeError(
        'The master SVG exceeds the byte limit — export the tiled volumes instead.',
      );
    }
    parts.push(markup);
  }
  parts.push('</g>', '</svg>');
  return parts.join('\n');
}
