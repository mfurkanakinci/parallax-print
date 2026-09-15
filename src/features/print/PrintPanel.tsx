import { useCallback, useMemo, useState } from 'react';
import { Disclosure } from '../../components/Disclosure';
import { MeasurementField } from '../../components/MeasurementField';
import { PageMap } from './PageMap';
import { ExportSection, type VolumeSelection } from './ExportSection';
import { planTiles, type PrintLayout } from '../../core/print/tiling';
import { estimateKitBytes } from '../../export/bundle';
import { LIMITS } from '../../core/limits';
import { formatMm } from '../../core/units';
import type {
  CalibrationRecord,
  CompiledScene,
  DisplayUnit,
  Issue,
  PrintSpec,
  ProjectV1,
  SurfaceId,
} from '../../core/types';
import type { StoredAsset, StoredPhoto } from '../../persistence/types';
import type { ExportStarter } from './ExportSection';
import type { ExportJobState } from '../../state/exportController';
import { useProjectStore } from '../../state/projectStore';
import '../../styles/production-panels.css';

const PAPERS = ['a4', 'letter', 'a3'] as const;
const DPIS = [150, 300] as const;

export function PrintPanel({
  project,
  scene,
  issues,
  readOnly,
  asset,
  calibration,
  exportJob,
  readyFile,
  onStartExport,
  onCancelExport,
  onDownloadExport,
  onClearExport,
  commandDockTarget = null,
  receiptTarget = null,
  photo = undefined,
}: {
  readonly project: ProjectV1;
  readonly scene: CompiledScene | null;
  readonly issues: readonly Issue[];
  readonly readOnly: boolean;
  readonly asset: StoredAsset | null;
  readonly calibration: CalibrationRecord | null;
  readonly exportJob: ExportJobState | null;
  readonly readyFile: { blob: Blob; filename: string } | null;
  readonly onStartExport: ExportStarter;
  readonly onCancelExport: () => void;
  readonly onDownloadExport: () => void;
  readonly onClearExport: () => void;
  /** The editor's sole command slot; export action ownership stays in ExportSection. */
  readonly commandDockTarget?: HTMLElement | null;
  /** Internal receipt slot, kept immediately below the Print heading. */
  readonly receiptTarget?: HTMLElement | null;
  /** Optional local reference photo retained in kit archive backups. */
  readonly photo?: StoredPhoto | null | undefined;
}) {
  const commit = useProjectStore((s) => s.commit);
  const print = project.print;
  const unit = project.displayUnit;
  const existing = new Set(scene?.surfaces.map((s) => s.surface.id) ?? []);

  const setPrint = (patch: Partial<PrintSpec>) =>
    commit((doc) => ({
      ...doc,
      project: { ...doc.project, print: { ...doc.project.print, ...patch } },
    }));

  const { layout, layoutError } = useMemo<{
    layout: PrintLayout | null;
    layoutError: string | null;
  }>(() => {
    if (!scene) return { layout: null, layoutError: null };
    try {
      return { layout: planTiles(scene, print), layoutError: null };
    } catch (e) {
      return {
        layout: null,
        layoutError:
          e instanceof RangeError ? e.message : 'Print planning failed.',
      };
    }
  }, [scene, print]);

  // §16.1/§16.2: the volume selection is owned here so the page summary and
  // the export production area always describe the same set.
  const [selectedVolumes, setSelectedVolumes] = useState<Set<number> | null>(
    null,
  );
  const [receiptSlot, setReceiptSlot] = useState<HTMLElement | null>(null);
  const setReceiptSlotRef = useCallback((node: HTMLElement | null) => {
    setReceiptSlot(node);
  }, []);
  const selection: VolumeSelection = useMemo(() => {
    const volumes = layout?.volumes ?? [];
    const activeVolumes = new Set(
      volumes
        .filter(
          (volume) =>
            selectedVolumes === null || selectedVolumes.has(volume.index),
        )
        .map((volume) => volume.index),
    );
    const selectedTiles = (layout?.tiles ?? []).filter((t) =>
      volumes.some(
        (v) => activeVolumes.has(v.index) && v.tileIds.includes(t.id),
      ),
    );
    const selectedPixels = selectedTiles.length
      ? volumes
          .filter((v) => activeVolumes.has(v.index))
          .reduce((s, v) => s + v.pixelCount, 0)
      : 0;
    const kitEstimateBytes = estimateKitBytes({
      artworkPixels: selectedPixels,
      tileCount: selectedTiles.length,
      sourceBytes: asset ? asset.normalizedPng.size : 0,
      photoBytes: photo?.asset.normalizedPng.size ?? 0,
    });
    return {
      volumes,
      activeVolumes,
      selectedTileIds: selectedTiles.map((t) => t.id),
      selectedTileCount: selectedTiles.length,
      kitEstimateBytes,
      kitFits:
        kitEstimateBytes <= LIMITS.bundleMaxBytes &&
        selectedTiles.length <= LIMITS.exportMaxPages,
      onToggleVolume: (index: number, checked: boolean) => {
        const next = new Set(activeVolumes);
        if (checked) next.add(index);
        else next.delete(index);
        setSelectedVolumes(next);
      },
    };
  }, [layout, selectedVolumes, asset, photo]);

  return (
    <div className="panel m4-production m4-print-panel">
      <h2>Print</h2>
      <p className="m4-panel-intro">
        Choose the paper setup, then generate a frozen production kit.
      </p>
      <div
        ref={setReceiptSlotRef}
        className="m4-print-receipt-slot"
        aria-live="polite"
      />
      <p className="print-summary m4-print-summary">
        <strong>
          {print.paper.toUpperCase()} {print.orientation} · {print.dpi} DPI
        </strong>
        {layout ? (
          <>
            <span>
              {selection.selectedTileCount} of {layout.tiles.length} page
            {layout.tiles.length === 1 ? '' : 's'} selected ·{' '}
            {selection.activeVolumes.size} of {selection.volumes.length} volume
            {selection.volumes.length === 1 ? '' : 's'} · ~
            {(selection.kitEstimateBytes / (1024 * 1024)).toFixed(1)} MiB
            estimated
            </span>
          </>
        ) : (
          <span>Page plan unavailable.</span>
        )}
      </p>
      <fieldset className="field-group" disabled={readOnly}>
        <legend>Paper setup</legend>
        <div className="m4-paper-grid">
          <div className="field">
            <label htmlFor="print-paper">Paper size</label>
            <select
              id="print-paper"
              value={print.paper}
              onChange={(e) =>
                setPrint({ paper: e.target.value as PrintSpec['paper'] })
              }
            >
              {PAPERS.map((p) => (
                <option key={p} value={p}>
                  {p.toUpperCase()}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="print-orientation">Orientation</label>
            <select
              id="print-orientation"
              value={print.orientation}
              onChange={(e) =>
                setPrint({
                  orientation: e.target.value as PrintSpec['orientation'],
                })
              }
            >
              <option value="portrait">Portrait</option>
              <option value="landscape">Landscape</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="print-dpi">Resolution</label>
            <select
              id="print-dpi"
              value={print.dpi}
              onChange={(e) =>
                setPrint({ dpi: Number(e.target.value) as 150 | 300 })
              }
            >
              {DPIS.map((d) => (
                <option key={d} value={d}>
                  {d} DPI
                </option>
              ))}
            </select>
          </div>
        </div>
      </fieldset>
      <fieldset className="field-group" disabled={readOnly}>
        <legend>Surfaces to print</legend>
        {(['A', 'B', 'C'] as const).map((id: SurfaceId) => (
          <label key={id} className="check-row">
            <input
              type="checkbox"
              checked={print.surfaceIds.includes(id)}
              disabled={readOnly || !existing.has(id)}
              onChange={(e) =>
                setPrint({
                  surfaceIds: e.target.checked
                    ? [...print.surfaceIds, id]
                    : print.surfaceIds.filter((s) => s !== id),
                })
              }
            />
            {id === 'A' ? 'Panel A' : id === 'B' ? 'Panel B' : 'Floor C'}
            {!existing.has(id) ? ' (not in this corner)' : ''}
          </label>
        ))}
      </fieldset>
      <Disclosure
        title="Margins & overlap"
        description="Printer-safe edges and tile assembly overlap."
      >
        <fieldset className="field-group" disabled={readOnly}>
          <legend>Margins ({formatRange(unit)})</legend>
        <MeasurementField
          id="margin-top"
          label="Top"
          valueMm={print.marginMm.top}
          unit={unit}
          minMm={LIMITS.marginMm.min}
          maxMm={LIMITS.marginMm.max}
          onCommit={(mm) => setPrint({ marginMm: { ...print.marginMm, top: mm } })}
        />
        <MeasurementField
          id="margin-right"
          label="Right"
          valueMm={print.marginMm.right}
          unit={unit}
          minMm={LIMITS.marginMm.min}
          maxMm={LIMITS.marginMm.max}
          onCommit={(mm) => setPrint({ marginMm: { ...print.marginMm, right: mm } })}
        />
        <MeasurementField
          id="margin-bottom"
          label="Bottom"
          valueMm={print.marginMm.bottom}
          unit={unit}
          minMm={LIMITS.marginMm.min}
          maxMm={LIMITS.marginMm.max}
          onCommit={(mm) => setPrint({ marginMm: { ...print.marginMm, bottom: mm } })}
        />
        <MeasurementField
          id="margin-left"
          label="Left"
          valueMm={print.marginMm.left}
          unit={unit}
          minMm={LIMITS.marginMm.min}
          maxMm={LIMITS.marginMm.max}
          onCommit={(mm) => setPrint({ marginMm: { ...print.marginMm, left: mm } })}
        />
        <MeasurementField
          id="print-overlap"
          label="Tile overlap"
          valueMm={print.overlapMm}
          unit={unit}
          minMm={LIMITS.overlapMm.min}
          maxMm={LIMITS.overlapMm.max}
          description="The printed overlap where two pages butt together."
          onCommit={(mm) => setPrint({ overlapMm: mm })}
        />
        </fieldset>
      </Disclosure>
      {layoutError ? (
        <p className="field-error" role="alert">
          {layoutError}
        </p>
      ) : null}
      {layout ? (
        <section aria-label="Page plan">
          <h3>Page plan</h3>
          <PageMap layout={layout} unit={unit} />
        </section>
      ) : null}
      <ExportSection
        commandDockTarget={commandDockTarget}
        project={project}
        scene={scene}
        layout={layout}
        asset={asset}
        compileIssues={issues}
        calibration={calibration}
        job={exportJob}
        readyFile={readyFile}
        selection={selection}
        onStart={onStartExport}
        onCancel={onCancelExport}
        onDownload={onDownloadExport}
        onClearReady={onClearExport}
        receiptTarget={receiptTarget ?? receiptSlot}
        photo={photo}
      />
    </div>
  );
}

function formatRange(unit: DisplayUnit) {
  return `${formatMm(LIMITS.marginMm.min, unit)}–${formatMm(
    LIMITS.marginMm.max,
    unit,
  )}`;
}
