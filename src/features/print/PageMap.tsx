import { Disclosure } from '../../components/Disclosure';
import type { PrintLayout } from '../../core/print/tiling';
import { formatMm } from '../../core/units';
import type { DisplayUnit } from '../../core/types';

export function PageMap({
  layout,
  unit,
}: {
  readonly layout: PrintLayout;
  readonly unit: DisplayUnit;
}) {
  const plannedCells = layout.grids.reduce(
    (total, g) => total + g.rows * g.columns,
    0,
  );
  const skipped = plannedCells - layout.tiles.length;
  const volumeForTile = new Map(
    layout.volumes.flatMap((volume) =>
      volume.tileIds.map((tileId) => [tileId, volume.index] as const),
    ),
  );
  return (
    <div className="page-map m4-page-map">
      <p className="page-map-summary">
        {layout.tiles.length} page{layout.tiles.length === 1 ? '' : 's'} across{' '}
        {layout.volumes.length} volume
        {layout.volumes.length === 1 ? '' : 's'}
        {skipped > 0
          ? ` · ${skipped} blank cell${skipped === 1 ? '' : 's'} skipped`
          : ''}
        {' · '}
        {(layout.estimatedBytes / (1024 * 1024)).toFixed(1)} MiB estimated.
      </p>
      <ul className="grid-summary" aria-label="Surface page grids">
        {layout.grids.map((g) => (
          <li key={g.surfaceId}>
            Surface {g.surfaceId}: {g.columns}×{g.rows} grid
          </li>
        ))}
      </ul>
      <Disclosure
        title="Exact tile plan"
        description="Every page in print order with its surface coordinates."
      >
        <ol className="tile-list">
          {layout.tiles.map((tile) => (
            <li key={tile.id}>
              <span className="tile-id">{tile.id}</span>{' '}
              <span className="tile-volume">
                Volume {(volumeForTile.get(tile.id) ?? 0) + 1}
              </span>{' '}
              <span className="tile-region">
                {formatMm(tile.regionMm.width, unit)} ×{' '}
                {formatMm(tile.regionMm.height, unit)} at U
                {formatMm(tile.regionMm.x, unit)}, V
                {formatMm(tile.regionMm.y, unit)}
              </span>
            </li>
          ))}
        </ol>
      </Disclosure>
    </div>
  );
}
