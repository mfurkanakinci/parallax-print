import fontkit from '@pdf-lib/fontkit';
import {
  PDFDocument,
  StandardFonts,
  clip as clipOp,
  closePath as closePathOp,
  endPath as endPathOp,
  lineTo as lineToOp,
  moveTo as moveToOp,
  popGraphicsState as popGraphicsStateOp,
  pushGraphicsState as pushGraphicsStateOp,
  rgb,
  type PDFFont,
  type PDFPage,
  type RGB,
} from 'pdf-lib';
import { mmToPt } from '../core/units';
import { LIMITS } from '../core/limits';
import { isXml10Text } from '../core/schema';
import {
  rasterBlocks,
  tileRasterRegion,
  type PrintLayout,
} from '../core/print/tiling';
import { renderRasterBlock } from '../core/raster/renderBlock';
import { encodePngRgba } from '../assets/pngEncode';
import { encodeNormalizedPngBrowser } from '../assets/normalizeArtwork';
import type {
  CompiledScene,
  CompiledSurface,
  PrintSpec,
  ProjectV1,
  RasterBlockRegion,
  SourcePyramid,
  TilePlan,
} from '../core/types';
import { fingerprintPayload } from '../core/fingerprints';
import { sanitizeBasename } from './types';

const INK = rgb(0, 0, 0);
const FAINT = rgb(0.45, 0.45, 0.45);

export interface PdfFonts {
  readonly fonts: readonly PDFFont[];
  readonly charSets: readonly ReadonlySet<number>[];
}

export async function createPdf(
  fontBytes: readonly ArrayBuffer[],
  title: string,
): Promise<{ doc: PDFDocument; fonts: PdfFonts }> {
  const doc = await PDFDocument.create();
  doc.setTitle(title);
  doc.setProducer('Parallax Print (digital alpha)');
  doc.setCreator('Parallax Print');
  doc.registerFontkit(fontkit);
  const fonts: PDFFont[] = [];
  for (const bytes of fontBytes) {
    try {
      fonts.push(await doc.embedFont(bytes, { subset: true }));
    } catch {
      continue;
    }
  }
  if (fonts.length === 0) {
    fonts.push(await doc.embedFont(StandardFonts.Helvetica));
  }
  const charSets = fonts.map((f) => new Set(f.getCharacterSet()));
  return { doc, fonts: { fonts, charSets } };
}

function fontFor(fonts: PdfFonts, cp: number): PDFFont | null {
  for (let i = 0; i < fonts.fonts.length; i += 1) {
    if (fonts.charSets[i]!.has(cp)) return fonts.fonts[i]!;
  }
  return null;
}

export function sanitizeText(fonts: PdfFonts, text: string): string {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    out += fontFor(fonts, cp)
      ? ch
      : `[U+${cp.toString(16).toUpperCase().padStart(4, '0')}]`;
  }
  return out;
}

export function textWidthPt(
  fonts: PdfFonts,
  text: string,
  size: number,
): number {
  let width = 0;
  for (const ch of sanitizeText(fonts, text)) {
    const cp = ch.codePointAt(0)!;
    const font = fontFor(fonts, cp) ?? fonts.fonts[0]!;
    width += font.widthOfTextAtSize(ch, size);
  }
  return width;
}

export function wrapText(
  fonts: PdfFonts,
  text: string,
  size: number,
  maxWidthPt: number,
): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push('');
      continue;
    }
    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (textWidthPt(fonts, candidate, size) <= maxWidthPt) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      if (textWidthPt(fonts, word, size) <= maxWidthPt) {
        line = word;
        continue;
      }
      let chunk = '';
      for (const ch of word) {
        if (textWidthPt(fonts, chunk + ch, size) > maxWidthPt && chunk) {
          lines.push(chunk);
          chunk = ch;
        } else {
          chunk += ch;
        }
      }
      line = chunk;
    }
    if (line) lines.push(line);
  }
  return lines;
}

export function drawText(
  page: PDFPage,
  fonts: PdfFonts,
  text: string,
  options: { x: number; y: number; size: number; color?: RGB },
): void {
  let x = options.x;
  const safe = sanitizeText(fonts, text);
  let run = '';
  let runFont: PDFFont | null = null;
  const flush = () => {
    if (!run || !runFont) return;
    page.drawText(run, {
      x,
      y: options.y,
      size: options.size,
      font: runFont,
      color: options.color ?? INK,
    });
    x += runFont.widthOfTextAtSize(run, options.size);
    run = '';
  };
  for (const ch of safe) {
    const cp = ch.codePointAt(0)!;
    const font = fontFor(fonts, cp) ?? fonts.fonts[0]!;
    if (font !== runFont) {
      flush();
      runFont = font;
    }
    run += ch;
  }
  flush();
}

function drawCrossMm(
  page: PDFPage,
  xMm: number,
  yMm: number,
  armMm: number,
): void {
  const x = mmToPt(xMm);
  const y = mmToPt(yMm);
  const arm = mmToPt(armMm);
  page.drawLine({
    start: { x: x - arm, y },
    end: { x: x + arm, y },
    thickness: 0.4,
    color: INK,
  });
  page.drawLine({
    start: { x, y: y - arm },
    end: { x, y: y + arm },
    thickness: 0.4,
    color: INK,
  });
}

export interface RenderDeps {
  readonly cancellation?: { readonly isCanceled: () => boolean };
  readonly yieldControl?: () => Promise<void>;
  readonly encodeBlock?: (
    width: number,
    height: number,
    pixels: Uint8ClampedArray,
  ) => Promise<Uint8Array> | Uint8Array;
}

export interface RenderedBlock {
  readonly region: RasterBlockRegion;
  readonly png: Uint8Array;
}

export type BlockEncoder = NonNullable<RenderDeps['encodeBlock']>;

export function defaultBlockEncoder(): BlockEncoder {
  if (typeof OffscreenCanvas !== 'undefined') {
    return (widthPx, heightPx, pixels) =>
      encodeNormalizedPngBrowser({ widthPx, heightPx, pixels });
  }
  return encodePngRgba;
}

export async function* renderTileBlocks(
  scene: CompiledScene,
  tile: TilePlan,
  dpi: 150 | 300,
  pyramid: SourcePyramid,
  deps?: RenderDeps,
): AsyncGenerator<RenderedBlock> {
  const compiled = scene.surfaces.find((s) => s.surface.id === tile.surfaceId);
  if (!compiled) throw new RangeError('Tile refers to a missing surface.');
  const region = tileRasterRegion(compiled.surface, tile.regionMm, dpi);
  const encode = deps?.encodeBlock ?? defaultBlockEncoder();
  for (const block of rasterBlocks(region)) {
    if (deps?.cancellation?.isCanceled()) {
      throw new CanceledError();
    }
    const result = await renderRasterBlock({
      scene,
      surfaceId: tile.surfaceId,
      blockPx: block,
      mmPerPixel: 25.4 / dpi,
      pyramid,
      yieldEveryRows: 16,
      ...(deps?.cancellation ? { cancellation: deps.cancellation } : {}),
      ...(deps?.yieldControl ? { yieldControl: deps.yieldControl } : {}),
    });
    if (result.status === 'canceled' || !result.pixels) {
      throw new CanceledError();
    }
    const png = await encode(block.width, block.height, result.pixels);
    yield { region: block, png };
  }
}

export function tileClipMm(
  paperMm: { readonly width: number; readonly height: number },
  marginMm: { readonly top: number; readonly left: number },
  regionMm: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
): { x: number; y: number; width: number; height: number } {
  const pageTop = paperMm.height - marginMm.top - LIMITS.guideGutterMm;
  return {
    x: marginMm.left + LIMITS.guideGutterMm,
    y: pageTop - regionMm.height,
    width: regionMm.width,
    height: regionMm.height,
  };
}

export function blockImageMm(
  paperMm: { readonly width: number; readonly height: number },
  marginMm: { readonly top: number; readonly left: number },
  boundsMm: { readonly x: number; readonly y: number; readonly height: number },
  regionMm: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  blockPx: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  mmPerPx: number,
): { x: number; y: number; width: number; height: number } {
  const pageLeft = marginMm.left + LIMITS.guideGutterMm;
  const pageTop = paperMm.height - marginMm.top - LIMITS.guideGutterMm;
  const blockLeft = boundsMm.x + blockPx.x * mmPerPx;
  const blockBottom =
    boundsMm.y + boundsMm.height - (blockPx.y + blockPx.height) * mmPerPx;
  return {
    x: pageLeft + blockLeft - regionMm.x,
    y: pageTop + blockBottom - (regionMm.y + regionMm.height),
    width: blockPx.width * mmPerPx,
    height: blockPx.height * mmPerPx,
  };
}

export class CanceledError extends Error {
  constructor() {
    super('Export canceled.');
    this.name = 'CanceledError';
  }
}

export function assertExportTitle(title: string): void {
  if (title.length > LIMITS.titleMaxLength) {
    throw new RangeError(
      `Project titles are limited to ${LIMITS.titleMaxLength} characters — shorten the title before exporting.`,
    );
  }
  if (!isXml10Text(title)) {
    throw new RangeError(
      'The project title contains characters outside the XML 1.0 range — remove control characters before exporting.',
    );
  }
}

function neighborTiles(
  tile: TilePlan,
  all: readonly TilePlan[],
): { horizontal: TilePlan[]; vertical: TilePlan[] } {
  const horizontal: TilePlan[] = [];
  const vertical: TilePlan[] = [];
  for (const id of tile.overlapNeighbors) {
    const other = all.find((t) => t.id === id);
    if (!other) continue;
    if (other.row === tile.row) horizontal.push(other);
    else if (other.column === tile.column) vertical.push(other);
  }
  return { horizontal, vertical };
}

export interface RegistrationMark {
  readonly xMm: number;
  readonly yMm: number;
  readonly uMm: number;
  readonly vMm: number;
}

export function registrationMarksMm(
  tile: TilePlan,
  all: readonly TilePlan[],
  paperMm: { readonly width: number; readonly height: number },
  marginMm: { readonly top: number; readonly left: number },
  overlapMm: number,
): RegistrationMark[] {
  const pageLeft = marginMm.left + LIMITS.guideGutterMm;
  const pageTop = paperMm.height - marginMm.top - LIMITS.guideGutterMm;
  const r = tile.regionMm;
  const marks: RegistrationMark[] = [];
  const neighbors = neighborTiles(tile, all);
  for (const other of neighbors.horizontal) {
    const midU = Math.max(r.x, other.regionMm.x) + overlapMm / 2;
    marks.push(
      {
        xMm: pageLeft + midU - r.x,
        yMm: pageTop + 2,
        uMm: midU,
        vMm: r.y + r.height + 2,
      },
      {
        xMm: pageLeft + midU - r.x,
        yMm: pageTop - r.height - 2,
        uMm: midU,
        vMm: r.y - 2,
      },
    );
  }
  for (const other of neighbors.vertical) {
    const midV =
      Math.min(
        r.y + r.height,
        other.regionMm.y + other.regionMm.height,
      ) -
      overlapMm / 2;
    const yMm = pageTop + midV - (r.y + r.height);
    marks.push(
      { xMm: pageLeft - 2, yMm, uMm: r.x - 2, vMm: midV },
      {
        xMm: pageLeft + r.width + 2,
        yMm,
        uMm: r.x + r.width + 2,
        vMm: midV,
      },
    );
  }
  return marks;
}

function drawTrimTicksMm(
  page: PDFPage,
  clip: { x: number; y: number; width: number; height: number },
): void {
  const len = 3;
  const off = 0.5;
  const corners: [number, number, number, number][] = [
    [clip.x, clip.y + clip.height, -1, 1],
    [clip.x + clip.width, clip.y + clip.height, 1, 1],
    [clip.x, clip.y, -1, -1],
    [clip.x + clip.width, clip.y, 1, -1],
  ];
  for (const [cx, cy, dx, dy] of corners) {
    page.drawLine({
      start: { x: mmToPt(cx + dx * off), y: mmToPt(cy) },
      end: { x: mmToPt(cx + dx * (off + len)), y: mmToPt(cy) },
      thickness: 0.4,
      color: INK,
    });
    page.drawLine({
      start: { x: mmToPt(cx), y: mmToPt(cy + dy * off) },
      end: { x: mmToPt(cx), y: mmToPt(cy + dy * (off + len)) },
      thickness: 0.4,
      color: INK,
    });
  }
}

function drawCenteredTextMm(
  page: PDFPage,
  fonts: PdfFonts,
  text: string,
  centerXMm: number,
  baselineYMm: number,
  size: number,
): void {
  const width = textWidthPt(fonts, text, size);
  drawText(page, fonts, text, {
    x: mmToPt(centerXMm) - width / 2,
    y: mmToPt(baselineYMm),
    size,
    color: FAINT,
  });
}

function drawTileMarginText(
  page: PDFPage,
  fonts: PdfFonts,
  input: {
    tile: TilePlan;
    revision: string;
    paperMm: { width: number; height: number };
    marginMm: PrintSpec['marginMm'];
  },
): void {
  const { tile, paperMm, marginMm } = input;
  const r = tile.regionMm;
  const pageLeft = marginMm.left + LIMITS.guideGutterMm;
  const pageTop = paperMm.height - marginMm.top - LIMITS.guideGutterMm;
  const clipBottom = pageTop - r.height;
  const center = pageLeft + r.width / 2;
  drawCenteredTextMm(
    page,
    fonts,
    `${tile.id} · rev ${input.revision.slice(0, 12)} · UP`,
    center,
    pageTop + 2.5,
    6,
  );
  drawCenteredTextMm(
    page,
    fonts,
    `U ${r.x.toFixed(1)}..${(r.x + r.width).toFixed(1)} · V ${r.y.toFixed(1)}..${(r.y + r.height).toFixed(1)} mm · 100% scale`,
    center,
    clipBottom - 3.5,
    6,
  );
}

export async function buildArtworkVolumePdf(input: {
  readonly fonts: readonly ArrayBuffer[];
  readonly project: ProjectV1;
  readonly revisionFingerprint: string;
  readonly scene: CompiledScene;
  readonly layout: PrintLayout;
  readonly tiles: readonly TilePlan[];
  readonly pyramid: SourcePyramid;
  readonly volumeIndex: number;
  readonly deps?: RenderDeps;
  readonly onPage?: (done: number, total: number) => void;
}): Promise<Uint8Array> {
  const { scene, layout, project } = input;
  const print = project.print;
  const P = layout.paperMm;
  const m = print.marginMm;
  assertExportTitle(project.title);
  if (input.tiles.length > LIMITS.pdfVolume.maxArtworkPages) {
    throw new RangeError(
      `A volume holds at most ${LIMITS.pdfVolume.maxArtworkPages} artwork pages — select a smaller range.`,
    );
  }
  let volumePixels = 0;
  for (const tile of input.tiles) {
    const compiled = scene.surfaces.find(
      (s) => s.surface.id === tile.surfaceId,
    );
    if (!compiled) throw new RangeError('Tile refers to a missing surface.');
    const region = tileRasterRegion(compiled.surface, tile.regionMm, print.dpi);
    volumePixels += region.width * region.height;
  }
  if (volumePixels > LIMITS.pdfVolume.maxArtworkPixels) {
    throw new RangeError(
      'The selected pages exceed the 24 MP volume budget — select a smaller range.',
    );
  }
  const { doc, fonts } = await createPdf(
    input.fonts,
    `${project.title} — artwork volume ${String(input.volumeIndex + 1).padStart(2, '0')}`,
  );
  const dpi = print.dpi;
  let done = 0;
  for (const tile of input.tiles) {
    if (input.deps?.cancellation?.isCanceled()) throw new CanceledError();
    const compiled = scene.surfaces.find(
      (s) => s.surface.id === tile.surfaceId,
    );
    if (!compiled) throw new RangeError('Tile refers to a missing surface.');
    const page = doc.addPage([mmToPt(P.width), mmToPt(P.height)]);
    const r = tile.regionMm;
    const clipMm = tileClipMm(P, m, r);

    const p = 25.4 / dpi;
    const bounds = compiled.surface.boundsMm;
    page.pushOperators(pushGraphicsStateOp());
    page.pushOperators(
      moveToOp(mmToPt(clipMm.x), mmToPt(clipMm.y)),
      lineToOp(mmToPt(clipMm.x + clipMm.width), mmToPt(clipMm.y)),
      lineToOp(
        mmToPt(clipMm.x + clipMm.width),
        mmToPt(clipMm.y + clipMm.height),
      ),
      lineToOp(mmToPt(clipMm.x), mmToPt(clipMm.y + clipMm.height)),
      closePathOp(),
      clipOp(),
      endPathOp(),
    );
    for await (const block of renderTileBlocks(
      scene,
      tile,
      dpi,
      input.pyramid,
      input.deps,
    )) {
      const g = block.region;
      const image = await doc.embedPng(block.png);
      const imageMm = blockImageMm(P, m, bounds, r, g, p);
      page.drawImage(image, {
        x: mmToPt(imageMm.x),
        y: mmToPt(imageMm.y),
        width: mmToPt(imageMm.width),
        height: mmToPt(imageMm.height),
      });
    }
    page.pushOperators(popGraphicsStateOp());

    for (const mark of registrationMarksMm(
      tile,
      layout.tiles,
      P,
      m,
      print.overlapMm,
    )) {
      drawCrossMm(page, mark.xMm, mark.yMm, 1);
    }
    drawTrimTicksMm(page, clipMm);

    drawTileMarginText(page, fonts, {
      tile,
      revision: input.revisionFingerprint,
      paperMm: P,
      marginMm: m,
    });
    done += 1;
    input.onPage?.(done, input.tiles.length);
    await input.deps?.yieldControl?.();
  }
  if (input.deps?.cancellation?.isCanceled()) throw new CanceledError();
  const bytes = await doc.save();
  if (bytes.byteLength > LIMITS.bundleMaxBytes) {
    throw new RangeError('The generated volume exceeds the bundle byte limit.');
  }
  return bytes;
}

export async function buildPlacementRecipePdf(input: {
  readonly fonts: readonly ArrayBuffer[];
  readonly project: ProjectV1;
  readonly revisionFingerprint: string;
  readonly scene: CompiledScene;
  readonly layout: PrintLayout;
  readonly tiles: readonly TilePlan[];
  readonly physicalHash: string;
  readonly layoutHash: string;
}): Promise<Uint8Array> {
  const { project, scene, layout } = input;
  const print = project.print;
  const P = layout.paperMm;
  const m = print.marginMm;
  assertExportTitle(project.title);
  const { doc, fonts } = await createPdf(
    input.fonts,
    `${project.title} — placement recipe`,
  );
  const marginXPt = mmToPt(m.left + 5);
  const contentWidth = mmToPt(P.width - m.left - m.right - 10);
  // The 100 mm ruler and the footer caption live in a reserved band at the
  // bottom of every recipe page; instructions must keep their baselines at or
  // above this floor so they can never collide with them or spill off-page.
  const contentFloorPt = mmToPt(m.bottom + 22);
  const maxPages = input.tiles.length + LIMITS.guideMaxPages;
  const drawRulerAndFooter = (page: PDFPage): void => {
    const rulerY = mmToPt(m.bottom + 12);
    const rulerX = mmToPt(m.left + 5);
    page.drawLine({
      start: { x: rulerX, y: rulerY },
      end: { x: rulerX + mmToPt(100), y: rulerY },
      thickness: 0.75,
      color: INK,
    });
    for (let t = 0; t <= 100; t += 10) {
      page.drawLine({
        start: { x: rulerX + mmToPt(t), y: rulerY },
        end: { x: rulerX + mmToPt(t), y: rulerY + mmToPt(3) },
        thickness: 0.5,
        color: INK,
      });
    }
    drawText(page, fonts, '100 mm', {
      x: rulerX,
      y: rulerY + mmToPt(5),
      size: 7,
      color: FAINT,
    });
    drawText(
      page,
      fonts,
      'Parallax Print — digital alpha; physical installation unverified.',
      {
        x: marginXPt,
        y: mmToPt(m.bottom + 4),
        size: 7,
        color: INK,
      },
    );
  };
  const addPage = (): PDFPage => {
    const page = doc.addPage([mmToPt(P.width), mmToPt(P.height)]);
    drawRulerAndFooter(page);
    return page;
  };
  for (const tile of input.tiles) {
    const compiled = scene.surfaces.find(
      (s) => s.surface.id === tile.surfaceId,
    );
    if (!compiled) continue;
    let page = addPage();
    const r = tile.regionMm;
    let y = mmToPt(P.height - m.top - 10);
    const continueOnNewPage = () => {
      if (doc.getPageCount() >= maxPages) {
        throw new RangeError(
          `The placement recipe exceeds its guide budget (${LIMITS.guideMaxPages} continuation pages) — shorten the title or export fewer pages.`,
        );
      }
      page = addPage();
      y = mmToPt(P.height - m.top - 10);
      for (const line of wrapText(
        fonts,
        `${project.title} — tile ${tile.id} (continued)`,
        10,
        contentWidth,
      )) {
        drawText(page, fonts, line, { x: marginXPt, y, size: 10 });
        y -= 10 * 1.45;
      }
      drawText(
        page,
        fonts,
        `Revision ${input.revisionFingerprint.slice(0, 12)}`,
        { x: marginXPt, y, size: 7, color: FAINT },
      );
      y -= 7 * 1.45 + 4;
    };
    const emit = (text: string, size = 9, color: RGB = INK) => {
      for (const line of wrapText(fonts, text, size, contentWidth)) {
        if (y < contentFloorPt) continueOnNewPage();
        drawText(page, fonts, line, { x: marginXPt, y, size, color });
        y -= size * 1.45;
      }
    };
    emit(`${project.title} — tile ${tile.id}`, 14);
    emit(`Revision ${input.revisionFingerprint.slice(0, 12)}`, 8, FAINT);
    y -= 6;
    emit(`Surface ${tile.surfaceId} · row ${tile.row + 1} of grid · column ${tile.column + 1}`, 10);
    emit(
      `Tile region: U ${r.x.toFixed(1)} to ${(r.x + r.width).toFixed(1)} mm · V ${r.y.toFixed(1)} to ${(r.y + r.height).toFixed(1)} mm (${r.width.toFixed(1)} × ${r.height.toFixed(1)} mm)`,
    );
    emit(
      `Surface bounds: U ${compiled.surface.boundsMm.x.toFixed(1)}..${(compiled.surface.boundsMm.x + compiled.surface.boundsMm.width).toFixed(1)} · V ${compiled.surface.boundsMm.y.toFixed(1)}..${(compiled.surface.boundsMm.y + compiled.surface.boundsMm.height).toFixed(1)} mm`,
    );
    emit(`Overlap with neighbours: ${print.overlapMm} mm on shared edges.`);
    emit(
      `Neighbour tiles: ${tile.overlapNeighbors.length ? tile.overlapNeighbors.join(', ') : 'none'} — match the printed cross pairs inside the overlap band.`,
    );
    for (const datum of compiled.surface.datums) {
      const end = datum.localEndMm
        ? ` to U ${datum.localEndMm[0].toFixed(1)} V ${datum.localEndMm[1].toFixed(1)}`
        : '';
      emit(
        `Datum “${datum.label}”: U ${datum.localMm[0].toFixed(1)} V ${datum.localMm[1].toFixed(1)} mm${end}`,
      );
    }
    const seamText =
      tile.surfaceId === 'A'
        ? 'The shared seam is the U = 0 edge of this surface.'
        : tile.surfaceId === 'B'
          ? 'The shared seam is the U = panel width edge of this surface.'
          : 'Mount the base with its datum vertex at the shared corner O.';
    emit(seamText);
    emit('Registration: retain the printed tabs until the match is verified, then remove them.', 9, INK);
    emit(
      'Print at 100% scale (actual size) — never “fit to page”. Verify the 100 mm ruler before cutting.',
      9,
      INK,
    );
  }
  return doc.save();
}

export async function buildCalibrationPdf(input: {
  readonly fonts: readonly ArrayBuffer[];
  readonly project: ProjectV1;
  readonly paperMm: { width: number; height: number };
  readonly physicalHash?: string;
}): Promise<Uint8Array> {
  const { project } = input;
  const m = project.print.marginMm;
  const P = input.paperMm;
  assertExportTitle(project.title);
  const { doc, fonts } = await createPdf(
    input.fonts,
    `${project.title} — calibration sheet`,
  );
  const printHash = (await fingerprintPayload(project.print)).slice(0, 12);
  const w = new GuideWriter(doc, fonts, P, m);
  w.heading(`${project.title} — printer calibration`);
  w.line(
    `${input.physicalHash ? `Physical fingerprint ${input.physicalHash.slice(0, 12)} · ` : ''}Print settings ${printHash}`,
    8,
    FAINT,
  );
  w.gap();
  w.line(
    'Print this page at 100% scale (actual size). Do not apply “fit to page” or any anisotropic correction.',
  );
  w.line(
    `Panels: A ${project.corner.panelA.widthMm} × ${project.corner.panelA.heightMm} mm · B ${project.corner.panelB.widthMm} × ${project.corner.panelB.heightMm} mm · angle ${project.corner.angleDeg}°.`,
  );
  if (project.corner.angleMeasurement) {
    const t = project.corner.angleMeasurement;
    w.line(
      `Tape triangle: offsets ${t.offsetAMm} / ${t.offsetBMm} mm, chord ${t.chordMm} mm at height ${t.measurementHeightMm} mm.`,
    );
  }
  w.line(
    'Measure each 100 mm ruler and the 50 mm square with a metal rule. Enter the readings in the app as the calibration record. Values between 99.5 mm and 100.5 mm pass provisionally; physical installation remains unverified.',
  );
  w.line('Parallax Print — digital alpha; physical installation unverified.', 7, FAINT);
  w.gap(2);

  w.figure(115, (page) => {
    const originXMm = m.left + 5;
    const originYMm = m.bottom + 5;
    const rulerY = mmToPt(originYMm);
    const rulerX = mmToPt(originXMm);
    page.drawLine({
      start: { x: rulerX, y: rulerY },
      end: { x: rulerX + mmToPt(100), y: rulerY },
      thickness: 0.75,
      color: INK,
    });
    for (let t = 0; t <= 100; t += 10) {
      page.drawLine({
        start: { x: rulerX + mmToPt(t), y: rulerY },
        end: { x: rulerX + mmToPt(t), y: rulerY + mmToPt(4) },
        thickness: 0.5,
        color: INK,
      });
      if (t % 20 === 0) {
        drawText(page, fonts, String(t), {
          x: rulerX + mmToPt(t) - 3,
          y: rulerY - 9,
          size: 6,
          color: FAINT,
        });
      }
    }
    page.drawLine({
      start: { x: rulerX, y: rulerY },
      end: { x: rulerX, y: rulerY + mmToPt(100) },
      thickness: 0.75,
      color: INK,
    });
    for (let t = 0; t <= 100; t += 10) {
      page.drawLine({
        start: { x: rulerX, y: rulerY + mmToPt(t) },
        end: { x: rulerX - mmToPt(4), y: rulerY + mmToPt(t) },
        thickness: 0.5,
        color: INK,
      });
    }
    drawText(page, fonts, '100 mm', {
      x: rulerX + mmToPt(103),
      y: rulerY - 3,
      size: 7,
      color: FAINT,
    });
    const sqX = rulerX + mmToPt(30);
    const sqY = rulerY + mmToPt(40);
    page.drawRectangle({
      x: sqX,
      y: sqY,
      width: mmToPt(50),
      height: mmToPt(50),
      borderWidth: 0.75,
      borderColor: INK,
    });
    drawText(page, fonts, '50 × 50 mm', {
      x: sqX,
      y: sqY + mmToPt(53),
      size: 7,
      color: FAINT,
    });
  });
  return doc.save();
}

export function surfaceMapY(
  bounds: { y: number; height: number },
  scale: number,
  yTopPt: number,
  v: number,
): number {
  return yTopPt - mmToPt((bounds.y + bounds.height - v) * scale);
}

export class GuideWriter {
  private page: PDFPage;
  private yPt = 0;
  constructor(
    private readonly doc: PDFDocument,
    private readonly fonts: PdfFonts,
    private readonly paperMm: { width: number; height: number },
    private readonly marginMm: PrintSpec['marginMm'],
  ) {
    this.page = doc.addPage([
      mmToPt(paperMm.width),
      mmToPt(paperMm.height),
    ]);
    this.yPt = mmToPt(paperMm.height - marginMm.top - 10);
  }
  private ensure(neededMm: number): void {
    if (this.yPt < mmToPt(this.marginMm.bottom + neededMm)) {
      if (this.doc.getPageCount() >= LIMITS.guideMaxPages) {
        throw new RangeError(
          `The guide exceeds the ${LIMITS.guideMaxPages}-page text budget — shorten the title or reduce the selection.`,
        );
      }
      this.page = this.doc.addPage([
        mmToPt(this.paperMm.width),
        mmToPt(this.paperMm.height),
      ]);
      this.yPt = mmToPt(this.paperMm.height - this.marginMm.top - 10);
    }
  }
  line(text: string, size = 9, color: RGB = INK): void {
    const width = mmToPt(
      this.paperMm.width - this.marginMm.left - this.marginMm.right - 10,
    );
    for (const line of wrapText(this.fonts, text, size, width)) {
      this.ensure(4);
      drawText(this.page, this.fonts, line, {
        x: mmToPt(this.marginMm.left + 5),
        y: this.yPt,
        size,
        color,
      });
      this.yPt -= size * 1.45;
    }
  }
  heading(text: string): void {
    this.ensure(14);
    this.yPt -= 6;
    this.line(text, 13);
    this.yPt -= 3;
  }
  /** Reserve a caption and figure together so a caption cannot be orphaned. */
  reserve(neededMm: number): void {
    this.ensure(neededMm);
  }
  figure(
    neededMm: number,
    draw: (page: PDFPage, originXPt: number, topYPt: number) => void,
  ): void {
    this.ensure(neededMm);
    draw(this.page, mmToPt(this.marginMm.left + 5), this.yPt);
    this.yPt -= mmToPt(neededMm);
  }
  gap(mm = 4): void {
    this.yPt -= mmToPt(mm);
  }
}

export async function buildAssemblyGuidePdf(input: {
  readonly fonts: readonly ArrayBuffer[];
  readonly project: ProjectV1;
  readonly revisionFingerprint: string;
  readonly physicalHash: string;
  readonly layoutHash: string;
  readonly exportHash: string;
  readonly scene: CompiledScene;
  readonly layout: PrintLayout;
  readonly selectedTiles: readonly TilePlan[];
}): Promise<Uint8Array> {
  const { project, scene, layout } = input;
  const m = project.print.marginMm;
  assertExportTitle(project.title);
  const { doc, fonts } = await createPdf(
    input.fonts,
    `${project.title} — assembly guide`,
  );
  const w = new GuideWriter(doc, fonts, layout.paperMm, m);
  const { corner, viewpoint } = project;
  const eye = viewpoint.eyeMm;

  w.heading(`${project.title} — assembly guide`);
  w.line(
    `Revision ${input.revisionFingerprint.slice(0, 12)} · physical ${input.physicalHash.slice(0, 12)} · layout ${input.layoutHash.slice(0, 12)} · export ${input.exportHash.slice(0, 12)}`,
    8,
    FAINT,
  );
  w.line(
    'Parallax Print — digital alpha. Physical installation is not verified; measure on site before fixing anything permanently.',
    8,
    INK,
  );
  w.gap();

  w.heading('Geometry');
  w.line(
    `Interior corner ${corner.angleDeg}° · panel A (+X wall) ${corner.panelA.widthMm} × ${corner.panelA.heightMm} mm · panel B (angled wall) ${corner.panelB.widthMm} × ${corner.panelB.heightMm} mm${corner.includeBase ? ' · horizontal base included' : ''}.`,
  );
  if (corner.angleMeasurement) {
    const t = corner.angleMeasurement;
    w.line(
      `Tape-triangle measurement: offsets ${t.offsetAMm} mm and ${t.offsetBMm} mm, chord ${t.chordMm} mm at height ${t.measurementHeightMm} mm.`,
    );
  }
  for (const compiled of scene.surfaces) {
    const s = compiled.surface;
    w.line(
      `Surface ${s.id}: bounds ${s.boundsMm.width.toFixed(1)} × ${s.boundsMm.height.toFixed(1)} mm at origin U ${s.boundsMm.x.toFixed(1)} V ${s.boundsMm.y.toFixed(1)} · polygon ${s.polygonMm
        .map((p) => `(${p[0].toFixed(1)}, ${p[1].toFixed(1)})`)
        .join(' ')} · front normal (${s.frontNormal.map((n) => n.toFixed(2)).join(', ')})`,
      8,
    );
    for (const d of s.datums) {
      w.line(
        `  datum “${d.label}”: U ${d.localMm[0].toFixed(1)} V ${d.localMm[1].toFixed(1)} mm${d.localEndMm ? ` to U ${d.localEndMm[0].toFixed(1)} V ${d.localEndMm[1].toFixed(1)}` : ''}`,
        8,
        FAINT,
      );
    }
  }
  w.gap();

  w.heading('Viewpoint');
  w.line(
    `Eye point: X ${eye[0].toFixed(1)} mm, Z ${eye[2].toFixed(1)} mm on the floor plan; lens height ${eye[1].toFixed(1)} mm. Aim on the shared seam at ${viewpoint.aimHeightMm.toFixed(1)} mm.`,
  );
  w.gap();

  w.heading('Print settings');
  w.line(
    `Paper ${project.print.paper} ${project.print.orientation} · ${project.print.dpi} DPI · margins ${m.top}/${m.right}/${m.bottom}/${m.left} mm · tile-to-tile overlap ${project.print.overlapMm} mm.`,
  );
  w.line(
    'Tile-to-tile overlap is the printed band shared by neighbouring pages; mounting-to-datum references are the surface U/V coordinates on each page. Do not confuse the two.',
  );
  w.gap();

  w.heading('Inventory and tile map');
  for (const compiled of scene.surfaces) {
    const surface = compiled.surface;
    const tiles = input.selectedTiles.filter(
      (t) => t.surfaceId === surface.id,
    );
    if (tiles.length === 0) continue;
    const grid = layout.grids.find(
      (g) => g.surfaceId === surface.id,
    );
    const allSurfaceTiles = layout.tiles.filter(
      (t) => t.surfaceId === surface.id,
    );
    const b = surface.boundsMm;
    const availWidthMm = layout.paperMm.width - m.left - m.right - 10;
    const scale = Math.min(
      (availWidthMm * 0.55) / Math.max(1e-6, b.width),
      62 / Math.max(1e-6, b.height),
    );
    const figureHeightMm = Math.min(70, b.height * scale + 10);
    const selectedIds = new Set(tiles.map((t) => t.id));
    w.reserve(figureHeightMm + 10);
    w.line(
      `Surface ${surface.id}: ${tiles.length} page(s) selected${grid ? ` of a ${grid.rows}×${grid.columns} grid` : ''}.`,
    );
    w.figure(figureHeightMm, (page, x0, yTop) => {
      const mmX = (u: number) => x0 + mmToPt((u - b.x) * scale);
      const mmY = (v: number) => surfaceMapY(b, scale, yTop, v);
      const poly = surface.polygonMm;
      page.drawLine({
        start: { x: mmX(poly[poly.length - 1]![0]), y: mmY(poly[poly.length - 1]![1]) },
        end: { x: mmX(poly[0]![0]), y: mmY(poly[0]![1]) },
        thickness: 0.9,
        color: INK,
      });
      for (let i = 0; i < poly.length - 1; i += 1) {
        page.drawLine({
          start: { x: mmX(poly[i]![0]), y: mmY(poly[i]![1]) },
          end: { x: mmX(poly[i + 1]![0]), y: mmY(poly[i + 1]![1]) },
          thickness: 0.9,
          color: INK,
        });
      }
      for (const t of allSurfaceTiles) {
        const r = t.regionMm;
        const selected = selectedIds.has(t.id);
        page.drawRectangle({
          x: mmX(r.x),
          y: mmY(r.y),
          width: mmToPt(r.width * scale),
          height: mmToPt(r.height * scale),
          borderWidth: selected ? 0.8 : 0.4,
          borderColor: selected ? INK : FAINT,
          ...(selected ? {} : { opacity: 0.5 }),
        });
        const tileWidthPt = mmToPt(r.width * scale);
        const tileHeightPt = mmToPt(r.height * scale);
        // Put captions in the tile interior, away from datum vertices. For
        // narrow edge tiles use row.column; the full IDs remain in the list.
        const fullCaption = selected ? t.id : `${t.id} (not in kit)`;
        const caption = textWidthPt(fonts, fullCaption, 5) <= tileWidthPt - 4
          ? fullCaption
          : `${t.row + 1}.${t.column + 1}`;
        const captionWidth = textWidthPt(fonts, caption, 5);
        if (captionWidth <= tileWidthPt - 4 && tileHeightPt >= 12) {
          drawText(page, fonts, caption, {
            x: mmX(r.x) + (tileWidthPt - captionWidth) / 2,
            y: mmY(r.y) + tileHeightPt / 2 - 2.5,
            size: 5,
            color: selected ? INK : FAINT,
          });
        }
      }
      const markers = new Map<string, { x: number; y: number; labels: string[] }>();
      surface.datums.forEach((d, index) => {
        const key = `${d.localMm[0]},${d.localMm[1]}`;
        const existing = markers.get(key);
        if (existing) existing.labels.push(`D${index + 1}`);
        else markers.set(key, { x: mmX(d.localMm[0]), y: mmY(d.localMm[1]), labels: [`D${index + 1}`] });
      });
      for (const marker of markers.values()) {
        page.drawCircle({
          x: marker.x,
          y: marker.y,
          size: 2.4,
          borderWidth: 0.7,
          borderColor: INK,
        });
        drawText(page, fonts, marker.labels.join('/'), {
          x: marker.x + 4,
          y: Math.min(marker.y + 2, yTop - 6),
          size: 5.5,
          color: INK,
        });
      }
      drawText(page, fonts, `surface ${surface.id} — diagram, not to scale`, {
        x: x0,
        y: yTop - mmToPt(figureHeightMm) + mmToPt(3),
        size: 5.5,
        color: FAINT,
      });
    });
    surface.datums.forEach((d, index) => {
      w.line(`D${index + 1}: ${d.label}`, 8);
    });
    for (const t of tiles) {
      w.line(
        `  ${t.id} — row ${t.row + 1}, column ${t.column + 1} · region U ${t.regionMm.x.toFixed(1)}..${(t.regionMm.x + t.regionMm.width).toFixed(1)} V ${t.regionMm.y.toFixed(1)}..${(t.regionMm.y + t.regionMm.height).toFixed(1)} mm · neighbours ${t.overlapNeighbors.join(', ') || 'none'}`,
        8,
      );
    }
  }
  w.gap();

  w.heading('Mounting order');
  w.line('1. Print every page at 100% scale and verify the ruler on page one.');
  w.line(
    '2. Join tiles on each surface: the next tile overlaps the previous tile’s right or bottom band; match the printed cross pairs inside the overlap.',
  );
  w.line(
    '3. Retain the registration tabs until each match is verified, then remove the tabs.',
  );
  w.line(
    '4. Mount surface A with its U = 0 edge flush against the shared seam, then surface B with its U = width edge at the seam.',
  );
  if (corner.includeBase) {
    w.line('5. Mount the base C with its datum vertex at the shared corner O.');
  }
  w.line(`${corner.includeBase ? 6 : 5}. View from the marked eye point to check the reconstruction.`);
  w.gap();

  w.heading('Troubleshooting');
  w.line('Printer: if rulers measure outside 99.5–100.5 mm, disable scaling and reprint; record the readings as a calibration record.');
  w.line('Placement: verify each tile’s U/V region against its row/column before applying adhesive.');
  w.line('Geometry: if the image tears at the seam, re-measure the corner angle and panel widths.');
  w.line('Viewpoint: the image only resolves at the recorded eye point and aim height; off-axis viewing is expected to break.');
  return doc.save();
}

export async function buildMasterPdf(input: {
  readonly fonts: readonly ArrayBuffer[];
  readonly project: ProjectV1;
  readonly scene: CompiledScene;
  readonly surface: CompiledSurface;
  readonly dpi: 150 | 300;
  readonly pyramid: SourcePyramid;
  readonly deps?: RenderDeps;
}): Promise<Uint8Array> {
  const { scene, surface, dpi, pyramid } = input;
  const bounds = surface.surface.boundsMm;
  assertExportTitle(input.project.title);
  const p = 25.4 / dpi;
  const region = tileRasterRegion(surface.surface, bounds, dpi);
  const widthPx = region.width;
  const heightPx = region.height;
  if (widthPx * heightPx > LIMITS.masterMaxPixels) {
    throw new RangeError(
      'Master exceeds the 24 MP budget — export the tiled volumes instead.',
    );
  }
  const { doc } = await createPdf(
    input.fonts,
    `${input.project.title} — master surface ${surface.surface.id}`,
  );
  const page = doc.addPage([mmToPt(bounds.width), mmToPt(bounds.height)]);
  page.pushOperators(pushGraphicsStateOp());
  const poly = surface.surface.polygonMm;
  page.pushOperators(
    moveToOp(mmToPt(poly[0]![0] - bounds.x), mmToPt(poly[0]![1] - bounds.y)),
    ...poly
      .slice(1)
      .map((pt) =>
        lineToOp(mmToPt(pt[0] - bounds.x), mmToPt(pt[1] - bounds.y)),
      ),
    closePathOp(),
    clipOp(),
    endPathOp(),
  );
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
    const image = await doc.embedPng(png);
    page.drawImage(image, {
      x: mmToPt(block.x * p),
      y: mmToPt(bounds.height - (block.y + block.height) * p),
      width: mmToPt(block.width * p),
      height: mmToPt(block.height * p),
    });
  }
  page.pushOperators(popGraphicsStateOp());
  const bytes = await doc.save();
  if (bytes.byteLength > LIMITS.bundleMaxBytes) {
    throw new RangeError('The generated master exceeds the byte limit.');
  }
  return bytes;
}

export function volumeFilename(
  title: string,
  volumeIndex: number,
): string {
  return `${sanitizeBasename(title)}-artwork-v${String(volumeIndex + 1).padStart(2, '0')}.pdf`;
}
