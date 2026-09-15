import type { ReactNode } from 'react';
import type { ExportKind } from '../../export/types';
import type { ExportJobState } from '../../state/exportController';
import {
  exportKindLabel,
  formatMiB,
  exportProgressCopy,
} from './productionCopy';

export function ProductionCommandDock({
  context,
  reason,
  primaryLabel,
  onPrimary,
  primaryAriaLabel,
  primaryDisabled = false,
  primaryBusy = false,
  secondaryLabel,
  onSecondary,
  state,
}: {
  readonly context: string;
  readonly reason: string;
  readonly primaryLabel?: string | undefined;
  readonly onPrimary?: (() => void) | undefined;
  readonly primaryAriaLabel?: string | undefined;
  readonly primaryDisabled?: boolean | undefined;
  readonly primaryBusy?: boolean | undefined;
  readonly secondaryLabel?: string | undefined;
  readonly onSecondary?: (() => void) | undefined;
  readonly state?: string | undefined;
}) {
  return (
    <div className="m4-command-dock" data-export-state={state}>
      <div className="m4-command-copy">
        <strong>{context}</strong>
        <span>{reason}</span>
      </div>
      <div className="m4-command-actions">
        {secondaryLabel && onSecondary ? (
          <button
            type="button"
            className="button-quiet"
            onClick={onSecondary}
          >
            {secondaryLabel}
          </button>
        ) : null}
        {primaryLabel ? (
          <button
            type="button"
            className="button-primary"
            disabled={primaryDisabled || primaryBusy}
            aria-busy={primaryBusy || undefined}
            aria-label={primaryAriaLabel}
            onClick={onPrimary}
          >
            {primaryLabel}
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function ExportStateReceipt({
  job,
  readyFile,
  busy,
  startError,
  children,
}: {
  readonly job: ExportJobState | null;
  readonly readyFile: { blob: Blob; filename: string } | null;
  readonly busy: ExportKind | null;
  readonly startError: string | null;
  readonly children?: ReactNode;
}) {
  if (startError) {
    return (
      <section className="export-receipt export-receipt--error" role="alert">
        <strong>Export could not start.</strong>
        <span>{startError}</span>
      </section>
    );
  }

  if (busy !== null) {
    return (
      <section
        className="export-receipt export-receipt--running export-progress"
        role="status"
      >
        <strong>Preparing export…</strong>
        <span>Loading the embedded type and freezing the current revision.</span>
      </section>
    );
  }

  if (job?.status === 'running') {
    return (
      <section
        className="export-receipt export-receipt--running export-progress"
        role="status"
      >
        <strong>{exportProgressCopy(job)}</strong>
        <progress
          max={Math.max(job.total, 1)}
          value={Math.min(job.completed, Math.max(job.total, 1))}
          aria-label="Export progress"
        />
      </section>
    );
  }

  if (job?.status === 'failed') {
    return (
      <section
        className="export-receipt export-receipt--error export-failed"
        role="alert"
      >
        <strong>Export failed.</strong>
        <span>{job.error || 'The export worker could not finish this file.'}</span>
        {children}
      </section>
    );
  }

  if (job?.status === 'canceled') {
    return (
      <section className="export-receipt export-receipt--canceled" role="status">
        <strong>Export canceled — no file was produced.</strong>
        <span>The print selection is preserved.</span>
      </section>
    );
  }

  if (readyFile) {
    return (
      <section
        className="export-receipt export-receipt--success export-ready"
        role="status"
      >
        <strong>Your {job ? exportKindLabel(job.kind) : 'file'} is ready.</strong>
        <span className="ready-file">
          {readyFile.filename} · {formatMiB(readyFile.blob.size)}
        </span>
      </section>
    );
  }

  return null;
}
