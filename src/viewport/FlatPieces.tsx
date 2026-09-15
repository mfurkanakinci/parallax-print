import { useEffect, useRef } from 'react';
import type {
  CompiledScene,
  PreviewSurfaceResult,
  Surface,
} from '../core/types';
import type { PrintLayout } from '../core/print/tiling';
import { formatMm } from '../core/units';
import type { DisplayUnit } from '../core/types';

function seamCaption(surface: Surface, unit: DisplayUnit): string {
  if (surface.id === 'A') {
    return 'Seam edge is U = 0 (shared corner O).';
  }
  if (surface.id === 'B') {
    return 'Seam edge is U = panel width (shared corner O).';
  }
  const corner = surface.datums.find((d) => d.id === 'shared-corner');
  if (corner) {
    return `Shared corner O prints at U ${formatMm(corner.localMm[0], unit)}, V ${formatMm(corner.localMm[1], unit)}.`;
  }
  return 'The shared corner O is marked by the base datums.';
}

function PieceCanvas({
  preview,
  hasFootprint,
  bounds,
}: {
  readonly preview: PreviewSurfaceResult | null;
  readonly hasFootprint: boolean;
  readonly bounds: { readonly width: number; readonly height: number };
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !preview) return;
    canvas.width = preview.widthPx;
    canvas.height = preview.heightPx;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.putImageData(
      new ImageData(
        new Uint8ClampedArray(preview.pixels),
        preview.widthPx,
        preview.heightPx,
      ),
      0,
      0,
    );
    ctx.globalCompositeOperation = 'destination-over';
    ctx.fillStyle = '#fdfcf8';
    ctx.fillRect(0, 0, preview.widthPx, preview.heightPx);
  }, [preview]);
  if (!preview) {
    // The preview worker skips surfaces the artwork frame does not cover —
    // a missing preview on a footprint-less piece is a permanent empty
    // state, not a pending render.
    return (
      <div
        className="piece-placeholder"
        style={{ aspectRatio: `${bounds.width} / ${bounds.height}` }}
      >
        <span>{hasFootprint ? 'Preview pending' : 'No artwork on this piece'}</span>
      </div>
    );
  }
  return (
    <canvas
      ref={ref}
      className="piece-canvas"
      style={{
        aspectRatio: `${preview.widthPx} / ${preview.heightPx}`,
      }}
    />
  );
}

export function FlatPieces({
  scene,
  previews,
  layout,
  unit,
}: {
  readonly scene: CompiledScene | null;
  readonly previews: readonly PreviewSurfaceResult[] | null;
  readonly layout?: PrintLayout | null;
  readonly unit: DisplayUnit;
}) {
  if (!scene) {
    return (
      <div className="pieces-empty" role="note">
        <p>The current geometry cannot be previewed. Resolve the blockers.</p>
      </div>
    );
  }
  const previewById = new Map(
    (previews ?? []).map((p) => [p.surfaceId, p] as const),
  );
  return (
    <div className="flat-pieces" role="region" aria-label="Printable flat pieces" tabIndex={0}>
      {scene.surfaces.map((compiled) => {
        const { surface } = compiled;
        const bounds = surface.boundsMm;
        const preview = previewById.get(surface.id) ?? null;
        const texWidthMm = preview
          ? preview.widthPx * preview.mmPerPixel
          : bounds.width;
        const texHeightMm = preview
          ? preview.heightPx * preview.mmPerPixel
          : bounds.height;
        const uMin = bounds.x;
        const vTop = bounds.y + bounds.height;
        const toSvg = (u: number, v: number) => ({
          x: u - uMin,
          y: vTop - v,
        });
        const tiles = (layout?.tiles ?? []).filter(
          (t) => t.surfaceId === surface.id,
        );
        return (
          <figure key={surface.id} className="piece">
            <div className="piece-stage">
              <PieceCanvas
                preview={preview}
                hasFootprint={compiled.printableFootprintMm.length >= 3}
                bounds={bounds}
              />
              <svg
                className="piece-overlay"
                viewBox={`0 0 ${texWidthMm} ${texHeightMm}`}
                preserveAspectRatio="none"
                aria-hidden="true"
              >
                {compiled.printableFootprintMm.length >= 3 ? (
                  <polygon
                    points={compiled.printableFootprintMm
                      .map(([u, v]) => `${toSvg(u, v).x},${toSvg(u, v).y}`)
                      .join(' ')}
                    className="piece-footprint"
                  />
                ) : null}
                {tiles.map((tile) => {
                  const r = tile.regionMm;
                  const p = toSvg(r.x, r.y + r.height);
                  return (
                    <rect
                      key={tile.id}
                      x={p.x}
                      y={p.y}
                      width={r.width}
                      height={r.height}
                      className="piece-tile"
                    />
                  );
                })}
              </svg>
            </div>
            <figcaption className="piece-caption">
              <strong>Surface {surface.id}</strong>{' '}
              {formatMm(bounds.width, unit)} × {formatMm(bounds.height, unit)}.{' '}
              {seamCaption(surface, unit)}
            </figcaption>
          </figure>
        );
      })}
    </div>
  );
}
