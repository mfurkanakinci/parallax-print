import { useMemo, useState } from 'react';
import { Disclosure } from '../../components/Disclosure';
import { IssueList } from '../../components/IssueList';
import { fingerprintForAckScope } from '../../core/fingerprints';
import { runPreflight } from '../../core/preflight/preflight';
import type { PrintLayout } from '../../core/print/tiling';
import type {
  CalibrationRecord,
  CompiledScene,
  Issue,
  ProjectV1,
} from '../../core/types';
import { saveCalibration } from '../../persistence/calibrations';
import type { StoredAsset } from '../../persistence/types';
import { useFingerprints } from '../../state/exportController';
import type { ExportJobState } from '../../state/exportController';
import type { PreviewStatus } from '../../state/jobController';
import { useProjectStore } from '../../state/projectStore';
import type { ExportStarter } from '../print/ExportSection';
import type { ProductionSnapshot } from '../../export/types';
import {
  ExportStateReceipt,
} from '../print/productionPresentation';
import { exportKindLabel } from '../print/productionCopy';

/**
 * How a stored calibration record compares to the live fingerprints.
 * - checking: fingerprints are still computing (or cannot be produced), so no
 *   comparison is possible — never claim the record "matches" in this state.
 * - matches: BOTH the physical (geometry/artwork) and layout (print settings)
 *   fingerprints equal the stored record.
 * - outdated: fingerprints resolved and at least one differs.
 */
export type CalibrationMatchState = 'checking' | 'matches' | 'outdated';

export function calibrationMatchState(
  calibration: CalibrationRecord,
  fingerprints: { physical: string; layout: string } | null,
): CalibrationMatchState {
  if (!fingerprints) return 'checking';
  return calibration.scopeFingerprint === fingerprints.physical &&
    calibration.settingsFingerprint === fingerprints.layout
    ? 'matches'
    : 'outdated';
}

export function ProofPanel({
  project,
  scene,
  asset,
  layout,
  issues,
  previewStatus,
  calibration,
  exportJob,
  readyFile,
  onStartExport,
  onCancelExport,
  onDownloadExport,
  onClearExport,
}: {
  readonly project: ProjectV1;
  readonly scene: CompiledScene | null;
  readonly asset: StoredAsset | null;
  readonly layout: PrintLayout | null;
  readonly issues: readonly Issue[];
  readonly previewStatus: PreviewStatus;
  readonly calibration: CalibrationRecord | null;
  readonly exportJob: ExportJobState | null;
  readonly readyFile: { blob: Blob; filename: string } | null;
  readonly onStartExport: ExportStarter;
  readonly onCancelExport: () => void;
  readonly onDownloadExport: () => void;
  readonly onClearExport: () => void;
  /** The shell owns the Check navigation dock; accepted for the shared panel contract. */
  readonly commandDockTarget?: HTMLElement | null;
}) {
  const setCalibration = useProjectStore((s) => s.setCalibration);
  const acknowledgements = useProjectStore((s) => s.acknowledgements);
  const fingerprints = useFingerprints(project, scene, asset);
  const calibrationMatch = calibration
    ? calibrationMatchState(calibration, fingerprints)
    : null;
  const [rulerX, setRulerX] = useState('');
  const [rulerY, setRulerY] = useState('');
  const [proofResult, setProofResult] = useState<'pass' | 'fail' | 'skip'>(
    'skip',
  );
  const [calError, setCalError] = useState<string | null>(null);
  const [exportBusy, setExportBusy] = useState(false);
  const [lastCheckAttempt, setLastCheckAttempt] = useState<
    'calibration' | 'proof' | null
  >(null);

  const preflight = useMemo(() => {
    if (!scene) return null;
    return runPreflight({
      project,
      scene,
      compileIssues: issues,
      layout,
      hasAsset: !!asset,
      calibration,
      physicalHash: fingerprints?.physical ?? null,
      layoutHash: fingerprints?.layout ?? null,
    });
  }, [
    scene,
    project,
    issues,
    layout,
    asset,
    calibration,
    fingerprints,
  ]);

  // Check consumes preflight output so blockers/warnings include the
  // synthesized entries (§11.4); compile issues stand in while the scene is
  // unavailable.
  const blockers = preflight
    ? preflight.blockers
    : issues.filter((i) => i.severity === 'blocker');
  const warnings = preflight
    ? preflight.warnings
    : issues.filter((i) => i.severity === 'warning');
  const info = preflight
    ? preflight.info
    : issues.filter((i) => i.severity === 'info');

  const unackedCount = fingerprints
    ? warnings.filter(
        (w) =>
          w.ackId &&
          acknowledgements[w.ackId] !==
            fingerprintForAckScope(w.ackScope, fingerprints),
      ).length
    : warnings.filter((w) => w.ackId).length;

  // §15 readiness language: "Ready for digital export" only when no blockers
  // and a valid layout; "Physically verified" is never claimed — the best
  // state is a current self-reported record.
  const readiness = (() => {
    if (blockers.length > 0 || !layout || !scene) {
      return {
        tone: 'blocked' as const,
        title: 'Needs attention',
        text:
          blockers.length > 0
            ? `Fix ${blockers.length} blocker${
                blockers.length === 1 ? '' : 's'
              } before production output.`
            : 'The project is not ready for a print layout yet.',
      };
    }
    if (unackedCount > 0) {
      return {
        tone: 'warning' as const,
        title: `Ready after ${unackedCount} warning${
          unackedCount === 1 ? '' : 's'
        }`,
        text: 'The project is valid; confirm the remaining risk before production.',
      };
    }
    return {
      tone: 'ready' as const,
      title: 'Ready for digital export',
      text: 'Geometry and layout checks pass at this revision.',
    };
  })();

  const physicalVerification = calibration
    ? calibrationMatch === 'checking'
      ? 'Checking against current geometry…'
      : calibrationMatch === 'matches'
        ? 'Current — self-reported record'
        : 'Outdated — geometry or print changed'
    : 'Unverified';

  const recordCalibration = async () => {
    setCalError(null);
    const projectId = project.id;
    const stillCurrent = () =>
      useProjectStore.getState().document?.project.id === projectId &&
      !useProjectStore.getState().readOnly;
    if (!stillCurrent()) return;
    if (!fingerprints) {
      setCalError('Fingerprints are still being computed — try again.');
      return;
    }
    const x = rulerX.trim() === '' ? null : Number(rulerX);
    const y = rulerY.trim() === '' ? null : Number(rulerY);
    if (
      (x !== null && (!Number.isFinite(x) || x <= 0)) ||
      (y !== null && (!Number.isFinite(y) || y <= 0))
    ) {
      setCalError(
        'Enter a positive measured millimetre length or leave a field blank.',
      );
      return;
    }
    const record: CalibrationRecord = {
      scopeFingerprint: fingerprints.physical,
      settingsFingerprint: fingerprints.layout,
      rulerXMm: x,
      rulerYMm: y,
      declaredProofResult: proofResult === 'skip' ? null : proofResult,
      recordedAt: new Date().toISOString(),
    };
    try {
      await saveCalibration(projectId, record);
      if (!stillCurrent()) return;
      setCalibration(record);
    } catch {
      if (!stillCurrent()) return;
      setCalibration(record);
      setCalError(
        'Recorded for this session only — saving the record to this device failed.',
      );
    }
  };

  const startCalibrationSheet = async () => {
    setExportBusy(true);
    setCalError(null);
    setLastCheckAttempt('calibration');
    try {
      const { loadFontBytes } = await import('../../assets/fonts');
      const fonts = await loadFontBytes();
      const started = onStartExport({ kind: 'calibration', project, fonts });
      if (!started) setCalError('Another export is already running.');
    } catch (e) {
      setCalError(e instanceof Error ? e.message : 'Export failed to start.');
    } finally {
      setExportBusy(false);
    }
  };

  const startProof = async () => {
    if (
      !scene ||
      !layout ||
      !fingerprints ||
      !asset ||
      !project.artwork ||
      layout.volumes.length === 0
    )
      return;
    setExportBusy(true);
    setCalError(null);
    setLastCheckAttempt('proof');
    try {
      const { buildProductionSnapshot } = await import(
        '../../state/exportController'
      );
      const { loadFontBytes } = await import('../../assets/fonts');
      const volume = layout.volumes[0]!;
      const snapshot: ProductionSnapshot = await buildProductionSnapshot({
        document: { project, asset },
        scene,
        layout,
        selectedTileIds: volume.tileIds,
        acknowledgements: [],
        calibration,
        volumeIndex: volume.index,
      });
      const fonts = await loadFontBytes();
      const started = onStartExport({
        kind: 'proof',
        snapshot,
        sourcePng: null,
        fonts,
      });
      if (!started) setCalError('Another export is already running.');
    } catch (e) {
      setCalError(e instanceof Error ? e.message : 'Export failed to start.');
    } finally {
      setExportBusy(false);
    }
  };

  const checkRetry =
    lastCheckAttempt === null ? null : () => {
      if (lastCheckAttempt === 'calibration') {
        void startCalibrationSheet();
      } else {
        void startProof();
      }
    };

  return (
    <div className="panel m4-production m4-check-panel">
      <h2>Check</h2>
      <p className="m4-panel-intro">
        Review digital readiness without overstating physical certainty.
      </p>
      <p className="m4-physical-note" role="note">
        <strong>Physical verification: unverified</strong>
        Digital alpha — physical installation and printer calibration are not
        verified. Always check printed scale before mounting.
      </p>
      {!asset ? (
        <p className="panel-note">
          No artwork is attached, so only geometry can be previewed.
        </p>
      ) : null}
      <section
        className={`m4-readiness m4-readiness--${readiness.tone}`}
        aria-label="Readiness"
      >
        <span className="m4-readiness-symbol" aria-hidden="true">
          {readiness.tone === 'blocked'
            ? '×'
            : readiness.tone === 'warning'
              ? '!'
              : '✓'}
        </span>
        <span className="m4-readiness-copy">
          <strong>{readiness.title}</strong>
          <span>{readiness.text}</span>
        </span>
      </section>
      <dl className="m4-check-ledger" aria-label="Check summary">
        <div>
          <dt>Geometry</dt>
          <dd data-tone={scene && blockers.length === 0 ? 'success' : 'error'}>
            {scene && blockers.length === 0 ? 'Valid' : 'Blocked'}
          </dd>
        </div>
        <div>
          <dt>Coverage</dt>
          <dd>
            {preflight?.coverage == null
              ? 'Unavailable'
              : `${(preflight.coverage * 100).toFixed(1)}%`}
          </dd>
        </div>
        <div>
          <dt>Source quality</dt>
          <dd>
            {preflight?.sampledPpi == null
              ? 'Unavailable'
              : `~${preflight.sampledPpi.toFixed(0)} PPI sampled`}
          </dd>
        </div>
        <div>
          <dt>Physical verification</dt>
          <dd data-tone="warning">{physicalVerification}</dd>
        </div>
      </dl>
      <section aria-label="Blockers">
        <h3>Blockers ({blockers.length})</h3>
        <IssueList issues={blockers} />
      </section>
      <Disclosure
        key={warnings.length > 0 ? 'warnings-open' : 'warnings-empty'}
        title={`Warnings (${warnings.length})`}
        description="Non-blocking issues worth reviewing before printing."
        defaultOpen={warnings.length > 0}
      >
        <IssueList issues={warnings} />
      </Disclosure>
      <Disclosure
        title={`Notes (${info.length})`}
        description="Informational checks recorded for this revision."
      >
        <IssueList issues={info} />
      </Disclosure>
      <Disclosure
        title="Physical calibration record"
        description="Self-reported ruler measurements from a printed sheet."
      >
        <section aria-label="Calibration record" className="calibration-form">
          <p className="panel-note">
            Measure the printed rulers on the calibration sheet and record
            what you measured. Passing requires 99.5–100.5 mm on a 100 mm
            ruler. This is self-reported — no physical validation has been
            performed.
          </p>
          {calibration ? (
            <p className="panel-note">
              Recorded {calibration.recordedAt} — rulers{' '}
              {calibration.rulerXMm ?? '—'}/{calibration.rulerYMm ?? '—'} mm,
              declared proof {calibration.declaredProofResult ?? 'skipped'}.
              <span className="calibration-match-state">
                {calibrationMatch === 'checking'
                  ? ' Checking against the current geometry and print settings.'
                  : calibrationMatch === 'outdated'
                    ? ' Outdated — geometry or print settings changed since this record.'
                    : ' Current — self-reported record matches this geometry and print setup.'}
              </span>
            </p>
          ) : null}
          <div className="field-row">
            <div className="field">
              <label htmlFor="ruler-x">Horizontal ruler (mm)</label>
              <input
                id="ruler-x"
                type="number"
                inputMode="decimal"
                value={rulerX}
                onChange={(e) => setRulerX(e.target.value)}
                placeholder="e.g. 100"
              />
            </div>
            <div className="field">
              <label htmlFor="ruler-y">Vertical ruler (mm)</label>
              <input
                id="ruler-y"
                type="number"
                inputMode="decimal"
                value={rulerY}
                onChange={(e) => setRulerY(e.target.value)}
                placeholder="e.g. 100"
              />
            </div>
            <div className="field">
              <label htmlFor="proof-result">Geometry proof</label>
              <select
                id="proof-result"
                value={proofResult}
                onChange={(e) =>
                  setProofResult(e.target.value as 'pass' | 'fail' | 'skip')
                }
              >
                <option value="skip">Skipped</option>
                <option value="pass">Pass (self-reported)</option>
                <option value="fail">Fail (self-reported)</option>
              </select>
            </div>
          </div>
          <button
            type="button"
            className="button-quiet"
            onClick={() => void recordCalibration()}
          >
            Record calibration
          </button>
          {calError ? (
            <p className="field-error" role="alert">
              {calError}
            </p>
          ) : null}
        </section>
      </Disclosure>
      <Disclosure
        title="Calibration and proof tools"
        description="Digital outputs remain independent of physical verification."
      >
        <section aria-label="Calibration and proof tools">
          <p className="panel-note">
            Calibration sheets and geometry proofs are available before
            production warning acknowledgements. Neither output certifies a
            physical installation.
          </p>
          <div className="export-actions">
            <button
              type="button"
              className="button-quiet"
              disabled={exportBusy || exportJob?.status === 'running'}
              onClick={() => void startCalibrationSheet()}
            >
              Download calibration sheet
            </button>
            <button
              type="button"
              className="button-quiet"
              disabled={
                !scene ||
                !layout ||
                !project.artwork ||
                !asset ||
                exportBusy ||
                exportJob?.status === 'running'
              }
              onClick={() => void startProof()}
            >
              Geometry proof PDF
            </button>
          </div>
        </section>
      </Disclosure>
      {exportJob?.status === 'running' ? (
        <div className="export-receipt export-receipt--running" role="status">
          <strong>
            Generating {exportKindLabel(exportJob.kind)}: {exportJob.completed}{' '}
            of {exportJob.total}. Editing is safe; this export uses the
            revision captured when it started.
          </strong>
          <button type="button" className="button-quiet" onClick={onCancelExport}>
            Cancel export
          </button>
        </div>
      ) : null}
      {exportJob?.status === 'failed' ? (
        <ExportStateReceipt
          job={exportJob}
          readyFile={null}
          busy={null}
          startError={null}
         >
          {checkRetry ? (
            <button type="button" className="button-quiet" onClick={checkRetry}>
              Retry
            </button>
          ) : null}
        </ExportStateReceipt>
      ) : null}
      {readyFile ? (
        <div>
          <ExportStateReceipt
            job={exportJob}
            readyFile={readyFile}
            busy={null}
            startError={null}
          />
          <div className="export-ready-actions">
            <button
              type="button"
              className="button-primary"
              onClick={onDownloadExport}
            >
              Download {readyFile.filename}
            </button>
            <button
              type="button"
              className="button-quiet"
              onClick={onClearExport}
            >
              Discard file
            </button>
          </div>
        </div>
      ) : null}
      <p className="panel-note m4-preview-status">
        Preview status: {previewStatus}.
      </p>
    </div>
  );
}
