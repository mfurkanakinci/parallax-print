import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Disclosure } from '../../components/Disclosure';
import { fingerprintForAckScope } from '../../core/fingerprints';
import { LIMITS } from '../../core/limits';
import { runPreflight, type PreflightResult } from '../../core/preflight/preflight';
import type { ExportKind } from '../../export/types';
import {
  buildProductionSnapshot,
  useFingerprints,
  type ExportJobState,
  type ExportStartInput,
} from '../../state/exportController';
import { loadFontBytes } from '../../assets/fonts';
import {
  tileRasterRegion,
  volumeMemoryEstimate,
  type PrintLayout,
  type PlannedVolume,
} from '../../core/print/tiling';
import type {
  CalibrationRecord,
  CompiledScene,
  Issue,
  ProjectV1,
  SurfaceId,
} from '../../core/types';
import type { EditorDocument, StoredAsset, StoredPhoto } from '../../persistence/types';
import { useProjectStore } from '../../state/projectStore';
import {
  ExportStateReceipt,
  ProductionCommandDock,
} from './productionPresentation';
import {
  exportKindLabel,
  exportProgressSummary,
  formatMiB,
} from './productionCopy';

export type ExportStarter = (input: ExportStartInput) => string;

function masterPixels(
  scene: CompiledScene | null,
  surfaceId: SurfaceId,
  dpi: 150 | 300,
): number | null {
  const s = scene?.surfaces.find((c) => c.surface.id === surfaceId);
  if (!s) return null;
  const region = tileRasterRegion(s.surface, s.surface.boundsMm, dpi);
  return region.width * region.height;
}

export interface VolumeSelection {
  readonly volumes: readonly PlannedVolume[];
  readonly activeVolumes: ReadonlySet<number>;
  readonly selectedTileIds: readonly string[];
  readonly selectedTileCount: number;
  readonly kitEstimateBytes: number;
  readonly kitFits: boolean;
  readonly onToggleVolume: (index: number, checked: boolean) => void;
}

export function ExportSection({
  project,
  scene,
  layout,
  asset,
  compileIssues,
  calibration,
  job,
  readyFile,
  selection,
  onStart,
  onCancel,
  onDownload,
  onClearReady,
  commandDockTarget = null,
  receiptTarget = null,
  photo = undefined,
}: {
  readonly project: ProjectV1;
  readonly scene: CompiledScene | null;
  readonly layout: PrintLayout | null;
  readonly asset: StoredAsset | null;
  readonly compileIssues: readonly Issue[];
  readonly calibration: CalibrationRecord | null;
  readonly job: ExportJobState | null;
  readonly readyFile: { blob: Blob; filename: string } | null;
  readonly selection: VolumeSelection;
  readonly onStart: ExportStarter;
  readonly onCancel: () => void;
  readonly onDownload: () => void;
  readonly onClearReady: () => void;
  /** Optional portal destination for the primary export action, owned by the editor shell. */
  readonly commandDockTarget?: HTMLElement | null;
  /** Optional receipt destination immediately below the Print title. */
  readonly receiptTarget?: HTMLElement | null;
  /** Optional local reference photo retained in kit archive backups. */
  readonly photo?: StoredPhoto | null | undefined;
}) {
  const acknowledgements = useProjectStore((s) => s.acknowledgements);
  const acknowledge = useProjectStore((s) => s.acknowledge);
  const draftErrors = useProjectStore((s) => s.draftErrors);
  const setStep = useProjectStore((s) => s.setStep);
  const fingerprints = useFingerprints(project, scene, asset);
  const [busy, setBusy] = useState<ExportKind | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [lastAttempt, setLastAttempt] = useState<{
    kind: ExportKind;
    volumeIndex?: number;
  } | null>(null);
  const [proofVolume, setProofVolume] = useState(0);
  const [masterSurface, setMasterSurface] = useState<SurfaceId>('A');

  const availableMasterSurfaces =
    scene?.surfaces.map((surface) => surface.surface.id) ?? [];
  const effectiveMasterSurface = availableMasterSurfaces.includes(masterSurface)
    ? masterSurface
    : (availableMasterSurfaces[0] ?? 'A');

  const preflight: PreflightResult | null = useMemo(() => {
    if (!scene) return null;
    return runPreflight({
      project,
      scene,
      compileIssues,
      layout,
      hasAsset: !!asset,
      calibration,
      physicalHash: fingerprints?.physical ?? null,
      layoutHash: fingerprints?.layout ?? null,
    });
  }, [
    scene,
    project,
    compileIssues,
    layout,
    asset,
    calibration,
    fingerprints,
  ]);

  const {
    volumes,
    activeVolumes,
    selectedTileIds,
    selectedTileCount,
    kitEstimateBytes,
    kitFits,
    onToggleVolume,
  } = selection;
  const proofTargetVolume =
    volumes[Math.min(proofVolume, Math.max(volumes.length - 1, 0))];

  // An acknowledgement is current iff the stored fingerprint equals the
  // fingerprint of the scope the issue declares (§14.2).
  const fingerprintFor = (issue: Issue) =>
    fingerprints
      ? fingerprintForAckScope(issue.ackScope, fingerprints)
      : null;
  const ackWarnings = (preflight?.warnings ?? []).filter((w) => w.ackId);
  const unacked = ackWarnings.filter(
    (w) => acknowledgements[w.ackId!] !== fingerprintFor(w),
  );

  // Structural readiness — everything an export physically needs. The
  // exempt kinds (calibration, proof) stop here; production kinds also
  // require every warning acknowledgement to be current.
  const baseReady =
    !!scene &&
    !!layout &&
    (preflight?.blockers.length ?? 1) === 0 &&
    Object.keys(draftErrors).length === 0 &&
    !!asset === !!project.artwork &&
    !!fingerprints;
  const exportReady = baseReady && unacked.length === 0;
  const canExport = exportReady && selectedTileCount > 0;
  const sourcePixels = asset ? asset.widthPx * asset.heightPx : 0;
  const sourceBytes = asset ? asset.normalizedPng.size : 0;
  const photoBytes = photo?.asset.normalizedPng.size ?? 0;
  const volumeFits = (v: PlannedVolume) =>
    volumeMemoryEstimate(sourceBytes, sourcePixels, v.pixelCount) <=
    LIMITS.bulkBufferTargetBytes;
  const kitVolumeFits = (v: PlannedVolume) =>
    volumeMemoryEstimate(sourceBytes + photoBytes, sourcePixels, v.pixelCount) <=
    LIMITS.bulkBufferTargetBytes;
  const selectedKitVolumeOverBudget = volumes.find(
    (volume) => activeVolumes.has(volume.index) && !kitVolumeFits(volume),
  );

  const overPageLimit = selectedTileCount > LIMITS.exportMaxPages;
  const overBundleLimit = kitEstimateBytes > LIMITS.bundleMaxBytes;

  const currentAckIds = () =>
    (preflight?.warnings ?? [])
      .filter(
        (w) => w.ackId && acknowledgements[w.ackId] === fingerprintFor(w),
      )
      .map((w) => w.ackId!);

  const masterPx = masterPixels(
    scene,
    effectiveMasterSurface,
    project.print.dpi,
  );
  const masterOverBudget =
    masterPx !== null && masterPx > LIMITS.masterMaxPixels;
  const masterMemoryFits =
    masterPx !== null &&
    volumeMemoryEstimate(sourceBytes, sourcePixels, masterPx) <=
      LIMITS.bulkBufferTargetBytes;
  const masterMemoryOverBudget = masterPx !== null && !masterMemoryFits;

  const blockerCount =
    (preflight?.blockers.length ?? 0) +
    Object.keys(draftErrors).length +
    (!!asset === !!project.artwork ? 0 : 1) +
    (!scene || !layout ? 1 : 0);

  const productionGateReason = (): string | null => {
    if (blockerCount > 0) {
      return `Fix ${blockerCount} blocker${blockerCount === 1 ? '' : 's'} before generating a kit.`;
    }
    if (!fingerprints && scene && layout) {
      return 'Preparing the readiness checks…';
    }
    if (unacked.length > 0) {
      return `Confirm ${unacked.length} warning${unacked.length === 1 ? '' : 's'}.`;
    }
    if (selectedTileCount === 0) {
      return 'Select at least one volume.';
    }
    if (overPageLimit) {
      return `The selected ${selectedTileCount} pages exceed the ${LIMITS.exportMaxPages}-page job limit. Select fewer volumes.`;
    }
    if (overBundleLimit) {
      return `Estimated kit size ${formatMiB(kitEstimateBytes)} exceeds the ${formatMiB(LIMITS.bundleMaxBytes)} bundle limit. Select fewer volumes or download volumes separately.`;
    }
    if (selectedKitVolumeOverBudget) {
      return `Volume ${selectedKitVolumeOverBudget.index + 1} exceeds the memory budget for this kit. Select fewer volumes or a lower resolution.`;
    }
    return null;
  };

  const exportStartReason = (
    kind: ExportKind,
    volumeIndex?: number,
  ): string | null => {
    if (kind === 'calibration') return null;
    if (kind === 'proof') {
      if (!baseReady || !project.artwork || !asset) {
        return 'Geometry proof needs a valid scene, layout, artwork, and current fields.';
      }
      const volume = volumes.find((candidate) => candidate.index === volumeIndex);
      if (!volume) return 'Choose an available proof volume.';
      if (!volumeFits(volume)) {
        return 'This proof volume exceeds the memory budget. Choose a lower resolution or larger paper.';
      }
      return null;
    }
    if (!exportReady) {
      return productionGateReason() ?? 'Production output is not ready at this revision.';
    }
    if (kind === 'kit') {
      if (selectedKitVolumeOverBudget) {
        return `Volume ${selectedKitVolumeOverBudget.index + 1} exceeds the memory budget for this kit. Select fewer volumes or a lower resolution.`;
      }
      return canExport && kitFits
        ? null
        : productionGateReason() ?? 'The selected kit cannot be generated.';
    }
    if (kind === 'volume') {
      const volume = volumes.find((candidate) => candidate.index === volumeIndex);
      if (!volume) return 'Choose an available volume.';
      if (!volumeFits(volume)) {
        return 'This volume exceeds the memory budget. Choose a lower resolution or larger paper.';
      }
      return null;
    }
    if (!project.artwork || masterPx === null) {
      return 'A master output needs an attached artwork and an available surface.';
    }
    if (masterOverBudget) {
      return `Surface ${effectiveMasterSurface} exceeds the master pixel budget. Use the tiled volumes instead.`;
    }
    if (masterMemoryOverBudget) {
      return 'Estimated master memory exceeds the device budget. Use the tiled volumes instead.';
    }
    return null;
  };

  const runExport = async (kind: ExportKind, volumeIndex?: number) => {
    if (job?.status === 'running') return;
    setStartError(null);
    const blockedReason = exportStartReason(kind, volumeIndex);
    if (blockedReason) {
      setStartError(blockedReason);
      return;
    }
    setBusy(kind);
    try {
      const fonts = await loadFontBytes();
      if (kind === 'calibration') {
        const started = onStart({ kind: 'calibration', project, fonts });
        if (!started) setStartError('Another export is already running.');
        else setLastAttempt({ kind });
        return;
      }
      if (!scene || !layout || !fingerprints) return;
      const snapshot = await buildProductionSnapshot({
        document: {
          project,
          asset,
          ...(photo !== undefined ? { photo } : {}),
        } satisfies EditorDocument,
        scene,
        layout,
        selectedTileIds:
          kind === 'volume' || kind === 'proof'
            ? (volumes.find((v) => v.index === volumeIndex)?.tileIds ?? [])
            : kind === 'master-pdf' || kind === 'master-svg'
              ? []
              : selectedTileIds,
        acknowledgements: currentAckIds(),
        calibration,
        ...(volumeIndex !== undefined ? { volumeIndex } : {}),
        ...(kind === 'master-pdf' || kind === 'master-svg'
          ? { masterSurfaceId: effectiveMasterSurface }
          : {}),
      });
      const sourcePng = asset ? await asset.normalizedPng.arrayBuffer() : null;
      const photoPng = kind === 'kit' && photo
        ? await photo.asset.normalizedPng.arrayBuffer()
        : undefined;
      const started = onStart({
        kind,
        snapshot,
        sourcePng,
        ...(photoPng !== undefined ? { photoPng } : {}),
        fonts,
      });
      if (!started) setStartError('Another export is already running.');
      else
        setLastAttempt(
          volumeIndex === undefined ? { kind } : { kind, volumeIndex },
        );
    } catch (e) {
      setStartError(e instanceof Error ? e.message : 'Export failed to start.');
    } finally {
      setBusy(null);
    }
  };

  const running = job?.status === 'running';

  // §16.3: the first applicable reason, rendered as a sentence above the
  // disabled action — never tooltip-only.
  const kitDisabledReason = (() => {
    if (running || busy !== null) return null;
    return productionGateReason();
  })();

  const selectedSummary = `${selectedTileCount} page${selectedTileCount === 1 ? '' : 's'} in ${activeVolumes.size} volume${activeVolumes.size === 1 ? '' : 's'} · about ${formatMiB(kitEstimateBytes)} estimated.`;

  const stateReceipt = (() => {
    if (busy !== null || job?.status === 'running' || job?.status === 'failed' || job?.status === 'canceled' || readyFile || startError) {
      return (
        <ExportStateReceipt
          job={job}
          readyFile={readyFile}
          busy={busy}
          startError={startError}
        />
      );
    }
    if (blockerCount > 0) {
      return (
        <section className="export-receipt export-receipt--blocker" role="alert">
          <strong>
            Fix {blockerCount} blocker{blockerCount === 1 ? '' : 's'} before
            generating a kit.
          </strong>
          <span>Review the blocker list, then return to Print.</span>
        </section>
      );
    }
    if (unacked.length > 0) {
      return (
        <section className="export-receipt export-receipt--warning">
          <strong>
            Confirm {unacked.length} warning{unacked.length === 1 ? '' : 's'}.
          </strong>
          <span>Review the source-quality and physical-release risks before production output.</span>
        </section>
      );
    }
    if (!fingerprints && scene && layout) {
      return (
        <section className="export-receipt export-receipt--running" role="status">
          <strong>Preparing the readiness checks…</strong>
          <span>Production output will be available when the current scopes finish computing.</span>
        </section>
      );
    }
    if (selectedTileCount === 0) {
      return (
        <section className="export-receipt export-receipt--warning">
          <strong>Select at least one volume.</strong>
          <span>A kit needs at least one selected page volume.</span>
        </section>
      );
    }
    if (overPageLimit) {
      return (
        <section className="export-receipt export-receipt--warning">
          <strong>
            The selected {selectedTileCount} pages exceed the{' '}
            {LIMITS.exportMaxPages}-page job limit.
          </strong>
          <span>Select fewer volumes or export the volumes separately.</span>
        </section>
      );
    }
    if (overBundleLimit) {
      return (
        <section className="export-receipt export-receipt--warning">
          <strong>
            Estimated kit size {formatMiB(kitEstimateBytes)} exceeds the bundle
            limit.
          </strong>
          <span>Select fewer volumes or download volumes separately.</span>
        </section>
      );
    }
    return (
      <section className="export-receipt export-receipt--success" role="status">
        <strong>Ready to generate.</strong>
        <span>{selectedSummary}</span>
      </section>
    );
  })();

  const focusVolumeSelection = () => {
    const disclosure = globalThis.document?.getElementById(
      'export-volume-selection',
    );
    if (!(disclosure instanceof HTMLElement)) return;
    const summary = disclosure.querySelector<HTMLElement>('summary');
    if (!disclosure.hasAttribute('open')) summary?.click();
    const focusRemedy = () => {
      const target =
        disclosure.querySelector<HTMLInputElement>('input[type="checkbox"]') ??
        disclosure.querySelector<HTMLButtonElement>('.export-actions button');
      if (!target) return;
      target.focus();
      target.scrollIntoView?.({ block: 'nearest' });
    };
    globalThis.setTimeout(focusRemedy, disclosure.hasAttribute('open') ? 0 : 40);
  };

  const retryLastAttempt = () => {
    if (!lastAttempt) return;
    void runExport(lastAttempt.kind, lastAttempt.volumeIndex);
  };

  const failedKind = lastAttempt?.kind ?? job?.kind ?? 'kit';
  const failedVolumeIndex = lastAttempt?.volumeIndex;
  const failedRetryReason = exportStartReason(failedKind, failedVolumeIndex);
  const failedRetryAllowed = failedRetryReason === null;
  const canceledKind = job?.kind ?? lastAttempt?.kind ?? 'kit';
  const canceledVolumeIndex = lastAttempt?.volumeIndex;
  const canceledRetryReason = exportStartReason(
    canceledKind,
    canceledVolumeIndex,
  );
  const canceledRetryAllowed = canceledRetryReason === null;

  const repeatLabel = (kind: ExportKind): string => {
    switch (kind) {
      case 'kit':
        return 'Generate kit';
      case 'volume':
        return 'Generate volume PDF';
      case 'proof':
        return 'Geometry proof PDF';
      case 'calibration':
        return 'Calibration sheet';
      case 'master-pdf':
        return 'Master PDF';
      case 'master-svg':
        return 'Master SVG';
    }
  };

  const dockState = (() => {
    if (busy !== null) {
      return {
        state: 'preparing',
        context: 'Preparing export…',
        reason: 'The current revision is being frozen for output.',
        primaryLabel: 'Preparing…',
        primaryDisabled: true,
        primaryBusy: true,
      };
    }
    if (job?.status === 'running') {
      return {
        state: 'running',
        context: `Generating ${exportKindLabel(job.kind)}`,
        reason: `${exportProgressSummary(job)} · editing is safe`,
        secondaryLabel: 'Cancel export',
        onSecondary: onCancel,
      };
    }
    if (readyFile) {
      return {
        state: 'complete',
        context: `${job ? exportKindLabel(job.kind) : 'Print kit'} ready`,
        reason: 'File ready to download.',
        primaryLabel: job ? `Download ${exportKindLabel(job.kind)}` : 'Download file',
        primaryAriaLabel: `Download ${readyFile.filename}`,
        onPrimary: onDownload,
        secondaryLabel: 'Discard file',
        onSecondary: onClearReady,
      };
    }
    if (job?.status === 'failed' || startError) {
      const failure = job?.error || startError || 'The export worker could not finish this file.';
      return {
        state: 'failed',
        context: 'Export failed',
        reason: failedRetryAllowed
          ? failure
          : `${failure} ${failedRetryReason ?? 'Retry is unavailable at this revision.'}`,
        primaryLabel: lastAttempt ? 'Retry' : repeatLabel(failedKind),
        primaryAriaLabel: lastAttempt ? undefined : repeatLabel(failedKind),
        primaryDisabled: !failedRetryAllowed,
        onPrimary: lastAttempt
          ? retryLastAttempt
          : () => void runExport(failedKind, failedVolumeIndex),
      };
    }
    if (job?.status === 'canceled') {
      return {
        state: 'canceled',
        context: 'Export canceled',
        reason: canceledRetryAllowed
          ? 'No file was produced. The fitting selection is preserved.'
          : `${canceledRetryReason ?? 'The export cannot be restarted at this revision.'} The fitting selection is preserved.`,
        primaryLabel: repeatLabel(canceledKind),
        primaryDisabled: !canceledRetryAllowed,
        onPrimary: () => void runExport(canceledKind, canceledVolumeIndex),
      };
    }
    if (blockerCount > 0) {
      return {
        state: 'blocked',
        context: 'Review blockers',
        reason: kitDisabledReason || 'Production output is unavailable at this revision.',
        primaryLabel: 'Review blockers',
        onPrimary: () => setStep('proof'),
      };
    }
    if (unacked.length > 0) {
      return {
        state: 'warnings',
        context: 'Review warning',
        reason: `Confirm ${unacked.length} warning${unacked.length === 1 ? '' : 's'} above.`,
        primaryLabel: 'Generate kit',
        primaryDisabled: true,
      };
    }
    if (!fingerprints && scene && layout) {
      return {
        state: 'checking',
        context: 'Preparing readiness checks…',
        reason: 'Production output needs current readiness data.',
        primaryLabel: 'Preparing…',
        primaryDisabled: true,
        primaryBusy: true,
      };
    }
    if (selectedTileCount === 0) {
      return {
        state: 'no-volume',
        context: 'Select volumes',
        reason: 'Select at least one volume.',
        primaryLabel: 'Select volumes',
        onPrimary: focusVolumeSelection,
      };
    }
    if (overPageLimit) {
      return {
        state: 'over-pages',
        context: 'Select fewer volumes',
        reason: `The selected ${selectedTileCount} pages exceed the ${LIMITS.exportMaxPages}-page job limit.`,
        primaryLabel: 'Select volumes',
        onPrimary: focusVolumeSelection,
      };
    }
    if (overBundleLimit) {
      return {
        state: 'over-bundle',
        context: 'Select fewer volumes',
        reason: `Estimated kit size ${formatMiB(kitEstimateBytes)} exceeds the ${formatMiB(LIMITS.bundleMaxBytes)} bundle limit.`,
        primaryLabel: 'Select volumes',
        onPrimary: focusVolumeSelection,
      };
    }
    return {
      state: 'ready',
      context: 'Ready to generate',
      reason: selectedSummary,
      primaryLabel: 'Generate kit',
      onPrimary: () => void runExport('kit'),
    };
  })();

  const dock = (
    <ProductionCommandDock
      context={dockState.context}
      reason={dockState.reason}
      primaryLabel={dockState.primaryLabel}
      onPrimary={dockState.onPrimary}
      primaryAriaLabel={
        'primaryAriaLabel' in dockState
          ? dockState.primaryAriaLabel
          : undefined
      }
      primaryDisabled={dockState.primaryDisabled}
      primaryBusy={dockState.primaryBusy}
      secondaryLabel={dockState.secondaryLabel}
      onSecondary={dockState.onSecondary}
      state={dockState.state}
    />
  );

  const receipt = receiptTarget
    ? createPortal(stateReceipt, receiptTarget)
    : stateReceipt;
  const commandDock = commandDockTarget
    ? createPortal(dock, commandDockTarget)
    : <div className="export-command-fallback">{dock}</div>;

  return (
    <section aria-label="Export" className="export-section m4-export-section">
      {receipt}
      <h3>Production outputs</h3>
      {photo ? (
        <p className="panel-note export-photo-note">
          The kit project backup includes this reference photo and its{' '}
          {photo.registration.status} registration. It remains separate from
          the printed raster and geometry.
        </p>
      ) : null}
      {volumes.length > 0 ? (
        <Disclosure
          id="export-volume-selection"
          title="Volume selection"
          description="Choose which page volumes go into the kit, or export them one at a time."
        >
          <fieldset className="field-group">
            <legend>Volumes</legend>
            {volumes.map((v) => (
              <label key={v.index} className="check-row">
                <input
                  type="checkbox"
                  checked={activeVolumes.has(v.index)}
                  onChange={(e) => onToggleVolume(v.index, e.target.checked)}
                />
                Volume {v.index + 1} — {v.tileIds.length} page
                {v.tileIds.length === 1 ? '' : 's'} ·{' '}
                {(v.pixelCount / 1_000_000).toFixed(1)} MP
              </label>
            ))}
          </fieldset>
          <div className="export-actions">
            {volumes.map((v) => (
              <button
                key={v.index}
                type="button"
                className="button-quiet"
                disabled={!exportReady || !volumeFits(v) || running || busy !== null}
                title={
                  !volumeFits(v)
                    ? 'This volume exceeds the memory budget — choose a lower DPI or larger paper.'
                    : undefined
                }
                onClick={() => void runExport('volume', v.index)}
              >
                Volume {v.index + 1} PDF
              </button>
            ))}
          </div>
        </Disclosure>
      ) : null}
      {volumes.length > 0 ? (
        <Disclosure
          title="Proof output"
          description="A single-volume low-ink check print for geometry review — available without acknowledging warnings."
        >
          <fieldset className="field-group">
            <legend>Geometry proof (one volume)</legend>
            {volumes.length > 1 ? (
              <div className="field">
                <label htmlFor="proof-volume">Proof volume</label>
                <select
                  id="proof-volume"
                  value={proofVolume}
                  onChange={(e) => setProofVolume(Number(e.target.value))}
                >
                  {volumes.map((v) => (
                    <option key={v.index} value={v.index}>
                      Volume {v.index + 1} — {v.tileIds.length} pages
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            <div className="export-actions">
              <button
                type="button"
                className="button-quiet"
                disabled={
                  !baseReady ||
                  !proofTargetVolume ||
                  !volumeFits(proofTargetVolume) ||
                  running ||
                  busy !== null
                }
                onClick={() =>
                  void runExport(
                    'proof',
                    proofTargetVolume?.index ?? 0,
                  )
                }
              >
                Geometry proof PDF
              </button>
            </div>
          </fieldset>
        </Disclosure>
      ) : null}
      <Disclosure
        title="Professional outputs"
        description="Full-size single-surface masters for large-format workflows."
      >
        <fieldset className="field-group">
          <legend>Full-size master (one surface)</legend>
          <div className="field">
            <label htmlFor="master-surface">Surface</label>
            <select
              id="master-surface"
              value={effectiveMasterSurface}
              onChange={(e) => setMasterSurface(e.target.value as SurfaceId)}
            >
              {(scene?.surfaces ?? []).map((s) => (
                <option key={s.surface.id} value={s.surface.id}>
                  Surface {s.surface.id}
                </option>
              ))}
            </select>
          </div>
          {masterOverBudget ? (
            <p className="field-error">
              Surface {effectiveMasterSurface} needs{' '}
              {((masterPx ?? 0) / 1_000_000).toFixed(1)} MP at{' '}
              {project.print.dpi} DPI — over the 24 MP master budget. Use the
              tiled volumes instead.
            </p>
          ) : masterMemoryOverBudget ? (
            <p className="field-error">
              The estimated memory for surface {effectiveMasterSurface} exceeds
              the device budget. Use the tiled volumes instead.
            </p>
          ) : (
            <div className="export-actions">
              <button
                type="button"
                className="button-quiet"
                disabled={
                  !exportReady ||
                  !masterMemoryFits ||
                  running ||
                  busy !== null ||
                  !project.artwork
                }
                onClick={() => void runExport('master-pdf')}
              >
                Master PDF
              </button>
              <button
                type="button"
                className="button-quiet"
                disabled={
                  !exportReady ||
                  !masterMemoryFits ||
                  running ||
                  busy !== null ||
                  !project.artwork
                }
                onClick={() => void runExport('master-svg')}
              >
                Master SVG
              </button>
            </div>
          )}
        </fieldset>
      </Disclosure>
      <div className="export-production">
        {ackWarnings.length > 0 ? (
          <fieldset id="export-warning-ack" className="field-group">
            <legend>Acknowledge warnings</legend>
            {ackWarnings.map((w) => (
              <label key={w.ackId} className="check-row">
                <input
                  type="checkbox"
                  checked={acknowledgements[w.ackId!] === fingerprintFor(w)}
                  onChange={(e) =>
                    acknowledge(
                      w.ackId!,
                      e.target.checked ? (fingerprintFor(w) ?? '') : '',
                    )
                  }
                />
                <span>{w.message}</span>
              </label>
            ))}
          </fieldset>
        ) : null}
        {kitDisabledReason ? (
          <p className="export-gate-reason" role="note">
            {kitDisabledReason}
          </p>
        ) : null}
        <div className="export-actions export-exempt-actions">
          <button
            type="button"
            className="button-quiet"
            disabled={running || busy !== null}
            onClick={() => void runExport('calibration')}
          >
            Calibration sheet
          </button>
        </div>
        <Disclosure
          title="Technical details"
          description="Fingerprints, frozen revision and worker diagnostics."
          className="export-technical"
        >
          <dl className="technical-list">
            <div>
              <dt>Readiness</dt>
              <dd>{exportReady ? 'Production scopes current' : 'Not ready'}</dd>
            </div>
            <div>
              <dt>Layout fingerprint</dt>
              <dd>{fingerprints?.layout ?? 'pending'}</dd>
            </div>
            <div>
              <dt>Physical fingerprint</dt>
              <dd>{fingerprints?.physical ?? 'pending'}</dd>
            </div>
            <div>
              <dt>Export phase</dt>
              <dd>{job?.phase ?? 'idle'}</dd>
            </div>
            <div>
              <dt>Frozen revision</dt>
              <dd>{job?.revisionFingerprint || '—'}</dd>
            </div>
            {job?.error ? (
              <div>
                <dt>Worker message</dt>
                <dd>{job.error}</dd>
              </div>
            ) : null}
          </dl>
        </Disclosure>
      </div>
      <p className="panel-note m4-export-safety-note">
        Output is produced from a frozen revision; editing remains safe while
        an export runs. Physical installation is unverified.
      </p>
      {commandDock}
    </section>
  );
}
