import type { ExportKind } from '../../export/types';
import type { ExportJobState } from '../../state/exportController';

/** User-facing names for export jobs; worker phase names stay technical. */
export function exportKindLabel(
  kind: ExportKind,
  volumeIndex?: number,
): string {
  switch (kind) {
    case 'kit':
      return 'print kit';
    case 'volume':
      return volumeIndex === undefined
        ? 'volume PDF'
        : `Volume ${volumeIndex + 1} PDF`;
    case 'proof':
      return 'geometry proof';
    case 'calibration':
      return 'calibration sheet';
    case 'master-pdf':
      return 'master PDF';
    case 'master-svg':
      return 'master SVG';
  }
}

export function formatMiB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function exportProgressCopy(job: ExportJobState): string {
  return `Generating ${exportKindLabel(job.kind)}: ${exportProgressSummary(job)}. Editing is safe; this export uses the revision captured when it started.`;
}

/**
 * Worker counters are pages for proof/volume/kit raster phases, but document
 * steps for the kit's packaging phase. Other outputs do not expose a stable
 * unit, so the copy intentionally leaves the counter unitless.
 */
export function exportProgressSummary(job: ExportJobState): string {
  const phase = job.phase.toLowerCase();
  const unit =
    phase === 'proof' ||
    phase === 'warp-pages' ||
    phase.startsWith('volume ')
      ? 'pages'
      : phase === 'documents'
        ? 'document steps'
        : null;
  return unit
    ? `${job.completed} of ${job.total} ${unit}`
    : `${job.completed} of ${job.total}`;
}
