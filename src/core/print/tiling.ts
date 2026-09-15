import { LIMITS } from '../limits';
import { mmPerPixel } from '../units';
import type { CompiledScene, PrintPlan, PrintSpec, RasterBlockRegion, RectMm, Surface, SurfaceId, TilePlan, Vec2, VolumePlan } from '../types';

export interface SurfaceGrid {
  readonly surfaceId: SurfaceId;
  readonly rows: number;
  readonly columns: number;
}

export interface PlannedVolume extends VolumePlan {
  readonly pixelCount: number;
}

export interface PrintLayout extends PrintPlan {
  readonly paperMm: { readonly width: number; readonly height: number };
  readonly grids: readonly SurfaceGrid[];
  readonly volumes: readonly PlannedVolume[];
  readonly pixelCount: number;
  readonly estimatedBytes: number;
}

export function polygonArea(polygon: readonly Vec2[]): number {
  if (polygon.length < 3) return 0;
  const origin = polygon[0]!;
  let twice = 0;
  for (let i = 1; i < polygon.length - 1; i += 1) {
    const p = polygon[i]!;
    const q = polygon[i + 1]!;
    twice += (p[0] - origin[0]) * (q[1] - origin[1]) - (p[1] - origin[1]) * (q[0] - origin[0]);
  }
  return Math.abs(twice) / 2;
}

export function clipToRect(polygon: readonly Vec2[], rect: RectMm): Vec2[] {
  let output = [...polygon];
  const planes = [
    (p: Vec2) => p[0] - rect.x,
    (p: Vec2) => rect.x + rect.width - p[0],
    (p: Vec2) => p[1] - rect.y,
    (p: Vec2) => rect.y + rect.height - p[1],
  ];
  for (const distance of planes) {
    const input = output;
    output = [];
    for (let i = 0; i < input.length; i += 1) {
      const p = input[i]!;
      const q = input[(i + 1) % input.length]!;
      const a = distance(p);
      const b = distance(q);
      if (a >= 0) output.push(p);
      if ((a >= 0) !== (b >= 0)) {
        const t = a / (a - b);
        output.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]);
      }
    }
  }
  return polygonArea(output) > 0 ? output : [];
}

export function paperDimensions(print: PrintSpec): { width: number; height: number } {
  const paper = LIMITS.paperMm[print.paper];
  if (!paper || !['portrait', 'landscape'].includes(print.orientation)) throw new RangeError('Choose a supported paper and orientation.');
  return print.orientation === 'landscape' ? { width: paper.height, height: paper.width } : { ...paper };
}

export function tileRasterRegion(surface: Surface, region: RectMm, dpi: 150 | 300): RasterBlockRegion {
  const pitch = mmPerPixel(dpi);
  const left = (region.x - surface.boundsMm.x) / pitch;
  const top = (surface.boundsMm.y + surface.boundsMm.height - region.y - region.height) / pitch;
  const right = (region.x + region.width - surface.boundsMm.x) / pitch;
  const bottom = (surface.boundsMm.y + surface.boundsMm.height - region.y) / pitch;
  const x = Math.floor(left + 1e-9);
  const y = Math.floor(top + 1e-9);
  return { x, y, width: Math.ceil(right - 1e-9) - x, height: Math.ceil(bottom - 1e-9) - y };
}

export function rasterBlocks(region: RasterBlockRegion): RasterBlockRegion[] {
  if (![region.x, region.y, region.width, region.height].every(Number.isSafeInteger) || region.width < 1 || region.height < 1 || region.width * region.height > LIMITS.masterMaxPixels) {
    throw new RangeError('Raster region exceeds the document pixel budget.');
  }
  const blocks: RasterBlockRegion[] = [];
  for (let y = 0; y < region.height; y += LIMITS.rasterBlockMaxPx) {
    for (let x = 0; x < region.width; x += LIMITS.rasterBlockMaxPx) {
      blocks.push({ x: region.x + x, y: region.y + y, width: Math.min(LIMITS.rasterBlockMaxPx, region.width - x), height: Math.min(LIMITS.rasterBlockMaxPx, region.height - y) });
    }
  }
  return blocks;
}

export function splitVolumes(tiles: readonly TilePlan[], scene: CompiledScene, dpi: 150 | 300): PlannedVolume[] {
  const volumes: PlannedVolume[] = [];
  let ids: string[] = [];
  let pixels = 0;
  const flush = () => {
    if (ids.length) volumes.push({ index: volumes.length, tileIds: ids, pixelCount: pixels });
    ids = [];
    pixels = 0;
  };
  for (const tile of tiles) {
    const surface = scene.surfaces.find((s) => s.surface.id === tile.surfaceId)?.surface;
    if (!surface) throw new RangeError('Tile refers to a missing surface.');
    const region = tileRasterRegion(surface, tile.regionMm, dpi);
    const count = region.width * region.height;
    if (!Number.isSafeInteger(count) || count < 1 || count > LIMITS.pdfVolume.maxArtworkPixels) throw new RangeError('A page exceeds the document pixel budget.');
    if (ids.length >= LIMITS.pdfVolume.maxArtworkPages || pixels + count > LIMITS.pdfVolume.maxArtworkPixels) flush();
    ids.push(tile.id);
    pixels += count;
  }
  flush();
  return volumes;
}

export function volumeMemoryEstimate(
  sourcePngBytes: number,
  sourcePixels: number,
  volumePixels: number,
): number {
  return (
    2 * sourcePngBytes +
    6 * sourcePixels +
    8 * volumePixels +
    32 * 1024 * 1024
  );
}

export function planTiles(scene: CompiledScene, print: PrintSpec): PrintLayout {
  const paperMm = paperDimensions(print);
  const margins = Object.values(print.marginMm);
  if (margins.length !== 4 || margins.some((v) => !Number.isFinite(v) || v < LIMITS.marginMm.min || v > LIMITS.marginMm.max) || !Number.isFinite(print.overlapMm) || print.overlapMm < LIMITS.overlapMm.min || print.overlapMm > LIMITS.overlapMm.max || !LIMITS.dpi.allowed.includes(print.dpi)) {
    throw new RangeError('Use 5–30 mm margins, 5–20 mm overlap, and 150 or 300 DPI.');
  }
  const width = paperMm.width - print.marginMm.left - print.marginMm.right - 2 * LIMITS.guideGutterMm;
  const height = paperMm.height - print.marginMm.top - print.marginMm.bottom - 2 * LIMITS.guideGutterMm;
  const stepMm = { x: width - print.overlapMm, y: height - print.overlapMm };
  if (stepMm.x <= 0 || stepMm.y <= 0) throw new RangeError('Margins and overlap leave no usable artwork area.');
  const selected = new Set(print.surfaceIds);
  if (!selected.size || selected.size !== print.surfaceIds.length || [...selected].some((id) => !scene.surfaces.some((s) => s.surface.id === id))) throw new RangeError('Select available surfaces once each.');
  const tiles: TilePlan[] = [];
  const grids: SurfaceGrid[] = [];
  for (const compiled of scene.surfaces) {
    const { surface, printableFootprintMm } = compiled;
    if (!selected.has(surface.id)) continue;
    const bounds = surface.boundsMm;
    if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0 || bounds.width > LIMITS.baseMaxMm || bounds.height > LIMITS.baseMaxMm) throw new RangeError('Surface bounds exceed the supported print area.');
    const columns = 1 + Math.max(0, Math.ceil((bounds.width - width - scene.epsilonMm) / stepMm.x));
    const rows = 1 + Math.max(0, Math.ceil((bounds.height - height - scene.epsilonMm) / stepMm.y));
    grids.push({ surfaceId: surface.id, columns, rows });
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const tileWidth = Math.min(width, bounds.width - column * stepMm.x);
        const tileHeight = Math.min(height, bounds.height - row * stepMm.y);
        const regionMm = { x: bounds.x + column * stepMm.x, y: bounds.y + bounds.height - row * stepMm.y - tileHeight, width: tileWidth, height: tileHeight };
        if (polygonArea(clipToRect(printableFootprintMm, regionMm)) <= scene.epsilonMm * scene.epsilonMm) continue;
        tiles.push({ id: `${surface.id}-r${String(row + 1).padStart(2, '0')}-c${String(column + 1).padStart(2, '0')}`, surfaceId: surface.id, row, column, regionMm, overlapNeighbors: [] });
      }
    }
  }
  const withNeighbors = tiles.map((tile) => ({ ...tile, overlapNeighbors: tiles.filter((other) => other.surfaceId === tile.surfaceId && Math.abs(other.row - tile.row) + Math.abs(other.column - tile.column) === 1).map((other) => other.id) }));
  const volumes = splitVolumes(withNeighbors, scene, print.dpi);
  const pixelCount = volumes.reduce((total, volume) => total + volume.pixelCount, 0);
  return { tiles: withNeighbors, artworkAreaMm: { width, height }, stepMm, paperMm, grids, volumes, pixelCount, estimatedBytes: pixelCount * LIMITS.exportBytesPerPixelEstimate + tiles.length * 65_536 + 1_048_576 };
}
