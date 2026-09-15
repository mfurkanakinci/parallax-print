import { LIMITS } from '../limits';
import type { PrintLayout } from '../print/tiling';
import type {
  CalibrationRecord,
  CompiledScene,
  Issue,
  PreflightReport,
  ProjectV1,
} from '../types';
import { frameCoverage, sampledSourcePpi } from './resolution';

export interface PreflightResult extends PreflightReport {
  readonly coverage: number | null;
  readonly sampledPpi: number | null;
  readonly layoutError: string | null;
  readonly printerScaleVerified: boolean;
  readonly geometryProofVerified: boolean;
}

export function printerScaleMatches(
  record: CalibrationRecord | null | undefined,
  physicalHash: string | null,
  layoutHash: string | null,
): boolean {
  if (!record || !physicalHash || !layoutHash) return false;
  return (
    record.scopeFingerprint === physicalHash &&
    record.settingsFingerprint === layoutHash &&
    record.rulerXMm !== null &&
    record.rulerYMm !== null &&
    record.rulerXMm >= 99.5 &&
    record.rulerXMm <= 100.5 &&
    record.rulerYMm >= 99.5 &&
    record.rulerYMm <= 100.5
  );
}

export function geometryProofMatches(
  record: CalibrationRecord | null | undefined,
  physicalHash: string | null,
): boolean {
  return (
    !!record &&
    !!physicalHash &&
    record.scopeFingerprint === physicalHash &&
    record.declaredProofResult === 'pass'
  );
}

export const calibrationMatches = printerScaleMatches;

export function runPreflight(input: {
  readonly project: ProjectV1;
  readonly scene: CompiledScene | null;
  readonly compileIssues: readonly Issue[];
  readonly layout: PrintLayout | null;
  readonly hasAsset: boolean;
  readonly calibration?: CalibrationRecord | null;
  readonly physicalHash?: string | null;
  readonly layoutHash?: string | null;
}): PreflightResult {
  const blockers: Issue[] = [];
  const warnings: Issue[] = [];
  const info: Issue[] = [];
  for (const issue of input.compileIssues) {
    if (issue.severity === 'blocker') {
      blockers.push(issue);
    } else if (issue.severity === 'warning') {
      warnings.push({
        ...issue,
        ackId:
          issue.ackId ??
          `geometry:${issue.code}:${issue.surfaceId ?? 'all'}`,
        // Geometry-domain warnings re-ask when the engine, room, artwork, or
        // source changes — but not on print-only edits (§14.2).
        ackScope: issue.ackScope ?? 'physical',
      });
    } else {
      info.push(issue);
    }
  }
  let coverage: number | null = null;
  let sampledPpi: number | null = null;
  let layoutError: string | null = null;

  if (input.project.artwork && !input.hasAsset) {
    blockers.push({
      code: 'missing-artwork',
      severity: 'blocker',
      message: 'The artwork file is missing from local storage.',
      remedy: 'Re-import the artwork before exporting.',
      fieldPath: 'artwork',
    });
  }

  if (!input.scene) {
    layoutError = 'The project could not be compiled.';
  } else {
    coverage = frameCoverage(input.scene);
    sampledPpi = sampledSourcePpi(input.scene);
    if (coverage !== null && coverage < 1 - 1 / 65536) {
      warnings.push({
        code: 'no-visible-footprint',
        severity: 'warning',
        ackId: 'frame-coverage',
        ackScope: 'physical',
        message: `Estimated frame coverage ${(coverage * 100).toFixed(1)}% — parts of the artwork frame fall outside the surfaces.`,
        remedy:
          'This is an estimate, not a measurement. Reduce the apparent size or reposition the artwork, and check the footprint overlay.',
      });
    }
    if (sampledPpi !== null) {
      const label = `Sampled minimum source PPI ${sampledPpi.toFixed(0)} (estimate).`;
      if (sampledPpi < 100) {
        warnings.push({
          code: 'invalid-print-spec',
          severity: 'warning',
          ackId: 'low-source-ppi',
          ackScope: 'layout',
          message: `${label} The print may look soft at the chosen size.`,
          remedy:
            'Use a higher-resolution source, print smaller, or inspect the geometry proof.',
        });
      } else if (sampledPpi < 150) {
        warnings.push({
          code: 'invalid-print-spec',
          severity: 'warning',
          ackId: 'marginal-source-ppi',
          ackScope: 'layout',
          message: `${label} It may only hold up at distance.`,
          remedy:
            'Use a higher-resolution source or inspect the geometry proof before printing.',
        });
      } else {
        info.push({
          code: 'invalid-print-spec',
          severity: 'info',
          message: `${label} Meets the 150 PPI guideline.`,
          remedy: 'None.',
        });
      }
    }
  }

  if (input.scene && !input.layout) {
    blockers.push({
      code: 'invalid-print-spec',
      severity: 'blocker',
      message: 'The print settings cannot produce a tile plan.',
      remedy: 'Check paper size, margins, overlap, and selected surfaces.',
    });
  }
  if (input.layout && input.layout.tiles.length > LIMITS.exportMaxPages) {
    info.push({
      code: 'invalid-print-spec',
      severity: 'info',
      message: `The full plan needs ${input.layout.tiles.length} pages — export it in volumes of at most ${LIMITS.exportMaxPages} pages.`,
      remedy: 'Select fewer pages or surfaces per export.',
    });
  }

  const printerScaleVerified = printerScaleMatches(
    input.calibration,
    input.physicalHash ?? null,
    input.layoutHash ?? null,
  );
  const geometryProofVerified = geometryProofMatches(
    input.calibration,
    input.physicalHash ?? null,
  );
  if (!printerScaleVerified) {
    warnings.push({
      code: 'invalid-print-spec',
      severity: 'warning',
      ackId: 'printer-scale-unverified',
      ackScope: 'layout',
      message:
        'Printer scale is unverified — no passing ruler record matches this geometry and print setup.',
      remedy:
        'Print the calibration sheet at 100% scale and record the ruler readings.',
    });
  }
  if (!geometryProofVerified) {
    warnings.push({
      code: 'invalid-print-spec',
      severity: 'warning',
      ackId: 'geometry-proof-unverified',
      ackScope: 'physical',
      message:
        'The geometry proof is unverified — no declared pass matches this geometry.',
      remedy:
        'Generate a geometry proof, check the fiducials physically, and declare the result.',
    });
  }
  info.push({
    code: 'invalid-print-spec',
    severity: 'info',
    message:
      'Physical release validation has not been performed; all records are self-reported.',
    remedy: 'None.',
  });
  return {
    blockers,
    warnings,
    info,
    coverage,
    sampledPpi,
    layoutError,
    printerScaleVerified,
    geometryProofVerified,
  };
}
